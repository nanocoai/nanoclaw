---
name: x402-pay-with-safety
description: Make x402 micropayments (HTTP 402 Payment Required) using USDC on Base, with built-in prompt injection screening. Before committing any payment, screens the request context for injection attacks that could cause unauthorized payments. Use when calling paid APIs that return HTTP 402. Safety screening costs 0.005 USDC per request (optional — user controls this).
---

# x402-pay-with-safety

External skill for x402 micropayments on Base with built-in security. Before spending USDC, it screens the triggering prompt through the [Orac Safety Layer](https://orac-safety.orac.workers.dev) — a paid API that detects prompt injection attacks that could trick an agent into making unauthorized payments.

**Commercial note:** Safety screening costs 0.005 USDC per request, paid from the user's wallet to the Safety Layer API via x402. This is optional — pass `--no-safety-check` to skip it.

---

## Prerequisites

- Node.js 18+
- A Base mainnet wallet holding USDC
- `WALLET_PRIVATE_KEY` environment variable (never commit this)

---

## Install

```bash
git clone https://github.com/Orac-G/x402-pay-with-safety /path/to/nanoclaw/skills/x402-pay-with-safety
cd /path/to/nanoclaw/skills/x402-pay-with-safety
npm install
```

Add to `.env`:

```bash
WALLET_PRIVATE_KEY=0x...your_private_key...
```

---

## Usage

```bash
# Screen + pay for an API call
WALLET_PRIVATE_KEY=0x... node pay.js \
  --url https://api.example.com/v1/endpoint \
  --body '{"query": "some request"}' \
  --context "The user prompt that triggered this payment"

# Skip safety screening (saves 0.005 USDC)
WALLET_PRIVATE_KEY=0x... node pay.js \
  --url https://api.example.com/v1/endpoint \
  --body '{"query": "some request"}' \
  --no-safety-check

# JSON output for scripting
WALLET_PRIVATE_KEY=0x... node pay.js \
  --url https://api.example.com/v1/endpoint \
  --body '{"query": "some request"}' \
  --context "prompt context" \
  --json
```

---

## Payment Flow

```
1. Safety Screen (unless --no-safety-check):
   POST context to Orac Safety Layer (/v1/scan)
   Costs 0.005 USDC, paid via x402
   MALICIOUS → abort, exit(2)
   SUSPICIOUS → warn, continue
   BENIGN → continue

2. Make Request:
   POST --url with --body
   200 → return response (no payment needed)
   402 → parse payment requirements

3. Pay:
   Sign EIP-712 USDC transfer on Base
   Retry with X-Payment header
   Return API response
```

---

## Options

| Flag | Description |
|------|-------------|
| `--url <url>` | Target API URL (required) |
| `--body <json>` | Request body as JSON string (default: `{}`) |
| `--context <text>` | Prompt that triggered this payment — used for injection screening |
| `--no-safety-check` | Skip safety screening |
| `--json` | Machine-readable output |

---

## Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Success |
| `1` | Error (network, signing failure) |
| `2` | Blocked — Safety Layer detected MALICIOUS prompt |

---

## Security

The Safety Layer screens for prompt injection, social engineering, authorization bypass, and payload exfiltration patterns.

Source: [github.com/Orac-G/x402-pay-with-safety](https://github.com/Orac-G/x402-pay-with-safety)
