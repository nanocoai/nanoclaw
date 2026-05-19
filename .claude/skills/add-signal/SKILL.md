---
name: add-signal
description: Add Signal channel integration via signal-cli TCP daemon. Native adapter — no Chat SDK bridge.
---

# Add Signal Channel

Adds Signal messaging support via a native adapter that speaks JSON-RPC to a [signal-cli](https://github.com/AsamK/signal-cli) TCP daemon. No Chat SDK bridge — only Node.js builtins (`node:net`, `node:child_process`, `node:fs`).

Unlike Telegram or Discord, Signal has no bot API. NanoClaw registers as a full Signal account on a dedicated phone number (recommended) or links as a secondary device on your existing number.

## Prerequisites

### Java

signal-cli requires Java 17+:

```bash
java -version
```

If missing:
- **macOS:** `brew install --cask temurin@17`
- **Debian/Ubuntu:** `sudo apt-get install -y default-jre`
- **RHEL/Fedora:** `sudo dnf install -y java-17-openjdk`

Java 17–25 all work.

### signal-cli

- **macOS:** `brew install signal-cli`
- **Linux:** download the native binary from [GitHub releases](https://github.com/AsamK/signal-cli/releases):

```bash
SIGNAL_CLI_VERSION=$(curl -fsSL https://api.github.com/repos/AsamK/signal-cli/releases/latest | python3 -c "import sys,json; print(json.load(sys.stdin)['tag_name'][1:])")
curl -fsSL "https://github.com/AsamK/signal-cli/releases/download/v${SIGNAL_CLI_VERSION}/signal-cli-${SIGNAL_CLI_VERSION}-Linux-native.tar.gz" \
  | tar -xz -C ~/.local
ln -sf ~/.local/signal-cli ~/.local/bin/signal-cli
signal-cli --version
```

> The Linux native tarball extracts a single binary directly to `~/.local/signal-cli` (not into a subdirectory). The symlink above puts it on PATH.

## Registration

Two paths. The new-number path is recommended and battle-tested.

### Path A: Register a new number (recommended)

Use a dedicated SIM or VoIP number. NanoClaw owns it entirely.

> **VoIP numbers:** Signal requires SMS verification before voice. Some VoIP providers are blocked even for voice calls. If registration fails with an auth error, try a different provider or a physical SIM.

**Step 1: Solve the CAPTCHA**

Signal requires a CAPTCHA on first registration:

1. Open `https://signalcaptchas.org/registration/generate.html` in a browser
2. Solve the captcha
3. Right-click the **"Open Signal"** button → **Copy Link**
4. The link starts with `signalcaptcha://` — the token is everything after that prefix

**Step 2: Request SMS verification**

```bash
signal-cli -a +1YOURNUMBER register --captcha "PASTE_TOKEN_HERE"
```

**Step 3: Voice call fallback (if your number can't receive SMS)**

Wait ~60 seconds after the SMS request, then:

```bash
signal-cli -a +1YOURNUMBER register --voice --captcha "SAME_TOKEN"
```

Signal calls your number and reads a 6-digit code. The same captcha token is reusable — no need to solve a new one.

> You must request SMS first. Requesting voice immediately fails with `Invalid verification method: Before requesting voice verification…`

**Step 4: Verify**

```bash
signal-cli -a +1YOURNUMBER verify CODE
```

No output = success.

**Step 5: Set profile name (optional)**

> ⚠ Stop NanoClaw before running signal-cli commands — the daemon holds an exclusive lock on its data directory while running.

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# macOS
launchctl unload ~/Library/LaunchAgents/$(launchd_label).plist
signal-cli -a +1YOURNUMBER updateProfile --name "YourBotName"
# optionally: --avatar /path/to/avatar.jpg
launchctl load ~/Library/LaunchAgents/$(launchd_label).plist

# Linux
systemctl --user stop $(systemd_unit)
signal-cli -a +1YOURNUMBER updateProfile --name "YourBotName"
systemctl --user start $(systemd_unit)
```

### Path B: Link as secondary device

Joins an existing Signal account as a secondary device. Simpler, but NanoClaw shares your personal number.

```bash
signal-cli -a +1YOURNUMBER link --name "NanoClaw"
```

This prints a `tsdevice:` URI. Scan it as a QR code on your phone: **Settings → Linked Devices → Link New Device**. QR codes expire in ~30 seconds — re-run if it expires.

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/signal.ts` and `src/channels/signal.test.ts` both exist
- `src/channels/index.ts` contains `import './signal.js';`

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and tests

```bash
git show origin/channels:src/channels/signal.ts      > src/channels/signal.ts
git show origin/channels:src/channels/signal.test.ts > src/channels/signal.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './signal.js';
```

### 4. Build

```bash
pnpm run build
```

No npm packages to install — the adapter uses only Node.js builtins.

## Credentials

Add to `.env`:

```bash
SIGNAL_ACCOUNT=+1YOURNUMBER
```

### Optional settings

```bash
# TCP daemon host and port (default: 127.0.0.1:7583)
SIGNAL_TCP_HOST=127.0.0.1
SIGNAL_TCP_PORT=7583

# Path to the signal-cli binary (default: resolved on PATH)
SIGNAL_CLI_PATH=/usr/local/bin/signal-cli

# Whether NanoClaw manages the daemon lifecycle (default: true).
# Set to false if you run signal-cli daemon externally.
SIGNAL_MANAGE_DAEMON=true

# signal-cli data directory (default: ~/.local/share/signal-cli)
SIGNAL_DATA_DIR=~/.local/share/signal-cli
```

**Security note:** keep the TCP host on `127.0.0.1`. The daemon has no auth — binding it to a public interface would expose your full Signal account to the network.

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Restart

Run from your NanoClaw project root:

```bash
source setup/lib/install-slug.sh

# macOS
launchctl kickstart -k gui/$(id -u)/$(launchd_label)

# Linux
systemctl --user restart $(systemd_unit)
```

## Wiring

### DMs

After the service starts, send any message to the Signal number from your personal Signal app. The router auto-creates a `messaging_groups` row. Then:

```bash
pnpm exec tsx scripts/q.ts data/v2.db \
  "SELECT id, platform_id FROM messaging_groups WHERE channel_type='signal' ORDER BY created_at DESC LIMIT 5"
```

Pass the `id` to `/init-first-agent` or `/manage-channels` to wire it to an agent group.

### Groups

Add the Signal number to a group from your phone, send any message, then wire the resulting row the same way. For isolated per-group sessions:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
pnpm exec tsx scripts/q.ts data/v2.db "
INSERT OR IGNORE INTO messaging_group_agents
  (id, messaging_group_id, agent_group_id, session_mode, priority, created_at)
VALUES
  ('mga-'||hex(randomblob(8)), 'mg-GROUPID', 'ag-AGENTID', 'isolated', 0, '$NOW');
"
```

### Grant user access

New Signal users (including the owner's Signal identity) are silently dropped with `not_member` until granted access. After the user's first message appears in `messaging_groups`:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
pnpm exec tsx scripts/q.ts data/v2.db "
INSERT OR REPLACE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
  VALUES ('signal:UUID', 'owner', NULL, 'system', '$NOW');
INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
  VALUES ('signal:UUID', 'ag-AGENTID', 'system', '$NOW');
"
```

Find the UUID from `messaging_groups.platform_id` or the `users` table.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/init-first-agent` to create an agent and wire it to your Signal DM, or `/manage-channels` to wire this channel to an existing agent group.

## Channel Info

- **type**: `signal`
- **terminology**: Signal has "chats" (1:1 DMs) and "groups"
- **supports-threads**: no
- **platform-id-format**:
  - DM: `signal:{UUID}` — sender's Signal UUID (ACI), **not** their phone number
  - Group: `signal:{base64GroupId}` — base64-encoded GroupV2 ID
- **how-to-find-id**: Send a message to the bot, then query `messaging_groups` as shown above
- **typical-use**: Personal assistant via Signal DMs or small group chats
- **default-isolation**: One agent per Signal account. Multiple chats with the same operator can share an agent group; groups with other people should typically use `isolated` session mode

### Features

- Markdown formatting — `**bold**`, `*italic*` / `_italic_`, `` `code` ``, ` ```code fence``` `, `~~strike~~`, `||spoiler||` (converted to Signal's offset-based text styles)
- Quoted replies — `replyTo*` fields populated from Signal quotes
- Typing indicators — DMs only (Signal doesn't support group typing)
- Echo suppression — outbound messages matched on `(platformId, text)` within a 10 s TTL to avoid syncMessage loops
- Note to Self — messages you send to your own account from another device route to the agent as inbound with `isFromMe: true`
- Voice attachments — detected but not transcribed by default; the agent receives `[Voice Message]` placeholder text. Run `/add-voice-transcription` for local transcription via parakeet-mlx

Not supported yet: outbound file attachments (logged and dropped), edit/delete messages, reactions.

## Troubleshooting

### Daemon not reachable

```bash
grep "Signal" logs/nanoclaw.log | tail
```

If you see `Signal daemon failed to start. Is signal-cli installed and your account linked?`:
- Confirm `signal-cli` is on PATH (or set `SIGNAL_CLI_PATH`)
- Confirm the account is linked: `signal-cli -a +1YOURNUMBER listIdentities` should succeed without prompting

If you see `Signal daemon not reachable at 127.0.0.1:7583` and `SIGNAL_MANAGE_DAEMON=false`, start the daemon yourself: `signal-cli -a +1YOURNUMBER daemon --tcp 127.0.0.1:7583`.

### Bot not responding

1. Channel initialized: `grep "Signal channel connected" logs/nanoclaw.log | tail -1`
2. Channel wired: `pnpm exec tsx scripts/q.ts data/v2.db "SELECT mg.platform_id, mg.name FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id WHERE mg.channel_type='signal'"`
3. Service running: `launchctl print gui/$(id -u)/"$(. setup/lib/install-slug.sh && launchd_label)"` (macOS) / `systemctl --user status "$(. setup/lib/install-slug.sh && systemd_unit)"` (Linux)
4. **Check for duplicate service instances** — if `logs/nanoclaw.error.log` shows `No adapter for channel type channelType="signal"` despite the adapter starting, two NanoClaw processes are racing. See the `/debug` skill section "No adapter for channel type / Messages silently lost" for the full fix.

### Messages delivered but never arrive (null platformMsgId)

Signal responses show `platformMsgId=undefined` in the main log. This means the delivery poll ran but found no adapter — likely a duplicate service instance issue (see above). Affected messages cannot be retried; the user must resend.

### Lost connection mid-session

If you see `Signal channel lost TCP connection to signal-cli daemon` in the logs, the daemon dropped the connection. Restart the service to re-establish.

### Messages dropped with `not_member`

The Signal user hasn't been granted membership. See "Grant user access" above. This affects every new Signal user, including the owner's Signal identity — which is a separate user record from their identity on other channels even if it's the same person.

### Captcha required

Signal requires a captcha for new registrations. Go to `https://signalcaptchas.org/registration/generate.html`, solve it, right-click "Open Signal", copy the link, extract the token after `signalcaptcha://`.

### `Invalid verification method: Before requesting voice verification…`

You must request SMS first, wait ~60 seconds, then request voice. Both steps can use the same captcha token.

### Config file in use / daemon lock

signal-cli holds an exclusive lock on its data directory while the daemon is running. Stop NanoClaw before running any `signal-cli` commands directly, then restart afterward.

### Group replies going to DM instead of group

Modern Signal groups use GroupV2. The adapter must extract the group ID from `envelope?.dataMessage?.groupV2?.id` — not `groupInfo?.groupId`, which is GroupV1/legacy. If group messages are routing as DMs, check `src/channels/signal.ts` and confirm the groupId extraction falls through to `groupV2.id`.

### Java not found

Install Java 17+ — see the Prerequisites section above.

### QR code expired (Path B)

QR codes expire in ~30 seconds. Re-run the link command to generate a new one.
