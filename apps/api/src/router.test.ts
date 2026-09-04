import { createHash } from "node:crypto";
import { RPCHandler } from "@orpc/server/fetch";
import { COMPUTER_SCREEN_UNAVAILABLE, ComputerScreenUnavailableError } from "@rakazo/adapters";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { createRouter, type RouterDeps } from "./router.js";

describe("account preferences", () => {
  function preferencesDeps(avatarStyle: string) {
    const update = vi.fn().mockResolvedValue({});
    const prisma = {
      user: {
        update,
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle,
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { update, deps, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  it("persists and returns the selected avatar style", async () => {
    const { update, actor, handler } = preferencesDeps("organic");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "organic" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    expect(update).toHaveBeenCalledWith({
      where: { id: "user-1" },
      data: { avatarStyle: "organic" },
    });
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "organic" }),
    });
  });

  it("rejects avatar styles outside robot|organic", async () => {
    const { update, actor, handler } = preferencesDeps("robot");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/preferences/update", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { avatarStyle: "dicebear" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(update).not.toHaveBeenCalled();
  });

  it("coerces unknown stored avatar styles to robot on me", async () => {
    const { actor, handler } = preferencesDeps("custom-cdn");

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/me", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ avatarStyle: "robot" }),
    });
  });
});

describe("model setup gate", () => {
  function modelGateDeps(options: {
    agentRuntime: string;
    deploymentModelKey?: string;
    deploymentModelCredentialCipher?: string;
  }) {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
      hermesBotToken: { findFirst: vi.fn().mockResolvedValue(null) },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: {
        findUnique: vi
          .fn()
          .mockResolvedValue(
            options.deploymentModelCredentialCipher
              ? { deploymentModelCredentialCipher: options.deploymentModelCredentialCipher }
              : null,
          ),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        agentRuntime: options.agentRuntime,
        defaultProvider: "openrouter",
        defaultModel: "test-model",
        deploymentModelKey: options.deploymentModelKey,
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { actor, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return response;
  }

  it("refuses to start a run when no model is configured", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "pi" });

    const response = await call(handler, actor, "threads/send", {
      botId: "bot-1",
      text: "hello",
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Connect a model to start a run.",
      }),
    });
  });

  it("does not require a model credential for the scripted test runtime", async () => {
    const { actor, handler } = modelGateDeps({ agentRuntime: "scripted" });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("accepts a deployment model key as model configuration", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelKey: "fake-deployment-key",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: false }),
    });
  });

  it("does not accept a stored deployment cipher the executor cannot use", async () => {
    const { actor, handler } = modelGateDeps({
      agentRuntime: "pi",
      deploymentModelCredentialCipher: "legacy-ciphertext",
    });

    const response = await call(handler, actor, "me", null);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({ needsModel: true }),
    });
  });
});

describe("thread answer delivery", () => {
  it("accepts a durable answer when the immediate worker wake fails", async () => {
    const answerRunInput = vi.fn().mockResolvedValue(true);
    const enqueue = vi.fn().mockRejectedValue(new Error("job broker unavailable"));
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: null,
        }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { answerRunInput },
      jobs: { enqueue },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/threads/answer", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            botId: "bot-1",
            runId: "run-1",
            messageId: "message-1",
            answer: "Paris",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(answerRunInput).toHaveBeenCalledWith(
      expect.objectContaining({
        spaceId: "workspace-1",
        threadId: "thread-1",
        runId: "run-1",
      }),
    );
    expect(enqueue).toHaveBeenCalledOnce();
    expect(logError).toHaveBeenCalledWith("thread answer enqueue", expect.any(Error));
    logError.mockRestore();
  });
});

describe("MCP server deletion", () => {
  it("does not fail when a concurrent credential rotation already removed the old secret", async () => {
    const deleteServer = vi.fn().mockResolvedValue({ id: "server-1" });
    const deleteSecrets = vi.fn().mockResolvedValue({ count: 0 });
    const prisma = {
      mcpServer: {
        findFirst: vi.fn().mockResolvedValue({ id: "server-1", secretId: "old-secret" }),
        delete: deleteServer,
      },
      secret: { deleteMany: deleteSecrets },
      $transaction: vi.fn((operations: Promise<unknown>[]) => Promise.all(operations)),
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/mcp/servers/remove", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { id: "server-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { ok: true } });
    expect(deleteServer).toHaveBeenCalledWith({ where: { id: "server-1" } });
    expect(deleteSecrets).toHaveBeenCalledWith({
      where: {
        id: "old-secret",
        spaceId: "workspace-1",
        userId: "user-1",
      },
    });
  });
});

describe("connections.complete", () => {
  it("forwards an optional code to the managed connector", async () => {
    const complete = vi.fn().mockResolvedValue({ connectionRef: "gmail" });
    const connectionReady = vi.fn().mockResolvedValue(true);
    const update = vi.fn().mockResolvedValue({
      id: "conn-1",
      connectorId: "composio",
      provider: "gmail",
      displayName: "Gmail",
      status: "connected",
      createdAt: new Date("2026-08-26T00:00:00.000Z"),
    });
    const prisma = {
      connection: {
        findFirst: vi.fn().mockResolvedValue({
          id: "conn-1",
          connectorId: "composio",
          provider: "gmail",
          displayName: "Gmail",
          providerRef: "gmail-state",
          status: "pending",
          createdAt: new Date("2026-08-26T00:00:00.000Z"),
        }),
        update,
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      connectors: {
        managed: vi.fn(() => ({ complete, connectionReady })),
      },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    const handler = new RPCHandler(createRouter(deps));

    const { matched, response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/connections/complete", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          json: {
            connectionId: "conn-1",
            code: "123456",
          },
        }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(matched).toBe(true);
    expect(response.status).toBe(200);
    expect(complete).toHaveBeenCalledWith(
      { state: "gmail-state", code: "123456" },
      expect.objectContaining({ spaceId: "workspace-1", userId: "user-1" }),
    );
    expect(connectionReady).toHaveBeenCalled();
  });
});

describe("updater owner gate", () => {
  function updaterDeps() {
    const prisma = {
      user: {
        findUniqueOrThrow: vi.fn().mockResolvedValue({
          email: "user@rakazo.test",
          name: "Test User",
          avatarStyle: "robot",
        }),
      },
      spaceModelPreference: { findFirst: vi.fn().mockResolvedValue(null) },
      deploymentSettings: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
        gitSha: "deadbeef",
        updaterUrl: undefined,
        updaterToken: undefined,
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    return { deps, handler: new RPCHandler(createRouter(deps)) };
  }

  it("forbids non-owners from updater status", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-2",
      email: "member@rakazo.test",
      isDeploymentOwner: false,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(403);
  });

  it("lets the deployment owner read status without applying git", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/status", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: null }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.json.supported).toBe(false);
    expect(["source", "compose"]).toContain(body.json.installKind);
    expect(Array.isArray(body.json.manualCommands)).toBe(true);
  });

  it("refuses apply when the sidecar is not configured", async () => {
    const { handler } = updaterDeps();
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "owner@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;

    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/updater/apply", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: {} }),
      }),
      { prefix: "/rpc", context: { actor } },
    );

    expect(response.status).toBeGreaterThanOrEqual(400);
    const body = await response.json();
    const message = JSON.stringify(body);
    expect(message).toMatch(/sidecar/i);
    expect(message).not.toMatch(/git (fetch|merge|pull)/i);
  });
});

describe("computer screen url", () => {
  const actor = {
    spaceId: "workspace-1",
    userId: "user-1",
    email: "user@rakazo.test",
    isDeploymentOwner: true,
  } satisfies Actor;
  const computerRow = {
    id: "computer-1",
    kind: "e2b",
    scope: "team",
    state: "running",
    providerRef: "sandbox-ref-1",
    homeKey: "home-1",
    controlHolder: "none",
    controlLeaseId: null,
    controlLeaseExpiresAt: null,
    controlBotId: null,
    controlRunId: null,
  };

  const callScreenUrl = async (connectScreen: () => Promise<unknown>, updateMany = vi.fn()) => {
    const prisma = {
      bot: {
        findFirst: vi.fn().mockResolvedValue({
          id: "bot-1",
          thread: { id: "thread-1" },
          computer: computerRow,
        }),
      },
      computer: { updateMany },
      computerExecutionLease: { findUnique: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      sandbox: { connectScreen },
      jobs: { enqueue: vi.fn().mockResolvedValue(undefined) },
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "e2b",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const handler = new RPCHandler(createRouter(deps));
    const { response } = await handler.handle(
      new Request("http://127.0.0.1/rpc/computer/screenUrl", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: { botId: "bot-1" } }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { response, updateMany };
  };

  it("clears the row instead of 500ing when the provider says the sandbox is gone", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(
        Object.assign(new Error("Sandbox is probably not running anymore"), {
          name: "SandboxNotFoundError",
        }),
      ),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ json: { url: null } });
    expect(updateMany).toHaveBeenCalledWith({
      where: { id: "computer-1", providerRef: "sandbox-ref-1" },
      data: { state: "stopped", providerRef: null },
    });
    logError.mockRestore();
  });

  it("keeps a transport blip an error and leaves the row alone", async () => {
    const logError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(Object.assign(new Error("fetch failed"), { code: "ECONNRESET" })),
    );
    expect(response.status).toBe(500);
    expect(updateMany).not.toHaveBeenCalled();
    logError.mockRestore();
  });

  it("returns a recoverable conflict when the screen is temporarily busy", async () => {
    const { response, updateMany } = await callScreenUrl(() =>
      Promise.reject(new ComputerScreenUnavailableError()),
    );
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      json: expect.objectContaining({
        code: "CONFLICT",
        message: COMPUTER_SCREEN_UNAVAILABLE,
      }),
    });
    expect(updateMany).not.toHaveBeenCalled();
  });
});

describe("bots.hermesToken", () => {
  function hermesTokenDeps(bot: unknown) {
    const rows: Array<Record<string, unknown>> = [];
    const prisma = {
      bot: { findFirst: async () => bot },
      hermesBotToken: {
        upsert: async ({
          where,
          update,
          create,
        }: {
          where: { botId: string };
          update: Record<string, unknown>;
          create: Record<string, unknown>;
        }) => {
          const existing = rows.find((row) => row.botId === where.botId);
          if (existing) return Object.assign(existing, update);
          const row = { ...create };
          rows.push(row);
          return row;
        },
        updateMany: async ({ data }: { data: Record<string, unknown> }) => {
          let count = 0;
          for (const row of rows) {
            if (row.revokedAt == null) {
              Object.assign(row, data);
              count += 1;
            }
          }
          return { count };
        },
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      env: {
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { rows, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response.status, json: await response.json() };
  }

  it("issues a token, stores only its hash, and rotates on re-issue", async () => {
    const { rows, actor, handler } = hermesTokenDeps({
      id: "bot_1",
      spaceId: "workspace-1",
      threadId: "thread_1",
    });

    const first = await call(handler, actor, "bots/hermesToken/issue", { botId: "bot_1" });
    expect(first.status).toBe(200);
    expect(first.json.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url

    const second = await call(handler, actor, "bots/hermesToken/issue", { botId: "bot_1" });
    expect(second.json.json.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second.json.json.token).not.toBe(first.json.json.token);

    // botId is unique in the schema: rotation replaces the hash on the single row.
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(
      createHash("sha256").update(second.json.json.token).digest("hex"),
    );
    expect(rows[0].revokedAt).toBeNull();
    expect(JSON.stringify(rows)).not.toContain(first.json.json.token);
    expect(JSON.stringify(rows)).not.toContain(second.json.json.token);
  });

  it("rejects issue for a bot outside the actor space", async () => {
    const { rows, actor, handler } = hermesTokenDeps(null);

    const response = await call(handler, actor, "bots/hermesToken/issue", { botId: "other" });

    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(rows).toHaveLength(0);
  });

  it("revokes the active token and refuses when none is active", async () => {
    const { rows, actor, handler } = hermesTokenDeps({
      id: "bot_1",
      spaceId: "workspace-1",
      threadId: "thread_1",
    });
    await call(handler, actor, "bots/hermesToken/issue", { botId: "bot_1" });

    const revoked = await call(handler, actor, "bots/hermesToken/revoke", { botId: "bot_1" });
    expect(revoked.status).toBe(200);
    expect(revoked.json.json).toEqual({ ok: true });
    expect(rows[0].revokedAt).toBeInstanceOf(Date);

    const repeat = await call(handler, actor, "bots/hermesToken/revoke", { botId: "bot_1" });
    expect(repeat.status).toBeGreaterThanOrEqual(400);
  });
});

describe("threads.send group hermes guard", () => {
  function groupSendDeps(hermesBotId: string | null) {
    const turns: Array<Record<string, unknown>> = [];
    const enqueued: unknown[] = [];
    let counter = 0;
    const nextId = (prefix: string) => `${prefix}_${(counter += 1)}`;
    const members = [
      { botId: hermesBotId ?? "bot_local_a", bot: { id: hermesBotId ?? "bot_local_a", name: "A", color: "#111111", runs: [] } },
      { botId: "bot_local_b", bot: { id: "bot_local_b", name: "B", color: "#222222", runs: [] } },
    ];
    const prisma = {
      $transaction: (callback: (client: unknown) => unknown) => callback(prisma),
      $queryRaw: async () => [{ id: "group_1" }],
      chatGroup: {
        findFirst: async () => ({
          id: "group_1",
          name: "Team",
          thread: { id: "thread_1" },
          members,
        }),
        update: async () => ({}),
      },
      spaceModelPreference: { findFirst: async () => null },
      deploymentSettings: { findUnique: async () => null },
      hermesBotToken: {
        findFirst: async ({ where }: { where: { botId: string } }) =>
          where.botId === hermesBotId ? { id: "token_1", botId: where.botId } : null,
      },
      hermesTurn: {
        create: async ({ data }: { data: Record<string, unknown> }) => {
          turns.push(data);
          return data;
        },
      },
      thread: {
        update: async ({ data }: { data: Record<string, unknown> }) => {
          if ("nextMessageSeq" in data) return { nextMessageSeq: 1 };
          return { nextEventSeq: 1 };
        },
      },
      message: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: nextId("message"), ...data }),
        update: async ({ where }: { where: { id: string } }) => ({ id: where.id }),
      },
      task: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: nextId("task"), ...data }),
      },
      run: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: nextId("run"), ...data }),
        findFirst: async () => null,
        findMany: async () => [],
        findUnique: async () => ({ id: "run_x", status: "queued", startedAt: null }),
        updateMany: async () => ({ count: 0 }),
      },
      event: {
        create: async ({ data }: { data: Record<string, unknown> }) => ({ id: nextId("event"), ...data }),
      },
    } as unknown as PrismaClient;
    const deps = {
      prisma,
      events: { notify: async () => undefined },
      jobs: { enqueue: async (job: unknown) => void enqueued.push(job) },
      env: {
        agentRuntime: "scripted",
        defaultProvider: "fake",
        defaultModel: "fake-model",
        webOrigin: "http://127.0.0.1:5173",
        screenProxySecret: "fake-test-secret",
        sandboxProvider: "fake",
      },
      dataDir: "/tmp/rakazo-router-test",
    } as unknown as RouterDeps;
    const actor = {
      spaceId: "workspace-1",
      userId: "user-1",
      email: "user@rakazo.test",
      isDeploymentOwner: true,
    } satisfies Actor;
    return { turns, enqueued, actor, handler: new RPCHandler(createRouter(deps)) };
  }

  async function call(handler: RPCHandler<never>, actor: Actor, path: string, body: unknown) {
    const { response } = await handler.handle(
      new Request(`http://127.0.0.1/rpc/${path}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ json: body }),
      }),
      { prefix: "/rpc", context: { actor } },
    );
    return { status: response.status, json: await response.json() };
  }

  it("rejects a group send when any member is a hermes bot", async () => {
    const { turns, actor, handler } = groupSendDeps("bot_hermes");

    const response = await call(handler, actor, "threads/send", {
      groupId: "group_1",
      text: "hello team",
    });

    expect(response.status).toBe(400);
    expect(response.json).toEqual({
      json: expect.objectContaining({
        code: "BAD_REQUEST",
        message: "Team bots coordinate through their PM — send requests to a single bot's thread.",
      }),
    });
    expect(turns).toHaveLength(0);
  });

  it("keeps local-only groups on the fan-out path", async () => {
    const { turns, enqueued, actor, handler } = groupSendDeps(null);

    const response = await call(handler, actor, "threads/send", {
      groupId: "group_1",
      text: "@everyone status check",
    });

    expect(response.status).toBe(200);
    expect(turns).toHaveLength(0);
    // Both local members fan out: one run.continue job per member bot.
    expect(enqueued).toHaveLength(2);
  });
});
