-- Fork: hermes channel. hermes_bot_tokens holds the per-bot sha256 token hash
-- (the plaintext is shown once at issuance and never stored); hermes_turns is
-- the queued-turn table the bot's hermes profile long-polls. runId points at
-- the companion Run(queued) row so threads.send's {taskId, runId, seq}
-- output contract and UI run status stay intact.

CREATE TABLE "hermes_bot_tokens" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "hermes_bot_tokens_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "hermes_turns" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "threadId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "prompt" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "repliedAt" TIMESTAMP(3),

    CONSTRAINT "hermes_turns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "hermes_bot_tokens_botId_key" ON "hermes_bot_tokens"("botId");
CREATE UNIQUE INDEX "hermes_bot_tokens_tokenHash_key" ON "hermes_bot_tokens"("tokenHash");
CREATE INDEX "hermes_bot_tokens_spaceId_idx" ON "hermes_bot_tokens"("spaceId");
CREATE INDEX "hermes_turns_botId_status_createdAt_idx" ON "hermes_turns"("botId", "status", "createdAt");

ALTER TABLE "hermes_bot_tokens" ADD CONSTRAINT "hermes_bot_tokens_botId_fkey" FOREIGN KEY ("botId") REFERENCES "bots"("id") ON DELETE CASCADE ON UPDATE CASCADE;
