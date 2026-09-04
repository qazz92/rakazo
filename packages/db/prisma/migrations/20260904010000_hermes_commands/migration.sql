-- Fork: provisioning command channel. The mini's supervisor long-polls
-- commands/next with the deploy token and reports back via commands/:id/result.
-- payload carries the bot token in plain text ONLY while status=queued|delivered;
-- completion overwrites it with '{}' so the plaintext never lingers.

CREATE TABLE "hermes_commands" (
    "id" TEXT NOT NULL,
    "botId" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "result" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "hermes_commands_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "hermes_commands_status_createdAt_idx" ON "hermes_commands"("status", "createdAt");
