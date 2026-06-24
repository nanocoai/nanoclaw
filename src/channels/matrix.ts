/**
 * Matrix channel adapter for NanoClaw v2 — SOUND persistent E2EE.
 *
 * This is a native (non-Chat-SDK) adapter built on `matrix-bot-sdk`, which
 * integrates the **native** Rust crypto binding
 * `@matrix-org/matrix-sdk-crypto-nodejs`. Unlike the previous Chat-SDK /
 * matrix-js-sdk adapter (which relied on the WASM crypto binding and could
 * only persist keys to IndexedDB — nonexistent in Node), the native binding
 * persists its identity + room keys to a **filesystem directory**
 * (`RustSdkCryptoStorageProvider`). That makes end-to-end encryption SOUND
 * across host restarts: same device id, same keys, history still decrypts.
 *
 * Why the rewrite: matrix-sdk-crypto-wasm only persists to IndexedDB. In a
 * Node host, in-memory crypto means a brand-new device + lost room keys on
 * every restart; IndexedDB shims fail during the RustCrypto store migration
 * (matrix-sdk-crypto-wasm#195). The native binding sidesteps all of that.
 *
 * Auth (resolved from env):
 *   - Access token: MATRIX_ACCESS_TOKEN + MATRIX_USER_ID
 *   - Password:     MATRIX_USERNAME + MATRIX_PASSWORD (token is fetched once
 *                   via password login and then PERSISTED to the FS store so
 *                   the same device is reused on subsequent boots).
 *
 * Env vars:
 *   MATRIX_BASE_URL             — homeserver URL (required)
 *   MATRIX_ACCESS_TOKEN         — bot access token (token auth)
 *   MATRIX_USER_ID              — bot user id, e.g. "@bot:server" (token auth)
 *   MATRIX_USERNAME             — bot localpart (password auth)
 *   MATRIX_PASSWORD             — bot password (password auth)
 *   MATRIX_DEVICE_ID            — stable device id; if set, seeded into the
 *                                 crypto store so the device is stable even on
 *                                 a fresh store. Otherwise the store's own
 *                                 device id (created on first login) is reused.
 *   MATRIX_CRYPTO_STORE_PATH    — crypto store directory (default
 *                                 data/v2-matrix-crypto). MUST persist across
 *                                 restarts — this is the whole point.
 *   MATRIX_STORE_PATH           — sync/account FS store file (default
 *                                 data/v2-matrix-store.json). Holds the sync
 *                                 token + the persisted access token.
 *   MATRIX_RECOVERY_KEY         — see the cross-signing note below.
 *   MATRIX_INVITE_AUTOJOIN      — "true" (default) auto-accepts room invites.
 *
 * Cross-signing + 4S (MATRIX_RECOVERY_KEY): a patch
 * (patches/matrix-bot-sdk@0.8.0.patch) fixes two SDK gaps and adds three new
 * methods to RustEngine. When MATRIX_RECOVERY_KEY is set this adapter calls all
 * three — idempotently and STRICTLY non-fatally:
 *
 *   1. bootstrapCrossSigning() — publishes the cross-signing identity
 *      (master/self/user-signing public keys via /keys/device_signing/upload,
 *      completing UIA with the bot's password) and self-signs this device. After
 *      it succeeds the bot device shows verified/green in clients.
 *      Requires crypto binding >= 0.5.0.
 *
 *   2. bootstrapSecretStorage() — derives an SSSS key from MATRIX_RECOVERY_KEY
 *      (via PBKDF2), uploads encrypted cross-signing private keys and a megolm
 *      key-backup decryption key to account data. Recovery from a new machine:
 *      provide the same MATRIX_RECOVERY_KEY value to re-import all keys.
 *      Requires crypto binding >= 0.6.0.
 *
 *   3. Megolm key backup (part of bootstrapSecretStorage) — creates a server-side
 *      key-backup version and enables it in the OlmMachine. Room-key history
 *      becomes recoverable from the homeserver using the backup decryption key
 *      stored in SSSS.
 *
 * The startup diagnostic reads (read-only, safe) the cross-signing + backup
 * state via the SDK's @internal crypto.engine.machine field and logs it honestly;
 * if a future SDK bump renames that field it WARNs loudly instead of going
 * silent. See docs/matrix-cross-signing.md and docs/matrix-e2ee-native.md.
 */
import { existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';

import {
  MatrixClient,
  MatrixAuth,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  AutojoinRoomsMixin,
} from 'matrix-bot-sdk';

// The rust-sdk store type. matrix-bot-sdk re-exports this as `const enum`, which
// has NO runtime binding (TS erases it). The native binding defines
// `StoreType.Sqlite = 0`, so we pass the literal 0 with this named constant for
// readability. (Sqlite is the only supported store type in crypto-nodejs 0.4.0.)
const RUST_CRYPTO_STORE_SQLITE = 0;

import type { ChannelAdapter, ChannelSetup, InboundMessage, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';
import { readEnvFile } from '../env.js';
import { log } from '../log.js';

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USER_ID',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_DEVICE_ID',
  'MATRIX_CRYPTO_STORE_PATH',
  'MATRIX_STORE_PATH',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
] as const;

const DEFAULT_CRYPTO_STORE = 'data/v2-matrix-crypto';
const DEFAULT_FS_STORE = 'data/v2-matrix-store.json';

// Key under which we persist the password-login access token in the FS store,
// so password auth reuses the same device on the next boot instead of creating
// a brand-new one (which would orphan the crypto keys on disk).
const PERSISTED_TOKEN_KEY = 'nanoclaw.matrix.accessToken';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface MatrixConfig {
  baseUrl: string;
  /** Access-token auth (takes precedence over username/password). */
  accessToken?: string;
  userId?: string;
  /** Password auth. */
  username?: string;
  password?: string;
  deviceId?: string;
  cryptoStorePath: string;
  fsStorePath: string;
  recoveryKey?: string;
  autojoin: boolean;
}

/**
 * Parse + validate the Matrix config from a raw env map. Exported for tests.
 * Returns null (with a debug log) when the channel is not configured — i.e.
 * no base url, or neither auth method present.
 */
export function parseMatrixConfig(env: Record<string, string | undefined>): MatrixConfig | null {
  const baseUrl = env.MATRIX_BASE_URL?.trim();
  if (!baseUrl) {
    log.debug('Matrix: MATRIX_BASE_URL not set, skipping channel');
    return null;
  }

  const accessToken = env.MATRIX_ACCESS_TOKEN?.trim() || undefined;
  const userId = env.MATRIX_USER_ID?.trim() || undefined;
  const username = env.MATRIX_USERNAME?.trim() || undefined;
  const password = env.MATRIX_PASSWORD?.trim() || undefined;

  const hasToken = Boolean(accessToken && userId);
  const hasPassword = Boolean(username && password);
  if (!hasToken && !hasPassword) {
    log.debug('Matrix: need MATRIX_ACCESS_TOKEN+MATRIX_USER_ID or MATRIX_USERNAME+MATRIX_PASSWORD, skipping channel');
    return null;
  }

  const cryptoStorePath = path.resolve(env.MATRIX_CRYPTO_STORE_PATH?.trim() || DEFAULT_CRYPTO_STORE);
  const fsStorePath = path.resolve(env.MATRIX_STORE_PATH?.trim() || DEFAULT_FS_STORE);

  // Default: auto-accept invites so DMs work without manual acceptance.
  const autojoin = (env.MATRIX_INVITE_AUTOJOIN?.trim() || 'true') !== 'false';

  return {
    baseUrl,
    accessToken,
    userId,
    username,
    password,
    deviceId: env.MATRIX_DEVICE_ID?.trim() || undefined,
    cryptoStorePath,
    fsStorePath,
    recoveryKey: env.MATRIX_RECOVERY_KEY?.trim() || undefined,
    autojoin,
  };
}

// ---------------------------------------------------------------------------
// DM platform-id <-> room mapping
// ---------------------------------------------------------------------------

/**
 * NanoClaw identifies channels by a stable platform_id. Matrix DMs live in
 * rooms (e.g. "!abc:server") whose ids are opaque and would create a fresh
 * messaging_group each time. So for 1:1 DMs we use the OTHER user's handle as
 * the platform_id: "matrix:@otheruser:server". Group rooms keep their room id.
 *
 *   - Inbound DM:  room "!abc:server" → platform_id "matrix:@otheruser:server"
 *   - Outbound DM: deliver("matrix:@otheruser:server") → resolve to (or create)
 *                  the DM room, then send there.
 *
 * Helpers are pure so they can be unit-tested without a live homeserver.
 */

/** Strip a leading "matrix:" prefix if present. */
export function stripMatrixPrefix(id: string): string {
  return id.startsWith('matrix:') ? id.slice('matrix:'.length) : id;
}

/** True when the platform id addresses a Matrix user (DM), not a room. */
export function isUserPlatformId(platformId: string): boolean {
  return stripMatrixPrefix(platformId).startsWith('@');
}

/** True when the id addresses a room ("!...") or alias ("#..."). */
export function isRoomId(id: string): boolean {
  const bare = stripMatrixPrefix(id);
  return bare.startsWith('!') || bare.startsWith('#');
}

/** Build the DM platform id from another user's matrix id. */
export function dmPlatformId(userId: string): string {
  return `matrix:${stripMatrixPrefix(userId)}`;
}

// ---------------------------------------------------------------------------
// Matrix event shapes (only the fields we read)
// ---------------------------------------------------------------------------

interface MatrixMessageEvent {
  sender?: string;
  event_id?: string;
  origin_server_ts?: number;
  content?: {
    msgtype?: string;
    body?: string;
    'm.relates_to'?: { 'm.in_reply_to'?: { event_id?: string } };
  };
}

/**
 * Minimal structural interface for the matrix-bot-sdk client we depend on.
 * Declaring it lets tests inject a fake client without a homeserver and keeps
 * our coupling to the SDK explicit.
 */
/**
 * The read-only crypto-status surface we reach for diagnostics. matrix-bot-sdk's
 * CryptoClient holds the native OlmMachine on a (documented-internal) `engine`
 * field. We ONLY ever call read-only machine methods (crossSigningStatus,
 * getBackupKeys) — never anything that enqueues an outgoing request, because
 * matrix-bot-sdk's RustEngine.run() THROWS on SignatureUpload/KeysBackup request
 * types ("Backup feature not possible"). See docs/matrix-e2ee-native.md.
 */
export interface OlmMachineReadonly {
  crossSigningStatus(): Promise<{ hasMaster: boolean; hasSelfSigning: boolean; hasUserSigning: boolean }>;
  getBackupKeys(): Promise<{ backupVersion?: string; decryptionKeyBase64?: string }>;
}

/**
 * UIA challenge shape passed to a {@link UIACallbackFn}. A 401 from
 * `/keys/device_signing/upload` carries the available `flows` (each with the
 * `stages` it requires), optional `params`, and a `session` id to thread
 * through the resubmission.
 */
export interface UIAChallenge {
  flows: { stages: string[] }[];
  params?: Record<string, unknown>;
  session?: string;
}

/** Returns the `auth` dict to retry a UIA request with, or null to abandon. */
export type UIACallbackFn = (uia: UIAChallenge) => Promise<Record<string, unknown> | null>;

/**
 * The patched RustEngine surface we drive for cross-signing. The patch
 * (patches/matrix-bot-sdk@0.8.0.patch) adds `bootstrapCrossSigning`, which
 * publishes the cross-signing identity (master/self/user-signing public keys)
 * and self-signs this device. Without the patch, the SDK's request runner
 * throws on the request types those operations need.
 */
export interface CrossSigningEngine {
  bootstrapCrossSigning(uiaCallback: UIACallbackFn, reset?: boolean): Promise<void>;
}

/**
 * The patched RustEngine surface for Secret Storage (4S/SSSS). The patch adds
 * `bootstrapSecretStorageFromPassphrase`, which derives an SSSS key from the
 * given passphrase, then encrypts the cross-signing private keys and a megolm
 * key-backup decryption key and stores them in Matrix account data.
 * Requires @matrix-org/matrix-sdk-crypto-nodejs >= 0.6.0.
 */
export interface SecretStorageEngine {
  bootstrapSecretStorageFromPassphrase(
    passphrase: string,
    opts?: { withKeyBackup?: boolean; reset?: boolean },
  ): Promise<void>;
  restoreSecretsFromSecretStorage(passphrase: string): Promise<void>;
}

export interface MatrixLikeClient {
  readonly crypto?: {
    prepare(roomIds: string[]): Promise<void>;
    readonly clientDeviceId?: string;
    /** Internal: the RustEngine wrapping the native OlmMachine. */
    readonly engine?: { readonly machine?: OlmMachineReadonly } & Partial<CrossSigningEngine> &
      Partial<SecretStorageEngine>;
  };
  readonly dms: {
    getOrCreateDm(userId: string): Promise<string>;
    isDm(roomId: string): boolean;
    update(): Promise<void>;
  };
  on(event: string, handler: (...args: unknown[]) => void): unknown;
  getUserId(): Promise<string>;
  getWhoAmI(): Promise<{ user_id: string; device_id?: string }>;
  getJoinedRooms(): Promise<string[]>;
  getJoinedRoomMembers(roomId: string): Promise<string[]>;
  joinRoom(roomIdOrAlias: string): Promise<string>;
  sendText(roomId: string, text: string): Promise<string>;
  sendMessage(roomId: string, content: Record<string, unknown>): Promise<string>;
  start(filter?: unknown): Promise<unknown>;
  stop(): void;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

/**
 * Build the MatrixClient with a persistent FS store + persistent native crypto
 * store. Performs password login once and persists the resulting token so the
 * device is stable across restarts.
 *
 * Overridable via the `deps` arg purely for testing — production passes the
 * real matrix-bot-sdk constructors.
 */
export interface MatrixClientDeps {
  MatrixClient: typeof MatrixClient;
  MatrixAuth: typeof MatrixAuth;
  SimpleFsStorageProvider: typeof SimpleFsStorageProvider;
  RustSdkCryptoStorageProvider: typeof RustSdkCryptoStorageProvider;
  AutojoinRoomsMixin: typeof AutojoinRoomsMixin;
}

const realDeps: MatrixClientDeps = {
  MatrixClient,
  MatrixAuth,
  SimpleFsStorageProvider,
  RustSdkCryptoStorageProvider,
  AutojoinRoomsMixin,
};

/**
 * Extract the read-only OlmMachine from the CryptoClient's internal `engine`
 * field, validating that the two read-only methods we rely on are actually
 * present. Returns null if the machine (or those methods) can't be reached —
 * which, given crypto is otherwise active, means matrix-bot-sdk changed its
 * internal shape (e.g. renamed `engine`/`machine`) on a version bump. Callers
 * treat null-when-crypto-present as a loud warning, not a silent no-op.
 */
export function extractReadonlyMachine(
  crypto: { readonly engine?: { readonly machine?: unknown } } | undefined,
): OlmMachineReadonly | null {
  const machine = crypto?.engine?.machine as Partial<OlmMachineReadonly> | undefined;
  if (!machine) return null;
  if (typeof machine.crossSigningStatus !== 'function' || typeof machine.getBackupKeys !== 'function') {
    return null;
  }
  return machine as OlmMachineReadonly;
}

/**
 * Read-only diagnostic of the device's cross-signing + key-backup state, logged
 * once at startup so operators get accurate, honest signal about E2EE trust.
 *
 * `cryptoActive` records whether the client HAS a working crypto provider. If it
 * does but the read-only OlmMachine can't be reached (the SDK renamed its
 * internal `engine`/`machine` field on an upgrade), we WARN loudly instead of
 * going silent — that's a signal to revisit this adapter against the new SDK.
 *
 * This NEVER mutates crypto state and never enqueues an outgoing request, so it
 * cannot hit matrix-bot-sdk's RustEngine "Backup feature not possible" throw. If
 * the operator set MATRIX_RECOVERY_KEY, we make explicit that it cannot be
 * applied here and why. Exported for unit testing.
 */
export async function reportCryptoStatus(
  machine: OlmMachineReadonly | null | undefined,
  hasRecoveryKey: boolean,
  cryptoActive = true,
): Promise<void> {
  if (!machine) {
    if (cryptoActive) {
      log.warn(
        'Matrix: crypto is active but the internal OlmMachine read-only API could not be reached — ' +
          'matrix-bot-sdk likely changed its internal shape (engine/machine field) on a version bump. ' +
          'E2EE message handling is unaffected, but the cross-signing/key-backup diagnostic is now blind. ' +
          'Revisit reportCryptoStatus in src/channels/matrix.ts against the new SDK. ' +
          'See docs/matrix-e2ee-native.md.',
      );
    }
    return;
  }
  try {
    const cs = await machine.crossSigningStatus();
    const crossSigned = cs.hasMaster && cs.hasSelfSigning;
    const backup = await machine.getBackupKeys();
    const backupActive = Boolean(backup.backupVersion);

    log.info('Matrix: E2EE trust status', {
      crossSigningReady: crossSigned,
      hasMasterKey: cs.hasMaster,
      hasSelfSigningKey: cs.hasSelfSigning,
      keyBackupVersion: backup.backupVersion ?? null,
    });

    if (!crossSigned) {
      if (hasRecoveryKey) {
        // MATRIX_RECOVERY_KEY was set so a bootstrap was attempted, but the
        // device is still not cross-signed — the bootstrap did not take (old
        // crypto binding, missing patch, or UIA failure; the bootstrap step
        // already logged the specific WARN). Point at the doc.
        log.warn(
          'Matrix: cross-signing was requested (MATRIX_RECOVERY_KEY set) but the device is still not ' +
            'cross-signed — see the preceding WARN for the cause. The device remains unverified; you can ' +
            'verify it interactively instead. See docs/matrix-cross-signing.md.',
        );
      } else {
        log.info(
          'Matrix: this device is not cross-signed (it starts unverified). Set MATRIX_RECOVERY_KEY to a ' +
            'passphrase to publish a cross-signing identity + 4S key backup automatically, or verify the device ' +
            'interactively from another logged-in session. See docs/matrix-cross-signing.md.',
        );
      }
    }
    if (hasRecoveryKey && !backupActive) {
      log.info(
        'Matrix: server-side key backup is not yet active (will be created on first startup with MATRIX_RECOVERY_KEY). ' +
          'Device keys persist soundly on disk across restarts regardless.',
      );
    }
  } catch (err) {
    // We reached the machine but a read-only call failed/changed signature —
    // another SDK-drift signal. Non-fatal to E2EE, but worth surfacing.
    log.warn('Matrix: failed to read crypto trust status — possible SDK drift (non-fatal to E2EE)', { err });
  }
}

/**
 * Build the UIA callback that satisfies `/keys/device_signing/upload`'s
 * User-Interactive Auth using the bot's own password. The Matrix UIA
 * `m.login.password` stage wants `{ type, identifier: { type: "m.id.user",
 * user }, password, session }`.
 *
 * Returns null (no callback possible) when we don't have a password — e.g.
 * access-token auth with no `MATRIX_PASSWORD`. In that case cross-signing
 * cannot be bootstrapped headlessly and the caller logs a clear WARN.
 *
 * Exported for unit testing.
 */
export function makeUIACallback(botUserId: string, password: string | undefined): UIACallbackFn | null {
  if (!password) return null;
  return async (uia: UIAChallenge) => {
    const supportsPassword = uia.flows.some((f) => f.stages.includes('m.login.password'));
    if (!supportsPassword) {
      // We can only complete password UIA; if the server demands something
      // else (SSO, recaptcha, …) we abandon rather than loop forever.
      log.warn('Matrix: cross-signing UIA requires a stage we cannot satisfy headlessly', {
        flows: uia.flows.map((f) => f.stages),
      });
      return null;
    }
    return {
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: botUserId },
      password,
      ...(uia.session ? { session: uia.session } : {}),
    };
  };
}

/**
 * Idempotently bootstrap cross-signing so the bot device self-verifies (stops
 * showing red/unverified in clients). NON-FATAL by contract: any failure logs a
 * WARN and returns false — it must never crash the run loop or message flow.
 *
 * Idempotency: if the device is already cross-signed (`hasMaster &&
 * hasSelfSigning`) we skip the upload entirely (`reset=false` would re-publish
 * the same identity, but we avoid the network round-trip and UIA prompt). The
 * underlying `bootstrapCrossSigning(reset=false)` is itself idempotent — it
 * reuses the existing local identity rather than resetting trust.
 *
 * Requires the patched SDK (the `engine.bootstrapCrossSigning` method) AND a
 * crypto binding >= 0.5.0 (which returns the upload requests). On an unpatched
 * SDK or an old binding, this degrades to a WARN and returns false; E2EE
 * messaging is unaffected.
 *
 * @returns true if the device is cross-signed after this call, false otherwise.
 * Exported for unit testing.
 */
export async function bootstrapCrossSigning(
  machine: OlmMachineReadonly | null | undefined,
  engine: Partial<CrossSigningEngine> | undefined,
  uiaCallback: UIACallbackFn | null,
): Promise<boolean> {
  if (!machine) {
    log.warn('Matrix: cannot bootstrap cross-signing — OlmMachine unreachable (SDK drift?). E2EE unaffected.');
    return false;
  }

  // Idempotency: already cross-signed → nothing to do.
  try {
    const cs = await machine.crossSigningStatus();
    if (cs.hasMaster && cs.hasSelfSigning) {
      log.info('Matrix: cross-signing already published for this device — skipping bootstrap');
      return true;
    }
  } catch (err) {
    log.warn('Matrix: could not read cross-signing status before bootstrap (continuing)', { err });
  }

  if (typeof engine?.bootstrapCrossSigning !== 'function') {
    log.warn(
      'Matrix: cross-signing bootstrap is unavailable — the matrix-bot-sdk patch ' +
        '(patches/matrix-bot-sdk@0.8.0.patch) is not applied, or the engine shape changed. ' +
        'The device will remain unverified; verify it interactively instead. ' +
        'See docs/matrix-cross-signing.md.',
    );
    return false;
  }
  if (!uiaCallback) {
    log.warn(
      'Matrix: cross-signing bootstrap needs the bot password to complete User-Interactive Auth, ' +
        'but none is available (set MATRIX_PASSWORD, even alongside MATRIX_ACCESS_TOKEN). ' +
        'Skipping bootstrap; the device remains unverified. See docs/matrix-cross-signing.md.',
    );
    return false;
  }

  try {
    await engine.bootstrapCrossSigning(uiaCallback, false);
    // Confirm it took.
    const cs = await machine.crossSigningStatus();
    const ok = cs.hasMaster && cs.hasSelfSigning;
    if (ok) {
      log.info('Matrix: cross-signing bootstrapped — device is now self-verified');
    } else {
      log.warn('Matrix: bootstrapCrossSigning completed but the device is still not cross-signed', {
        hasMaster: cs.hasMaster,
        hasSelfSigning: cs.hasSelfSigning,
      });
    }
    return ok;
  } catch (err) {
    log.warn(
      'Matrix: cross-signing bootstrap failed (non-fatal — E2EE messaging continues, device stays unverified). ' +
        'Common causes: crypto binding < 0.5.0 (cannot return the upload requests), or UIA rejected. ' +
        'See docs/matrix-cross-signing.md.',
      { err },
    );
    return false;
  }
}

/**
 * Restore cross-signing private keys (and megolm backup decryption key) from
 * 4S/SSSS account data into the local crypto store, using `recoveryPassphrase`
 * to decrypt. This is the recovery path when the crypto store has been lost:
 * the keys were previously uploaded by `bootstrapSecretStorage` and can be
 * re-imported from the homeserver using the same passphrase.
 *
 * Returns true if all three cross-signing keys were successfully imported.
 * NON-FATAL: any failure logs a WARN and returns false.
 * Exported for unit testing.
 */
export async function restoreFromSecretStorage(
  machine: OlmMachineReadonly | null | undefined,
  engine: Partial<SecretStorageEngine> | undefined,
  recoveryPassphrase: string,
): Promise<boolean> {
  if (!machine || !engine || !recoveryPassphrase) return false;

  if (typeof engine.restoreSecretsFromSecretStorage !== 'function') {
    log.warn(
      'Matrix: Secret Storage restore is unavailable — the matrix-bot-sdk patch does not include ' +
        'restoreSecretsFromSecretStorage. Falling back to fresh cross-signing bootstrap.',
    );
    return false;
  }

  try {
    await engine.restoreSecretsFromSecretStorage(recoveryPassphrase);
    const cs = await machine.crossSigningStatus();
    const ok = cs.hasMaster && cs.hasSelfSigning;
    if (ok) {
      log.info('Matrix: cross-signing keys restored from 4S/SSSS account data');
    } else {
      log.warn('Matrix: restoreSecretsFromSecretStorage completed but device is still not cross-signed', {
        hasMaster: cs.hasMaster,
        hasSelfSigning: cs.hasSelfSigning,
      });
    }
    return ok;
  } catch (err) {
    log.warn(
      'Matrix: failed to restore cross-signing keys from 4S/SSSS account data (non-fatal). ' +
        'Cause: wrong passphrase, missing account data, or binding < 0.6.0. ' +
        'Falling back to fresh cross-signing bootstrap.',
      { err },
    );
    return false;
  }
}

/**
 * Idempotently set up Secure Secret Storage (4S/SSSS) using `recoveryPassphrase`
 * as the SSSS key derivation passphrase, then store the cross-signing private keys
 * and a megolm key-backup decryption key in Matrix account data.
 *
 * Idempotency: skipped when the OlmMachine already has a persisted backup version
 * (set by the previous `bootstrapSecretStorage` call via `saveBackupDecryptionKey`).
 * This avoids replacing SSSS metadata with new PBKDF2 params on every restart.
 *
 * NON-FATAL by contract: any failure logs a WARN and returns false. The value of
 * MATRIX_RECOVERY_KEY is used as the passphrase; it never leaves the local machine
 * — the server only ever sees the encrypted blobs.
 *
 * Exported for unit testing.
 */
export async function bootstrapSecretStorage(
  machine: OlmMachineReadonly | null | undefined,
  engine: Partial<SecretStorageEngine> | undefined,
  recoveryPassphrase: string,
): Promise<boolean> {
  if (!machine || !engine || !recoveryPassphrase) return false;

  // Idempotency: if a backup version is already saved in the crypto store, 4S was
  // previously bootstrapped. Re-running createFromPassphrase would generate a new
  // PBKDF2 salt and effectively rotate the key, so we skip.
  try {
    const backupKeys = await machine.getBackupKeys();
    if (backupKeys.backupVersion) {
      log.info('Matrix: 4S already set up (backup key in crypto store) — skipping re-bootstrap');
      return true;
    }
  } catch (err) {
    log.warn('Matrix: could not check backup keys for 4S idempotency (continuing)', { err });
  }

  if (typeof engine.bootstrapSecretStorageFromPassphrase !== 'function') {
    log.warn(
      'Matrix: Secret Storage (4S) bootstrap is unavailable — the SDK patch does not include ' +
        'bootstrapSecretStorageFromPassphrase. Cross-signing is still active; back up ' +
        'data/v2-matrix-crypto for recovery.',
    );
    return false;
  }

  try {
    await engine.bootstrapSecretStorageFromPassphrase(recoveryPassphrase);
    log.info(
      'Matrix: 4S bootstrap complete — cross-signing keys + key backup decryption key stored ' +
        'encrypted in account data. Recovery: provide MATRIX_RECOVERY_KEY value as passphrase.',
    );
    return true;
  } catch (err) {
    log.warn(
      'Matrix: Secret Storage (4S) bootstrap failed (non-fatal — cross-signing + E2EE messaging ' +
        'continue unaffected). Back up data/v2-matrix-crypto for recovery in the interim.',
      { err },
    );
    return false;
  }
}

/** Ensure the crypto store directory exists (it must persist across restarts). */
export function ensureCryptoStoreDir(cryptoStorePath: string): void {
  if (!existsSync(cryptoStorePath)) {
    mkdirSync(cryptoStorePath, { recursive: true });
    log.info('Matrix: created crypto store directory', { path: cryptoStorePath });
  } else {
    log.info('Matrix: reusing existing crypto store directory', { path: cryptoStorePath });
  }
}

export function createMatrixAdapter(config: MatrixConfig, deps: MatrixClientDeps = realDeps): ChannelAdapter {
  let client: MatrixLikeClient | null = null;
  let setup: ChannelSetup | null = null;
  let connected = false;
  let botUserId: string | null = null;

  // Cache: DM room id -> other user's matrix id, for rewriting inbound room
  // ids to user-handle platform ids. Populated lazily on inbound and when we
  // resolve an outbound DM room.
  const roomToUser = new Map<string, string>();

  /**
   * Resolve a DM room id to the other participant's matrix id, caching the
   * result. Returns null for non-DM rooms (group rooms keep their room id as
   * the platform id).
   */
  async function resolveOtherUser(roomId: string): Promise<string | null> {
    const cached = roomToUser.get(roomId);
    if (cached) return cached;
    if (!client) return null;

    let isDm = false;
    try {
      isDm = client.dms.isDm(roomId);
    } catch {
      isDm = false;
    }

    let members: string[] = [];
    try {
      members = await client.getJoinedRoomMembers(roomId);
    } catch (err) {
      log.debug('Matrix: failed to fetch room members', { roomId, err });
      return null;
    }

    const others = members.filter((m) => m !== botUserId);
    // Treat a 2-member room as a DM even if account-data m.direct hasn't synced
    // yet (common right after auto-joining a fresh invite).
    if (!isDm && members.length > 2) return null;
    if (others.length !== 1) return null;

    const other = others[0]!;
    roomToUser.set(roomId, other);
    return other;
  }

  async function handleMessage(roomId: string, event: MatrixMessageEvent): Promise<void> {
    if (!setup || !client) return;

    const sender = event.sender;
    if (!sender) return;
    // Ignore our own echoes.
    if (sender === botUserId) return;

    const msgtype = event.content?.msgtype;
    const body = (event.content?.body ?? '').trim();
    // Only handle text-ish messages; notices/emotes carry body too.
    if (!body) return;
    if (msgtype && msgtype !== 'm.text' && msgtype !== 'm.notice' && msgtype !== 'm.emote') return;

    const other = await resolveOtherUser(roomId);
    const isGroup = other === null;
    // DMs are addressed by the user handle; groups by the room id.
    const platformId = isGroup ? `matrix:${roomId}` : dmPlatformId(other!);

    setup.onMetadata(platformId, isGroup ? roomId : sender, isGroup);

    const message: InboundMessage = {
      id: event.event_id ?? String(event.origin_server_ts ?? Date.now()),
      kind: 'chat',
      content: {
        text: body,
        sender,
        // Matrix user ids contain ":" which the permissions module would treat
        // as already-prefixed. Always carry the explicit "matrix:" prefix so
        // user records match between init-first-agent and inbound routing.
        senderId: `matrix:${sender}`,
        senderName: sender,
      },
      timestamp: event.origin_server_ts ? new Date(event.origin_server_ts).toISOString() : new Date().toISOString(),
      // DMs are an implicit mention of the bot; group messages are not unless
      // the router's text-match fallback fires.
      isMention: !isGroup,
      isGroup,
    };

    await setup.onInbound(platformId, null, message);
    log.info('Matrix message received', { platformId, sender, isGroup });
  }

  /** Resolve an outbound platform id to a concrete room id (creating the DM if needed). */
  async function resolveTargetRoom(platformId: string): Promise<string> {
    if (!client) throw new Error('Matrix client not connected');
    const bare = stripMatrixPrefix(platformId);

    if (isUserPlatformId(platformId)) {
      const roomId = await client.dms.getOrCreateDm(bare);
      roomToUser.set(roomId, bare);
      return roomId;
    }
    // Room id or alias — pass through. (Aliases would need resolution, but the
    // router stores joined room ids; "#alias" support is best-effort.)
    return bare;
  }

  const adapter: ChannelAdapter = {
    name: 'matrix',
    channelType: 'matrix',
    // Matrix threads exist but client support is uneven; treat the room as the
    // conversation unit, matching the previous adapter.
    supportsThreads: false,

    async setup(cfg: ChannelSetup): Promise<void> {
      setup = cfg;

      // The crypto store directory is the load-bearing persistence surface.
      ensureCryptoStoreDir(config.cryptoStorePath);

      const storage = new deps.SimpleFsStorageProvider(config.fsStorePath);
      const cryptoStore = new deps.RustSdkCryptoStorageProvider(config.cryptoStorePath, RUST_CRYPTO_STORE_SQLITE);

      // Resolve an access token. Token auth uses it directly. Password auth
      // reuses a previously persisted token (stable device) or logs in once
      // and persists the result.
      //
      // IMPORTANT: the crypto store's device id MUST equal the device id the
      // homeserver bound to this access token. The store's device id is used to
      // sign uploaded device keys; if it disagrees with the session device, the
      // server rejects the key upload with M_BAD_JSON ("Provided device_id in
      // device_keys does not match that of the authenticated user device"). So
      // we never pre-seed the store from MATRIX_DEVICE_ID before login — the
      // server assigns the device on a fresh password login. We seed the store
      // from the AUTHORITATIVE device id (getWhoAmI) below, after the client is
      // constructed. MATRIX_DEVICE_ID only names the device at login time
      // (cosmetic) and is honored as-is for token auth (where the operator's
      // token is already bound to that device).
      let accessToken = config.accessToken;
      let freshLogin = false;
      if (!accessToken) {
        // readValue/storeValue on the FS store are synchronous.
        const persisted = storage.readValue(PERSISTED_TOKEN_KEY);
        if (persisted) {
          accessToken = persisted;
          log.info('Matrix: reusing persisted access token (stable device)');
        } else {
          log.info('Matrix: performing password login', { username: config.username });
          const auth = new deps.MatrixAuth(config.baseUrl);
          // Use the pinned id as the device display name; the server still
          // assigns the actual device_id.
          const loggedIn = await auth.passwordLogin(config.username!, config.password!, config.deviceId || 'NanoClaw');
          accessToken = loggedIn.accessToken;
          storage.storeValue(PERSISTED_TOKEN_KEY, accessToken);
          freshLogin = true;
          log.info('Matrix: password login complete, token persisted');
        }
      }

      client = new deps.MatrixClient(config.baseUrl, accessToken!, storage, cryptoStore) as unknown as MatrixLikeClient;

      botUserId = await client.getUserId();

      // Seed the crypto store's device id from the server-authoritative value
      // (getWhoAmI) on first run, so the store and the session agree. No-op once
      // the store already has a device id (subsequent restarts reuse it).
      try {
        const existing = await (cryptoStore as RustSdkCryptoStorageProvider).getDeviceId();
        if (!existing) {
          const whoami = await client.getWhoAmI();
          const serverDeviceId = whoami.device_id;
          if (serverDeviceId) {
            await (cryptoStore as RustSdkCryptoStorageProvider).setDeviceId(serverDeviceId);
            log.info('Matrix: seeded crypto store with server-assigned device id', {
              deviceId: serverDeviceId,
              freshLogin,
            });
            if (config.deviceId && config.deviceId !== serverDeviceId && !config.accessToken) {
              log.warn(
                'Matrix: MATRIX_DEVICE_ID does not match the server-assigned device id for this login — ' +
                  'with password auth the homeserver assigns the device id, so the pinned value is used only as the ' +
                  'device display name. The stable device is now persisted regardless. See docs/matrix-e2ee-native.md.',
                { pinned: config.deviceId, serverAssigned: serverDeviceId },
              );
            }
          }
        }
      } catch (err) {
        log.warn('Matrix: could not reconcile crypto-store device id with the server (E2EE may fail)', { err });
      }

      if (config.autojoin) {
        deps.AutojoinRoomsMixin.setupOnClient(client as unknown as MatrixClient);
      }

      client.on('room.message', (...args: unknown[]) => {
        const [roomId, event] = args as [string, MatrixMessageEvent];
        handleMessage(roomId, event).catch((err) => log.error('Matrix: error handling message', { roomId, err }));
      });

      // Crypto must be prepared (with the currently-joined rooms) before sync.
      if (client.crypto) {
        const joined = await client.getJoinedRooms();
        await client.crypto.prepare(joined);
        const whoami = await client.getWhoAmI();
        log.info('Matrix: crypto ready', {
          deviceId: client.crypto.clientDeviceId ?? whoami.device_id,
          cryptoStore: config.cryptoStorePath,
        });

        const machine = extractReadonlyMachine(client.crypto);

        // When MATRIX_RECOVERY_KEY is set AND crypto is ready, publish a
        // cross-signing identity so the bot device stops showing as unverified
        // (red) in clients. Idempotent and strictly non-fatal: a failure logs a
        // WARN and the run loop / message flow continue untouched. The cross-
        // signing UIA is completed with the bot's own password.
        if (config.recoveryKey) {
          const uiaCallback = makeUIACallback(botUserId!, config.password);

          // Check if we already have cross-signing keys in this crypto store.
          let crossSigningOk = false;
          try {
            const cs = await machine?.crossSigningStatus();
            crossSigningOk = (cs?.hasMaster && cs?.hasSelfSigning) ?? false;
          } catch (_) {
            /* non-fatal */
          }

          if (!crossSigningOk) {
            // Try to restore from 4S first (crypto store was lost but keys are
            // in account data). Fall back to fresh bootstrap if restore fails
            // (first run, or account data missing/wrong passphrase).
            crossSigningOk = await restoreFromSecretStorage(machine, client.crypto.engine, config.recoveryKey);
            if (!crossSigningOk) {
              crossSigningOk = await bootstrapCrossSigning(machine, client.crypto.engine, uiaCallback);
            }
          } else {
            log.info('Matrix: cross-signing already in local crypto store — skipping bootstrap/restore');
          }

          // 4S: only attempt after cross-signing is confirmed — cross-signing
          // keys must exist in the local store before they can be exported.
          if (crossSigningOk) {
            await bootstrapSecretStorage(machine, client.crypto.engine, config.recoveryKey);
          }
        }

        // Honest, read-only report of cross-signing / key-backup trust state.
        // Reports crossSigningReady: true once the bootstrap above has taken.
        // cryptoActive=true here, so a missing machine warns loudly (SDK drift)
        // rather than going silent.
        await reportCryptoStatus(machine, Boolean(config.recoveryKey), true);
      } else {
        log.warn('Matrix: crypto provider unavailable — E2EE rooms will NOT decrypt');
      }

      await client.start();
      connected = true;
      log.info('Matrix channel connected', { userId: botUserId, baseUrl: config.baseUrl });
    },

    async teardown(): Promise<void> {
      connected = false;
      try {
        client?.stop();
      } catch (err) {
        log.debug('Matrix: stop() failed', { err });
      }
      client = null;
      roomToUser.clear();
      log.info('Matrix channel disconnected');
    },

    isConnected(): boolean {
      return connected;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      if (!connected || !client) return undefined;

      const content = message.content as Record<string, unknown> | string | undefined;
      let text: string | null = null;
      if (typeof content === 'string') text = content;
      else if (content && typeof content === 'object' && typeof content.text === 'string') text = content.text;
      if (!text) return undefined;

      try {
        const roomId = await resolveTargetRoom(platformId);
        // sendText transparently encrypts when the room is encrypted and crypto
        // is enabled — no explicit encrypt step.
        const eventId = await client.sendText(roomId, text);
        log.info('Matrix message sent', { platformId, roomId, length: text.length });
        return eventId;
      } catch (err) {
        log.error('Matrix: send failed', { platformId, err });
        return undefined;
      }
    },

    /**
     * Open (or fetch) the DM room for a user and return its NanoClaw platform
     * id. The handle is already the DM addressing key for Matrix, so callers
     * normally use it directly; we implement openDM so cold-DM initiation
     * (approvals, welcome messages) eagerly creates the room.
     */
    async openDM(userHandle: string): Promise<string> {
      if (!client) throw new Error('Matrix client not connected');
      const userId = stripMatrixPrefix(userHandle);
      const roomId = await client.dms.getOrCreateDm(userId);
      roomToUser.set(roomId, userId);
      return dmPlatformId(userId);
    },
  };

  return adapter;
}

// ---------------------------------------------------------------------------
// Self-registration
// ---------------------------------------------------------------------------

registerChannelAdapter('matrix', {
  factory: () => {
    const env = readEnvFile([...ENV_KEYS]);
    const config = parseMatrixConfig(env);
    if (!config) return null;
    return createMatrixAdapter(config);
  },
});
