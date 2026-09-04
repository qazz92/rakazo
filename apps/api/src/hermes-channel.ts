import type { Hono } from "hono";
import { createHash } from "node:crypto";
import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
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
      body = await c.req.json();
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
