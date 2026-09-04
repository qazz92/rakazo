import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  HERMES_CHANNEL_BASE_PATH,
  mountHermesChannelRoutes,
  sha256Token,
} from "./hermes-channel.js";

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
  prompt: string;
  status: string;
  createdAt: Date;
  deliveredAt: Date | null;
  repliedAt: Date | null;
}

function fakePrisma(rows: { tokens: FakeToken[]; bots: FakeBot[]; turns: FakeTurn[] }) {
  return {
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
        where: { botId: string; status: string };
        orderBy: { createdAt: "asc" | "desc" };
      }) =>
        [...rows.turns]
          .filter((t) => t.botId === where.botId && t.status === where.status)
          .sort((a, b) => {
            const delta = +new Date(a.createdAt) - +new Date(b.createdAt);
            return orderBy.createdAt === "asc" ? delta : -delta;
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
    },
  };
}

function mount(rows: { tokens?: FakeToken[]; bots?: FakeBot[]; turns?: FakeTurn[] } = {}) {
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
  };
  const app = new Hono();
  mountHermesChannelRoutes(app, {
    // Structural fake of the two tables the channel reads.
    prisma: fakePrisma(state) as unknown as PrismaClient,
    events: { notify: vi.fn() } as unknown as ThreadEvents,
  });
  return { app, state };
}

function postTurnsNext(headers: Record<string, string> = {}) {
  return {
    method: "POST",
    headers: { authorization: "Bearer test-token", ...headers },
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
