# Matrix cross-signing for the NanoClaw bot device

This documents the `matrix-bot-sdk` patch that lets the NanoClaw Matrix bot
**publish a cross-signing identity and self-sign its own device**, so it shows
as a verified (green) device in Element X without any manual verification step.

**Status: working.** Cross-signing, 4S/SSSS key backup, and the green shield
have all been verified against a live self-hosted Synapse with Element X.

---

## TL;DR

- Stock `matrix-bot-sdk@0.8.0` cannot drive cross-signing. Its request runner
  throws on `SignatureUpload`/`KeysBackup` request types, and 0.4.0 of the
  native binding discards the upload requests from `bootstrapCrossSigning`.
- We patch `matrix-bot-sdk` (`patches/matrix-bot-sdk@0.8.0.patch`) to add the
  request handlers and new methods on `RustEngine`.
- We pin `@matrix-org/matrix-sdk-crypto-nodejs` to **0.6.1** (overrides entry
  in `pnpm-workspace.yaml`) — the first version that returns upload requests
  from `bootstrapCrossSigning`.
- The adapter calls the patch methods when `MATRIX_RECOVERY_KEY` is set,
  **idempotently** on every start and **strictly non-fatally**.

---

## Why the patch was necessary

### The request runner blocks it

`RustEngine.runOnly()` is the single loop that drives all E2EE traffic. Two
cases threw unconditionally:

```js
case 4 /* SignatureUpload */: throw new Error("Bindings error: Backup feature not possible");
case 6 /* KeysBackup */:      throw new Error("Bindings error: Backup feature not possible");
```

Triggering anything that enqueues those types (cross-signing, key backup)
crashed normal E2EE traffic too.

### The 0.4.0 binding discarded the upload requests

`@matrix-org/matrix-sdk-crypto-nodejs@0.4.0`'s `bootstrapCrossSigning(reset)`
returned `void`. The underlying Rust machine creates the identity locally and
returns the upload requests to the caller — but the 0.4.0 NAPI wrapper
discarded them. The result: local cross-signing state flipped to
`hasMaster/hasSelfSigning = true`, but no requests were ever sent to the
server.

**What changed in 0.5.0+:** `bootstrapCrossSigning` was changed to return
`CrossSigningBootstrapRequests`:

```ts
class CrossSigningBootstrapRequests {
  readonly uploadKeysReq?: KeysUploadRequest;
  readonly uploadSigningKeysReq: string;          // body for /keys/device_signing/upload (UIA)
  readonly uploadSignaturesReq: SignatureUploadRequest;
}
```

With 0.5.0+ the upload requests are retrievable. The patch drives exactly that
shape. We pin 0.6.1 (vs 0.5.0) because it also fixes CVE-2026-45056 and its
prebuilt binaries are available for Node 24.

---

## The `matrix-bot-sdk` patch

File: `patches/matrix-bot-sdk@0.8.0.patch`. Applied automatically by pnpm via
`patchedDependencies` in `pnpm-workspace.yaml`. Changes to `RustEngine`:

1. **`SignatureUpload` handler** — `POST /_matrix/client/v3/keys/signatures/upload`
   with the request body, then `machine.markRequestAsSent(id, type, response)`.
   Skips `markRequestAsSent` for the bootstrap signature request (which has an
   empty `request.id`).

2. **`KeysBackup` handler** — looks up the active backup version, then
   `PUT /room_keys/keys?version=…` and marks sent.

3. **`bootstrapCrossSigning(uiaCallback, reset=false)`** (new method) — the
   missing piece:
   - Calls `machine.bootstrapCrossSigning(reset)` and reads the returned
     requests (throws a clear error if binding returns `void`, i.e. too old).
   - Uploads device keys via `/keys/upload` if present.
   - **POSTs cross-signing keys to `/keys/device_signing/upload`**, driving the
     UIA challenge (see below).
   - Uploads the self-signature via the `SignatureUpload` path.
   - **Fixes the `SignatureUpload` envelope bug**: the binding returns
     `{ signed_keys: {...} }` but the server expects the inner map directly.
     Without the unwrap, the server sees `"signed_keys"` as a user id and
     rejects with a "leading sigil" deserialization error.

4. **`bootstrapSecretStorageFromPassphrase(passphrase, opts)`** (new method) —
   derives an SSSS key from a passphrase (PBKDF2 + the Rust machine's key
   derivation), then calls `bootstrapSecretStorage`. This keeps the
   `@matrix-org/matrix-sdk-crypto-nodejs` import inside the CJS patch context
   where it's in scope, avoiding pnpm isolation issues that would prevent
   nanoclaw's ESM dist from importing the transitive dep directly.

5. **`enableKeyBackup(authData, algorithm?)`** (new) — creates/activates a
   server-side backup version.

### The UIA (User-Interactive Authentication) flow

`/keys/device_signing/upload` is UIA-protected:

1. POST the cross-signing keys with no `auth`.
2. Server replies **401** with `{ flows, params, session }`. matrix-bot-sdk's
   HTTP layer surfaces this by throwing the raw response object (not a
   `MatrixError`), so `extractUIA()` reads `statusCode === 401` + `body.flows`.
3. Call `uiaCallback(uia)` to get an `auth` dict. The adapter supplies an
   `m.login.password` stage using the bot's user id + password with the
   server's `session` threaded in.
4. Resubmit the same key body with `{ ...keys, auth }`.
5. Success → done. A rejected stage (Synapse returns 401 with both `flows` and
   `errcode`) surfaces as a credential rejection. Multi-stage flows loop up to a
   bounded attempt count.

> **Token-only auth:** UIA requires the bot's password. With
> `MATRIX_ACCESS_TOKEN` but no `MATRIX_PASSWORD`, bootstrap is skipped with a
> clear WARN. To use cross-signing with token auth, also set `MATRIX_PASSWORD`.

---

## Adapter wiring (`src/channels/matrix.ts`)

On startup, when `MATRIX_RECOVERY_KEY` is set and crypto is ready:

1. **Cross-signing** — checks `crossSigningStatus()`. If `hasMaster &&
   hasSelfSigning` are already true, skips. Otherwise calls
   `bootstrapCrossSigning(uiaCallback)`.
2. **4S/SSSS** — checks whether the megolm backup key is already in the crypto
   store. If yes, skips. Otherwise calls
   `bootstrapSecretStorageFromPassphrase(recoveryKey)`, which derives the SSSS
   key, uploads encrypted cross-signing private keys and the megolm backup
   decryption key to account data, and creates a server-side key backup version.

Both steps are **strictly non-fatal**: any failure logs a `WARN` and returns
without throwing into the message run loop.

---

## Requirements

| Requirement | Status |
|---|---|
| `matrix-bot-sdk` patch applied | ✅ Applied via `patchedDependencies` |
| `@matrix-org/matrix-sdk-crypto-nodejs` >= 0.5.0 | ✅ Pinned to 0.6.1 via `overrides` |
| `MATRIX_PASSWORD` set | Required for UIA on `/keys/device_signing/upload` |
| Node >= 24 | Required by the 0.6.1 prebuilt binary ABI |

---

## What is unit-tested

`src/channels/matrix-rustengine-patch.test.ts` — drives the patched
`RustEngine` with a mocked homeserver + mocked OlmMachine:

- `SignatureUpload` and `KeysBackup` handlers (correct endpoints +
  `markRequestAsSent`)
- Full UIA 401 → password → resubmit → success flow
- Credential-rejection and hard-error paths
- Too-old-binding guard
- `enableKeyBackup`
- `extractUIA` / `hasFailedUIA` helpers

`src/channels/matrix.test.ts` — adapter-level tests for `makeUIACallback`,
`bootstrapCrossSigning` (idempotent skip, success, non-fatal on throw, missing
patch, missing password, unreachable machine), and `adapter.setup()`.

---

## See also

- `docs/matrix-e2ee-native.md` — native E2EE adapter (persistence, device
  stability, full runbook).
- `patches/matrix-bot-sdk@0.8.0.patch` — the patch itself.
