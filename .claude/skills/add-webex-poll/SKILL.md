---
name: add-webex-poll
description: Add Webex channel integration via REST polling (no public webhook URL required).
---

# Add Webex (Polling) Channel

Adds Cisco Webex support via REST polling — no webhook, no public URL. Suitable
for enterprise installs behind firewalls or NAT where the webhook-based
`/add-webex` adapter can't receive inbound events.

The adapter polls `/v1/rooms?sortBy=lastactivity` every 5 s, skips rooms whose
`lastActivity` hasn't changed, then fetches recent messages for changed rooms
and routes them. Mention detection reads the `mentionedPeople` array from the
REST response — no webhook subscription needed.

**Trade-offs vs the webhook adapter (`/add-webex`):**

| | `webex-poll` (this skill) | `webex` (webhook) |
|---|---|---|
| Public URL required | **No** | Yes |
| Latency | ~5 s | Instant |
| Thread support | No | Yes |
| Mention-sticky wiring | No | Yes |

Uses Node's built-in `fetch` — no new npm dependency. Both adapters can
coexist; channel type `webex-poll` is distinct from `webex`.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Webex polling
adapter from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/webex-poll.ts` exists
- `src/channels/index.ts` contains `import './webex-poll.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and registration test

```bash
git show origin/channels:src/channels/webex-poll.ts > src/channels/webex-poll.ts
git show origin/channels:src/channels/webex-poll-registration.test.ts > src/channels/webex-poll-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './webex-poll.js';
```

### 4. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/webex-poll-registration.test.ts
```

`webex-poll-registration.test.ts` imports the real channel barrel and asserts
the registry contains `webex-poll`. It goes red if the import line is deleted
or drifts. End-to-end delivery against a real Webex space is verified manually
once the service runs.

## Credentials

### Create the Webex bot

1. Go to [developer.webex.com](https://developer.webex.com/my-apps/new/bot) and
   create a new bot.
2. Copy the **Bot Access Token** — it is shown once at creation. If lost,
   regenerate it from the bot's page; regenerating invalidates the old token.

### Configure environment

```bash
WEBEX_BOT_TOKEN=your-bot-access-token
```

No webhook secret is needed — the polling adapter makes outbound calls only;
Webex never calls back.

### Confirm the token works

```bash
curl -sf https://webexapis.com/v1/people/me \
  -H "Authorization: Bearer $WEBEX_BOT_TOKEN" | jq -er '.displayName + " (" + .id + ")"'
```

A failure here means the token is wrong or expired.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now. Otherwise
run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `webex-poll`
- **terminology**: Webex has "spaces." A space can be a group conversation or a 1:1 direct message with the bot.
- **platform-id-format**: `webex-poll:{roomId}` (e.g. `webex-poll:Y2lzY29zcGFyazovL...`)
- **how-to-find-id**: Open the space in Webex, click the space name > Settings — the Space ID is listed there. Or call `GET https://webexapis.com/v1/rooms` with the bot token. The adapter prefixes room IDs with `webex-poll:` internally.
- **supports-threads**: no
- **typical-use**: Enterprise installs that can't expose a public webhook URL — corporate firewalls, VPN-only networks, local dev.
- **default-isolation**: Same agent group for spaces where you're the primary user. Separate agent group for spaces with different teams or sensitive information.

## Troubleshooting

**Sends fail with 401.** The Bot Access Token is shown once at creation on the
bot's page at developer.webex.com — it is *not* the 12-hour personal access
token from the API docs pages (that one works briefly, then everything 401s).
Regenerate the token on the bot page if needed; update `WEBEX_BOT_TOKEN` right
away as regenerating invalidates the old value.

**Messages in a space never reach the agent.** The bot must be added as a
member of the space. The polling adapter fetches `/v1/rooms` which only lists
spaces the bot is a member of — spaces it isn't in are invisible to the poll.
Check `logs/nanoclaw.log` for `webex-poll adapter ready` on startup and
`webex-poll: poll error` for repeated failures.

**Bot sees its own messages.** The adapter filters by `personId` fetched at
startup via `GET /v1/people/me`. If that fetch fails, no filter is applied and
the bot's own responses get re-routed. The startup log prints `botPersonId` on
success; if it's absent, check the bot token.

**Rate limit errors.** The adapter retries with exponential backoff on 429
responses, reading the `Retry-After` header as the base delay and doubling on
each successive retry (up to 4 attempts). Sustained rate limiting is logged as
`webex-poll: rate limited` in `logs/nanoclaw.log`. If it persists, reduce the
poll frequency by increasing `POLL_INTERVAL_MS` in `src/channels/webex-poll.ts`
and rebuilding.
