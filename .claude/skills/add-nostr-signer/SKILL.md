---
name: add-nostr-signer
description: Add Nostr signing daemon — agents sign events, post notes, upload to Blossom, and manage sessions without the nsec ever entering a container. Key lives in Linux kernel keyring.
---

# Add Nostr Signing Daemon

Host-side signing daemon that lets NanoClaw agents sign Nostr events, post notes, upload media to Blossom, and manage NIP-46 sessions — without the private key (nsec) ever entering a container or passing through any API.

**The key never leaves the host.** The nsec is stored in the Linux kernel keyring and read only by the daemon process. Containers communicate via a Unix socket mounted read-only. This is the architecture Nostr agents should use.

**Battle-tested:** Production-proven since March 2026. Daily Nostr posting, Blossom uploads, and zap request signing.

## Components

| File | Lines | Purpose |
|------|-------|---------|
| `index.js` | 304 | Main daemon — Unix socket server, event signing, NIP-44 encryption, gift wrap |
| `clawstr-post.js` | 189 | CLI — compose and publish Nostr notes from container |
| `blossom-upload.js` | 172 | CLI — upload media to Blossom server with signed auth |
| `rate-limiter.js` | 113 | Token-bucket rate limiter (prevents spam) |
| `sessions.js` | 149 | NIP-46 session management |

## Architecture

```
Linux kernel keyring
  ← nsec stored via: echo -n "nsec1..." | keyctl padd user nostr-nsec @u
nostr-signer daemon (tools/nostr-signer/index.js)
  ← reads nsec from keyring at startup, converts to hex in RAM
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
| `sign_event` | Signs any Nostr event | clawstr-post, NWC wallet (zaps) |
| `get_pubkey` | Returns the agent's hex pubkey | clawstr-post, identity verification |
| `nip44_encrypt` | NIP-44 encryption | Nostr DM adapter (gift wrapping) |
| `nip44_decrypt` | NIP-44 decryption | Nostr DM adapter (unwrapping) |
| `unwrap_gift_wrap` | Decrypt NIP-17 gift-wrapped DM | Nostr DM adapter |
| `wrap_dm` | Create NIP-17 gift-wrapped DM | Nostr DM adapter |

## Prerequisites

### 1. Store nsec in kernel keyring

```bash
# Convert your nsec to hex if needed, or paste nsec1... directly
echo -n "nsec1..." | keyctl padd user nostr-nsec @u

# Verify it's stored
keyctl print $(keyctl search @u user nostr-nsec)
```

The keyring is volatile — **wiped on reboot**. You'll need to re-add the nsec after each reboot. This is a security feature, not a bug.

### 2. Install dependencies

```bash
cd tools/nostr-signer && npm install && cd ../..
```

npm deps: `nostr-tools`, `ws`, `@noble/hashes`

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
| `No key found` at startup | nsec not in keyring (rebooted?) | Re-add: `echo -n "nsec1..." \| keyctl padd user nostr-nsec @u` |
| Rate limited | Too many sign requests | Wait — token bucket refills automatically |

## Removal

```bash
systemctl --user disable --now nostr-signer
rm -rf tools/nostr-signer
# Remove mount from container.json
systemctl --user restart nanoclaw
```
