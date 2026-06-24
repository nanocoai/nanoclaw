# Matrix native E2EE adapter — verification & runbook

The Matrix channel adapter (`src/channels/matrix.ts`) does **sound, persistent,
end-to-end-encrypted** Matrix in the Node host. This document explains why it
is sound, how to configure it, and a live runbook to verify real E2E against a
self-hosted Synapse using Element X on a phone.

## Why this adapter is sound (and the old one was not)

NanoClaw's host is Node. The previous Matrix adapter wrapped
`@beeper/chat-adapter-matrix` → `matrix-js-sdk` → the **WASM** crypto binding
`matrix-sdk-crypto-wasm`. That binding only persists its store to
**IndexedDB**, which does not exist in Node:

- In-memory crypto means a **brand-new device and lost room keys on every
  host restart** — unsound.
- IndexedDB shims (`indexeddbshim` / `fake-indexeddb`) **fail during the
  RustCrypto store migration** with `"transaction not active"`
  (matrix-sdk-crypto-wasm#195).

This adapter builds on **`matrix-bot-sdk`** with the **native** Rust crypto
binding `@matrix-org/matrix-sdk-crypto-nodejs`. The native binding has a
filesystem **store** (`RustSdkCryptoStorageProvider`), so device identity and
room keys persist to a directory on disk and survive restarts.

```
data/v2-matrix-crypto/    ← native crypto store (device identity + room keys)
data/v2-matrix-store.json ← sync token + persisted access token
```

## What is supported

| Capability | Status |
|---|---|
| Persistent device identity + room keys across restarts | ✅ Native FS crypto store |
| Stable device id | ✅ Seeded from server-assigned device id on first login; reused from the crypto store on every subsequent restart |
| Transparent encryption in encrypted rooms | ✅ `sendText` encrypts automatically |
| Decrypting inbound encrypted events | ✅ Re-emitted as plaintext `room.message` |
| Auto-join DM invites | ✅ `MATRIX_INVITE_AUTOJOIN` (default true) |
| Password **or** access-token login | ✅ |
| **Cross-signing bootstrap** | ✅ Self-signs device on first start with `MATRIX_RECOVERY_KEY` set |
| **4S/SSSS key backup** | ✅ Uploads encrypted cross-signing private keys + megolm backup key to account data |
| **Recovery-key restore** | ✅ Provide same `MATRIX_RECOVERY_KEY` to restore keys from account data |

Cross-signing and 4S are both **idempotent**: subsequent restarts skip
re-bootstrap when the device is already cross-signed and key backup already
exists.

## Environment variables

```bash
# Homeserver (required)
MATRIX_BASE_URL=https://matrix.your-tailnet.ts.net

# Auth — pick ONE method:
#   A) username + password (token is fetched once and persisted)
MATRIX_USERNAME=nanoclaw          # localpart only, no @ or :server
MATRIX_PASSWORD=...
#   B) access token
# MATRIX_ACCESS_TOKEN=syt_...
# MATRIX_USER_ID=@nanoclaw:your-tailnet.ts.net

# Stable device id — generate once, never change
MATRIX_DEVICE_ID=NANOCLAWBOT

# Recovery passphrase — enables cross-signing + 4S/SSSS key backup
MATRIX_RECOVERY_KEY=a-long-random-passphrase

# Persistence (defaults shown) — must survive restarts
MATRIX_CRYPTO_STORE_PATH=data/v2-matrix-crypto
MATRIX_STORE_PATH=data/v2-matrix-store.json

# Optional
MATRIX_INVITE_AUTOJOIN=true
MATRIX_INVITE_AUTOJOIN_ALLOWLIST=@you:your-server   # only accept invites from these users
MATRIX_BOT_USERNAME="NanoClaw"
```

`MATRIX_RECOVERY_KEY` is the single anchor for recovery. It is used for two
independent purposes:

1. **SSSS key derivation** — derives a key via PBKDF2, uploads encrypted
   cross-signing private keys and the megolm backup decryption key to account
   data.
2. **age private key encryption** — if you've followed the `/setup-private-matrix`
   runbook, this same passphrase decrypts the age private key that protects
   your Synapse backups.

Generate a strong value: `openssl rand -base64 32`. Store it in a password
manager — it cannot be recovered if lost.

> **`MATRIX_DEVICE_ID` and device-id stability.** The crypto store's device id
> must equal the device id the homeserver bound to the access token. With
> **password auth** the homeserver assigns the device id; the adapter seeds the
> crypto store from the server-authoritative `whoami` value on first run, and
> `MATRIX_DEVICE_ID` is used as the device's display name. Stability comes from
> the persisted access token + crypto store. With **token auth**, the store is
> seeded from that token's device.

After editing `.env`, sync it for the host:

```bash
mkdir -p data/env && cp .env data/env/env
```

## Live verification runbook

### Prerequisites

1. A self-hosted **Synapse** homeserver, reachable from the host over Tailscale.
   Confirm: `curl -sS $MATRIX_BASE_URL/_matrix/client/versions | head -c 200`
2. A **bot account** on that server with credentials in `.env`.
3. **Element X** on your phone, signed into your **personal** account on the
   same homeserver.
4. NanoClaw built and the Matrix channel wired to an agent group.

### Step 1 — First start: crypto store + cross-signing + 4S

Start the host. In `logs/nanoclaw.log` you should see, in order:

```
Matrix: created crypto store directory   path=".../data/v2-matrix-crypto"
Matrix: crypto ready                      deviceId="<DEVICE_ID>"
Cross-signing bootstrapped (new setup)
4S bootstrap done — keyBackupVersion="1"
Matrix: E2EE trust status                 crossSigningReady=true keyBackupVersion="1"
Matrix channel connected                  userId="@nanoclaw:<server>"
```

Record the `deviceId`. Confirm the store is on disk:

```bash
ls -la data/v2-matrix-crypto/
```

### Step 2 — Encrypted DM round-trip

1. From Element X, start a **new direct message** with `@nanoclaw:<server>`.
   Element creates an encrypted room and invites the bot. The bot auto-joins.
2. Send "hello bot". The host log shows:
   `Matrix message received  platformId="matrix:@you:<server>"`
3. The agent replies, arriving in Element **encrypted**. Decryption working
   in both directions is the core E2E proof.

### Step 3 — Persistence across restart

1. Note the bot `deviceId` from Step 1.
2. **Kill and restart the host.**
3. On restart the log must show:
   - `Matrix: reusing existing crypto store directory` (NOT "created")
   - `Matrix: crypto ready  deviceId="<SAME DEVICE_ID>"` — identical to before
   - `4S already set up (backup key in crypto store) — skipping re-bootstrap`
   - `Cross-signing already set up — skipping re-bootstrap`
4. In Element, open the same DM. Older messages still decrypt (no red
   padlocks). Send a new message; the bot replies in the same encrypted room.

### Step 4 — Verify the green shield

The bot self-signs its device on first start, so no manual verification is
needed. In Element X:

1. Open the DM with the bot → tap the bot's avatar → **View profile**.
2. The bot's device should show a **green shield / verified** state.

If the shield is not green, check the log for `Cross-signing bootstrapped` or
any WARN after it. The most common cause is `MATRIX_PASSWORD` not being set
(UIA requires the bot's password even with token auth).

### Step 5 — Group room (optional)

1. Create an encrypted room in Element, invite the bot; it auto-joins.
2. Send a message. Host log: `Matrix message received ... isGroup=true`.
3. The agent replies encrypted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Matrix: created crypto store directory` on **every** restart | The store path isn't persisting. Point `MATRIX_CRYPTO_STORE_PATH` at a durable path. |
| New `deviceId` on each restart | With password auth, the token isn't being reused — check `data/v2-matrix-store.json` contains `nanoclaw.matrix.accessToken`. |
| Element shows "Unable to decrypt" for bot replies | Verify the bot device (Step 4), or confirm `Matrix: crypto ready` appears in logs. |
| `Matrix: crypto provider unavailable` | Native binding failed to load. Requires Node 24+; run `pnpm rebuild` after a Node upgrade. |
| No green shield | Check logs for WARN after `Cross-signing bootstrap`. Ensure `MATRIX_PASSWORD` is set (UIA needs it even with token auth). |
| `401 / M_UNKNOWN_TOKEN` at start | Stale persisted token. Delete `data/v2-matrix-store.json` to force fresh login; do NOT delete `data/v2-matrix-crypto`. |
| `M_BAD_JSON: Provided device_id … does not match` | The crypto store's device id disagrees with the session. Delete both `data/v2-matrix-crypto` and `data/v2-matrix-store.json` and restart (loses old room keys). |
| Bot never receives messages | Confirm the bot auto-joined the room (`MATRIX_INVITE_AUTOJOIN` not `false`) and the host can reach `MATRIX_BASE_URL`. |

## Supply-chain notes

- **`matrix-bot-sdk@0.8.0`** (pinned). Pulls
  `@matrix-org/matrix-sdk-crypto-nodejs`, overridden to **0.6.1** via
  `pnpm-workspace.yaml` `overrides`. 0.6.1 is the first version with
  `bootstrapCrossSigning` returning upload requests (0.4.0 returns `void`),
  includes a High-severity crypto CVE fix (CVE-2026-45056), and requires
  Node >= 24.
- **`patches/matrix-bot-sdk@0.8.0.patch`** — adds `bootstrapCrossSigning`,
  `bootstrapSecretStorageFromPassphrase`, and fixes the `SignatureUpload`
  envelope unwrapping bug. Applied via `pnpm-workspace.yaml`
  `patchedDependencies`. See `matrix-cross-signing.md` for details.
- **Native build**: `@matrix-org/matrix-sdk-crypto-nodejs` ships prebuilt
  binaries downloaded by its `postinstall` script. No Rust toolchain required.
  Listed in `onlyBuiltDependencies` (human-approved).
- **Removed**: `@beeper/chat-adapter-matrix`, `matrix-js-sdk`, WASM crypto,
  the old ESM-patch step.
