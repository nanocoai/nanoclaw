import fs from 'fs';
import { execSync } from 'child_process';

import { log } from './log.js';

const TOKEN_ENDPOINT = 'https://platform.claude.com/v1/oauth/token';
const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';
const KEYCHAIN_SERVICE = 'Claude Code-credentials';

// Refresh when access token expires within this many minutes.
export const OAUTH_REFRESH_THRESHOLD_MINUTES = 60;

interface OauthFields {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  [key: string]: unknown;
}

/**
 * Attempts to refresh the OAuth access token stored in `claudeJsonPath`
 * using the stored refresh_token. Updates both the file and macOS Keychain
 * on success so subsequent reads (including pre-spawn Keychain reads) see
 * the fresh token.
 *
 * Returns:
 *   'refreshed'  — new token written, good to go
 *   'failed'     — API call rejected (refresh token likely expired; user must re-run claude login)
 *   'no-token'   — file not found or has no refreshToken field
 *   'not-needed' — token is not near expiry, no refresh attempted
 */
export async function refreshOauthTokenIfNeeded(
  claudeJsonPath: string,
  logContext: string,
): Promise<'refreshed' | 'failed' | 'no-token' | 'not-needed'> {
  if (!fs.existsSync(claudeJsonPath)) return 'no-token';

  let fileData: Record<string, unknown>;
  let current: OauthFields | undefined;
  try {
    fileData = JSON.parse(fs.readFileSync(claudeJsonPath, 'utf8'));
    current = fileData?.claudeAiOauth as OauthFields | undefined;
  } catch {
    return 'no-token';
  }
  if (!current?.refreshToken) return 'no-token';

  const minutesLeft = (current.expiresAt - Date.now()) / 60_000;
  if (minutesLeft >= OAUTH_REFRESH_THRESHOLD_MINUTES) return 'not-needed';

  let resp: Response;
  try {
    resp = await fetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'claude-code/1.0' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: current.refreshToken,
        client_id: CLIENT_ID,
      }),
    });
  } catch (err) {
    log.warn(`${logContext} Token refresh network error`, { err });
    return 'failed';
  }

  if (!resp.ok) {
    log.warn(`${logContext} Token refresh rejected`, { status: resp.status });
    return 'failed';
  }

  let body: { access_token?: string; refresh_token?: string; expires_in?: number };
  try {
    body = (await resp.json()) as typeof body;
  } catch {
    return 'failed';
  }
  if (!body.access_token) return 'failed';

  const newOauth: OauthFields = {
    ...current,
    accessToken: body.access_token,
    refreshToken: body.refresh_token ?? current.refreshToken,
    expiresAt: Date.now() + (body.expires_in ?? 28_800) * 1_000,
  };

  fileData.claudeAiOauth = newOauth;
  fs.writeFileSync(claudeJsonPath, JSON.stringify(fileData, null, 2));

  // Update Keychain so the next pre-spawn Keychain read sees the fresh token.
  // Pass the new JSON via env var to avoid shell-quoting issues with the token string.
  try {
    const keychainRaw = execSync(`security find-generic-password -s "${KEYCHAIN_SERVICE}" -w 2>/dev/null`, {
      encoding: 'utf8',
      timeout: 5_000,
    }).trim();
    if (keychainRaw) {
      const keychainData = JSON.parse(keychainRaw);
      keychainData.claudeAiOauth = newOauth;
      execSync(
        `security add-generic-password -s "${KEYCHAIN_SERVICE}" -a "${process.env.USER ?? 'files'}" -w "$KEYCHAIN_PWD" -U`,
        { encoding: 'utf8', timeout: 5_000, env: { ...process.env, KEYCHAIN_PWD: JSON.stringify(keychainData) } },
      );
    }
  } catch (err) {
    log.warn(`${logContext} Keychain update after refresh failed`, { err });
  }

  log.info(`${logContext} OAuth token refreshed`, { newExpiresAt: new Date(newOauth.expiresAt).toISOString() });
  return 'refreshed';
}
