---
name: add-nostr-signer
description: Add Nostr signing daemon — agents sign events, post notes, upload to Blossom, and manage sessions without the nsec ever entering a container. Keys live in the Linux kernel keyring; one daemon can hold several Nostr identities (personal + business accounts) and agents pick one per post with --account.
---

# Add Nostr Signing Daemon

Host-side signing daemon that lets NanoClaw agents sign Nostr events, post notes, upload media to Blossom, and manage NIP-46 sessions — without the private key (nsec) ever entering a container or passing through any API.

**The key never leaves the host.** The nsec is stored in the Linux kernel keyring and read only by the daemon process. Containers communicate via a Unix socket mounted read-only. This is the architecture Nostr agents should use.

**Multiple identities, one gatekeeper.** Run your own account and your businesses' accounts from the same daemon. The agent says which identity to post as (`--account my-business`) and never sees any of the keys.

**Battle-tested:** Production-proven since March 2026. Daily Nostr posting, Blossom uploads, and zap request signing. Multi-account since October 2026 (one personal + two business identities).

## Components

| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 378 | Main daemon — Unix socket server, multi-account event signing, NIP-44 encryption, gift wrap |
| `clawstr-post.js` | 214 | CLI — compose and publish Nostr notes from container (`--account` selects the identity) |
| `add-account-key.sh` | 30 | Host helper — store an extra identity's nsec with hidden input (never in argv or history) |
| `blossom-upload.js` | 172 | CLI — upload media to Blossom server with signed auth |
| `rate-limiter.js` | 113 | Token-bucket rate limiter (prevents spam) |
| `sessions.js` | 149 | NIP-46 session management |

## Architecture

```
Linux kernel keyring
  ← default nsec stored as user key `nsec`
  ← extra identities stored as user keys `nostr:<account>` (add-account-key.sh)
nostr-signer daemon (tools/nostr-signer/index.js)
  ← reads every nsec from the keyring at startup, converts to hex in RAM
  ← listens on Unix socket ($XDG_RUNTIME_DIR/nostr-signer.sock)
Container agent
  → /run/nostr/signer.sock (mounted read-only)
  → clawstr-post: "Post this note to Nostr"
  → blossom-upload: "Upload this image to Blossom"
  → NWC wallet: "Sign this zap request"
```

## Signing operations

| Operation | Socket method | Used by |
|-----------|--------------|---------|
| `sign_event` | Signs any Nostr event (optional `account` param) | clawstr-post, NWC wallet (zaps) |
| `get_public_key` | Returns an identity's hex pubkey (optional `account` param) | clawstr-post, identity verification |
| `list_accounts` | Lists loaded identities and their pubkeys (never keys) | `clawstr-post accounts` |
| `nip44_encrypt` | NIP-44 encryption | Nostr DM adapter (gift wrapping) |
| `nip44_decrypt` | NIP-44 decryption | Nostr DM adapter (unwrapping) |
| `unwrap_gift_wrap` | Decrypt NIP-17 gift-wrapped DM | Nostr DM adapter |
| `wrap_dm` | Create NIP-17 gift-wrapped DM | Nostr DM adapter |

## Prerequisites

### 1. Store nsec in kernel keyring

```bash
# Read the nsec without echoing it or leaving it in shell history
read -rs NSEC && printf '%s' "$NSEC" | keyctl padd user nsec @u; unset NSEC

# Verify it's stored (shows the key name, not the value)
keyctl show @u | grep nsec
```

The keyring is volatile — **wiped on reboot**. You'll need to re-add the nsec after each reboot. This is a security feature, not a bug.

### 2. Install dependencies

```bash
cd tools/nostr-signer && npm install && cd ../..
```

npm deps: `nostr-tools`, `ws`, `@noble/hashes`

## Multiple identities

The `nsec` key is the default identity. Every extra identity is a keyring key named `nostr:<account>`, and the daemon loads all of them at startup. Nothing to configure.

```bash
# On the host, once per identity (prompts for the nsec, input hidden)
bash tools/nostr-signer/add-account-key.sh my-business
systemctl --user restart nostr-signer
systemctl --user restart nanoclaw   # containers re-mount the new socket
```

Name the default identity by adding `Environment=NOSTR_SIGNER_DEFAULT_ACCOUNT=<name>` to the service. `--account default` always works as well.

From a container:

```bash
clawstr-post accounts                                   # name + pubkey of each identity
clawstr-post post ai-freedom "Hello" --account my-business
clawstr-post pubkey --account my-business
```

- **Unknown names fail closed.** An unknown or unloaded account name returns an error. The daemon never falls back to the default, so nothing gets posted as the wrong identity.
- **Encryption stays on the default key.** DM and encryption methods (NIP-17, NIP-44, NIP-04) always use the default identity. Only `sign_event` and `get_public_key` take `account`.
- **One shared rate limit.** Rate limits and session tokens apply across all identities.

## Install

### Phase 1: Pre-flight

```bash
test -f tools/nostr-signer/index.js && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/nostr-signer
git checkout origin/skill/nostr-signer -- tools/nostr-signer/ .claude/skills/add-nostr-signer/
cd tools/nostr-signer && npm install && cd ../..
```

### Phase 3: Set up systemd service

```bash
cat > ~/.config/systemd/user/nostr-signer.service << 'EOF'
[Unit]
Description=Nostr signing daemon
After=network.target

[Service]
ExecStart=/usr/bin/node /home/YOU/NanoClaw/tools/nostr-signer/index.js
Restart=on-failure
RestartSec=5
Environment=XDG_RUNTIME_DIR=/run/user/1000
# Optional: what to call the default identity in `clawstr-post accounts`
# Environment=NOSTR_SIGNER_DEFAULT_ACCOUNT=me

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now nostr-signer
```

### Phase 4: Mount socket into containers

The Nostr DM adapter automatically mounts the socket. For other uses, add to `groups/<folder>/container.json`:

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/NanoClaw/tools/nostr-signer",
      "containerPath": "nostr-tools",
      "readonly": true
    }
  ]
}
```

The socket mount (`/run/nostr/signer.sock`) is contributed by the Nostr DM channel adapter's `containerConfig`.

### Phase 5: Restart

```bash
systemctl --user restart nanoclaw
```

## Usage from container

```bash
# Post a note
node /workspace/extra/nostr-tools/clawstr-post.js post "Hello from Jorgenclaw"

# Post to a community
node /workspace/extra/nostr-tools/clawstr-post.js post ai-freedom "Thoughts on agent sovereignty..."

# Upload to Blossom
node /workspace/extra/nostr-tools/clawstr-post.js upload /path/to/image.jpg

# Get pubkey
node /workspace/extra/nostr-tools/clawstr-post.js pubkey
```

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `ECONNREFUSED` on socket | Daemon not running or socket recreated | `systemctl --user restart nostr-signer` |
| `keyctl: not found` | keyutils not installed | `sudo apt install keyutils` |
| `No key found` at startup | nsec not in keyring (rebooted?) | Re-add it (see Prerequisites) and any `nostr:<account>` keys, then restart the daemon |
| `ENOENT /run/nostr/signer.sock` in a container | Container spawned before the daemon was up, or the daemon restarted after the container spawned | `systemctl --user restart nanoclaw` (daemon first, then containers) |
| `Unknown or unloaded account: X` | No `nostr:X` key when the daemon started | `add-account-key.sh X`, then restart the daemon |
| Rate limited | Too many sign requests | Wait — token bucket refills automatically |

## Removal

```bash
systemctl --user disable --now nostr-signer
rm -rf tools/nostr-signer
# Remove mount from container.json
systemctl --user restart nanoclaw
```
