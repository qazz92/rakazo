import { ORPCError } from "@orpc/server";
import type { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type Prisma,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";

function isUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export const HERMES_CHANNEL_BASE_PATH = "/api/v1/hermes";

const POLL_INTERVAL_MS = 500;
const POLL_MAX_MS = 25_000;

export function sha256Token(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function bearerToken(request: Request): string | null {
  const header = request.headers.get("authorization");
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice(7).trim();
  return token || null;
}

/** Resolve a bearer token to its bot. Revoked tokens, archived bots, and
 *  bots without a home thread never authenticate. */
export async function resolveHermesToken(
  prisma: Pick<PrismaClient, "hermesBotToken" | "bot">,
  token: string,
): Promise<{ botId: string; spaceId: string; threadId: string } | null> {
  const row = await prisma.hermesBotToken.findFirst({
    where: { tokenHash: sha256Token(token), revokedAt: null },
    select: { botId: true, spaceId: true },
  });
  if (!row) return null;
  const bot = await prisma.bot.findFirst({
    where: { id: row.botId, archivedAt: null },
    select: { thread: { select: { id: true } } },
  });
  const threadId = bot?.thread?.id;
  if (!threadId) return null;
  return { botId: row.botId, spaceId: row.spaceId, threadId };
}

/** Atomic claim: the updateMany status guard means two concurrent pollers
 *  can never take the same turn. */
export async function claimNextHermesTurn(
  prisma: Pick<PrismaClient, "hermesTurn">,
  botId: string,
): Promise<{ id: string; threadId: string; prompt: string } | null> {
  const next = await prisma.hermesTurn.findFirst({
    where: { botId, status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!next) return null;
  const claimed = await prisma.hermesTurn.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "delivered", deliveredAt: new Date() },
  });
  if (claimed.count === 0) return null; // ponytail: raced poller won — caller's next loop iteration retries
  return prisma.hermesTurn.findUniqueOrThrow({
    where: { id: next.id },
    select: { id: true, threadId: true, prompt: true },
  });
}

export async function isHermesBot(
  prisma: Pick<PrismaClient, "hermesBotToken">,
  botId: string,
): Promise<boolean> {
  const token = await prisma.hermesBotToken.findFirst({
    where: { botId, revokedAt: null },
    select: { id: true },
  });
  return token !== null;
}

/** Fan-out guard: a hermes member in a group thread would answer as one of
 *  many voices with no PM to coordinate — team bots stay in 1:1 threads. */
export async function assertNoHermesMembers(
  prisma: Pick<PrismaClient, "hermesBotToken">,
  botIds: string[],
): Promise<void> {
  const hermesMembers = await Promise.all(botIds.map((id) => isHermesBot(prisma, id)));
  if (hermesMembers.some(Boolean)) {
    throw new ORPCError("BAD_REQUEST", {
      message: "Team bots coordinate through their PM — send requests to a single bot's thread.",
    });
  }
}

/** Drop runs that belong to a hermes turn: their execution lives on the
 *  mini, so local dispatch sites (send replay) must skip them. */
export async function withoutHermesRuns<T extends { id: string }>(
  prisma: Pick<PrismaClient, "hermesTurn">,
  runs: T[],
): Promise<T[]> {
  if (!runs.length) return runs;
  const turns = await prisma.hermesTurn.findMany({
    where: { runId: { in: runs.map((run) => run.id) } },
    select: { runId: true },
  });
  if (!turns.length) return runs;
  const hermesRunIds = new Set(turns.map((turn) => turn.runId));
  return runs.filter((run) => !hermesRunIds.has(run.id));
}

export interface HermesSendRedirect {
  message: { id: string; seq: number };
  runs: Array<{ id: string; taskId: string; status: string }>;
  eventSeq: number;
  hermes: true;
}

export interface HermesSendArgs {
  spaceId: string;
  botId: string;
  threadId: string;
  userId: string;
  message: { id: string; seq: number };
  blocks: unknown[];
  prompt: string;
  replyToMessageId?: string;
}

/**
 * Fork: route a bot-thread send to the hermes turn queue instead of the local
 * run executor. Returns null for non-hermes bots so the normal path continues.
 * A companion Task/Run (both queued) keeps the threads.send output contract
 * ({taskId, runId, seq}) and the UI's execution state; the reply endpoint
 * completes the run when hermes answers. cancelSupersededQueuedRuns is not
 * called: hermes turns run sequentially on the mini.
 */
export async function redirectHermesSend(
  tx: Prisma.TransactionClient,
  args: HermesSendArgs,
): Promise<HermesSendRedirect | null> {
  const token = await tx.hermesBotToken.findFirst({
    where: { botId: args.botId, revokedAt: null },
    select: { id: true },
  });
  if (!token) return null;

  const task = await tx.task.create({
    data: {
      spaceId: args.spaceId,
      botId: args.botId,
      threadId: args.threadId,
      userId: args.userId,
      prompt: args.prompt,
      status: "queued",
    },
  });
  const run = await tx.run.create({
    data: {
      spaceId: args.spaceId,
      botId: args.botId,
      threadId: args.threadId,
      taskId: task.id,
      userId: args.userId,
      status: "queued",
      trigger: "user",
      sourceMessageId: args.message.id,
    },
  });
  await tx.message.update({ where: { id: args.message.id }, data: { runId: run.id } });
  await tx.hermesTurn.create({
    data: {
      spaceId: args.spaceId,
      botId: args.botId,
      threadId: args.threadId,
      runId: run.id,
      prompt: args.prompt,
    },
  });
  const event = await appendEventInTransaction(tx, {
    spaceId: args.spaceId,
    threadId: args.threadId,
    botId: args.botId,
    type: "thread.message.created",
    runId: run.id,
    payload: {
      messageId: args.message.id,
      role: "user",
      blocks: args.blocks,
      runIds: [run.id],
      replyToMessageId: args.replyToMessageId,
    },
  });
  return { message: args.message, runs: [run], eventSeq: event.seq, hermes: true };
}

/**
 * Fork: the hermes side of the channel. Each bot's hermes gateway profile
 * long-polls this endpoint with its per-bot bearer token and receives one
 * queued turn at a time (Telegram-style direction reversal — rakazo opens
 * no inbound route to the hermes host). Mounted in Task 5.
 */
export function mountHermesChannelRoutes(
  app: Hono,
  deps: { prisma: PrismaClient; events: ThreadEvents },
) {
  app.post(`${HERMES_CHANNEL_BASE_PATH}/turns/next`, async (c) => {
    const token = bearerToken(c.req.raw);
    const auth = token ? await resolveHermesToken(deps.prisma, token) : null;
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    const deadline = Date.now() + POLL_MAX_MS;
    while (Date.now() < deadline) {
      const turn = await claimNextHermesTurn(deps.prisma, auth.botId);
      if (turn) return c.json(turn);
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return c.json({ timeout: true });
  });

  app.post(`${HERMES_CHANNEL_BASE_PATH}/turns/:turnId/reply`, async (c) => {
    const token = bearerToken(c.req.raw);
    const auth = token ? await resolveHermesToken(deps.prisma, token) : null;
    if (!auth) return c.json({ error: "Unauthorized" }, 401);
    let body: { threadId?: unknown; text?: unknown; clientNonce?: unknown };
    try {
      // A literal `null` (or scalar) parses without throwing — guard before field access.
      const parsed: unknown = await c.req.json();
      if (!parsed || typeof parsed !== "object") return c.json({ error: "Invalid JSON" }, 400);
      body = parsed as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const threadId = typeof body.threadId === "string" ? body.threadId : "";
    const text = typeof body.text === "string" ? body.text : "";
    const clientNonce = typeof body.clientNonce === "string" ? body.clientNonce : "";
    if (!threadId || !text.trim() || !clientNonce)
      return c.json({ error: "threadId, text, and clientNonce are required" }, 400);
    if (threadId !== auth.threadId)
      return c.json({ error: "This token is not for that thread" }, 401);

    const replayed = await deps.prisma.message.findFirst({
      where: { threadId, clientNonce },
      select: { id: true },
    });
    if (replayed) return c.json({ ok: true, messageId: replayed.id, duplicate: true });

    const blocks = [{ kind: "text" as const, text }];
    const turnId = c.req.param("turnId");
    let committed: { messageId: string; eventSeq: number | null };
    try {
      committed = await deps.prisma.$transaction(async (tx) => {
        const message = await createThreadMessageInTransaction(tx, {
          threadId,
          role: "bot",
          blocks,
          botId: auth.botId,
          clientNonce,
        });
        let runId: string | null = null;
        if (turnId !== "ad-hoc") {
          const turn = await tx.hermesTurn.findFirst({
            where: { id: turnId, botId: auth.botId, status: "delivered" },
            select: { runId: true },
          });
          if (!turn) return { messageId: message.id, eventSeq: null };
          runId = turn.runId;
          await tx.hermesTurn.update({
            where: { id: turnId },
            data: { status: "replied", repliedAt: new Date() },
          });
          if (runId) {
            await tx.run.update({ where: { id: runId }, data: { status: "completed" } });
          }
        }
        const event = await appendEventInTransaction(tx, {
          spaceId: auth.spaceId,
          threadId,
          botId: auth.botId,
          type: "thread.message.created",
          runId: runId ?? undefined,
          payload: { messageId: message.id, role: "bot", blocks },
        });
        return { messageId: message.id, eventSeq: event.seq };
      });
    } catch (error) {
      // Race guard: a concurrent reply with the same nonce lost the
      // Message(threadId, clientNonce) unique race — surface the winner.
      if (!isUniqueViolation(error)) throw error;
      const winner = await deps.prisma.message.findFirst({
        where: { threadId, clientNonce },
        select: { id: true },
      });
      if (winner) return c.json({ ok: true, messageId: winner.id, duplicate: true });
      throw error;
    }
    if (committed.eventSeq != null) {
      await deps.events.notify(threadId, committed.eventSeq).catch((error) => {
        console.error("hermes reply notify failed", error);
      });
    }
    return c.json({ ok: true, messageId: committed.messageId });
  });
}
