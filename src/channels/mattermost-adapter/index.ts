/**
 * In-tree Chat SDK `Adapter` for Mattermost.
 *
 * Built against `chat@4.29.0` (pinned exactly). WebSocket inbound with
 * liveness pings and reliable-websocket resume, REST outbound with timeouts
 * and 429 handling, plain-text/markdown round trip with emoji placeholders
 * resolved, interactive cards (buttons, selects, fields, images, plus an
 * authenticated click callback), threads and thread listing, file
 * attachments in both directions (including on edit), ephemeral posts with a
 * DM fallback, link previews, and inbound reactions.
 *
 * Deliberately absent: any routing of `post_edited` / `post_deleted`, which
 * the Slack adapter also drops and the SDK has no sink for.
 */

import { MattermostAdapter } from './adapter.js';
import type { MattermostAdapterOptions } from './adapter.js';

export { MattermostAdapter } from './adapter.js';
export type { MattermostAdapterOptions } from './adapter.js';

export { MattermostApiError, MattermostRestClient, normalizeBaseUrl, rateLimitDelayMs } from './rest.js';
export type { MattermostRestOptions } from './rest.js';

export {
  MATTERMOST_PREFIX,
  ThreadIdError,
  channelIdFromThreadId,
  decodeThreadId,
  encodeThreadId,
  rawChannelId,
} from './thread-id.js';
export type { MattermostThreadId } from './thread-id.js';

export {
  CALLBACK_SECRET_KEY,
  cardToAttachment,
  cardToMarkdown,
  emojify,
  extractFiles,
  isSystemPost,
  renderFormatted,
  renderGfmTable,
  renderPostable,
  toAst,
  toEmojiName,
  toPlainTextFromMarkdown,
} from './format.js';
export type { RenderedMessage, RenderOptions } from './format.js';

export { MattermostSocket, backoffDelay, webSocketUrl } from './websocket.js';
export type { MattermostSocketOptions, SocketLogger } from './websocket.js';

export * from './types.js';

/**
 * Explicit configuration for {@link createMattermostAdapter}.
 *
 * Field names mirror the host's channel wiring (NanoClaw's
 * `src/channels/mattermost.ts`), which reads `MATTERMOST_*` out of its own
 * `.env` and hands the values over directly — hence `botToken` rather than the
 * adapter-internal `token`. Every field is optional: whatever is omitted (or
 * left empty) falls back to `process.env`.
 */
export interface MattermostAdapterConfig extends Partial<Omit<MattermostAdapterOptions, 'token' | 'url'>> {
  /** Bot account token. Overrides `MATTERMOST_BOT_TOKEN`. */
  botToken?: string;
  /** Instance base URL. Overrides `MATTERMOST_URL`. */
  url?: string;
}

/**
 * Build the adapter from explicit config, the environment, or both.
 *
 * Falls back to `MATTERMOST_URL`, `MATTERMOST_BOT_TOKEN`,
 * `MATTERMOST_CALLBACK_URL`, `MATTERMOST_CALLBACK_SECRET` and
 * `MATTERMOST_TEAM` (all but the first two optional) for anything `config`
 * leaves out.
 *
 * Returns `null` when the URL or the bot token is absent from both sources,
 * per the NanoClaw channel-registry contract (spec §7) — an unconfigured
 * channel must not throw at import time.
 *
 * @param config - Explicit values that win over the environment.
 */
export function createMattermostAdapter(config: MattermostAdapterConfig = {}): MattermostAdapter | null {
  const env = process.env;
  const { botToken, callbackSecret, callbackUrl, team, url, ...rest } = config;
  const resolvedUrl = url || env.MATTERMOST_URL;
  const resolvedToken = botToken || env.MATTERMOST_BOT_TOKEN;
  if (!resolvedUrl || !resolvedToken) {
    return null;
  }

  const resolvedCallbackUrl = callbackUrl || env.MATTERMOST_CALLBACK_URL;
  const resolvedCallbackSecret = callbackSecret || env.MATTERMOST_CALLBACK_SECRET;
  const resolvedTeam = team || env.MATTERMOST_TEAM;

  return new MattermostAdapter({
    ...rest,
    url: resolvedUrl,
    token: resolvedToken,
    ...(resolvedCallbackUrl ? { callbackUrl: resolvedCallbackUrl } : {}),
    ...(resolvedCallbackSecret ? { callbackSecret: resolvedCallbackSecret } : {}),
    ...(resolvedTeam ? { team: resolvedTeam } : {}),
  });
}
