/**
 * Shared Slack channel-layer library — the minimal fetch-based Slack Web API
 * client plus the per-instance bot-token .env key convention. Channel-layer
 * modules import Slack HTTP plumbing from here so it has exactly one home
 * (and so nothing in the channel layer reaches into feature modules for it).
 *
 * Failures become SlackApiError(step, `slack ${method} failed: ${error}`),
 * where `step` is a caller-supplied context tag naming where in the caller's
 * flow the call happened — callers with typed step ids pass them through
 * (any string union narrows to string).
 *
 * Slack's error strings are safe to surface; token values never are — tokens
 * travel only in the Authorization header and are never interpolated into
 * messages or logs.
 */

const SLACK_API = 'https://slack.com/api';

/**
 * Typed failure for Slack Web API calls. `step` is the caller's context tag
 * for the call site. `message` MUST never contain a token value.
 */
export class SlackApiError extends Error {
  constructor(
    readonly step: string,
    message: string,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

/**
 * POST one Web API method with a JSON body. Returns the parsed response when
 * `ok: true`; throws SlackApiError otherwise (network failure, timeout,
 * non-JSON body, or a Slack-side error string).
 */
export async function slackCall(
  token: string,
  method: string,
  body: Record<string, unknown>,
  step: string,
): Promise<Record<string, unknown>> {
  let res: Response;
  try {
    res = await fetch(`${SLACK_API}/${method}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (err) {
    throw new SlackApiError(step, `slack ${method} failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  let json: Record<string, unknown>;
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    throw new SlackApiError(step, `slack ${method} failed: HTTP ${res.status}, non-JSON body`);
  }
  if (json.ok !== true) {
    throw new SlackApiError(step, `slack ${method} failed: ${String(json.error ?? `HTTP ${res.status}`)}`);
  }
  return json;
}

/** auth.test — the calling bot's own identity. `url` is the workspace URL
 *  (`https://<domain>.slack.com/`) — canvas permalinks hang off it. */
export async function slackAuthTest(
  token: string,
  step: string,
): Promise<{ userId: string; teamId?: string; team?: string; url?: string }> {
  const json = await slackCall(token, 'auth.test', {}, step);
  const userId = typeof json.user_id === 'string' ? json.user_id : null;
  if (!userId) throw new SlackApiError(step, 'slack auth.test failed: no user_id in response');
  return {
    userId,
    teamId: typeof json.team_id === 'string' ? json.team_id : undefined,
    team: typeof json.team === 'string' ? json.team : undefined,
    url: typeof json.url === 'string' ? json.url : undefined,
  };
}

/**
 * conversations.open — one user id opens (or fetches) the 1:1 IM; two or
 * more open an MPIM. Idempotent on Slack's side. Returns the channel id.
 */
export async function slackConversationsOpen(token: string, userIds: string[], step: string): Promise<string> {
  const json = await slackCall(token, 'conversations.open', { users: userIds.join(',') }, step);
  const channel = json.channel as Record<string, unknown> | undefined;
  const channelId = typeof channel?.id === 'string' ? channel.id : null;
  if (!channelId) throw new SlackApiError(step, 'slack conversations.open failed: no channel id in response');
  return channelId;
}

/** chat.postMessage — plain-text post into a channel, DM, or MPIM. */
export async function slackPostMessage(
  token: string,
  channel: string,
  text: string,
  step = 'post-message',
): Promise<void> {
  await slackCall(token, 'chat.postMessage', { channel, text }, step);
}

/**
 * conversations.info — minimal channel classification: is this an MPIM
 * (group DM), and what is it called?
 */
export async function slackConversationsInfo(
  token: string,
  channelId: string,
  step: string,
): Promise<{ isMpim: boolean; name?: string; creator?: string }> {
  const json = await slackCall(token, 'conversations.info', { channel: channelId }, step);
  const channel = json.channel as Record<string, unknown> | undefined;
  return {
    isMpim: channel?.is_mpim === true,
    name: typeof channel?.name === 'string' ? channel.name : undefined,
    creator: typeof channel?.creator === 'string' ? channel.creator : undefined,
  };
}

/**
 * conversations.members — the channel's full member set (user ids, bots
 * included). Cursor-paginated; the page cap bounds pathological channels —
 * membership comparisons only run over small rooms (MPIMs are ≤9 members).
 */
export async function slackConversationsMembers(token: string, channelId: string, step: string): Promise<string[]> {
  const members: string[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 10; page++) {
    const json = await slackCall(
      token,
      'conversations.members',
      { channel: channelId, limit: 200, ...(cursor ? { cursor } : {}) },
      step,
    );
    for (const m of (json.members as unknown[] | undefined) ?? []) {
      if (typeof m === 'string') members.push(m);
    }
    const meta = json.response_metadata as { next_cursor?: string } | undefined;
    cursor = meta?.next_cursor || undefined;
    if (!cursor) break;
  }
  return members;
}

/** slug.toUpperCase().replace(/-/g, '_') — the .env key suffix shape. */
function envSuffix(slug: string): string {
  return slug.toUpperCase().replace(/-/g, '_');
}

/**
 * .env bot-token key for an adapter-instance key. The default instance
 * ('slack') maps to SLACK_BOT_TOKEN; any other instance key maps to
 * SLACK_BOT_TOKEN_<NAME> with a leading 'slack-' prefix stripped and the
 * remainder uppercased with dashes as underscores (the same suffix shape
 * multi-instance registration writes). Returns the key name only — reading
 * the value stays with the caller.
 */
export function botTokenKeyForInstance(instanceKey: string): string {
  if (instanceKey === 'slack') return 'SLACK_BOT_TOKEN';
  return `SLACK_BOT_TOKEN_${envSuffix(instanceKey.replace(/^slack-/, ''))}`;
}
