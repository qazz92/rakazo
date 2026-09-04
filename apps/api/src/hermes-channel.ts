import { ORPCError } from "@orpc/server";
import type { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
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

/** Both channel env vars must be set for provisioning hooks to fire;
 * unset keeps rakazo fully local (upstream behavior). */
export function hermesChannelEnabled(): boolean {
  return Boolean(process.env.HERMES_DEPLOY_TOKEN && process.env.HERMES_PUBLIC_URL);
}

/** The supervisor's shared deploy token (not per-bot). Unset env never authenticates. */
export function resolveDeployToken(token: string): boolean {
  const expected = process.env.HERMES_DEPLOY_TOKEN;
  if (!expected) return false;
  return sha256Token(token) === sha256Token(expected);
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

/** Same atomic claim pattern as turns: the updateMany status guard means two
 * concurrent supervisor pollers can never take the same command. */
export async function claimNextHermesCommand(
  prisma: Pick<PrismaClient, "hermesCommand">,
): Promise<{ id: string; action: string; payload: string } | null> {
  const next = await prisma.hermesCommand.findFirst({
    where: { status: "queued" },
    orderBy: { createdAt: "asc" },
    select: { id: true },
  });
  if (!next) return null;
  const claimed = await prisma.hermesCommand.updateMany({
    where: { id: next.id, status: "queued" },
    data: { status: "delivered" },
  });
  if (claimed.count === 0) return null; // ponytail: raced poller won — caller's next loop iteration retries
  return prisma.hermesCommand.findUniqueOrThrow({
    where: { id: next.id },
    select: { id: true, action: true, payload: true },
  });
}

export async function enqueueHermesCommand(
  prisma: Pick<PrismaClient, "hermesCommand">,
  botId: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await prisma.hermesCommand.create({
    data: { botId, action, payload: JSON.stringify(payload) },
  });
}

/**
 * Fork: bot creation = hermes provisioning. Mints the bot's channel token and
 * queues the provision command the supervisor turns into `hermes profile
 * create rakazo-<botId> --clone-from rakazo-template` + env injection. The
 * token's plaintext rides only in the queued payload (zeroed on completion)
 * and as a sha256 hash in hermesBotToken.
 */
export async function provisionHermesBot(
  prisma: Pick<PrismaClient, "hermesBotToken" | "hermesCommand">,
  bot: { id: string; spaceId: string; instructions: string; threadId: string },
): Promise<void> {
  const token = randomBytes(32).toString("base64url");
  const tokenHash = sha256Token(token);
  // botId is unique: upsert resets the hash in place (rotation ruling) —
  // revoke-then-create would P2002 on the unique botId. Upsert first so a
  // failed enqueue can never orphan a command whose token rakazo never stored.
  await prisma.hermesBotToken.upsert({
    where: { botId: bot.id },
    update: { tokenHash, revokedAt: null },
    create: { botId: bot.id, spaceId: bot.spaceId, tokenHash },
  });
  await enqueueHermesCommand(prisma, bot.id, "provision", {
    name: `rakazo-${bot.id}`,
    soul: bot.instructions,
    url: process.env.HERMES_PUBLIC_URL,
    threadId: bot.threadId,
    token,
  });
}

/**
 * Fork: bot lifecycle → supervisor command. provision comes from
 * provisionHermesBot; every later transition routes through here as
 * update (persona) | stop (archive) | start (restore) | deprovision (remove).
 */
export async function hookHermesLifecycle(
  prisma: Pick<PrismaClient, "hermesCommand">,
  bot: { id: string; instructions?: string | null },
  action: "update" | "stop" | "start" | "deprovision" | "rotate",
  extra: { token?: string } = {},
): Promise<void> {
  await enqueueHermesCommand(prisma, bot.id, action, {
    name: `rakazo-${bot.id}`,
    ...(action === "update" && bot.instructions != null ? { soul: bot.instructions } : {}),
    ...extra,
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

/**
 * Fork: token propagation after hermesToken.issue. A provision that is
 * queued, delivered, or done means the profile is being or has been created —
 * 'update' is FIFO-correct there (it runs after the in-flight provision),
 * while a second full 'provision' would fail "profile exists" and strand the
 * in-flight token. No provision row (or a failed one) means the profile
 * likely does not exist: an 'update' would fail "profile does not exist" and
 * the bot's sends would queue forever, so the full payload is re-issued.
 */
export async function propagateHermesToken(
  prisma: Pick<PrismaClient, "hermesCommand">,
  bot: { id: string; instructions: string; threadId: string },
  token: string,
): Promise<void> {
  const provisionRow = await prisma.hermesCommand.findFirst({
    where: {
      botId: bot.id,
      action: "provision",
      status: { in: ["queued", "delivered", "done"] },
    },
    select: { id: true },
  });
  if (provisionRow) {
    await enqueueHermesCommand(prisma, bot.id, "update", {
      name: `rakazo-${bot.id}`,
      token,
    });
    return;
  }
  await enqueueHermesCommand(prisma, bot.id, "provision", {
    name: `rakazo-${bot.id}`,
    soul: bot.instructions,
    url: process.env.HERMES_PUBLIC_URL,
    threadId: bot.threadId,
    token,
  });
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
        const messageEvent = await appendEventInTransaction(tx, {
          spaceId: auth.spaceId,
          threadId,
          botId: auth.botId,
          type: "thread.message.created",
          runId: runId ?? undefined,
          payload: { messageId: message.id, role: "bot", blocks },
        });
        // Fork: mirror finalizeRun — the web client clears live run state only
        // on run.completed/failed/cancelled, so a turn with a companion Run
        // must append the terminal event here or the thread UI stays busy.
        let eventSeq = messageEvent.seq;
        if (runId) {
          const completedEvent = await appendEventInTransaction(tx, {
            spaceId: auth.spaceId,
            threadId,
            botId: auth.botId,
            type: "run.completed",
            runId,
            payload: {},
          });
          eventSeq = completedEvent.seq;
        }
        return { messageId: message.id, eventSeq };
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

  // The supervisor (not a bot profile) long-polls provisioning commands with
  // the shared deploy token and reports each outcome back.
  app.post(`${HERMES_CHANNEL_BASE_PATH}/commands/next`, async (c) => {
    const token = bearerToken(c.req.raw);
    if (!token || !resolveDeployToken(token)) return c.json({ error: "Unauthorized" }, 401);
    const deadline = Date.now() + POLL_MAX_MS;
    while (Date.now() < deadline) {
      const command = await claimNextHermesCommand(deps.prisma);
      if (command) return c.json(command);
      await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    }
    return c.json({ timeout: true });
  });

  app.post(`${HERMES_CHANNEL_BASE_PATH}/commands/:id/result`, async (c) => {
    const token = bearerToken(c.req.raw);
    if (!token || !resolveDeployToken(token)) return c.json({ error: "Unauthorized" }, 401);
    let body: { ok?: boolean; detail?: string };
    try {
      // A literal `null` (or scalar) parses without throwing — guard before field access.
      const parsed: unknown = await c.req.json();
      if (!parsed || typeof parsed !== "object") return c.json({ error: "Invalid JSON" }, 400);
      body = parsed as typeof body;
    } catch {
      return c.json({ error: "Invalid JSON" }, 400);
    }
    const updated = await deps.prisma.hermesCommand.updateMany({
      where: { id: c.req.param("id"), status: "delivered" },
      data: {
        status: body.ok ? "done" : "failed",
        result: body.detail ?? null,
        payload: "{}", // discard the plaintext bot token
        doneAt: new Date(),
      },
    });
    if (updated.count === 0) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });
}
