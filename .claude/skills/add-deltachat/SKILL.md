---
name: add-deltachat
description: Add DeltaChat channel integration via @deltachat/stdio-rpc-server. Native adapter — no Chat SDK bridge. Email-based messaging with end-to-end encryption.
---

# Add DeltaChat Channel

The adapter drives the `@deltachat/stdio-rpc-server` JSON-RPC subprocess directly — pure Node.js against the DeltaChat core library. Messages are delivered over email with Autocrypt/OpenPGP encryption.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/deltachat.ts` exists
- `src/channels/index.ts` contains `import './deltachat.js';`
- `@deltachat/stdio-rpc-server` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/deltachat.ts > src/channels/deltachat.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if already present):

```typescript
import './deltachat.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @deltachat/stdio-rpc-server@2.49.0
```

### 5. Build

```bash
pnpm run build
```

## Account Setup

A dedicated email account is strongly recommended — it will accumulate DeltaChat-formatted messages and store encryption keys. Not all providers work well with DeltaChat; check https://providers.delta.chat/ before picking one.

**Default security modes:** IMAP uses SSL/TLS (port 993), SMTP uses STARTTLS (port 587). Both are configurable via `.env` — see Credentials below.

To find the correct hostnames for a domain:

```bash
node -e "require('dns').resolveMx('example.com', (e,r) => console.log(r))"
```

Most providers publish their IMAP/SMTP hostnames in their help docs under "manual setup" or "IMAP access."

## Credentials

Add to `.env`:

```bash
DC_EMAIL=bot@example.com
DC_PASSWORD=your-app-password
DC_IMAP_HOST=imap.example.com
DC_IMAP_PORT=993
DC_IMAP_SECURITY=1        # 1=SSL/TLS (default), 2=STARTTLS, 3=plain
DC_SMTP_HOST=smtp.example.com
DC_SMTP_PORT=587
DC_SMTP_SECURITY=2        # 2=STARTTLS (default), 1=SSL/TLS, 3=plain
```

Security settings are applied on every startup, so changing them in `.env` and restarting takes effect without wiping the account.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Optional settings

The following are read from the process environment (not `.env`). To override them, add `Environment=` lines to the systemd service unit or your launchd plist:

| Variable | Default | Description |
|----------|---------|-------------|
| `DC_ACCOUNT_DIR` | `dc-account` | Directory for DeltaChat account data (IMAP state, keys, blobs) |
| `DC_DISPLAY_NAME` | `NanoClaw` | Bot display name shown in DeltaChat |
| `DC_AVATAR_PATH` | _(none)_ | Absolute path to avatar image; set at startup only |

The `/set-avatar` command (send an image with that caption) is the easiest way to set the avatar at runtime without modifying the service file. Only users with `owner` or global `admin` role can use it.

### Restart

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# Linux
systemctl --user restart $(systemd_unit)

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)
```

On first start the adapter configures the email account (IMAP/SMTP credentials, calls `configure()`). Subsequent starts skip straight to `startIo()`. Account data is stored in `dc-account/` in the project root (or your `DC_ACCOUNT_DIR`).

## Wiring

### DMs

**DeltaChat contacts cannot be added by email alone** — to start a chat, the user must open the bot's invite link in their DeltaChat app or scan its QR code. This triggers the SecureJoin handshake.

#### Step 1 — Get the invite link

After the service starts, the adapter logs the invite URL and writes a QR SVG:

```bash
grep "invite link" logs/nanoclaw.log | tail -1
# url field contains the https://i.delta.chat/... invite link
# also written to dc-account/invite-qr.svg (or $DC_ACCOUNT_DIR/invite-qr.svg)
```

The invite URL is stable (tied to the bot's email and encryption keys) so it stays valid across restarts.

#### Step 2 — Add the bot in DeltaChat

Two options for the user to connect:

- **Link**: Copy the `https://i.delta.chat/...` URL and open it on the device running DeltaChat. The app recognises it and shows a "Start chat" prompt.
- **QR code**: Open `dc-account/invite-qr.svg` in a browser or image viewer, display it on screen, and scan it from the DeltaChat app using the QR-scan button on the new-chat screen.

After accepting, DeltaChat exchanges keys and creates the chat automatically.

#### Step 3 — Wire the chat to an agent

Once the first message arrives the router auto-creates a `messaging_groups` row. Look up the chat ID:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT platform_id, name FROM messaging_groups WHERE channel_type='deltachat' AND is_group=0 ORDER BY created_at DESC LIMIT 5"
```

Then run `/init-first-agent` — it creates the agent group, grants the user owner access, and wires the messaging group in one step:

```bash
pnpm exec tsx scripts/init-first-agent.ts \
  --channel deltachat \
  --user-id deltachat:user@example.com \
  --platform-id <platform_id from above> \
  --display-name "Your Name"
```

### Groups

Add the bot email to a DeltaChat group. When any member sends a message, the router creates a `messaging_groups` row with `is_group = 1`. Run `/manage-channels` to wire it to an agent group.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/init-first-agent` to create an agent and wire it to your DeltaChat DM (see Wiring above), or `/manage-channels` to wire this channel to an existing agent group.

## Channel Info

- **type**: `deltachat`
- **terminology**: DeltaChat calls them "chats" (1:1 DMs) and "groups"
- **supports-threads**: no — DeltaChat has no thread model
- **platform-id-format**: numeric chat ID as a string (e.g. `"12"`) — the DeltaChat core's internal chat identifier
- **user-id-format**: `deltachat:{email}` — the contact's email address
- **how-to-find-id**: Send a message from DeltaChat to the bot email, then query `messaging_groups` as shown above
- **typical-use**: Personal assistant over DeltaChat DMs; small groups where participants use DeltaChat
- **default-isolation**: One agent per bot identity. Multiple chats with the same operator can share an agent group; groups with other people should typically use `isolated` session mode

### Features

- File attachments — inbound and outbound; inbound waits up to 30 seconds for large-message download to complete
- Invite link logged on every startup — URL + QR SVG written to `dc-account/invite-qr.svg`; see Wiring for the bootstrap flow
- `/set-avatar` — send an image with this caption to change the bot's DeltaChat avatar (admin/owner only)
- Connectivity watchdog — restarts IO if IMAP goes quiet for 20 minutes or connectivity drops below threshold for two consecutive 5-minute checks
- Network nudge — `maybeNetwork()` called every 10 minutes to recover from prolonged idle

Not supported: DeltaChat reactions, message editing/deletion, read receipts.

### Connectivity model

`isConnected()` returns `true` when the internal connectivity value is ≥ 3000:

| Range | Meaning |
|-------|---------|
| 1000–1999 | Not connected |
| 2000–2999 | Connecting |
| 3000–3999 | Working (IMAP fetching) |
| ≥ 4000 | Fully connected (IMAP IDLE) |

## Troubleshooting

### Adapter not starting — credentials missing

```bash
grep "Channel credentials missing" logs/nanoclaw.log | grep deltachat
```

All six required vars (`DC_EMAIL`, `DC_PASSWORD`, `DC_IMAP_HOST`, `DC_IMAP_PORT`, `DC_SMTP_HOST`, `DC_SMTP_PORT`) must be present in `.env`.

### Account configure fails

```bash
grep "DeltaChat" logs/nanoclaw.log | tail -20
```

Common causes:
- Wrong IMAP/SMTP hostnames — double-check provider docs
- App password not generated — Gmail and some others require this when 2FA is enabled
- Port/security mismatch — defaults are port 993 + SSL/TLS for IMAP and port 587 + STARTTLS for SMTP; override with `DC_IMAP_PORT`/`DC_IMAP_SECURITY` or `DC_SMTP_PORT`/`DC_SMTP_SECURITY` in `.env`

### Provider uses SMTP port 465 (SSL/TLS) instead of 587

Set `DC_SMTP_SECURITY=1` and `DC_SMTP_PORT=465` in `.env`, then restart.

### Messages not arriving

1. Check the service is running and the adapter started: `grep "Channel adapter started.*deltachat" logs/nanoclaw.log`
2. Check connectivity: `grep "DeltaChat: IO started" logs/nanoclaw.log`
3. Check the sender has been granted access — run `/init-first-agent` to create their user record and wire the chat
4. Verify the messaging group is wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mga.agent_group_id FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id WHERE mg.channel_type='deltachat'"`

### Stale lock file after crash

```bash
rm -f dc-account/accounts.lock
systemctl --user restart "$(. setup/lib/install-slug.sh && systemd_unit)"
```

### Bot not responding after restart

The account is already configured — IO restarts automatically on service start. If the RPC subprocess is stuck, restart the service. Check for errors:

```bash
grep "DeltaChat" logs/nanoclaw.error.log | tail -20
```

### Messages received but agent not responding

The messaging group exists but may not be wired to an agent group. Run:

```bash
pnpm exec tsx scripts/q.ts data/v2.db "SELECT id, platform_id, name FROM messaging_groups WHERE channel_type='deltachat'"
```

If the group has no entry in `messaging_group_agents`, wire it with `/manage-channels`.
