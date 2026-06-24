# Matrix native E2EE adapter — verification & runbook

The Matrix channel adapter (`src/channels/matrix.ts`) does **sound, persistent,
end-to-end-encrypted** Matrix in the Node host. This document explains why it
is sound, how to configure it, and a precise live runbook to verify real E2E
against a self-hosted Synapse (reached over Tailscale) using Element X on a
phone.

## Why this adapter is sound (and the old one was not)

NanoClaw's host is Node. The previous Matrix adapter wrapped
`@beeper/chat-adapter-matrix` → `matrix-js-sdk` → the **WASM** crypto binding
`matrix-sdk-crypto-wasm`. That binding only persists its store to
**IndexedDB**, which does not exist in Node:

- In-memory crypto (`useIndexedDB:false`) means a **brand-new device and lost
  room keys on every host restart** — unsound.
- IndexedDB shims (`indexeddbshim` / `fake-indexeddb`) **fail during the
  RustCrypto store migration** with `"transaction not active"`
  (matrix-sdk-crypto-wasm#195).

So the WASM path cannot do sound persistent E2E in Node.

This adapter instead builds on **`matrix-bot-sdk`**, which integrates the
**native** Rust crypto binding `@matrix-org/matrix-sdk-crypto-nodejs` (same Rust
core as the WASM binding, compiled as a native Node addon). The native binding
has a filesystem **store** (`RustSdkCryptoStorageProvider`), so the device
identity and room keys persist to a directory on disk and survive restarts.

```
data/v2-matrix-crypto/    ← native crypto store (device identity + room keys)
data/v2-matrix-store.json ← sync token + persisted access token (FS store)
```

## What is and is NOT supported

| Capability | Status |
|---|---|
| Persistent device identity + room keys across restarts | ✅ Native FS crypto store |
| Stable device id | ✅ Reused from the crypto store; on first run seeded from the **server-assigned** device id (the crypto store must agree with the session's device — see note below) |
| Transparent encryption when a room is encrypted | ✅ `sendText` encrypts automatically once crypto is prepared |
| Decrypting inbound encrypted events | ✅ Re-emitted as plaintext `room.message` |
| Auto-join DM invites | ✅ `MATRIX_INVITE_AUTOJOIN` (default true) |
| Password **or** access-token login | ✅ |
| Interactive device verification (from another client) | ✅ Possible after the device is known to the homeserver |
| **Cross-signing bootstrap / server-side key backup / recovery-key import** | ❌ **Not supported** — see below |

### The `MATRIX_RECOVERY_KEY` limitation (read this — it's a real SDK wall)

This was investigated down to the binding level, not assumed:

- The **native** `OlmMachine` (`@matrix-org/matrix-sdk-crypto-nodejs@0.4.0`)
  *does* have `bootstrapCrossSigning(reset)`, `enableBackupV1()`,
  `backupRoomKeys()`, `crossSigningStatus()`, and `getBackupKeys()`.
- **But `matrix-bot-sdk@0.8.0` cannot drive the write paths.** Its outgoing-
  request runner (`RustEngine.runOnly`) explicitly **throws** on the two request
  types those operations enqueue:

  ```js
  case 4 /* SignatureUpload */: throw new Error("Bindings error: Backup feature not possible");
  case 6 /* KeysBackup */:      throw new Error("Bindings error: Backup feature not possible");
  ```

  So calling `bootstrapCrossSigning` / `enableBackupV1` and then letting the SDK
  run its loop would **throw and crash the entire crypto run loop** — which also
  drives normal key uploads and room-key sharing, i.e. it would break ordinary
  message sending, not just cross-signing.
- The 0.4.0 binding also exposes **no room-key import** API (only
  `exportRoomKeysForSession`), so there is no sound way to *restore* a
  recovery-key backup into the store either.

Conclusion: cross-signing bootstrap and recovery-key backup/restore are
**genuinely not possible** through this SDK without re-implementing its entire
outgoing-request pipeline (plus UIA) — out of scope for this adapter. We
deliberately do **not** trigger those paths.

Consequences:

- Setting `MATRIX_RECOVERY_KEY` has **no effect**. At startup the adapter does a
  **read-only** check of cross-signing + key-backup state (`crossSigningStatus()`
  / `getBackupKeys()` — neither enqueues a request, so neither hits the throw)
  and logs the real status, plus a clear `WARN` if the recovery key is set,
  rather than silently pretending it took effect.
- The bot's keys are still **persisted soundly on disk** — nothing is lost
  across restarts, and history the bot has the keys for still decrypts.
- The bot device starts **unverified**. You can verify it interactively from
  another logged-in session (see the runbook), which is the normal path for a
  bot.
- The diagnostic reaches the OlmMachine through matrix-bot-sdk's `@internal`
  `crypto.engine.machine` field. If a future SDK bump renames or restructures
  that field, the adapter does **not** go silently blind — it logs a loud `WARN`
  ("the internal OlmMachine read-only API could not be reached … likely changed
  its internal shape") so you know to revisit `reportCryptoStatus`. E2EE message
  handling itself is unaffected; only the diagnostic depends on the internal
  field.

If `matrix-bot-sdk` later lands SignatureUpload/KeysBackup support (the native
machine is already capable), this adapter can bootstrap cross-signing + key
backup with little extra code — revisit this section then.

## Environment variables

```bash
# Homeserver (required)
MATRIX_BASE_URL=https://matrix.your-tailnet.ts.net

# Auth — pick ONE method:
#   A) access token (recommended for production)
MATRIX_ACCESS_TOKEN=syt_...
MATRIX_USER_ID=@nanoclaw:your-tailnet.ts.net
#   B) username + password (token is fetched once and persisted)
# MATRIX_USERNAME=nanoclaw
# MATRIX_PASSWORD=...

# Persistence (defaults shown). MUST persist across restarts.
MATRIX_CRYPTO_STORE_PATH=data/v2-matrix-crypto
MATRIX_STORE_PATH=data/v2-matrix-store.json

# Optional
MATRIX_DEVICE_ID=NANOCLAW01          # device DISPLAY NAME at password login (see note)
MATRIX_INVITE_AUTOJOIN=true          # auto-accept room invites (default true)
MATRIX_RECOVERY_KEY=...              # NO EFFECT (see limitation above) — warns at boot
```

> **`MATRIX_DEVICE_ID` and device-id stability.** The crypto store's device id
> must equal the device id the homeserver bound to the access token, otherwise
> the server rejects the device-key upload with `M_BAD_JSON ("Provided device_id
> … does not match")`. With **password auth** the homeserver *assigns* the
> device id, so the adapter seeds the crypto store from the server-authoritative
> `whoami` value on first run, and `MATRIX_DEVICE_ID` is used only as the
> device's display name. Stability comes from the persisted access token +
> crypto store (the same device is reused on every restart). With **token auth**,
> supply a `MATRIX_ACCESS_TOKEN` already bound to a device; the store is seeded
> from that token's device. Do not expect `MATRIX_DEVICE_ID` to force a specific
> id on a fresh password login — it can't.

After editing `.env`, sync it for the host:

```bash
mkdir -p data/env && cp .env data/env/env
```

> The bot needs its **own** Matrix account, separate from your personal
> account — Matrix cannot DM yourself. Register e.g. `@nanoclaw:<server>`.

## Live verification runbook

You cannot fully verify E2E without a real client, homeserver, and phone. This
is the manual procedure.

### Prerequisites

1. A self-hosted **Synapse** homeserver, reachable from the host over
   **Tailscale** (e.g. `https://matrix.<tailnet>.ts.net`). Confirm the host can
   reach it: `curl -sS $MATRIX_BASE_URL/_matrix/client/versions | head -c 200`.
2. A **bot account** on that server (`@nanoclaw:<server>`) with an access token
   or password in `.env`.
3. **Element X** (or Element Web/Desktop) on your phone, signed in to your
   **personal** account on the same homeserver.
4. NanoClaw built and the Matrix channel wired to an agent group
   (`/manage-channels`).

### Step 1 — First start: crypto store is created

Start the host (`pnpm run dev`, or your service). In `logs/nanoclaw.log` you
should see, in order:

```
Matrix: created crypto store directory   path=".../data/v2-matrix-crypto"
Matrix: crypto ready                      deviceId="<DEVICE_ID>" cryptoStore=".../data/v2-matrix-crypto"
Matrix: E2EE trust status                 crossSigningReady=false keyBackupVersion=null
Matrix channel connected                  userId="@nanoclaw:<server>"
```

(`crossSigningReady=false` is expected for a fresh bot — the device is
unverified until you verify it from another session; see Step 4.)

Record the `deviceId`. Confirm the store is on disk and non-empty:

```bash
ls -la data/v2-matrix-crypto/        # should contain the rust-sdk sqlite store + bot-sdk.json
```

### Step 2 — Encrypted DM round-trip

1. From Element on your phone, start a **new direct message** with
   `@nanoclaw:<server>`. Element creates an **encrypted** room and invites the
   bot. The bot auto-joins (you'll see `room.join` activity in the host log).
2. Send "hello bot". The host log shows:
   `Matrix message received  platformId="matrix:@you:<server>" isGroup=false`.
3. The agent replies. The reply arrives in Element **encrypted** (padlock /
   "Encrypted" indicator on the message). Decryption working in both directions
   over an encrypted room is the core E2E proof.

### Step 3 — Persistence across restart (the whole point)

This proves the store is sound — same device, no re-keying, history decrypts.

1. Note the bot `deviceId` from Step 1.
2. **Kill and restart the host** (`launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
   on macOS, `systemctl --user restart nanoclaw` on Linux, or stop/start
   `pnpm run dev`).
3. On restart the log must show:
   - `Matrix: reusing existing crypto store directory` (NOT "created")
   - `Matrix: crypto ready  deviceId="<SAME DEVICE_ID>"` — **identical** to before.
   - If using password auth: `Matrix: reusing persisted access token (stable device)`
     (NOT "performing password login").
4. In Element, open the **same DM**. Older messages still show decrypted (no
   "Unable to decrypt" / red padlocks for messages the bot already had keys
   for). Send a new message; the bot replies in the same encrypted room.
5. In Element → your profile → **Sessions/Devices**, confirm there is **one**
   bot device with the recorded device id — a new device id or a second bot
   device on each restart would indicate the store is NOT persisting (the old
   unsound behavior).

### Step 4 — Verify the bot device (cross-signing from your client)

The bot device starts **unverified** (the adapter cannot self-cross-sign — see
the limitation). To trust it:

1. In Element, open the DM with the bot → room info → **People** → the bot →
   **its device**. Element shows the device id; it will be marked unverified.
2. Use Element's manual verification (compare the device's public key /
   "verify manually") to mark it verified. There is no SAS emoji handshake from
   the bot side — this is one-directional manual trust, which is expected for a
   headless bot without cross-signing.

After verification the messages from the bot show a verified shield in Element.

### Step 5 — Group room (optional)

1. Create an **encrypted** room in Element, invite the bot; it auto-joins.
2. Send a message. Host log: `Matrix message received ... isGroup=true`,
   `platformId="matrix:!roomid:<server>"`.
3. The agent replies into the room, encrypted.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Matrix: created crypto store directory` on **every** restart | The store path isn't persisting (ephemeral mount, wrong cwd, or `data/` wiped). Point `MATRIX_CRYPTO_STORE_PATH` at a durable path. |
| New `deviceId` / second bot device on each restart | With password auth, the token isn't being persisted/reused — check `data/v2-matrix-store.json` contains `nanoclaw.matrix.accessToken`, and that `MATRIX_STORE_PATH` is durable. With token auth, the same `MATRIX_ACCESS_TOKEN` must be reused. |
| Element shows "Unable to decrypt" for the bot's replies | The bot device is a fresh/unknown device to your client — verify it (Step 4), or the room key wasn't shared. Confirm `Matrix: crypto ready` appears (not the `crypto provider unavailable` warning). |
| `Matrix: crypto provider unavailable — E2EE rooms will NOT decrypt` | The native binding failed to load. Reinstall: `pnpm install` (the postinstall downloads the prebuilt `.node`). Check the binary exists under `node_modules/.pnpm/@matrix-org+matrix-sdk-crypto-nodejs@*/`. |
| `MATRIX_RECOVERY_KEY is set, but matrix-bot-sdk cannot bootstrap or restore…` warning | Expected. matrix-bot-sdk's request runner throws on the backup/cross-signing request types (see limitation). Remove the var or ignore the warning. |
| `the internal OlmMachine read-only API could not be reached … changed its internal shape` warning | matrix-bot-sdk was upgraded and renamed/restructured its internal `crypto.engine.machine` field. E2EE still works; only the cross-signing/key-backup diagnostic is blind. Revisit `extractReadonlyMachine` / `reportCryptoStatus` in `src/channels/matrix.ts` against the new SDK. |
| Bot never receives messages | Confirm the bot auto-joined the room (`MATRIX_INVITE_AUTOJOIN` not `false`), and that the host can reach `MATRIX_BASE_URL` over Tailscale. |
| `401 / M_UNKNOWN_TOKEN` at start | Stale persisted token. With password auth, delete the `nanoclaw.matrix.accessToken` entry (or `data/v2-matrix-store.json`) to force a fresh login; do **not** delete `data/v2-matrix-crypto` (that would lose the device + keys). |
| `M_BAD_JSON: Provided device_id in device_keys does not match …` at start | The crypto store's device id disagrees with the session's device — happens if the store was seeded with a device id that doesn't match the access token (e.g. a stale store paired with a fresh login, or an old build that pre-seeded `MATRIX_DEVICE_ID`). Fix: delete **both** `data/v2-matrix-crypto` and `data/v2-matrix-store.json` so a clean login reseeds the store from the server-assigned device id, then restart. (Deleting the crypto store discards old room keys; undecryptable history can be re-shared by the sender or recovered only via key backup, which this adapter can't restore — so do this only on a fresh/test bot.) |

## Supply-chain notes (what was added)

- **Dependency**: `matrix-bot-sdk@0.8.0` (pinned), which pulls
  `@matrix-org/matrix-sdk-crypto-nodejs@0.4.0` (pinned via the SDK's `^0.4.0`,
  whose only stable 0.4.x is 0.4.0).
- **Native build**: `@matrix-org/matrix-sdk-crypto-nodejs` ships **prebuilt
  binaries**. Its `postinstall` (`download-lib.js`) downloads the platform
  `.node` (e.g. `matrix-sdk-crypto.darwin-arm64.node`) from the project's GitHub
  releases. **No Rust toolchain is required.** Because it runs an install
  script, the package is listed in `onlyBuiltDependencies` in
  `pnpm-workspace.yaml` (human-approved).
- **`minimumReleaseAge` (3 days)**: both packages were published 2026-01-16 —
  far older than 3 days — so **no `minimumReleaseAgeExclude` entry is needed**.
  (If you bump to a version published <3 days ago, pnpm will block it; add a
  pinned `name@version` exclude only with human sign-off.)
- **Removed**: this adapter no longer uses `matrix-js-sdk`,
  `@beeper/chat-adapter-matrix`, or any IndexedDB/WASM crypto. The old ESM-patch
  step from the Chat-SDK install is no longer relevant.
```
