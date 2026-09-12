/**
 * Who the host's bot is on Slack, for a coding session's surface.
 *
 * The service invites the host's bot into a session's channel and needs its user
 * id. The service's own record of the app may lack it (a managed install
 * does not always report one), so a host that holds the bot token supplies
 * the id itself: one `auth.test` call on that token answers with `user_id`
 * and `team_id`. The answer is cached beside the install state
 * (`data/slack-bot-identity.json`, keyed by app id) so the call happens once
 * per install, not once per sandbox.
 *
 * Belt and braces, never a gate: any failure — no token, the platform not
 * answering, a refused token — resolves null and the binding proceeds as it
 * did before, letting the service fill the id in from its side. The token is
 * used for the one request and appears in no log, file or error.
 */
import path from 'node:path';

import { readJson, writePrivate } from '../community-portal/private-file.js';

export const SLACK_API_BASE = 'https://slack.com/api';

export interface BotIdentity {
  botUserId: string;
  teamId?: string;
}

interface CachedBotIdentity extends BotIdentity {
  appId: string;
  checkedAt: string;
}

export const botIdentityFile = (root = process.cwd()): string => path.join(root, 'data/slack-bot-identity.json');

const USER_ID = /^[UW][A-Z0-9]{1,31}$/;
const TEAM_ID = /^[A-Z0-9]{1,32}$/;

/** The cached answer for this app, or null (absent, malformed, or another app's). */
export async function readCachedBotIdentity(root: string, appId: string): Promise<BotIdentity | null> {
  let cached: Partial<CachedBotIdentity> | null;
  try {
    cached = await readJson<Partial<CachedBotIdentity>>(botIdentityFile(root));
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return null; // a torn cache is no cache
  }
  if (!cached || typeof cached !== 'object' || cached.appId !== appId) return null;
  if (typeof cached.botUserId !== 'string' || !USER_ID.test(cached.botUserId)) return null;
  const teamId = typeof cached.teamId === 'string' && TEAM_ID.test(cached.teamId) ? cached.teamId : undefined;
  return { botUserId: cached.botUserId, ...(teamId ? { teamId } : {}) };
}

export async function writeCachedBotIdentity(root: string, appId: string, identity: BotIdentity): Promise<void> {
  const record: CachedBotIdentity = { appId, ...identity, checkedAt: new Date().toISOString() };
  await writePrivate(botIdentityFile(root), record);
}

export interface AuthTestOptions {
  /** Test seam. */
  fetch?: typeof fetch;
  apiBase?: string;
  timeoutMs?: number;
}

/**
 * `auth.test` on the bot token → the bot's user id and workspace, or null
 * on any failure. Never throws; never surfaces the token.
 */
export async function slackAuthTest(botToken: string, options: AuthTestOptions = {}): Promise<BotIdentity | null> {
  const fetchFn = options.fetch ?? fetch;
  let body: unknown;
  try {
    const response = await fetchFn(`${options.apiBase ?? SLACK_API_BASE}/auth.test`, {
      method: 'POST',
      headers: { authorization: `Bearer ${botToken}`, 'content-type': 'application/x-www-form-urlencoded' },
      signal: AbortSignal.timeout(options.timeoutMs ?? 10_000),
      redirect: 'error',
    });
    if (!response.ok) return null;
    body = await response.json();
  } catch {
    return null; // unreachable, timed out, or not JSON — the service fills the id in
  }
  if (!body || typeof body !== 'object') return null;
  const answer = body as { ok?: unknown; user_id?: unknown; team_id?: unknown };
  if (answer.ok !== true || typeof answer.user_id !== 'string' || !USER_ID.test(answer.user_id)) return null;
  const teamId = typeof answer.team_id === 'string' && TEAM_ID.test(answer.team_id) ? answer.team_id : undefined;
  return { botUserId: answer.user_id, ...(teamId ? { teamId } : {}) };
}

export interface ResolveBotIdentityInput extends AuthTestOptions {
  root: string;
  appId: string;
  botToken?: string;
}

/** Cached answer first; else one auth.test on the token, cached on success; else null. */
export async function resolveBotIdentity(input: ResolveBotIdentityInput): Promise<BotIdentity | null> {
  const cached = await readCachedBotIdentity(input.root, input.appId).catch(() => null);
  if (cached) return cached;
  if (!input.botToken) return null;
  const identity = await slackAuthTest(input.botToken, input);
  if (!identity) return null;
  try {
    await writeCachedBotIdentity(input.root, input.appId, identity);
  } catch {
    // a cache that cannot be written only costs a repeat call next time
  }
  return identity;
}
