/**
 * Slack thread-parent fetcher.
 *
 * Looks up the originating top-level message of a Slack thread via
 * `conversations.replies` and returns enough context (id, sender display
 * name, text) for the router to seed `replyTo` on a fresh per-thread
 * session's first inbound. Without this, the agent wakes with no idea
 * what message the user is replying to in a brand-new thread.
 *
 * User and bot display names are resolved through `users.info` /
 * `bots.info` and cached for the host process lifetime — same name lookups
 * recur often and Slack rate-limits Web API calls.
 */

const SLACK_API = 'https://slack.com/api';
const FETCH_TIMEOUT_MS = 4000;
const TEXT_MAX_CHARS = 4000;

interface SlackMessage {
  ts?: string;
  user?: string;
  bot_id?: string;
  username?: string;
  text?: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bot_profile?: { name?: string } | any;
}

export interface ThreadParentFetcherConfig {
  botToken: string;
  /** Optional logger for transient failures. Errors are otherwise swallowed (fail-open). */
  log?: (msg: string, meta?: Record<string, unknown>) => void;
  /** Test seam: override fetch (defaults to globalThis.fetch). */
  fetch?: typeof fetch;
}

/**
 * Strip the "slack:" prefix from a platform_id like "slack:C02CJGH9T".
 * Returns null if the input doesn't look like a Slack platform_id.
 */
export function channelFromPlatformId(platformId: string): string | null {
  if (!platformId.startsWith('slack:')) return null;
  const rest = platformId.slice('slack:'.length);
  if (!rest) return null;
  return rest;
}

/**
 * Strip the "slack:<channel>:" prefix from a thread_id like
 * "slack:C02CJGH9T:1778005926.008039". Returns the bare ts, or null if
 * the input doesn't look like a Slack thread_id for this channel.
 */
export function tsFromThreadId(threadId: string, channel: string): string | null {
  const prefix = `slack:${channel}:`;
  if (!threadId.startsWith(prefix)) return null;
  const ts = threadId.slice(prefix.length);
  if (!ts) return null;
  return ts;
}

export function createThreadParentFetcher(config: ThreadParentFetcherConfig) {
  const f = config.fetch ?? globalThis.fetch;
  const userNameCache = new Map<string, string>();
  const botNameCache = new Map<string, string>();
  const warn = config.log ?? (() => {});

  async function api<T = Record<string, unknown>>(method: string, params: URLSearchParams): Promise<T | null> {
    const url = `${SLACK_API}/${method}?${params.toString()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const r = await f(url, {
        headers: { Authorization: `Bearer ${config.botToken}` },
        signal: controller.signal,
      });
      const j = (await r.json()) as { ok?: boolean; error?: string } & T;
      if (!j.ok) {
        warn('Slack API call returned not-ok', { method, error: j.error });
        return null;
      }
      return j;
    } catch (err) {
      warn('Slack API call failed', { method, err: err instanceof Error ? err.message : String(err) });
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveUserName(userId: string): Promise<string> {
    const cached = userNameCache.get(userId);
    if (cached) return cached;
    const j = await api<{ user?: { real_name?: string; name?: string; profile?: { display_name?: string } } }>(
      'users.info',
      new URLSearchParams({ user: userId }),
    );
    const name = j?.user?.profile?.display_name || j?.user?.real_name || j?.user?.name || userId;
    userNameCache.set(userId, name);
    return name;
  }

  async function resolveBotName(botId: string): Promise<string> {
    const cached = botNameCache.get(botId);
    if (cached) return cached;
    const j = await api<{ bot?: { name?: string } }>('bots.info', new URLSearchParams({ bot: botId }));
    const name = j?.bot?.name || botId;
    botNameCache.set(botId, name);
    return name;
  }

  async function senderFor(msg: SlackMessage): Promise<string> {
    if (msg.bot_profile?.name) return msg.bot_profile.name;
    if (msg.username) return msg.username;
    if (msg.bot_id) return resolveBotName(msg.bot_id);
    if (msg.user) return resolveUserName(msg.user);
    return 'Unknown';
  }

  return async function fetchThreadParent(
    platformId: string,
    threadId: string,
  ): Promise<{ id: string; sender: string; text: string } | null> {
    const channel = channelFromPlatformId(platformId);
    if (!channel) return null;
    const ts = tsFromThreadId(threadId, channel);
    if (!ts) return null;

    const j = await api<{ messages?: SlackMessage[] }>(
      'conversations.replies',
      new URLSearchParams({ channel, ts, inclusive: 'true', limit: '1' }),
    );
    const parent = j?.messages?.[0];
    if (!parent || parent.ts !== ts) return null;

    const text = (parent.text ?? '').slice(0, TEXT_MAX_CHARS);
    if (!text) return null;

    const sender = await senderFor(parent);
    return { id: ts, sender, text };
  };
}
