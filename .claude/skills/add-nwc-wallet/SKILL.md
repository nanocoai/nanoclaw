---
name: add-nwc-wallet
description: Add NWC Lightning wallet — agent can check balance, create invoices, pay invoices, and zap Nostr users. Uses Nostr Wallet Connect (NIP-47). Zap signing via daemon — main nsec never enters container.
---

# Add NWC Lightning Wallet

Give your NanoClaw agent a Lightning wallet via Nostr Wallet Connect (NIP-47). The agent can check its balance, create invoices, pay invoices, and zap Nostr users — all from chat commands.

**Key security:** The NWC connection uses a wallet session key (NOT the main nsec). This session key is safe to handle in the container. Zap requests (kind:9734) are signed via the host-side signing daemon so the main nsec never enters the container.

**Battle-tested:** Production-proven since March 2026. Daily zaps and balance checks.

## Capabilities

| Command | What it does |
|---------|-------------|
| `balance` | Show wallet balance in sats + USD equivalent |
| `invoice <amount> [description]` | Create a Lightning invoice |
| `pay <bolt11>` | Pay a Lightning invoice |
| `zap <npub/hex> <amount>` | Zap a Nostr user (signs kind:9734 via daemon) |
| `spend-status` | Show daily spending against configurable limits |

## Architecture

```
Agent container
  → node /workspace/extra/nwc-wallet/index.js <command>
    → NWC relay (NIP-47 encrypted commands)
      → Your Lightning wallet (Alby, Mutiny, Zeus, etc.)
        → Lightning Network

Zap flow:
  Agent → signing daemon (kind:9734 zap request) → NWC relay → wallet → Lightning
```

## Prerequisites

### 1. A Lightning wallet with NWC support

Any NWC-compatible wallet:
- **Alby** (alby.com) — browser extension + hosted wallet
- **Mutiny** (mutinywallet.com) — self-custodial
- **Zeus** — connect to your own node
- **Rizful** — Lightning address provider with NWC

Get the NWC connection string from your wallet. It looks like:
```
nostr+walletconnect://pubkey?relay=wss://...&secret=hex
```

### 2. Nostr signing daemon (for zaps)

Zap requests need to be signed by your main Nostr identity. The signing daemon handles this — see `/add-nostr-dm` for setup. If you only need balance/pay/invoice (no zaps), the signing daemon is optional.

### 3. Spending config (optional)

Create `groups/<folder>/config/nwc.json`:

```json
{
  "nwcConnectionString": "nostr+walletconnect://...",
  "dailySpendLimitSats": 1000,
  "perTransactionLimitSats": 500
}
```

## Install

### Phase 1: Pre-flight

```bash
test -d tools/nwc-wallet && echo "Already installed" || echo "Ready to install"
```

### Phase 2: Apply

```bash
git fetch origin skill/nwc-wallet
git checkout origin/skill/nwc-wallet -- tools/nwc-wallet/ .claude/skills/add-nwc-wallet/
cd tools/nwc-wallet && npm install && cd ../..
```

Add the mount to your agent group's `groups/<folder>/container.json`:

```json
{
  "additionalMounts": [
    {
      "hostPath": "~/NanoClaw/tools/nwc-wallet",
      "containerPath": "nwc-wallet",
      "readonly": true
    }
  ]
}
```

Add to mount allowlist (`~/.config/nanoclaw/mount-allowlist.json`):

```json
{
  "allowedRoots": [
    { "path": "/home/YOU/NanoClaw/tools", "allowReadWrite": false }
  ]
}
```

Create the config file:

```bash
mkdir -p groups/<folder>/config
cat > groups/<folder>/config/nwc.json << 'EOF'
{
  "nwcConnectionString": "nostr+walletconnect://YOUR_CONNECTION_STRING",
  "dailySpendLimitSats": 1000,
  "perTransactionLimitSats": 500
}
EOF
```

### Phase 3: Restart

```bash
systemctl --user restart nanoclaw
```

## Usage

The agent calls the wallet CLI directly:

```bash
node /workspace/extra/nwc-wallet/index.js balance
node /workspace/extra/nwc-wallet/index.js invoice 1000 "Thanks for the coffee"
node /workspace/extra/nwc-wallet/index.js pay lnbc1...
node /workspace/extra/nwc-wallet/index.js zap npub1abc... 100
node /workspace/extra/nwc-wallet/index.js spend-status
```

Or tell the agent in natural language: "Check my Lightning balance" or "Zap @fiatjaf 500 sats".

## Spending limits

The `dailySpendLimitSats` and `perTransactionLimitSats` in `nwc.json` are enforced client-side. The wallet tracks daily spending in `groups/<folder>/config/spending.json` (auto-created). Resets at midnight UTC.

## npm dependencies

- `nostr-tools` — NIP-47 protocol, NIP-04 encryption, event signing
- `ws` — WebSocket for relay connections

## Troubleshooting

| Problem | Cause | Fix |
|---------|-------|-----|
| `nwc.json not found` | Config not created | Create at `groups/<folder>/config/nwc.json` |
| `Connection timeout` | NWC relay unreachable | Check the relay URL in connection string |
| `Spending limit exceeded` | Daily cap hit | Increase `dailySpendLimitSats` or wait for midnight UTC reset |
| `Zap failed: signer unavailable` | Signing daemon not running | `systemctl --user status nostr-signer` |
| Mount rejected | Path not in allowlist | Add `tools` to mount-allowlist.json |

## Removal

```bash
rm -rf tools/nwc-wallet
# Remove mount from groups/*/container.json
systemctl --user restart nanoclaw
```
