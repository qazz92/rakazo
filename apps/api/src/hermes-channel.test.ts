import {
  appendEventInTransaction,
  createThreadMessageInTransaction,
  type PrismaClient,
  type ThreadEvents,
} from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  HERMES_CHANNEL_BASE_PATH,
  mountHermesChannelRoutes,
  sha256Token,
} from "./hermes-channel.js";

// The reply route reuses @rakazo/db's transaction helpers; the mock replaces
// just those two so tests pin the route's orchestration. Seq allocation and
// serialization retry are @rakazo/db's own concern, covered by its tests.
vi.mock("@rakazo/db", () => ({
  appendEventInTransaction: vi.fn(),
  createThreadMessageInTransaction: vi.fn(),
}));

/**
 * The channel is a thin long-poll surface over the hermesBotToken /
 * hermesTurn tables: bearer auth resolves a bot, then the oldest queued
 * turn is claimed atomically. These tests pin that contract with fake
 * prisma rows, following messaging-webhook.test.ts style.
 */
interface FakeToken {
  id: string;
  botId: string;
  spaceId: string;
  tokenHash: string;
  revokedAt: Date | null;
}

interface FakeBot {
  id: string;
  thread: { id: string } | null;
  archivedAt: Date | null;
}

interface FakeTurn {
  id: string;
  botId: string;
  threadId: string;
  runId?: string | null;
  prompt: string;
  status: string;
  createdAt: Date;
  deliveredAt: Date | null;
  repliedAt: Date | null;
}

interface FakeRun {
  id: string;
  status: string;
}

interface FakeMessage {
  id: string;
  threadId?: string;
  clientNonce?: string;
}

function fakePrisma(
  rows: {
    tokens: FakeToken[];
    bots: FakeBot[];
    turns: FakeTurn[];
    runs: FakeRun[];
    messages: FakeMessage[];
  },
) {
  const prisma = {
    hermesBotToken: {
      findFirst: async ({ where }: { where: { tokenHash: string; revokedAt: Date | null } }) =>
        rows.tokens.find(
          (t) => t.tokenHash === where.tokenHash && t.revokedAt === where.revokedAt,
        ) ?? null,
    },
    bot: {
      findFirst: async ({ where }: { where: { id: string; archivedAt: Date | null } }) =>
        rows.bots.find((b) => b.id === where.id && b.archivedAt === where.archivedAt) ?? null,
    },
    hermesTurn: {
      findFirst: async ({
        where,
        orderBy,
      }: {
        where: { id?: string; botId?: string; status?: string };
        orderBy?: { createdAt: "asc" | "desc" };
      }) =>
        rows.turns
          .filter(
            (t) =>
              (where.id === undefined || t.id === where.id) &&
              (where.botId === undefined || t.botId === where.botId) &&
              (where.status === undefined || t.status === where.status),
          )
          .sort((a, b) => {
            const delta = +new Date(a.createdAt) - +new Date(b.createdAt);
            return orderBy?.createdAt === "desc" ? -delta : delta;
          })[0] ?? null,
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: string; status: string };
        data: { status: string; deliveredAt: Date };
      }) => {
        let count = 0;
        for (const t of rows.turns)
          if (t.id === where.id && t.status === where.status) {
            Object.assign(t, data);
            count++;
          }
        return { count };
      },
      findUniqueOrThrow: async ({ where }: { where: { id: string } }) => {
        const turn = rows.turns.find((t) => t.id === where.id);
        if (!turn) throw new Error(`hermesTurn ${where.id} not found`);
        return turn;
      },
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const turn = rows.turns.find((t) => t.id === where.id);
        if (turn) Object.assign(turn, data);
        return turn;
      },
    },
    run: {
      update: async ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const run = rows.runs.find((r) => r.id === where.id);
        if (run) Object.assign(run, data);
        return run;
      },
    },
    message: {
      findFirst: async ({ where }: { where: { threadId: string; clientNonce: string } }) =>
        rows.messages.find(
          (m) => m.threadId === where.threadId && m.clientNonce === where.clientNonce,
        ) ?? null,
    },
    $transaction: async (fn: (tx: unknown) => unknown) => fn(prisma),
  };
  return prisma;
}

function mount(
  rows: {
    tokens?: FakeToken[];
    bots?: FakeBot[];
    turns?: FakeTurn[];
    runs?: FakeRun[];
    messages?: FakeMessage[];
  } = {},
) {
  const state = {
    tokens: rows.tokens ?? [
      {
        id: "tok1",
        botId: "bot_1",
        spaceId: "space_1",
        tokenHash: sha256Token("test-token"),
        revokedAt: null,
      },
    ],
    bots: rows.bots ?? [{ id: "bot_1", thread: { id: "thread_1" }, archivedAt: null }],
    turns: rows.turns ?? [],
    runs: rows.runs ?? [],
    messages: rows.messages ?? [],
  };
  const notify = vi.fn(async () => {});
  const app = new Hono();
  mountHermesChannelRoutes(app, {
    // Structural fake of the tables the channel reads.
    prisma: fakePrisma(state) as unknown as PrismaClient,
    events: { notify } as unknown as ThreadEvents,
  });
  return { app, state, notify };
}

function postTurnsNext(headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer test-token", ...headers },
  };
}

function postReply(body: unknown, headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  };
}


describe("hermes channel POST /turns/next", () => {
  it("401s without a valid bearer token", async () => {
    const { app } = mount();
    const res = await app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/next`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: "Unauthorized" });

    const unknown = await app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/next`, postTurnsNext({
      authorization: "Bearer not-a-real-token",
    }));
    expect(unknown.status).toBe(401);
  });

  it("claims the oldest queued turn exactly once and marks it delivered", async () => {
    const turns: FakeTurn[] = [
      { id: "t2", botId: "bot_1", threadId: "thread_1", prompt: "later", status: "queued", createdAt: new Date("2026-09-04T02:00:00Z"), deliveredAt: null, repliedAt: null },
      { id: "t1", botId: "bot_1", threadId: "thread_1", prompt: "first", status: "queued", createdAt: new Date("2026-09-04T01:00:00Z"), deliveredAt: null, repliedAt: null },
    ];
    const { app } = mount({ turns });
    const res = await app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/next`, postTurnsNext());

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      id: "t1",
      threadId: "thread_1",
      prompt: "first",
    });
    expect(turns.find((t) => t.id === "t1")!.status).toBe("delivered");
    expect(turns.find((t) => t.id === "t1")!.deliveredAt).toBeInstanceOf(Date);
    // The newer turn stays queued for the next poll.
    expect(turns.find((t) => t.id === "t2")!.status).toBe("queued");
  });

  it("returns timeout after the poll window with no queued turn", async () => {
    vi.useFakeTimers();
    try {
      const { app } = mount();
      const promise = app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/next`, postTurnsNext());
      await vi.advanceTimersByTimeAsync(25_500);
      const res = await promise;
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ timeout: true });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("hermes channel POST /turns/:turnId/reply", () => {
  const createMessage = vi.mocked(createThreadMessageInTransaction);
  const appendEvent = vi.mocked(appendEventInTransaction);

  function stubHelpers(
    messages: Array<Record<string, unknown>>,
    events: Array<Record<string, unknown>>,
  ) {
    createMessage.mockReset();
    appendEvent.mockReset();
    createMessage.mockImplementation(async (_tx, input) => {
      const message = { id: `m${messages.length}`, ...input };
      messages.push(message);
      return message as never;
    });
    appendEvent.mockImplementation(async (_tx, input) => {
      events.push(input);
      return { seq: events.length } as never;
    });
  }

  it("appends an assistant message, emits thread event, marks turn replied, notifies", async () => {
    const turns: FakeTurn[] = [
      {
        id: "t1",
        botId: "bot_1",
        threadId: "thread_1",
        runId: "run_1",
        prompt: "q",
        status: "delivered",
        createdAt: new Date("2026-09-04T01:00:00Z"),
        deliveredAt: new Date("2026-09-04T01:00:05Z"),
        repliedAt: null,
      },
    ];
    const runs: FakeRun[] = [{ id: "run_1", status: "queued" }];
    const messages: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    stubHelpers(messages, events);
    const { app, notify } = mount({ turns, runs, messages });

    const res = await app.request(
      `${HERMES_CHANNEL_BASE_PATH}/turns/t1/reply`,
      postReply({ threadId: "thread_1", text: "hermes 답", clientNonce: "n1" }),
    );

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ ok: true, messageId: "m0" });
    expect(messages[0]).toMatchObject({
      threadId: "thread_1",
      role: "bot",
      clientNonce: "n1",
      blocks: [{ kind: "text", text: "hermes 답" }],
    });
    expect(turns[0]!.status).toBe("replied");
    expect(turns[0]!.repliedAt).toBeInstanceOf(Date);
    expect(runs[0]!.status).toBe("completed");
    expect(events[0]).toMatchObject({
      spaceId: "space_1",
      threadId: "thread_1",
      botId: "bot_1",
      type: "thread.message.created",
      runId: "run_1",
      payload: { messageId: "m0", role: "bot", blocks: [{ kind: "text", text: "hermes 답" }] },
    });
    expect(notify).toHaveBeenCalledWith("thread_1", 1);
  });

  it("ad-hoc replies append an event without a run; nonce replays are duplicates", async () => {
    const messages: Array<Record<string, unknown>> = [];
    const events: Array<Record<string, unknown>> = [];
    stubHelpers(messages, events);
    const { app, notify } = mount({ messages });
    const body = { threadId: "thread_1", text: "cron 선발화", clientNonce: "n1" };

    const first = await app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/ad-hoc/reply`, postReply(body));
    expect(first.status).toBe(200);
    await expect(first.json()).resolves.toEqual({ ok: true, messageId: "m0" });
    expect(events[0]).toMatchObject({ type: "thread.message.created", threadId: "thread_1" });
    expect(events[0]!.runId).toBeUndefined();
    expect(notify).toHaveBeenCalledWith("thread_1", 1);

    const replay = await app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/ad-hoc/reply`, postReply(body));
    expect(replay.status).toBe(200);
    await expect(replay.json()).resolves.toEqual({ ok: true, messageId: "m0", duplicate: true });
    expect(messages).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("401s when the token's bot does not own threadId; 400s on bad input", async () => {
    createMessage.mockReset();
    appendEvent.mockReset();
    const { app } = mount();

    const other = await app.request(
      `${HERMES_CHANNEL_BASE_PATH}/turns/ad-hoc/reply`,
      postReply({ threadId: "thread_OTHER", text: "x", clientNonce: "n" }),
    );
    expect(other.status).toBe(401);
    await expect(other.json()).resolves.toEqual({ error: "This token is not for that thread" });

    const blank = await app.request(
      `${HERMES_CHANNEL_BASE_PATH}/turns/ad-hoc/reply`,
      postReply({ threadId: "thread_1", text: "   ", clientNonce: "n" }),
    );
    expect(blank.status).toBe(400);
    await expect(blank.json()).resolves.toEqual({ error: "threadId, text, and clientNonce are required" });

    const invalid = await app.request(`${HERMES_CHANNEL_BASE_PATH}/turns/ad-hoc/reply`, {
      method: "POST",
      headers: { authorization: "Bearer test-token", "content-type": "application/json" },
      body: "{not json",
    });
    expect(invalid.status).toBe(400);

    expect(createMessage).not.toHaveBeenCalled();
  });
});
