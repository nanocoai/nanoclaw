---
name: add-matrix
description: Add Matrix channel with persistent native E2EE (cross-signing + 4S). Works with any Matrix homeserver, including self-hosted Synapse.
---

# Add Matrix Channel

Adds Matrix support via a native adapter built on `matrix-bot-sdk` and the
`@matrix-org/matrix-sdk-crypto-nodejs` Rust binding. Unlike the previous Chat
SDK bridge (which relied on WASM crypto and lost E2E keys on every restart),
this adapter persists its crypto identity and room keys to the filesystem — so
the bot device is stable across restarts and the green shield is achievable.

Features: E2EE with persistent key storage, cross-signing, 4S/SSSS secret
backup, auto-join invites, quoted replies, typing indicators (DMs), read
receipts.

For a self-hosted private homeserver (Synapse on Tailscale + encrypted
backups), run `/setup-private-matrix` after this skill.

## Prerequisites

- Node 24+ (required for the native crypto binding). Check: `node --version`

## Install

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/matrix.ts` exists and its first comment mentions `SOUND persistent E2EE`
- `src/channels/index.ts` contains `import './matrix.js';`
- `matrix-bot-sdk` is listed in `package.json` dependencies
- `patches/matrix-bot-sdk@0.8.0.patch` exists

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter, tests, and patch

```bash
git show origin/channels:src/channels/matrix.ts > src/channels/matrix.ts
git show origin/channels:src/channels/matrix.test.ts > src/channels/matrix.test.ts
git show origin/channels:src/channels/matrix-registration.test.ts > src/channels/matrix-registration.test.ts
git show origin/channels:src/channels/matrix-rustengine-patch.test.ts > src/channels/matrix-rustengine-patch.test.ts
git show origin/channels:patches/matrix-bot-sdk@0.8.0.patch > patches/matrix-bot-sdk@0.8.0.patch
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './matrix.js';
```

### 4. Add dep + patch config

In `package.json` dependencies, add:

```json
"matrix-bot-sdk": "0.8.0"
```

Remove `@beeper/chat-adapter-matrix` from dependencies if present.

Append to `pnpm-workspace.yaml`:

```yaml
patchedDependencies:
  matrix-bot-sdk@0.8.0: patches/matrix-bot-sdk@0.8.0.patch

overrides:
  '@matrix-org/matrix-sdk-crypto-nodejs': 0.6.1
```

### 5. Install and build

```bash
pnpm install
pnpm run build
```

`pnpm install` applies the patch automatically. The patch adds
`bootstrapCrossSigning` and `bootstrapSecretStorageFromPassphrase` to
`RustEngine`, and fixes the `SignatureUpload` envelope unwrapping bug.

## Credentials

Add to `.env`:

```bash
MATRIX_BASE_URL=https://your-homeserver.example.com
MATRIX_USERNAME=yourbot          # localpart only, no @ or :server
MATRIX_PASSWORD=yourpassword

# Stable device id — generate once, never change:
MATRIX_DEVICE_ID=NANOCLAWBOT

# Recovery passphrase — enables cross-signing + 4S/SSSS key backup:
MATRIX_RECOVERY_KEY=a-long-random-passphrase
```

`MATRIX_DEVICE_ID` and `MATRIX_RECOVERY_KEY` are both strongly recommended:

- `MATRIX_DEVICE_ID` — ensures the bot always appears as the same device (no
  new-device notifications on restarts)
- `MATRIX_RECOVERY_KEY` — bootstraps cross-signing (green shield) and uploads
  encrypted key backups to account data so room keys survive if the crypto
  store is lost

Generate a strong recovery key:

```bash
openssl rand -base64 32
```

Store it somewhere safe (password manager). It cannot be recovered if lost.

### Optional env vars

```bash
MATRIX_INVITE_AUTOJOIN=true                         # auto-accept room invites
MATRIX_INVITE_AUTOJOIN_ALLOWLIST=@you:example.com   # only from these users
MATRIX_BOT_USERNAME="NanoClaw"                      # display name
MATRIX_CRYPTO_STORE_PATH=data/v2-matrix-crypto      # default
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

### Restart

```bash
# macOS
launchctl kickstart -k gui/$(id -u)/com.nanoclaw

# Linux
systemctl --user restart nanoclaw
```

On first start with `MATRIX_RECOVERY_KEY` set, the adapter bootstraps
cross-signing and 4S. Subsequent restarts detect the existing setup and skip
(idempotent). Check logs for:

```
Matrix channel connected
Cross-signing bootstrapped (new setup)   — or "already set up — skipping"
4S bootstrap done — keyBackupVersion="1" — or "already set up — skipping"
```

## Wiring

After the service starts, send a message from your Matrix client to the bot.
The router creates a `messaging_groups` row. Then:

```bash
sqlite3 data/v2.db \
  "SELECT id, platform_id FROM messaging_groups WHERE channel_type='matrix' ORDER BY created_at DESC LIMIT 5"
```

Pass the `id` to `/init-first-agent` or `/manage-channels`.

### Grant user access

New Matrix users are silently dropped with `not_member` until granted:

```bash
NOW=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
sqlite3 data/v2.db "
INSERT OR REPLACE INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at)
  VALUES ('matrix:@you:yourserver', 'owner', NULL, 'system', '$NOW');
INSERT OR IGNORE INTO agent_group_members (user_id, agent_group_id, added_by, added_at)
  VALUES ('matrix:@you:yourserver', 'ag-AGENTID', 'system', '$NOW');
"
```

Find your Matrix ID from `messaging_groups.platform_id` or the `users` table.

## Channel Info

- **type**: `matrix`
- **terminology**: Matrix has "rooms" (both DMs and group chats)
- **supports-threads**: no
- **platform-id-format**: `matrix:@user:server`
- **how-to-find-id**: send a message to the bot, then query `messaging_groups`
- **typical-use**: private DMs (especially with a self-hosted homeserver) or
  group rooms as a privacy-respecting alternative to Slack/Discord

### Features

- Persistent native E2EE — crypto store survives restarts (no lost keys)
- Cross-signing — green shield achievable after device verification
- 4S/SSSS key backup — cross-signing private keys + megolm backup key encrypted
  in account data, recoverable with `MATRIX_RECOVERY_KEY`
- Auto-join room invites
- Quoted replies (reply context passed to agent)
- Typing indicators (DMs only)
- Read receipts

Not yet supported: outbound file attachments, edit/delete, reactions, threads.

## Troubleshooting

### Bot not responding

1. `grep "Matrix channel" logs/nanoclaw.log | tail -3`
2. `sqlite3 data/v2.db "SELECT mg.platform_id FROM messaging_groups mg JOIN messaging_group_agents mga ON mg.id = mga.messaging_group_id WHERE mg.channel_type='matrix'"`
3. Service status: `launchctl print gui/$(id -u)/com.nanoclaw` (macOS) / `systemctl --user status nanoclaw` (Linux)

### `ERR_DLOPEN_FAILED` on start

Requires Node 24+. Check `node --version`. After upgrading Node, run
`pnpm rebuild` to recompile native modules.

### Cross-signing not completing / no green shield

Ensure both `MATRIX_DEVICE_ID` and `MATRIX_RECOVERY_KEY` are set. The crypto
store at `data/v2-matrix-crypto/` must be writable. Check logs for errors after
`Cross-signing bootstrap`.

### `401 Unauthorized` on start

Password login failed. Verify `MATRIX_USERNAME` is the localpart only (no `@`
or `:server`) and `MATRIX_PASSWORD` matches.

### Messages dropped with `not_member`

The Matrix user hasn't been granted membership. See "Grant user access" above.

### Self-hosted homeserver

For a private self-hosted setup (Synapse on Tailscale + age-encrypted Google
Drive backups), run `/setup-private-matrix` after this skill completes.
