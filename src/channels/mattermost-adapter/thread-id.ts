/**
 * Thread id codecs.
 *
 * A Mattermost thread id composes the channel id with the optional root post
 * id: `mattermost:<channelId>` for channel top level, and
 * `mattermost:<channelId>:<rootId>` inside a thread.
 *
 * `:` is unambiguous as a separator because Mattermost ids are 26-character
 * alphanumeric strings (`[a-z0-9]{26}`) and can never contain one. These are
 * pure string functions with no adapter state, so they are safe to reuse from
 * the channel module and from tests.
 */

/** Prefix identifying this adapter inside a thread id. */
export const MATTERMOST_PREFIX = 'mattermost';

/** Platform-specific thread data carried by a Mattermost thread id. */
export interface MattermostThreadId {
  channelId: string;
  /** Root post id, absent for channel top-level threads. */
  rootId?: string;
}

export class ThreadIdError extends Error {
  constructor(threadId: string) {
    super(`Invalid Mattermost thread ID: ${threadId}`);
    this.name = 'ThreadIdError';
  }
}

/** Encode platform data into a thread id string. */
export function encodeThreadId(data: MattermostThreadId): string {
  if (!data.channelId) {
    throw new ThreadIdError(`${MATTERMOST_PREFIX}:<empty channel>`);
  }
  return data.rootId
    ? `${MATTERMOST_PREFIX}:${data.channelId}:${data.rootId}`
    : `${MATTERMOST_PREFIX}:${data.channelId}`;
}

/** Decode a thread id string back into platform data. */
export function decodeThreadId(threadId: string): MattermostThreadId {
  const parts = threadId.split(':');
  if (parts.length < 2 || parts.length > 3 || parts[0] !== MATTERMOST_PREFIX) {
    throw new ThreadIdError(threadId);
  }
  const channelId = parts[1];
  if (!channelId) {
    throw new ThreadIdError(threadId);
  }
  const rootId = parts.length === 3 ? parts[2] : undefined;
  return rootId ? { channelId, rootId } : { channelId };
}

/** Channel id form of a thread id: `mattermost:<channelId>`. */
export function channelIdFromThreadId(threadId: string): string {
  const { channelId } = decodeThreadId(threadId);
  return `${MATTERMOST_PREFIX}:${channelId}`;
}

/** Strip the `mattermost:` prefix from a channel id, if present. */
export function rawChannelId(channelId: string): string {
  const parts = channelId.split(':');
  if (parts[0] === MATTERMOST_PREFIX && parts[1]) {
    return parts[1];
  }
  return channelId;
}
