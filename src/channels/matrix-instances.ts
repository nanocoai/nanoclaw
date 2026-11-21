/**
 * Multi-account support for the Matrix channel.
 *
 * MATRIX_INSTANCES=<name>[,<name>...] registers one extra Matrix account per
 * name under the `matrix-<name>` instance key. Each reads its own credentials
 * from MATRIX_<KEY>_<NAME> (name uppercased, dashes to underscores); the
 * default account keeps the unsuffixed MATRIX_<KEY> variables. channelType
 * stays 'matrix', so user ids and container config are one namespace across
 * accounts — only the identity the bot speaks as differs (own avatar/name).
 *
 * The config is passed straight to createMatrixAdapter(config), never via
 * process.env, so accounts cannot leak settings into each other.
 */
import type { MatrixAdapterConfig } from '@beeper/chat-adapter-matrix';

import { readEnvFile } from '../env.js';

const ENV_KEYS = [
  'MATRIX_BASE_URL',
  'MATRIX_ACCESS_TOKEN',
  'MATRIX_USERNAME',
  'MATRIX_PASSWORD',
  'MATRIX_USER_ID',
  'MATRIX_BOT_USERNAME',
  'MATRIX_DEVICE_ID',
  'MATRIX_RECOVERY_KEY',
  'MATRIX_INVITE_AUTOJOIN',
  'MATRIX_INVITE_AUTOJOIN_ALLOWLIST',
] as const;

/** Valid instance name: lowercase kebab, so the env-key mapping is one-to-one and the key is URL-safe. */
export const MATRIX_INSTANCE_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Env-key suffix for a named instance: uppercased, dashes to underscores. */
export function matrixEnvSuffix(name: string): string {
  return name.toUpperCase().replace(/-/g, '_');
}

/** Names listed in MATRIX_INSTANCES (raw, unvalidated, trimmed, non-empty). */
export function readMatrixInstanceNames(): string[] {
  return (readEnvFile(['MATRIX_INSTANCES']).MATRIX_INSTANCES ?? '')
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
}

function list(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Account identity per instance key, so one Matrix account is never started
 * twice (two syncs on one user would process every message twice). Keyed on
 * homeserver + localpart: "alfred" and "@alfred:hs" are the same account.
 */
const claimedAccounts = new Map<string, string>();

function accountKey(config: MatrixAdapterConfig): string {
  const id = config.auth.userID ?? ('username' in config.auth ? config.auth.username : '');
  const local = id.replace(/^@/, '').split(':')[0].toLowerCase();
  return `${config.baseURL.replace(/\/+$/, '').toLowerCase()}|${local}`;
}

/**
 * Claim the account behind `config` for `instanceKey`. Returns the instance
 * that already holds it (caller skips this one), or undefined on success.
 * Re-claiming by the same instance is allowed (adapter restart).
 */
export function claimMatrixAccount(config: MatrixAdapterConfig, instanceKey: string): string | undefined {
  // Access-token auth without a user id cannot be identified before login.
  if (!config.auth.userID && !('username' in config.auth)) return undefined;
  const key = accountKey(config);
  const holder = claimedAccounts.get(key);
  if (holder !== undefined && holder !== instanceKey) return holder;
  claimedAccounts.set(key, instanceKey);
  return undefined;
}

/**
 * Build the adapter config for one account from `.env`. `name` undefined is
 * the default account. Returns null when credentials are missing (the
 * registry's "credentials missing, skipping" path).
 */
export function buildMatrixConfig(name?: string): MatrixAdapterConfig | null {
  const suffix = name ? `_${matrixEnvSuffix(name)}` : '';
  const raw = readEnvFile(ENV_KEYS.map((k) => `${k}${suffix}`));
  const get = (key: (typeof ENV_KEYS)[number]): string | undefined => raw[`${key}${suffix}`] || undefined;

  const baseURL = get('MATRIX_BASE_URL');
  if (!baseURL) return null;

  const username = get('MATRIX_USERNAME');
  const password = get('MATRIX_PASSWORD');
  const accessToken = get('MATRIX_ACCESS_TOKEN');
  const userID = get('MATRIX_USER_ID');
  let auth: MatrixAdapterConfig['auth'];
  if (username && password) auth = { type: 'password', username, password, userID };
  else if (accessToken) auth = { type: 'accessToken', accessToken, userID };
  else return null;

  const recoveryKey = get('MATRIX_RECOVERY_KEY');
  const autojoin = (get('MATRIX_INVITE_AUTOJOIN') ?? 'true').trim().toLowerCase();

  return {
    baseURL,
    auth,
    userName: get('MATRIX_BOT_USERNAME') ?? 'bot',
    deviceID: get('MATRIX_DEVICE_ID'),
    recoveryKey,
    // Auto-join room invites by default so DMs work without manual acceptance.
    inviteAutoJoin: ['1', 'true', 'yes', 'on'].includes(autojoin)
      ? { inviterAllowlist: list(get('MATRIX_INVITE_AUTOJOIN_ALLOWLIST')) }
      : undefined,
    // Named accounts get their own crypto store; the default keeps the library default.
    e2ee: recoveryKey && name ? { cryptoDatabasePrefix: `nanoclaw-${name}-` } : undefined,
    matrixSDKLogLevel: 'error',
  };
}
