---
name: add-nostr-dm
description: Add Nostr private DM channel via NIP-17 gift-wrapped direct messages. Uses a signing daemon for key isolation — nsec never enters the container. Supports encrypted image attachments via Blossom.
---

# Add Nostr DM Channel (V2)

Private direct messages on Nostr using NIP-17 (gift-wrapped DMs). Your agent can receive and reply to encrypted DMs from any Nostr user, with the private key safely isolated in a host-side signing daemon.

**Key security:** The agent's nsec never enters the container or passes through any API. All signing happens via a Unix socket to a host-side daemon that reads the key from the Linux kernel keyring. This is the architecture Nostr agents should use — not key-in-env-var.

**Battle-tested:** Production-proven since March 2026. Daily DM conversations with real Nostr users.

## Features

- **NIP-17 gift-wrapped DMs** — encrypted, metadata-private direct messages
- **Signing daemon isolation** — nsec in kernel keyring → daemon → Unix socket → container
- **Allowlist** — only process DMs from approved pubkeys (spam protection)
- **Multi-relay** — subscribes to 3+ relays for redundancy, auto-reconnects
- **Image support** — encrypted images via Blossom media server (optional)
- **SimplePool** — uses nostr-tools for relay management

## Architecture

```
Nostr relays (wss://...)
  ↓ NIP-17 kind:1059 gift wraps
NanoClaw Nostr DM adapter (src/channels/nostr-dm.ts)
  ↓ Calls signing daemon via Unix socket to unwrap
nostr-signer daemon (tools/nostr-signer/index.js)
  ↓ Reads nsec from Linux kernel keyring
  ↓ Decrypts gift wrap → extracts DM content
NanoClaw adapter
  ↓ InboundMessage → Router → Session → Container → Agent
  ↓ Agent reply → adapter calls daemon to wrap + encrypt
  ↓ Publishes gift-wrapped reply to relays
```

## Prerequisites

### 1. Nostr signing daemon

The daemon manages the nsec and exposes signing operations via Unix socket:

```bash
# The daemon lives at tools/nostr-signer/index.js
# It reads nsec from the Linux kernel keyring

# Store your nsec in the keyring:
echo -n "nsec1..." | keyctl padd user nostr-nsec @u

# Set up systemd service:
cat > ~/.config/systemd/user/nostr-signer.service << 'EOF'
[Unit]
Description=Nostr Signing Daemon
After=network.target

[Service]
ExecStart=/usr/bin/node /home/YOU/NanoClaw/tools/nostr-signer/index.js
Restart=on-failure
RestartSec=5
Environment=XDG_RUNTIME_DIR=/run/user/1000

[Install]
WantedBy=default.target
EOF

systemctl --user enable --now nostr-signer
```

The socket appears at `$XDG_RUNTIME_DIR/nostr-signer.sock`.

### 2. nostr-tools (npm)

```bash
pnpm add nostr-tools ws
```

### 3. Nostr relays

Choose 3+ relays. Defaults:

```
wss://relay.damus.io
wss://nos.lol
wss://relay.nostr.band
```

## Install

### Phase 1: Pre-flight

```bash
test -f src/channels/nostr-dm.ts && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/nostr-dm-v2
git checkout origin/skill/nostr-dm-v2 -- src/channels/nostr-dm.ts
pnpm add nostr-tools ws
```

Add the import to `src/channels/index.ts`:

```typescript
import './nostr-dm.js';
```

Add config exports to `src/config.ts`:

```typescript
// In readEnvFile array:
'NOSTR_SIGNER_SOCKET',
'NOSTR_DM_RELAYS',
'NOSTR_DM_ALLOWLIST',

// Exports:
export const NOSTR_SIGNER_SOCKET =
  process.env.NOSTR_SIGNER_SOCKET || envConfig.NOSTR_SIGNER_SOCKET || '/run/nostr/signer.sock';
export const NOSTR_DM_RELAYS = (
  process.env.NOSTR_DM_RELAYS || envConfig.NOSTR_DM_RELAYS ||
  'wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band'
).split(',').filter(Boolean);
export const NOSTR_DM_ALLOWLIST = new Set(
  (process.env.NOSTR_DM_ALLOWLIST || envConfig.NOSTR_DM_ALLOWLIST || '').split(',').filter(Boolean),
);
```

Add to `.env`:

```bash
NOSTR_DM_RELAYS=wss://relay.damus.io,wss://nos.lol,wss://relay.nostr.band
NOSTR_DM_ALLOWLIST=<hex-pubkey-1>,<hex-pubkey-2>
```

### Phase 3: Build and restart

```bash
pnpm run build
systemctl --user restart nanoclaw
```

## Verify

Check logs for relay connections:

```bash
tail -f logs/nanoclaw.log | grep -i nostr
```

You should see: `Nostr DM channel connected`, relay count, allowlist count.

Send a DM to your agent's npub from any Nostr client. The agent should receive and reply.

## Container mounts

The adapter contributes a mount for the signing daemon socket:

```
$XDG_RUNTIME_DIR/nostr-signer.sock → /run/nostr/signer.sock (read-only)
```

This allows the container to call `clawstr-post` for Nostr social posting (separate from DMs).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NOSTR_SIGNER_SOCKET` | `/run/nostr/signer.sock` | Path to signing daemon Unix socket |
| `NOSTR_DM_RELAYS` | damus, nos.lol, nostr.band | Comma-separated relay WebSocket URLs |
| `NOSTR_DM_ALLOWLIST` | (empty = allow none) | Comma-separated hex pubkeys allowed to DM |

## Security model

- **nsec isolation:** Private key lives in the Linux kernel keyring, read only by the signing daemon. Never in `.env`, never in container env, never in chat context.
- **Allowlist:** Only DMs from listed pubkeys are processed. Unknown senders are silently dropped. This prevents spam — Nostr DMs are open by default.
- **Gift wrapping (NIP-17):** DM metadata (sender, recipient, timestamp) is encrypted in the outer gift wrap. Relays can't see who's talking to whom.

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `Nostr DM channel connected` not in logs | Signer socket missing or relays down | Check `systemctl --user status nostr-signer` |
| DMs not received | Sender not in allowlist | Add their hex pubkey to NOSTR_DM_ALLOWLIST |
| `ECONNREFUSED` on signer socket | Daemon restarted, socket path changed | `systemctl --user restart nostr-signer` |
| Replies not delivered | Relay connection dropped | Adapter auto-reconnects; check relay status |

## Removal

```bash
rm src/channels/nostr-dm.ts
# Remove nostr-dm import from src/channels/index.ts
# Remove NOSTR_* exports from src/config.ts
pnpm run build
```
