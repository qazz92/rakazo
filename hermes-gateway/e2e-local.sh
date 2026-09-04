#!/usr/bin/env bash
# e2e-local.sh — local E2E round trip through the rakazo<->hermes channel:
# issue token -> threads.send (routes to the hermes turn queue) -> long-poll
# turn -> reply -> duplicate reply (idempotency) -> thread mirror check.
#
# Requires a running dev api (apps/api listens on :3100) and jq.
#
# Env:
#   API         api base URL (default http://localhost:3100)
#   AUTH        dev session token: the full `better-auth.session_token` cookie
#               value from the web app (including the ".signature" part).
#               Sent as `authorization: Bearer $AUTH`; the api maps it back to
#               the session cookie (apps/api/src/app.ts sessionHeaders).
#   BOT_ID      existing bot. Issuing the hermes token is itself what makes the
#               bot's sends route to the hermes queue (redirectHermesSend keys
#               on a non-revoked hermesBotToken row).
#   SPACE_ID    optional; sent as x-rakazo-space-id when the bot lives in a
#               non-default space.
#   BOT_THREAD  optional expected threadId; checked against the polled turn.
#   REPLY_TEXT  optional reply body (default "e2e 답").
set -euo pipefail

API=${API:-http://localhost:3100}
AUTH=${AUTH:?set AUTH to the dev session token (better-auth.session_token cookie value)}
BOT_ID=${BOT_ID:?set BOT_ID}
REPLY_TEXT=${REPLY_TEXT:-e2e 답}

command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

# oRPC (@orpc/server 1.15) mounts at /rpc with slash-joined procedure paths;
# the wire is {"json": <input>} in and {"json": <output>} out — unwrap .json.
rpc() { # rpc <procedure-path> <json-body>
  curl -sf -m 15 -X POST "$API/rpc/$1" \
    -H "authorization: Bearer $AUTH" \
    -H 'content-type: application/json' \
    ${SPACE_ID:+-H "x-rakazo-space-id: $SPACE_ID"} \
    -d "$(jq -nc --argjson body "$2" '{json: $body}')"
}

# Reruns get fresh nonces: Message(threadId, clientNonce) is unique, so a fixed
# nonce would make the first reply of a later run look like a replay.
NONCE="e2e-$(date +%s)"

echo "== issue hermes token"
TOKEN=$(rpc bots/hermesToken/issue "{\"botId\":\"$BOT_ID\"}" | jq -r '.json.token')
[ -n "$TOKEN" ] && [ "$TOKEN" != null ] || { echo "token issue failed" >&2; exit 1; }
echo "token issued: ${TOKEN:0:8}..."

echo "== send (expect turn queued: taskId/runId/seq)"
SEND=$(rpc threads/send "{\"botId\":\"$BOT_ID\",\"text\":\"hermes e2e\",\"clientNonce\":\"$NONCE-send\"}")
echo "$SEND" | jq -e '.json.taskId' >/dev/null || { echo "send failed: $SEND" >&2; exit 1; }
echo "$SEND" | jq -c '.json'

echo "== long-poll turns/next (server holds up to 25s per request)"
TURN=""
for _ in 1 2; do
  POLL=$(curl -sf -m 35 -X POST "$API/api/v1/hermes/turns/next" \
    -H "authorization: Bearer $TOKEN")
  if [ -n "$(echo "$POLL" | jq -r '.id // empty')" ]; then TURN=$POLL; break; fi
  [ "$(echo "$POLL" | jq -r '.timeout // empty')" = true ] \
    || { echo "unexpected poll response: $POLL" >&2; exit 1; }
  echo "poll timed out, retrying"
done
[ -n "$TURN" ] || { echo "no turn claimed after 2 polls" >&2; exit 1; }
TURN_ID=$(echo "$TURN" | jq -r .id)
THREAD_ID=$(echo "$TURN" | jq -r .threadId)
echo "turn $TURN_ID on thread $THREAD_ID: $(echo "$TURN" | jq -r .prompt)"

if [ -n "${BOT_THREAD:-}" ] && [ "$BOT_THREAD" != "$THREAD_ID" ]; then
  echo "BOT_THREAD ($BOT_THREAD) != turn threadId ($THREAD_ID)" >&2
  exit 1
fi

echo "== reply"
reply() {
  curl -sf -X POST "$API/api/v1/hermes/turns/$TURN_ID/reply" \
    -H "authorization: Bearer $TOKEN" \
    -H 'content-type: application/json' \
    -d "$(jq -nc --arg threadId "$THREAD_ID" --arg text "$REPLY_TEXT" \
      --arg nonce "$NONCE" '{threadId:$threadId,text:$text,clientNonce:$nonce}')"
}
FIRST=$(reply)
echo "$FIRST" | jq -c .
DUP=$(reply | jq -r '.duplicate // false')
[ "$DUP" = true ] && echo "idempotency OK" \
  || { echo "replayed reply was not flagged duplicate" >&2; exit 1; }

echo "== thread mirror (expect '$REPLY_TEXT' as a bot message)"
PAGE=$(rpc threads/messages "{\"botId\":\"$BOT_ID\"}")
FOUND=$(echo "$PAGE" | jq -r --arg t "$REPLY_TEXT" \
  '[.json.messages[] | select(.role == "bot") | .blocks[]? | select(.kind == "text") | .text]
   | any(. == $t)')
[ "$FOUND" = true ] && echo "thread mirror OK" \
  || { echo "reply text missing from thread messages" >&2; exit 1; }
