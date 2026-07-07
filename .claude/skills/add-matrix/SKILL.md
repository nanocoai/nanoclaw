---
name: add-matrix
description: Add Matrix channel integration via Chat SDK. Works with any Matrix homeserver.
---

# Add Matrix Channel

Adds Matrix support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Matrix adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/matrix.ts` exists
- `src/channels/matrix-registration.test.ts` exists
- `src/channels/index.ts` contains `import './matrix.js';`
- `@beeper/chat-adapter-matrix` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter and its registration test

```bash
git show origin/channels:src/channels/matrix.ts                 > src/channels/matrix.ts
git show origin/channels:src/channels/matrix-registration.test.ts > src/channels/matrix-registration.test.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './matrix.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install @beeper/chat-adapter-matrix@0.2.0
```

### 5. Patch matrix-js-sdk ESM imports

The adapter's published dist references `matrix-js-sdk/lib/...` without `.js`
extensions, which fails under Node 22 strict ESM resolution. Add the missing
extensions (idempotent — safe to re-run):

```bash
node -e '
  const fs = require("fs"), path = require("path");
  const root = "node_modules/.pnpm";
  const dir = fs.readdirSync(root).find(d => d.startsWith("@beeper+chat-adapter-matrix@"));
  if (!dir) { console.log("Matrix adapter not installed"); process.exit(0); }
  const f = path.join(root, dir, "node_modules/@beeper/chat-adapter-matrix/dist/index.js");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace(
    /from "(matrix-js-sdk\/lib\/[^"]+?)(?<!\.js)"/g, "from \"$1.js\""
  ));
  console.log("Patched", f);
'
```

Re-run this after every `pnpm install` that touches the adapter.

### 6. Build and validate

```bash
pnpm run build
pnpm exec vitest run src/channels/matrix-registration.test.ts
```

Both must be clean before proceeding. `matrix-registration.test.ts` is the one integration test: it imports the real channel barrel and asserts the registry contains `matrix`. It goes red if the `import './matrix.js';` line is deleted or drifts, if the barrel fails to evaluate, or if `@beeper/chat-adapter-matrix` isn't installed (the import throws) — so it also implicitly verifies the dependency from step 4. The adapter also calls core's `createChatSdkBridge(...)`; that typed core-API consumption is guarded by `pnpm run build`.

End-to-end message delivery against a real Matrix homeserver is verified manually once the service is running — see Next Steps.

## Credentials

The bot needs its own Matrix account — separate from the user's account. This is required because Matrix cannot send DMs to yourself.

### Create a bot account

1. Open [app.element.io](https://app.element.io) in a private/incognito window (or sign out first)
2. Register a new account for the bot (e.g. `andybot` on matrix.org)
3. Note the bot's user ID (e.g. `@andybot:matrix.org`)

### Choose an auth method

**Option A: Username + Password (simpler)**

No extra steps — just use the bot account's credentials directly. The adapter logs in automatically.

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_USERNAME=andybot
MATRIX_PASSWORD=your-bot-password
MATRIX_USER_ID=@andybot:matrix.org
MATRIX_BOT_USERNAME=Andy
```

**Option B: Access Token (recommended for production)**

Get an access token from Element: sign into the bot account → **Settings** > **Help & About** > **Access Token** (under Advanced). Or via API:

```bash
curl -XPOST 'https://matrix.org/_matrix/client/r0/login' \
  -d '{"type":"m.login.password","user":"andybot","password":"..."}'
```

```bash
MATRIX_BASE_URL=https://matrix.org
MATRIX_ACCESS_TOKEN=your-access-token
MATRIX_USER_ID=@andybot:matrix.org
MATRIX_BOT_USERNAME=Andy
```

### Optional settings

```bash
MATRIX_INVITE_AUTOJOIN=true                    # Auto-accept room invites (default: true)
MATRIX_INVITE_AUTOJOIN_ALLOWLIST=@you:matrix.org  # Only accept invites from these users
MATRIX_RECOVERY_KEY=your-recovery-key          # Enable E2EE cross-signing
MATRIX_DEVICE_ID=NANOCLAW01                    # Stable device ID across restarts
```

### Configure environment

Add the chosen env vars to `.env`, then sync:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `matrix`
- **terminology**: Matrix has "rooms." A room can be a group chat or a direct message. Rooms have internal IDs (like `!abc123:matrix.org`) and optional aliases (like `#general:matrix.org`).
- **how-to-find-id**: For DMs, use the bot's `openDM` to resolve the room automatically. For group rooms, in Element click the room name > Settings > Advanced — the "Internal room ID" is the platform ID (starts with `!`). Or use a room alias like `#general:matrix.org`.
- **supports-threads**: partial (some clients support threads, but not all — treat as no for reliability)
- **typical-use**: Interactive chat — rooms or direct messages. Requires a separate bot account (the agent cannot DM users from their own account).
- **default-isolation**: Same agent group for rooms where you're the primary user. Separate agent group for rooms with different communities or sensitive contexts.
