/**
 * Strava token management — refreshes access tokens on demand.
 *
 * Reads credentials from data/strava-tokens.json (written by the one-time
 * OAuth script). Refreshes automatically when the token is expired or about
 * to expire (5-minute buffer). Persists refreshed tokens back to disk.
 *
 * Used by materializeContainerJson to inject a fresh access token into
 * remote MCP server headers at container spawn time.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import { log } from './log.js';

const TOKEN_PATH = path.join(DATA_DIR, 'strava-tokens.json');
const REFRESH_BUFFER_SECONDS = 300;

interface StravaTokens {
  client_id: string;
  client_secret: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  athlete_id?: number;
  athlete_name?: string;
  updated_at?: string;
}

let cached: StravaTokens | null = null;

function readTokens(): StravaTokens | null {
  try {
    if (!fs.existsSync(TOKEN_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')) as StravaTokens;
    if (!raw.client_id || !raw.client_secret || !raw.refresh_token) return null;
    return raw;
  } catch {
    return null;
  }
}

function writeTokens(tokens: StravaTokens): void {
  tokens.updated_at = new Date().toISOString();
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2) + '\n');
  cached = tokens;
}

function isExpired(tokens: StravaTokens): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now >= tokens.expires_at - REFRESH_BUFFER_SECONDS;
}

async function refreshAccessToken(tokens: StravaTokens): Promise<StravaTokens> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: tokens.client_id,
      client_secret: tokens.client_secret,
      refresh_token: tokens.refresh_token,
      grant_type: 'refresh_token',
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Strava token refresh failed (${res.status}): ${body}`);
  }

  const data = (await res.json()) as {
    access_token: string;
    refresh_token: string;
    expires_at: number;
  };

  const updated: StravaTokens = {
    ...tokens,
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: data.expires_at,
  };

  writeTokens(updated);
  log.info('Strava access token refreshed', {
    expiresAt: new Date(data.expires_at * 1000).toISOString(),
  });

  return updated;
}

/**
 * Get a valid Strava access token. Refreshes automatically if expired.
 * Returns null if no Strava tokens are configured.
 */
export async function getStravaAccessToken(): Promise<string | null> {
  let tokens = cached ?? readTokens();
  if (!tokens) return null;

  if (isExpired(tokens)) {
    try {
      tokens = await refreshAccessToken(tokens);
    } catch (err) {
      log.error('Failed to refresh Strava token', { err });
      return tokens.access_token;
    }
  }

  cached = tokens;
  return tokens.access_token;
}

/** Check if Strava tokens are configured (without refreshing). */
export function hasStravaTokens(): boolean {
  return readTokens() !== null;
}
