---
name: add-webhook
description: Add a bidirectional HTTP webhook channel. Enables external integrations to send and receive messages via HTTP POST without any third-party dependencies.
---

# Add Webhook Channel

This skill adds a generic bidirectional HTTP webhook to NanoClaw. External systems can push messages in via `POST /v1/inbound` and receive agent replies via `POST /v1/outbound`. Zero npm dependencies — uses Node's built-in `http` module.

## Phase 1: Pre-flight

### Check if already applied

Read `.nanoclaw/state.yaml`. If `webhook` is in `applied_skills`, skip to Phase 3 (Setup). The code changes are already in place.

### Ask the user

1. **Mode**: Replace WhatsApp or add alongside it?
   - Replace → will set `WEBHOOK_ONLY=true`
   - Alongside → both channels active (default)

2. **Auth token**: Do they want bearer token auth? (recommended for production)

3. **Port**: Default is `18794`. Change if needed.

## Phase 2: Apply Code Changes

Run the skills engine to apply this skill's code package. The package files are in this directory alongside this SKILL.md.

### Initialize skills system (if needed)

If `.nanoclaw/` directory doesn't exist yet:

```bash
npx tsx scripts/apply-skill.ts --init
```

### Apply the skill

```bash
npx tsx scripts/apply-skill.ts .claude/skills/add-webhook
```

This deterministically:
- Adds `src/channels/webhook.ts` (WebhookChannel class implementing Channel interface)
- Adds `src/channels/webhook.test.ts` (unit tests)
- Three-way merges webhook support into `src/index.ts` (multi-channel support, findChannel routing)
- Three-way merges webhook config into `src/config.ts` (WEBHOOK_PORT, WEBHOOK_HOST, WEBHOOK_TOKEN, WEBHOOK_CONNECTOR_URL, WEBHOOK_ONLY)
- Three-way merges updated routing tests into `src/routing.test.ts`
- Updates `.env.example` with webhook environment variables
- Records the application in `.nanoclaw/state.yaml`

If the apply reports merge conflicts, read the intent files:
- `modify/src/index.ts.intent.md` — what changed and invariants for index.ts
- `modify/src/config.ts.intent.md` — what changed for config.ts

### Validate code changes

```bash
npm test
npm run build
```

All tests must pass (including the new webhook tests) and build must be clean before proceeding.

## Phase 3: Setup

### Configure environment

Add to `.env`:

```bash
WEBHOOK_PORT=18794
WEBHOOK_HOST=127.0.0.1
WEBHOOK_TOKEN=your-secret-token-here
WEBHOOK_CONNECTOR_URL=http://127.0.0.1:19400/v1/outbound
```

If they chose to replace WhatsApp:

```bash
WEBHOOK_ONLY=true
```

Sync to container environment:

```bash
mkdir -p data/env && cp .env data/env/env
```

### Build and restart

```bash
npm run build
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## Phase 4: Registration

### Register a webhook chat

The webhook channel uses `wh:` prefixed JIDs. Register a chat for inbound messages:

```typescript
registerGroup("wh:default", {
  name: "Webhook",
  folder: "main",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: false,
});
```

For additional webhook endpoints (trigger-only):

```typescript
registerGroup("wh:monitoring", {
  name: "Monitoring Webhook",
  folder: "monitoring",
  trigger: `@${ASSISTANT_NAME}`,
  added_at: new Date().toISOString(),
  requiresTrigger: true,
});
```

## Phase 5: Verify

### Test inbound

```bash
curl -X POST http://127.0.0.1:18794/v1/inbound \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-secret-token-here" \
  -d '{"userId": "default", "content": "Hello from webhook"}'
```

### Test health

```bash
curl http://127.0.0.1:18794/health
# Expected: {"status":"ok","channel":"webhook"}
```

### Check logs if needed

```bash
tail -f logs/nanoclaw.log
```

## Troubleshooting

### Webhook not responding

1. Check `WEBHOOK_PORT` is set in `.env` AND synced to `data/env/env`
2. Check the port isn't already in use: `lsof -i :18794`
3. Service is running: `launchctl list | grep nanoclaw`

### Auth errors

1. Verify `WEBHOOK_TOKEN` matches in `.env` and your client's `Authorization: Bearer <token>` header
2. If token is empty/unset, auth is disabled (all requests accepted)

### Messages not routing

1. Check chat is registered: `sqlite3 store/messages.db "SELECT * FROM registered_groups WHERE jid LIKE 'wh:%'"`
2. For non-main chats: message must include trigger pattern

## HTTP API Reference

### POST /v1/inbound

Receive a message from an external source.

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` (if token configured)

**Body:**
```json
{
  "userId": "user-123",
  "content": "Hello agent",
  "sessionId": "optional-session-id"
}
```

**Response:** `200 OK`
```json
{ "ok": true, "messageId": "..." }
```

### POST /v1/outbound

Forward agent replies to a connector or external system.

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <token>` (if token configured)

**Body:** Platform-specific outbound payload.

**Response:** `200 OK`
```json
{ "ok": true }
```

### GET /health

**Response:** `200 OK`
```json
{ "status": "ok", "channel": "webhook" }
```
