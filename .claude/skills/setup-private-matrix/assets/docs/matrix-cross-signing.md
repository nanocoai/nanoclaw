# Matrix cross-signing for the NanoClaw bot device

This documents the work that lets the NanoClaw Matrix bot **publish a
cross-signing identity and self-sign its own device**, so it stops showing as an
unverified (red) device in Element. It covers the `matrix-bot-sdk` patch, the
adapter wiring, the User-Interactive Auth (UIA) flow, what is unit-tested vs.
what still needs **live human verification**, what is deferred, and the
binding/Node version requirements.

> **Status honesty.** Everything here is **built + unit-tested with no live
> homeserver and no running service**. The author did **not** run it against a
> real homeserver, phone, or Element — that is the human live-verification step
> in the runbook at the bottom. There is also a hard **version gate** (see
> "Requirements") without which the bootstrap cannot publish keys; read that
> first.

---

## TL;DR

- Stock `matrix-bot-sdk@0.8.0` **cannot** drive cross-signing. Its request
  runner throws on the `SignatureUpload`/`KeysBackup` request types, and the
  cross-signing public-key upload is not an outgoing-queue request at all.
- We patch `matrix-bot-sdk` (`patches/matrix-bot-sdk@0.8.0.patch`, applied via
  pnpm `patchedDependencies`) to:
  1. turn the two throwing request-type cases into real HTTP handlers, and
  2. add `RustEngine.bootstrapCrossSigning(uiaCallback, reset)`, which publishes
     the cross-signing keys (with UIA) and self-signs the device.
- The Matrix adapter (`src/channels/matrix.ts`) calls that method when
  `MATRIX_RECOVERY_KEY` is set and crypto is ready — **idempotently** and
  **strictly non-fatally** (a failure logs a WARN; message flow never breaks).
- **Requirement (hard gate):** the native crypto binding
  `@matrix-org/matrix-sdk-crypto-nodejs` must be **>= 0.5.0**. The version
  currently pinned on the `feat/matrix-native-e2ee` branch is **0.4.0**, which
  **discards** the cross-signing upload requests and returns `void`, so with
  0.4.0 the bot device will **not** go green. See "Requirements".

---

## The problem (diagnosed at the binding level)

The native `OlmMachine` (`@matrix-org/matrix-sdk-crypto-nodejs`) has
`bootstrapCrossSigning()`, `crossSigningStatus()`, `enableBackupV1()`,
`backupRoomKeys()`. But `matrix-bot-sdk@0.8.0` cannot get the keys to the server:

1. **The request runner throws.** `RustEngine.runOnly()` is a single `switch`
   over the outgoing-request queue that also handles ordinary send/receive. Two
   cases throw:

   ```js
   case 4 /* SignatureUpload */: throw new Error("Bindings error: Backup feature not possible");
   case 6 /* KeysBackup */:      throw new Error("Bindings error: Backup feature not possible");
   ```

   Because they live in the **shared** loop, triggering anything that enqueues
   them crashes normal E2EE traffic too.

2. **The cross-signing public-key upload never reaches the queue.** Empirically
   verified against the installed `0.4.0` binding (a local, offline probe — no
   homeserver): after `bootstrapCrossSigning(false)`, `crossSigningStatus()`
   flips to `hasMaster/hasSelfSigning/hasUserSigning = true` (the identity is
   created **locally**), but `outgoingRequests()` returns **only** `KeysUpload`
   and `KeysQuery` — no `SignatureUpload`, and no `device_signing/upload` request
   of any kind, across multiple drain rounds. In matrix-rust-sdk,
   `bootstrap_cross_signing` **returns** the upload requests for the caller to
   send; it does not enqueue them. The **`0.4.0` NAPI wrapper discards that
   return value** (`bootstrapCrossSigning(reset): Promise<void>`).

So on `0.4.0` there is genuinely **no API path** to publish the cross-signing
keys. The earlier adapter was correct to refuse to try.

**What changed:** `@matrix-org/matrix-sdk-crypto-nodejs@0.5.0` (PR #67, 2026-04-20)
changed `bootstrapCrossSigning` to **return** `CrossSigningBootstrapRequests`:

```ts
class CrossSigningBootstrapRequests {
  readonly uploadKeysReq?: KeysUploadRequest;   // device keys (may already be uploaded)
  readonly uploadSigningKeysReq: string;         // JSON body for /keys/device_signing/upload (no id; UIA required)
  readonly uploadSignaturesReq: SignatureUploadRequest; // self-signature
}
```

With **>= 0.5.0** the upload requests are retrievable, so cross-signing can be
published. The patch is written to drive exactly that shape.

---

## The `matrix-bot-sdk` patch

File: `patches/matrix-bot-sdk@0.8.0.patch` (pnpm `patchedDependencies` in
`pnpm-workspace.yaml`). It edits `src/e2ee/RustEngine.ts` (the upstream source,
for PR fidelity) and the shipped `lib/e2ee/RustEngine.js` + `.d.ts` (what
actually runs). Changes:

1. **`SignatureUpload` handler** — `POST /_matrix/client/v3/keys/signatures/upload`
   with the request body, then `machine.markRequestAsSent(id, type, response)`.
   No UIA on this endpoint.
2. **`KeysBackup` handler** — looks up the active backup version
   (`GET /room_keys/version`), then `PUT /room_keys/keys?version=…` and marks
   sent. If no backup version exists it throws a clear, actionable error rather
   than silently dropping room keys (key backup is otherwise deferred — see
   below).
3. **`bootstrapCrossSigning(uiaCallback, reset=false)`** (new public method) —
   the missing piece. It:
   - calls `machine.bootstrapCrossSigning(reset)` and reads the returned
     requests (throwing a clear error if the binding returns `void`, i.e. it is
     too old);
   - uploads device keys via the existing `/keys/upload` path if present;
   - **POSTs the cross-signing keys to `/keys/device_signing/upload`, driving
     the UIA challenge** (see next section);
   - uploads the self-signature via the `SignatureUpload` path.
4. **`enableKeyBackup(authData, algorithm?)`** (new) — creates/activates a
   server-side backup version. Plumbing for the deferred key-backup path.
5. Two small exported helpers, `extractUIA` / `hasFailedUIA`, for parsing the
   401 UIA response shape.

The patch is intentionally additive: ordinary `KeysUpload`/`KeysQuery`/
`KeysClaim`/`ToDevice` handling is untouched, so normal E2EE is unaffected.

### The UIA (User-Interactive Authentication) flow

`/keys/device_signing/upload` is UIA-protected. The flow the patch implements:

1. POST the cross-signing keys with **no** `auth`.
2. Server replies **401** with `{ flows, params, session }`. matrix-bot-sdk's
   HTTP layer surfaces a 401-with-no-`errcode` by `throw`ing the **raw response**
   object (not a `MatrixError`), so `extractUIA()` reads `statusCode === 401` +
   `body.flows`/`body.session`.
3. Call `uiaCallback(uia)` to get an `auth` dict. The adapter supplies an
   `m.login.password` stage built from the bot's own user id + password, with
   the server's `session` threaded in.
4. **Resubmit the same key body** with `{ ...keys, auth }`.
5. Success → done. Another 401 that still carries `flows` **and** an `errcode`
   (Synapse's way of signalling a rejected stage) → treated as a credential
   rejection and surfaced (no infinite loop). A 401/4xx with an `errcode` and no
   `flows` is re-thrown as-is. Multi-stage flows loop up to a bounded number of
   attempts.

---

## Adapter wiring (`src/channels/matrix.ts`)

- When `MATRIX_RECOVERY_KEY` is set **and** crypto is ready, `setup()` calls the
  `bootstrapCrossSigning(...)` helper.
- **Idempotent:** if `crossSigningStatus()` already shows `hasMaster &&
  hasSelfSigning`, it skips the upload entirely. The underlying
  `bootstrapCrossSigning(reset=false)` is itself idempotent (reuses the existing
  local identity; does not reset device trust).
- **Strictly non-fatal:** every failure path (binding too old, patch missing, no
  password for UIA, UIA rejected, machine unreachable) logs a `WARN` and returns
  `false`. It never throws into the run loop or message flow.
- **UIA needs the bot password.** The `m.login.password` stage uses
  `MATRIX_PASSWORD`. With **token-only** auth (no `MATRIX_PASSWORD`), there is no
  password to complete UIA, so bootstrap is skipped with a clear WARN. **To use
  cross-signing with token auth, also set `MATRIX_PASSWORD`** (the bot's account
  password) alongside the token.
- The startup crypto diagnostic now reports `crossSigningReady: true` once the
  device is cross-signed, and is honest about the deferred key-backup state.

---

## Requirements (read before expecting green)

| Requirement | Why | Current state on `feat/matrix-native-e2ee` |
|---|---|---|
| `matrix-bot-sdk` patch applied | Adds the request handlers + `bootstrapCrossSigning` | ✅ Applied via `patchedDependencies` |
| `@matrix-org/matrix-sdk-crypto-nodejs` **>= 0.5.0** | First version whose `bootstrapCrossSigning` **returns** the upload requests (0.4.0 returns `void`) | ❌ **0.4.0 is pinned** — must be bumped |
| `MATRIX_PASSWORD` available | Completes the `/keys/device_signing/upload` UIA password stage | Set it (even alongside `MATRIX_ACCESS_TOKEN`) |

### The crypto-binding bump is a human decision

Bumping `@matrix-org/matrix-sdk-crypto-nodejs` from 0.4.0 to 0.6.x is **not done
in this change** because it carries tradeoffs that need human sign-off:

- **Node version.** 0.5.0 dropped Node 22 and the 0.6.x line declares
  `engines: node >= 24`. This host currently runs **Node 22**. NAPI bindings are
  ABI-stable, so the prebuilt `.node` may well still load on Node 22, but it is
  officially unsupported and `engines` will warn. Bumping the binding may mean
  bumping Node.
- **Supply chain.** Per `CLAUDE.md`, runtime deps are pinned deliberately and
  never bumped blindly; a transitive-dep override needs review. (Note: 0.6.0 is
  a **High-severity** security fix, CVE-2026-45056 — an additional reason to
  bump, but still a human call.)
- **Store compatibility.** The native crypto store format should be re-validated
  across the bump on a **test** bot before touching a real one.

When the human bumps the binding (override the transitive
`@matrix-org/matrix-sdk-crypto-nodejs` to `>=0.5.0`, e.g. via a pnpm `overrides`
entry, pinned, with the supply-chain checks), the adapter publishes cross-signing
automatically on the next start with `MATRIX_RECOVERY_KEY` set. Until then it
logs a clear WARN that the binding is too old and the device stays unverified —
**no silent failure, no fake success.**

---

## What is deferred

- **Server-side key backup (room-key backup).** The patch adds the request
  plumbing (`KeysBackup` handler + `enableKeyBackup`), but the adapter does
  **not** enable it. The `0.4.0` binding exposes no room-key *import*, so a
  recovery-key backup cannot be *restored* into the store, and a one-sided backup
  adds risk/complexity without the restore half. Device keys persist soundly on
  disk across restarts regardless (the existing native FS crypto store). If/when
  key backup is wired, it builds on the handlers shipped here.

---

## What is unit-tested vs. what needs live verification

**Unit-tested (no homeserver, no service):**

- `src/channels/matrix-rustengine-patch.test.ts` — drives the **shipped patched**
  `RustEngine` (imported from the patched dep) with a mocked homeserver + mocked
  OlmMachine: the `SignatureUpload` and `KeysBackup` handlers (right endpoints +
  `markRequestAsSent`), the **full UIA 401 → password → resubmit → success**
  flow, credential-rejection and hard-error paths, the too-old-binding guard,
  `enableKeyBackup`, and the `extractUIA`/`hasFailedUIA` helpers.
- `src/channels/matrix.test.ts` — `makeUIACallback`, the `bootstrapCrossSigning`
  adapter helper (idempotent skip, success, **non-fatal** on throw, missing
  patch, missing password, unreachable machine), and `adapter.setup()` (triggers
  bootstrap when `MATRIX_RECOVERY_KEY` set, skips when unset, stays non-fatal,
  reports `crossSigningReady: true`).

**NOT done — must be verified by a human against a real homeserver/Element:**

- That a real Synapse accepts the `device_signing/upload` UIA password stage and
  the device actually turns **green/verified** in Element.
- That the bump to a `>= 0.5.0` binding loads on the host's Node version and
  keeps the existing crypto store sound across a restart.

---

## Live-verification runbook (human steps — the author did NOT run these)

> These touch the live install and restart the service. The agent that wrote
> this change did **not** run any of them.

1. **Bump the crypto binding (human supply-chain decision).** Override the
   transitive `@matrix-org/matrix-sdk-crypto-nodejs` to a pinned `>= 0.5.0`
   (e.g. via a pnpm `overrides` entry), run the supply-chain checks in
   `CLAUDE.md`, then `pnpm install`. Confirm the binding loads on this host's
   Node version; bump Node if required (0.6.x wants Node >= 24).
2. **Set env.** In `.env`, ensure `MATRIX_RECOVERY_KEY` is set **and**
   `MATRIX_PASSWORD` is the bot account's password (needed for UIA, even with
   token auth). Sync it: `mkdir -p data/env && cp .env data/env/env`.
3. **Build:** `pnpm run build`.
4. **Restart your own service:**
   - macOS: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw`
   - Linux: `systemctl --user restart nanoclaw`
5. **Check `logs/nanoclaw.log`** for, in order:
   - `Matrix: crypto ready`
   - `Matrix: cross-signing bootstrapped — device is now self-verified`
     (or, if it skipped: `Matrix: cross-signing already published for this device`)
   - `Matrix: E2EE trust status   crossSigningReady=true`
   - If you instead see a WARN about the binding being too old / patch not
     applied / UIA, fix that cause (this doc) — the run continues regardless.
6. **In Element**, open the DM with the bot → the bot's device. It should now
   show **verified/green** without you manually verifying it. Re-check after a
   host restart to confirm it stays green (the store persists the identity).

---

## See also

- `docs/matrix-e2ee-native.md` — the native E2EE adapter (persistence, device
  stability, the original cross-signing limitation this change addresses).
- `patches/matrix-bot-sdk@0.8.0.patch` — the patch itself.
