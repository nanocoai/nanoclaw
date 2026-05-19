---
name: add-wechat
description: Add WeChat (personal) channel integration via Tencent's official iLink Bot API. Uses long-polling and QR scan — no webhook, no ToS risk, no paid token.
---

# Add WeChat Channel

Adds WeChat support via **iLink Bot API** — the first-party Tencent API for personal WeChat bots (different from WeCom / Official Account).

**Why this is different from wechaty/PadLocal:**

- Official Tencent API — no ToS violation, no ban risk
- Free — no PadLocal token required
- No public webhook URL needed — uses long-poll
- Works with any personal WeChat account

## Prerequisites

- A **personal WeChat account** with the mobile app installed
- A phone to scan the QR code for login
- Node.js >= 20 (already required by NanoClaw)

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the WeChat adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/wechat.ts` exists
- `src/channels/index.ts` contains `import './wechat.js';`
- `wechat-ilink-client` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/wechat.ts > src/channels/wechat.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './wechat.js';
```

### 4. Install the library (pinned)

```bash
pnpm install wechat-ilink-client@0.1.0
```

### 5. Build

```bash
pnpm run build
```

## Credentials

Unlike most channels, WeChat requires **no pre-configured API keys**. Auth happens via QR code scan from your phone.

### 1. Enable the channel

Add to `.env`:

```bash
WECHAT_ENABLED=true
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### 2. Start the service and scan the QR

Restart NanoClaw.

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh
systemctl --user restart $(systemd_unit)              # Linux
# or
launchctl kickstart -k gui/$(id -u)/$(launchd_label)  # macOS
```

The adapter will print a **QR URL** to the logs and save it to `data/wechat/qr.txt`:

```bash
tail -f logs/nanoclaw.log | grep WeChat
# or
cat data/wechat/qr.txt
```

Open the URL in a browser (it renders a QR code), then:

1. Open WeChat on your phone
2. Use its built-in QR scanner (top-right "+" → Scan)
3. Approve the authorization on your phone
4. Auth credentials are saved to `data/wechat/auth.json` — do not commit this file

The bot is now connected as your WeChat account.

## Wire your first DM

A successful QR login alone isn't enough — the adapter still needs to be wired to an agent group before it can respond.

### 1. Trigger the first inbound message

Have a different WeChat account send a message to the bot account. This auto-creates a `messaging_groups` row with the sender's `platform_id`.

### 2. Run the wire script

```bash
pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts
```

Interactive flow: the script lists all unwired WeChat messaging groups, asks which agent group to wire it to, and creates the `messaging_group_agents` row with sensible defaults (sender policy `request_approval`, session mode `shared`).

With `request_approval`, the next DM from the stranger fires an approval card to the admin — admin taps Approve/Deny, approved users are added as members and their queued message replays through the agent.

Non-interactive:

```bash
pnpm exec tsx .claude/skills/add-wechat/scripts/wire-dm.ts \
  --platform-id wechat:wxid_xxxxx \
  --agent-group ag-xxxxx \
  --non-interactive
```

Flags:

- `--platform-id <id>` — wire a specific messaging group (default: most recent unwired)
- `--agent-group <id>` — target agent group (default: prompt; or solo admin group in non-interactive)
- `--sender-policy public|strict|request_approval` — default `request_approval` (fires an admin approval card on unknown-sender DMs)
- `--session-mode shared|per-thread` — default `shared`

### 3. Test

Have the sender message the bot again — the agent should respond.

## Operational notes

- **Only one instance can use a given token at a time.** Don't run multiple NanoClaw instances pointing to the same `data/wechat/auth.json`.
- **Re-login on session expiry:** if you see `WeChat: session expired` in logs, delete `data/wechat/auth.json` and restart — you'll be asked to re-scan.
- **Sync cursor persistence:** `data/wechat/sync-buf.txt` holds the long-poll cursor. Deleting it replays recent history on next start; don't delete it in normal operation.
- **Account safety:** this uses the official Tencent API, so account bans for bot automation aren't a risk. That said, don't spam — normal rate limits still apply.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, restart the service to pick up the new channel and wiring.

## Channel Info

- **type**: `wechat`
- **terminology**: WeChat has "contacts" (DMs) and "group chats" (rooms). Each DM or group is a separate messaging group.
- **how-to-find-id**: Send a message to the bot from the target account; the adapter auto-creates a messaging group and logs `WeChat inbound platformId=wechat:<id>`. Use `wechat:<user_id>` for DMs, `wechat:<group_id>` for rooms.
- **admin-user-id**: The operator's WeChat user_id (for `init-first-agent.ts --admin-user-id`) is saved to `data/wechat/auth.json` as `operatorUserId` after the QR scan. Read it with `cat data/wechat/auth.json | jq -r .operatorUserId` and prefix with `wechat:` (i.e. `wechat:<operatorUserId>`).
- **supports-threads**: no (WeChat has no reply threads)
- **typical-use**: Long-poll — the adapter holds a persistent connection to Tencent's iLink API and receives messages in real time. No webhook URL needed.
- **default-isolation**: `shared` session mode per messaging group (DM or room). Use `strict` sender policy if you want only specific users to reach the agent; `public` opens it to anyone who messages the bot.
- **post-install-wiring**: Use the `wire-dm.ts` helper (see the "Wire your first DM" section above) if running this skill standalone. If running as part of `bash nanoclaw.sh`, `init-first-agent.ts` handles wiring — just pass the `platform-id` and `admin-user-id` captured above.
