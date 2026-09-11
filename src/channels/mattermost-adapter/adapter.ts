/**
 * Chat SDK `Adapter` implementation for Mattermost.
 *
 * WebSocket inbound (with liveness pings and reliable-websocket resume), REST
 * outbound (bounded by timeouts, 429-aware), plain text / markdown round
 * trip, interactive cards — `postMessage` / `editMessage` render buttons and
 * selects as message-attachment actions, and `handleWebhook` authenticates
 * the click and dispatches it into `chat.processAction` — threads, file
 * attachments in both directions (including on edit), ephemeral posts with a
 * DM fallback, link previews, inbound reactions, channel and thread listing.
 *
 * One omission is deliberate rather than pending and documented where it
 * would otherwise live: the routing of `post_edited` / `post_deleted` (see
 * `handleSocketEvent`).
 */

import { ConsoleLogger, defaultEmojiResolver, Message } from 'chat';
import type {
  ActionEvent,
  Adapter,
  AdapterPostableMessage,
  Attachment,
  Author,
  ChannelInfo,
  ChannelVisibility,
  ChatInstance,
  EmojiValue,
  EphemeralMessage,
  FetchOptions,
  FetchResult,
  FileUpload,
  FormattedContent,
  LinkPreview,
  ListThreadsOptions,
  ListThreadsResult,
  LockScope,
  Logger,
  RawMessage,
  ReactionEvent,
  ThreadInfo,
  ThreadSummary,
  UserInfo,
  WebhookOptions,
} from 'chat';

import {
  CALLBACK_SECRET_KEY,
  carriesCard,
  extractFiles,
  isSystemPost,
  renderFormatted,
  renderPostable,
  toAst,
  toEmojiName,
  toPlainTextFromMarkdown,
} from './format.js';
import type { RenderOptions } from './format.js';
import { MattermostApiError, MattermostRestClient, normalizeBaseUrl } from './rest.js';
import { channelIdFromThreadId, decodeThreadId, encodeThreadId, rawChannelId } from './thread-id.js';
import type { MattermostThreadId } from './thread-id.js';
import { MattermostSocket } from './websocket.js';
import type {
  MattermostChannelInfo,
  MattermostChannelType,
  MattermostFileInfo,
  MattermostHelloEventData,
  MattermostPost,
  MattermostPostList,
  MattermostPostProps,
  MattermostPostedEventData,
  MattermostReaction,
  MattermostUser,
  MattermostWebSocketEvent,
  PostActionIntegrationRequest,
} from './types.js';
import { isExplicitMention, parseEncoded, reactionChannelId } from './types.js';

const DEFAULT_FETCH_LIMIT = 60;
/** Mattermost caps `per_page` at 200 on the post endpoints. */
const MAX_PAGE_SIZE = 200;
const MATTERMOST_ID = /^[a-z0-9]{26}$/;

/**
 * Path segment the NanoClaw host's webhook server routes to this adapter
 * (`src/webhook-server.ts`: `/webhook/{adapterName}`). Appended to a
 * `callbackUrl` that does not already point at a webhook route, so
 * `MATTERMOST_CALLBACK_URL` can be the plain externally-reachable base URL.
 */
const WEBHOOK_PATH = '/webhook/mattermost';

export interface MattermostAdapterOptions {
  /**
   * Shared secret every interactive action carries back in its context.
   * When set, `handleWebhook` rejects callbacks that do not present it —
   * the only authentication Mattermost's action callbacks can have. Cards
   * posted before the secret was configured stop being clickable.
   */
  callbackSecret?: string;
  /** Externally reachable base URL Mattermost POSTs button clicks to. */
  callbackUrl?: string;
  /** Injectable for tests. */
  fetchImpl?: typeof fetch;
  /** Liveness ping interval for the WebSocket. `0` disables. Default 30s. */
  heartbeatIntervalMs?: number;
  /** Per-request REST deadline. Default 30s. */
  requestTimeoutMs?: number;
  /** Skip opening the WebSocket during `initialize` (tests). */
  skipSocket?: boolean;
  /** Optional team scope. Recorded on thread metadata; not enforced. */
  team?: string;
  /** Bot account token. */
  token: string;
  /** Instance base URL, e.g. `https://mm.example.com`. */
  url: string;
}

/**
 * Cursors are tagged so channel-page and post-anchored pagination can share
 * one opaque string: `before:<postId>` (backward) and `after:<postId>`
 * (forward). `page:<n>` remains accepted for cursors emitted by 0.1.0 before
 * anchor-based pagination was introduced.
 */
type Cursor = { kind: 'page'; page: number } | { kind: 'after'; postId: string } | { kind: 'before'; postId: string };

/**
 * Extract the Mattermost post id from a message id that may carry host-side
 * decoration. NanoClaw's bridge hands adapters the host's composite message id
 * verbatim — observed live as `<postId>:<agentGroupId>` (the host namespaces
 * inbound message ids per agent group) — and Mattermost rejects that whole
 * string as a `post_id` with the same opaque 400 an invalid emoji gets.
 * Mattermost ids are 26 chars of `[a-z0-9]` and never contain `:`, so take
 * the first segment shaped like one; fall back to the first segment.
 */
function toPostId(messageId: string): string {
  const segments = messageId.split(':');
  return segments.find((s) => MATTERMOST_ID.test(s)) ?? segments[0] ?? messageId;
}

function parseCursor(cursor: string | undefined): Cursor | undefined {
  if (!cursor) {
    return undefined;
  }
  const [kind, value] = cursor.split(':');
  if (kind === 'page' && value !== undefined) {
    const page = Number.parseInt(value, 10);
    return Number.isNaN(page) ? undefined : { kind: 'page', page };
  }
  if (kind === 'after' && value) {
    return { kind: 'after', postId: value };
  }
  if (kind === 'before' && value) {
    return { kind: 'before', postId: value };
  }
  return undefined;
}

/**
 * A `Map` that forgets its least-recently-used entry past `capacity`. Every
 * cache in the adapter is one of these: a long-lived bot sees an unbounded
 * stream of users, channels and cards, and none of them may grow without
 * limit.
 */
class BoundedMap<K, V> {
  private readonly map = new Map<K, V>();

  constructor(private readonly capacity: number) {}

  get size(): number {
    return this.map.size;
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get(key: K): V | undefined {
    const value = this.map.get(key);
    if (value !== undefined) {
      this.map.delete(key);
      this.map.set(key, value);
    }
    return value;
  }

  has(key: K): boolean {
    return this.map.has(key);
  }

  set(key: K, value: V): void {
    this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.map.delete(oldest);
    }
  }
}

interface KnownUser {
  fullName?: string;
  isBot?: boolean;
  /** Whether a full `GetUser` has been seen, as opposed to a frame's handle. */
  resolved: boolean;
  userName?: string;
}

export class MattermostAdapter implements Adapter<MattermostThreadId, MattermostPost> {
  readonly name = 'mattermost';
  /**
   * A Mattermost thread is a real unit of concurrency: replies in one thread
   * do not interleave with the channel, so the SDK may lock per thread.
   */
  readonly lockScope: LockScope = 'thread';
  /** Overwritten from `/users/me` during `initialize`. */
  userName = 'mattermost-bot';
  botUserId: string | undefined;

  readonly rest: MattermostRestClient;

  private readonly callbackSecret: string | undefined;
  private readonly callbackUrl: string | undefined;
  /**
   * Posts this adapter wrote interactive attachments onto.
   *
   * Two jobs, both on the click path:
   *  - `threadId` recovers the posting thread, which the callback body does
   *    not carry (it has `channel_id` but no `root_id`).
   *  - `props` is the server's own props for the post minus `attachments`, so
   *    a later card-less `editMessage` can clear the buttons without dropping
   *    `from_bot` and friends.
   *
   * Entries are added on post, refreshed on click (so a process restart
   * mid-question still clears the card), and dropped when the card is cleared.
   */
  private readonly cardPosts = new BoundedMap<string, { props: MattermostPostProps; threadId: string }>(500);
  /** `isDM` is synchronous, so channel types are cached as they are observed. */
  private readonly channelTypes = new BoundedMap<string, MattermostChannelType>(2_000);
  private chat: ChatInstance | undefined;
  /** Set after the first 403 from `/posts/ephemeral`; later calls go straight to the DM fallback. */
  private ephemeralForbidden = false;
  private logger: Logger;
  private readonly options: MattermostAdapterOptions;
  /**
   * Per-channel pre-dispatch chains for `posted` frames.
   *
   * Resolving an uncached author requires REST. Without a chain, a later
   * frame whose lookup finishes first can enter `chat.processMessage` ahead
   * of an earlier frame from the same channel, defeating the SDK's ordered
   * thread locking before it even sees the messages.
   */
  private readonly postedQueues = new BoundedMap<string, Promise<void>>(2_000);
  private socket: MattermostSocket | undefined;
  /**
   * What is known about a Mattermost user id, from any source: a `posted`
   * frame's `sender_name`, an action callback's `user_name`, or a full
   * `GetUser`. One cache, so every projection of the same person agrees
   * (see {@link projectAuthor}).
   */
  private readonly users = new BoundedMap<string, KnownUser>(2_000);

  constructor(options: MattermostAdapterOptions) {
    this.options = { ...options, url: normalizeBaseUrl(options.url) };
    this.callbackUrl = options.callbackUrl;
    this.callbackSecret = options.callbackSecret;
    this.logger = new ConsoleLogger('info', 'mattermost');
    this.rest = new MattermostRestClient({
      baseUrl: this.options.url,
      token: options.token,
      fetchImpl: options.fetchImpl,
      timeoutMs: options.requestTimeoutMs,
    });
  }

  // =========================================================================
  // Lifecycle
  // =========================================================================

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
    this.logger = chat.getLogger('mattermost');

    try {
      const me = await this.rest.getMe();
      this.botUserId = me.id;
      this.userName = me.username;
      this.cacheUser(me);
      this.logger.info('Mattermost auth completed', {
        botUserId: this.botUserId,
        userName: this.userName,
      });
    } catch (error) {
      this.logger.error('Mattermost: could not resolve bot user', { error });
      throw error;
    }

    if (this.options.skipSocket) {
      return;
    }

    this.socket = new MattermostSocket({
      baseUrl: this.options.url,
      heartbeatIntervalMs: this.options.heartbeatIntervalMs,
      logger: this.logger,
      onEvent: (event) => this.handleSocketEvent(event),
      token: this.options.token,
    });
    await this.socket.connect();
  }

  async disconnect(): Promise<void> {
    await this.socket?.disconnect();
    this.socket = undefined;
  }

  // =========================================================================
  // Thread id codecs
  // =========================================================================

  encodeThreadId(platformData: MattermostThreadId): string {
    return encodeThreadId(platformData);
  }

  decodeThreadId(threadId: string): MattermostThreadId {
    return decodeThreadId(threadId);
  }

  channelIdFromThreadId(threadId: string): string {
    return channelIdFromThreadId(threadId);
  }

  /**
   * Mattermost channel ids carry no type prefix (unlike Slack's `D...`), so
   * this answers from the channel-type cache populated by inbound frames,
   * `fetchThread`, `fetchChannelInfo`, `openDM` and `onThreadSubscribe`.
   * Unknown channels report `false`.
   */
  isDM(threadId: string): boolean {
    const { channelId } = decodeThreadId(threadId);
    return this.channelTypes.get(channelId) === 'D';
  }

  /** Synchronous twin of `fetchThread().channelVisibility`, from the same cache `isDM` reads. */
  getChannelVisibility(threadId: string): ChannelVisibility {
    const { channelId } = decodeThreadId(threadId);
    const type = this.channelTypes.get(channelId);
    return type ? visibilityOf(type) : 'unknown';
  }

  /**
   * Prime the channel-type cache when the SDK starts following a thread, so
   * `isDM` / `getChannelVisibility` are right for it even before a frame has
   * been seen (the "cold DM" case: a thread subscribed from persisted state
   * after a restart). Best-effort — a failed read leaves the cache as it was.
   */
  async onThreadSubscribe(threadId: string): Promise<void> {
    const { channelId } = decodeThreadId(threadId);
    if (this.channelTypes.has(channelId)) {
      return;
    }
    try {
      await this.fetchThread(threadId);
    } catch (error) {
      this.logger.debug('Mattermost: could not prime channel type on subscribe', {
        channelId,
        error,
      });
    }
  }

  // =========================================================================
  // Formatting
  // =========================================================================

  renderFormatted(content: FormattedContent): string {
    return renderFormatted(content);
  }

  parseMessage(raw: MattermostPost): Message<MattermostPost> {
    const threadId = threadIdForPost(raw);
    const message = this.toMessage(raw, threadId);
    message.isMention = this.detectTextMention(raw);
    return message;
  }

  // =========================================================================
  // Outbound
  // =========================================================================

  async postMessage(threadId: string, message: AdapterPostableMessage): Promise<RawMessage<MattermostPost>> {
    const { channelId, rootId } = decodeThreadId(threadId);
    const { message: body, props } = renderPostable(message, this.renderOptions());
    const fileIds = await this.uploadFiles(channelId, extractFiles(message));
    const post = await this.rest.createPost({
      channel_id: channelId,
      message: body,
      ...(fileIds.length > 0 ? { file_ids: fileIds } : {}),
      ...(props ? { props } : {}),
      ...(rootId ? { root_id: rootId } : {}),
    });
    if (props) {
      this.rememberCardPost(post, threadId);
    }
    return { id: post.id, raw: post, threadId };
  }

  /** Post at channel top level. `channelId` may be raw or `mattermost:`-prefixed. */
  postChannelMessage(channelId: string, message: AdapterPostableMessage): Promise<RawMessage<MattermostPost>> {
    return this.postMessage(encodeThreadId({ channelId: rawChannelId(channelId) }), message);
  }

  /**
   * CreateEphemeralPost — visible to `userId` alone, in place.
   *
   * The endpoint is gated on `create_post_ephemeral`, which Team Edition
   * grants to system admins only (probed live: 403 for a plain bot). Rather
   * than leave the member off — which would make every ephemeral silently
   * disappear unless the caller opted into the SDK's own DM fallback — a 403
   * falls back to a DM with `usedFallback: true`, the signal the SDK defines
   * for exactly this, and the 403 is remembered so later calls skip the
   * doomed request. Files are not carried on the ephemeral path (an
   * ephemeral post has no channel to upload into on the recipient's behalf);
   * the DM fallback carries them.
   */
  async postEphemeral(
    threadId: string,
    userId: string,
    message: AdapterPostableMessage,
  ): Promise<EphemeralMessage<MattermostPost>> {
    if (!this.ephemeralForbidden) {
      const { channelId, rootId } = decodeThreadId(threadId);
      const { message: body, props } = renderPostable(message, this.renderOptions());
      try {
        const post = await this.rest.createEphemeralPost(userId, {
          channel_id: channelId,
          message: body,
          ...(props ? { props } : {}),
          ...(rootId ? { root_id: rootId } : {}),
        });
        return { id: post.id, raw: post, threadId, usedFallback: false };
      } catch (error) {
        if (!(error instanceof MattermostApiError) || error.status !== 403) {
          throw error;
        }
        this.ephemeralForbidden = true;
        this.logger.warn(
          'Mattermost: ephemeral posts need the create_post_ephemeral permission (system admin); falling back to DMs for this process',
        );
      }
    }
    const dmThreadId = await this.openDM(userId);
    const result = await this.postMessage(dmThreadId, message);
    return { id: result.id, raw: result.raw, threadId: dmThreadId, usedFallback: true };
  }

  /**
   * PatchPost.
   *
   * Cards need one extra step over a plain edit: Mattermost keeps whatever
   * `props` a post already has unless the patch replaces them, so editing a
   * card down to plain text would leave its buttons live and clickable. When
   * the target is a known card post and the new content carries no attachment,
   * the patch therefore rewrites `props` without `attachments` — which is how
   * an `ask_question` card reaches its terminal state, since the Chat SDK's
   * `processAction` returns `void` and cannot carry the resolved card back in
   * the click response.
   *
   * Files on an edit are uploaded and *added* to the post's existing files:
   * a patch's `file_ids` replaces the set, so the current ids are read first.
   */
  async editMessage(
    threadId: string,
    rawMessageId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<MattermostPost>> {
    const messageId = toPostId(rawMessageId);
    const { channelId } = decodeThreadId(threadId);
    const { message: body, props } = renderPostable(message, this.renderOptions());
    const files = extractFiles(message);
    const [clearedProps, fileIds] = await Promise.all([
      props ? undefined : this.propsClearingCard(messageId, carriesCard(message)),
      files.length > 0 ? this.fileIdsForEdit(messageId, channelId, files) : undefined,
    ]);
    const nextProps = props ?? clearedProps;
    const post = await this.rest.patchPost(messageId, {
      message: body,
      ...(nextProps ? { props: nextProps } : {}),
      ...(fileIds ? { file_ids: fileIds } : {}),
    });
    if (props) {
      this.rememberCardPost(post, threadId);
    } else if (clearedProps) {
      this.cardPosts.delete(messageId);
    }
    return { id: post.id, raw: post, threadId };
  }

  async deleteMessage(_threadId: string, messageId: string): Promise<void> {
    await this.rest.deletePost(toPostId(messageId));
  }

  async addReaction(_threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    const userId = this.requireBotUserId();
    await this.rest.addReaction(userId, toPostId(messageId), toEmojiName(emoji));
  }

  async removeReaction(_threadId: string, messageId: string, emoji: EmojiValue | string): Promise<void> {
    const userId = this.requireBotUserId();
    await this.rest.removeReaction(userId, toPostId(messageId), toEmojiName(emoji));
  }

  async startTyping(threadId: string): Promise<void> {
    const { channelId, rootId } = decodeThreadId(threadId);
    const userId = this.requireBotUserId();
    await this.rest.publishUserTyping(userId, {
      channel_id: channelId,
      ...(rootId ? { parent_id: rootId } : {}),
    });
  }

  /**
   * CreateDirectChannel, returned as a channel-level thread id.
   *
   * Accepts a Mattermost user id or a handle (`ethan` / `@ethan`): the host's
   * `openDM` tool is fed by humans and agents, who know handles, not ids.
   */
  async openDM(userIdOrHandle: string): Promise<string> {
    const userId = await this.resolveUserId(userIdOrHandle);
    const channel = await this.rest.createDirectChannel(this.requireBotUserId(), userId);
    this.channelTypes.set(channel.id, channel.type);
    return encodeThreadId({ channelId: channel.id });
  }

  async getUser(userId: string): Promise<UserInfo | null> {
    try {
      const user = await this.rest.getUser(userId);
      this.cacheUser(user);
      return {
        userId: user.id,
        userName: user.username,
        fullName: fullNameOf(user),
        isBot: user.is_bot === true,
        avatarUrl: this.rest.userImageUrl(user.id),
        ...(user.email ? { email: user.email } : {}),
      };
    } catch (error) {
      this.logger.debug('Mattermost: getUser failed', { userId, error });
      return null;
    }
  }

  // =========================================================================
  // Fetching
  // =========================================================================

  /** One post by id, or `null` when Mattermost has no such post. */
  async fetchMessage(_threadId: string, messageId: string): Promise<Message<MattermostPost> | null> {
    try {
      const post = await this.rest.getPost(toPostId(messageId));
      return this.parseMessage(post);
    } catch (error) {
      if (error instanceof MattermostApiError && error.status === 404) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Thread replies when the thread id carries a root post, channel posts
   * otherwise.
   *
   * Cursors come straight off the server's `prev_post_id` / `next_post_id`
   * (the post beyond the page's oldest / newest edge, `""` at the end), so a
   * page is marked continuable exactly when more exists.
   *
   * Mattermost has no direct "oldest page" query. For the first forward page,
   * the adapter therefore follows anchored `before` pages to the oldest edge;
   * subsequent pages use the returned `after:` cursor normally. Thread
   * fetches return the whole thread in one page (threads are bounded).
   */
  async fetchMessages(threadId: string, options: FetchOptions = {}): Promise<FetchResult<MattermostPost>> {
    const { channelId, rootId } = decodeThreadId(threadId);
    const limit = clampLimit(options.limit);

    if (rootId) {
      // Mattermost's thread endpoint defaults `perPage` to 0, meaning all
      // replies. Supplying the SDK page limit without implementing the
      // endpoint's timestamp cursor silently truncated long threads while
      // returning no `nextCursor`. Fetch the complete thread instead: thread
      // replies are the bounded conversation unit this adapter exposes.
      const list = await this.rest.getPostThread(rootId);
      return { messages: this.orderedMessages(list, threadId) };
    }

    const cursor = parseCursor(options.cursor);
    const direction = options.direction ?? 'backward';

    if (direction === 'forward') {
      const continuing = cursor?.kind === 'after';
      const { list, traversed } = continuing
        ? {
            list: await this.rest.getChannelPosts(channelId, {
              per_page: limit,
              after: cursor.postId,
            }),
            traversed: false,
          }
        : await this.fetchOldestChannelPage(channelId, limit);
      const messages = this.orderedMessages(list, threadId);
      const newest = list.order[0];
      const hasNewer = continuing
        ? hasMore(list.next_post_id, list.order.length, limit)
        : traversed || (list.next_post_id !== undefined && list.next_post_id !== '');
      return {
        messages,
        ...(hasNewer && newest ? { nextCursor: `after:${newest}` } : {}),
      };
    }

    const page = cursor?.kind === 'page' ? cursor.page : undefined;
    const list = await this.rest.getChannelPosts(channelId, {
      ...(cursor?.kind === 'before' ? { before: cursor.postId } : {}),
      ...(page === undefined ? {} : { page }),
      per_page: limit,
    });
    const messages = this.orderedMessages(list, threadId);
    const oldest = list.order.at(-1);
    return {
      messages,
      ...(hasMore(list.prev_post_id, list.order.length, limit) && oldest ? { nextCursor: `before:${oldest}` } : {}),
    };
  }

  /** Channel top-level history. `channelId` may be raw or `mattermost:`-prefixed. */
  fetchChannelMessages(channelId: string, options?: FetchOptions): Promise<FetchResult<MattermostPost>> {
    return this.fetchMessages(encodeThreadId({ channelId: rawChannelId(channelId) }), options);
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    const { channelId, rootId } = decodeThreadId(threadId);
    const channel = await this.rest.getChannel(channelId);
    this.channelTypes.set(channel.id, channel.type);
    return {
      id: threadId,
      channelId,
      channelName: channel.display_name || channel.name,
      channelVisibility: visibilityOf(channel.type),
      isDM: channel.type === 'D',
      metadata: {
        channelType: channel.type,
        rootId,
        teamId: channel.team_id ?? this.options.team,
      },
    };
  }

  /**
   * Channel description. The member count rides on a second, best-effort
   * request (`GetChannelStats`); a failure there leaves `memberCount` unset
   * rather than failing the lookup.
   */
  async fetchChannelInfo(channelId: string): Promise<ChannelInfo> {
    const id = rawChannelId(channelId);
    const [channel, stats] = await Promise.all([
      this.rest.getChannel(id),
      this.rest.getChannelStats(id).catch((error: unknown) => {
        this.logger.debug('Mattermost: channel stats unavailable', { channelId: id, error });
        return undefined;
      }),
    ]);
    this.channelTypes.set(channel.id, channel.type);
    return {
      id: channel.id,
      name: channel.display_name || channel.name,
      isDM: channel.type === 'D',
      channelVisibility: visibilityOf(channel.type),
      ...(stats ? { memberCount: stats.member_count } : {}),
      metadata: {
        channelType: channel.type,
        header: channel.header,
        purpose: channel.purpose,
        teamId: channel.team_id ?? this.options.team,
      },
    };
  }

  /**
   * Threads in a channel: its root posts that have replies, newest first.
   * Mattermost has no threads-in-channel query short of the channel's posts,
   * so this walks them page by page (using stable post anchors) and keeps the roots
   * with a `reply_count`. A page of posts that happens to hold no threads
   * still advances the cursor, so callers should loop on `nextCursor`.
   */
  async listThreads(channelId: string, options: ListThreadsOptions = {}): Promise<ListThreadsResult<MattermostPost>> {
    const id = rawChannelId(channelId);
    const limit = clampLimit(options.limit);
    const cursor = parseCursor(options.cursor);
    const page = cursor?.kind === 'page' ? cursor.page : undefined;
    const list = await this.rest.getChannelPosts(id, {
      ...(cursor?.kind === 'before' ? { before: cursor.postId } : {}),
      ...(page === undefined ? {} : { page }),
      per_page: limit,
    });
    const threads: ThreadSummary<MattermostPost>[] = [];
    for (const postId of list.order ?? []) {
      const post = list.posts?.[postId];
      if (!post || post.root_id || isSystemPost(post) || !(post.reply_count && post.reply_count > 0)) {
        continue;
      }
      const threadId = encodeThreadId({ channelId: id, rootId: post.id });
      threads.push({
        id: threadId,
        rootMessage: this.toMessage(post, threadId),
        replyCount: post.reply_count,
        ...(post.last_reply_at ? { lastReplyAt: new Date(post.last_reply_at) } : {}),
      });
    }
    const oldest = list.order?.at(-1);
    return {
      threads,
      ...(hasMore(list.prev_post_id, list.order?.length ?? 0, limit) && oldest
        ? { nextCursor: `before:${oldest}` }
        : {}),
    };
  }

  // =========================================================================
  // Inbound: WebSocket
  // =========================================================================

  /** Dispatch one decoded WebSocket event frame. Exposed for tests. */
  handleSocketEvent(event: MattermostWebSocketEvent): void {
    switch (event.event) {
      case 'hello': {
        const data = event.data as MattermostHelloEventData | undefined;
        this.logger.debug('Mattermost WS: hello', { serverVersion: data?.server_version });
        return;
      }
      case 'posted':
        this.enqueuePosted(event);
        return;
      case 'post_edited':
      case 'post_deleted':
        // Deliberately not routed, matching the Slack adapter: it lists
        // `message_deleted` among the subtypes it drops outright, and handles
        // `message_changed` only to harvest link-unfurl metadata — never
        // re-dispatching an edit as a message. The Chat SDK has no edit or
        // delete sink to route them to either (`chat.process*` covers
        // messages, reactions, actions, modals and slash commands, and
        // nothing else). Re-dispatching an edit as a fresh `processMessage`
        // was rejected on purpose: every edit of an old post would look like
        // a new message to the router and could re-trigger an agent.
        this.logger.debug('Mattermost WS: post lifecycle event, not routed', {
          event: event.event,
        });
        return;
      case 'reaction_added':
      case 'reaction_removed':
        void this.handleReaction(event);
        return;
      case 'typing':
      case 'status_change':
        // Informational; the SDK has no sink for either.
        return;
      default:
        this.logger.debug('Mattermost WS: unhandled event', { event: event.event });
    }
  }

  /** Preserve WebSocket order while asynchronous author lookups complete. */
  private enqueuePosted(event: MattermostWebSocketEvent): void {
    const data = event.data as MattermostPostedEventData | undefined;
    const post = parseEncoded<MattermostPost>(data?.post);
    // Malformed frames share a queue so their warnings remain ordered too.
    const channelId = post?.channel_id || event.broadcast?.channel_id || '<unknown>';
    const previous = this.postedQueues.get(channelId) ?? Promise.resolve();
    const task = previous
      .then(() => this.handlePosted(event))
      .catch((error: unknown) => {
        this.logger.error('Mattermost WS: posted frame handling failed', {
          channelId,
          error,
        });
      });
    this.postedQueues.set(channelId, task);
    void task.then(() => {
      if (this.postedQueues.get(channelId) === task) {
        this.postedQueues.delete(channelId);
      }
    });
  }

  private async handlePosted(event: MattermostWebSocketEvent): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      return;
    }
    const data = event.data as MattermostPostedEventData | undefined;
    const post = parseEncoded<MattermostPost>(data?.post);
    if (!post?.id || !post.channel_id) {
      this.logger.warn('Mattermost WS: posted frame without a usable post');
      return;
    }
    if (data?.channel_type) {
      this.channelTypes.set(post.channel_id, data.channel_type);
    }
    if (post.user_id === this.botUserId) {
      return;
    }
    if (isSystemPost(post)) {
      return;
    }

    const senderName = data?.sender_name?.replace(/^@/, '');
    if (senderName) {
      this.rememberUser(post.user_id, { userName: senderName });
    }
    // One `GetUser` per user per process: a frame carries the handle but not
    // the display name or bot flag, and the host bylines messages with the
    // former. Failure is tolerated — the handle is still a fine name.
    await this.ensureUserResolved(post.user_id);

    const threadId = threadIdForPost(post);
    const message = this.toMessage(post, threadId);
    // Mattermost puts the other participant in `data.mentions` on every DM
    // post, so only non-DM channels can report an explicit @-mention.
    message.isMention = isExplicitMention(event.data, this.botUserId);

    void chat.processMessage(this, threadId, message);
  }

  /**
   * `reaction_added` / `reaction_removed` → `chat.processReaction`, mirroring
   * the Slack adapter's literal.
   *
   * Two Mattermost quirks are handled here:
   *  - the encoded reaction's `channel_id` is empty on removals, so the
   *    channel comes off `broadcast.channel_id` (see `reactionChannelId`);
   *  - the frame says nothing about the reacted-to post's thread. Slack pays a
   *    REST read to root a reaction in its parent thread, and so do we — one
   *    `GetPost` — so reacting inside a thread does not surface as a
   *    channel-level event. The same read supplies the event's `message`. A
   *    failed read degrades to the channel-level thread id rather than
   *    dropping the reaction.
   */
  private async handleReaction(event: MattermostWebSocketEvent): Promise<void> {
    const chat = this.chat;
    if (!chat) {
      return;
    }
    const reaction = parseEncoded<MattermostReaction>(event.data?.reaction);
    if (!reaction?.post_id || !reaction.emoji_name) {
      this.logger.warn('Mattermost WS: reaction frame without a usable reaction');
      return;
    }
    const channelId = reactionChannelId(event, reaction);
    if (!channelId) {
      this.logger.warn('Mattermost WS: reaction frame without a channel', {
        postId: reaction.post_id,
      });
      return;
    }

    let post: MattermostPost | undefined;
    try {
      post = await this.rest.getPost(reaction.post_id);
    } catch (error) {
      this.logger.debug('Mattermost: could not root reaction in its thread', {
        postId: reaction.post_id,
        error,
      });
    }
    const rootId = post?.root_id || undefined;
    const threadId = encodeThreadId({ channelId, ...(rootId ? { rootId } : {}) });
    await this.ensureUserResolved(reaction.user_id);

    const reactionEvent: Omit<ReactionEvent<MattermostPost>, 'adapter' | 'thread'> = {
      added: event.event === 'reaction_added',
      emoji: defaultEmojiResolver.fromSlack(reaction.emoji_name),
      messageId: reaction.post_id,
      ...(post ? { message: this.toMessage(post, threadId) } : {}),
      raw: event,
      // Mattermost emoji names are Slack-style shortcodes (`+1`,
      // `white_check_mark`), so the SDK's Slack resolver is the right decoder.
      rawEmoji: reaction.emoji_name,
      threadId,
      user: this.projectAuthor(reaction.user_id),
    };
    chat.processReaction({ ...reactionEvent, adapter: this });
  }

  // =========================================================================
  // Inbound: HTTP (button callbacks)
  // =========================================================================

  /**
   * Interactive-message callback.
   *
   * Mattermost POSTs a `PostActionIntegrationRequest` to
   * `PostAction.integration.url` when a button is clicked — unlike Slack
   * Socket Mode, this is a real inbound HTTP route, served by the host's
   * webhook server at `/webhook/mattermost`.
   *
   * Mattermost signs nothing on this request. When a `callbackSecret` is
   * configured, the click must present it in `context` (where
   * `cardToAttachment` put it and where no client can read it); a callback
   * without it is refused with 401 before anything is dispatched.
   *
   * The dispatch is fire-and-forget, mirroring Slack's `handleBlockActions`:
   * `chat.processAction` is started and the 200 goes back immediately, because
   * Mattermost blocks the clicking client on this response. The card's
   * terminal state therefore arrives as a follow-up `PatchPost` from the
   * bridge's `onAction` handler, not in this body (see `editMessage`).
   */
  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    if (!this.isActionCallbackPath(request)) {
      this.logger.debug('Mattermost webhook: unrecognised path', {
        path: new URL(request.url).pathname,
      });
      return new Response('ok', { status: 200 });
    }

    let payload: PostActionIntegrationRequest;
    try {
      payload = (await request.json()) as PostActionIntegrationRequest;
    } catch {
      return new Response('Invalid JSON', { status: 400 });
    }

    if (this.callbackSecret !== undefined) {
      const presented = payload.context?.[CALLBACK_SECRET_KEY];
      if (presented !== this.callbackSecret) {
        this.logger.warn('Mattermost action callback rejected: missing or wrong callback secret', {
          postId: payload.post_id,
          userId: payload.user_id,
        });
        return new Response('Unauthorized', { status: 401 });
      }
    }

    const event = this.toActionEvent(payload);
    if (!event) {
      this.logger.warn('Mattermost action callback: unusable payload', {
        hasContext: Boolean(payload.context),
        postId: payload.post_id,
      });
      return new Response('Bad request', { status: 400 });
    }
    event.threadId = (await this.actionThreadId(payload)) ?? event.threadId;

    const chat = this.chat;
    if (!chat) {
      this.logger.warn('Mattermost action callback arrived before initialize');
      return this.actionResponse();
    }

    // A failed recovery still needs the old best-effort cache entry so the
    // follow-up edit knows this was a card and can clear its actions.
    if (payload.post_id && !this.cardPosts.has(payload.post_id)) {
      this.cardPosts.set(payload.post_id, { props: {}, threadId: event.threadId });
    }

    this.logger.debug('Mattermost action dispatched', {
      actionId: event.actionId,
      messageId: event.messageId,
      threadId: event.threadId,
    });
    void chat.processAction(event, options);

    return this.actionResponse();
  }

  /**
   * Project a callback body onto the SDK's `ActionEvent`.
   *
   * `context.action_id` / `context.value` are the round trip of what
   * `cardToAttachment` put in `integration.context`; the user goes through the
   * same {@link projectAuthor} a post author does, so `onAction` and
   * `onInbound` cannot disagree on identity.
   *
   * `context.selected_option` is the server's own addition on a `select`
   * click and holds the chosen option's value; it takes precedence over the
   * static `context.value` a button carries, since a select writes no `value`.
   */
  private toActionEvent(
    payload: PostActionIntegrationRequest,
  ): (Omit<ActionEvent, 'thread' | 'openModal'> & { adapter: Adapter }) | undefined {
    const actionId = payload.context?.action_id;
    if (typeof actionId !== 'string' || !actionId || !payload.post_id) {
      return undefined;
    }
    const userId = payload.user_id ?? '';
    if (payload.user_name) {
      this.rememberUser(userId, { userName: payload.user_name });
    }
    const rawValue = payload.context?.selected_option ?? payload.context?.value;
    const cached = this.cardPosts.get(payload.post_id);
    const threadId = cached?.threadId ?? encodeThreadId({ channelId: payload.channel_id ?? '' });
    return {
      actionId,
      adapter: this,
      messageId: payload.post_id,
      raw: payload,
      threadId,
      ...(payload.trigger_id ? { triggerId: payload.trigger_id } : {}),
      user: this.projectAuthor(userId, { fallbackUserName: payload.user_name }),
      ...(rawValue === undefined ? {} : { value: String(rawValue) }),
    };
  }

  /**
   * Recover a card's rooted thread after a process restart.
   *
   * Mattermost's callback body carries `channel_id` and `post_id`, but omits
   * the post's `root_id`. The in-memory card cache handles clicks during one
   * process lifetime; after restart, read the post once so the action reaches
   * the same thread and preserve its non-card props for the terminal edit.
   */
  private async actionThreadId(payload: PostActionIntegrationRequest): Promise<string | undefined> {
    if (!payload.post_id) {
      return undefined;
    }
    const cached = this.cardPosts.get(payload.post_id);
    if (cached) {
      return cached.threadId;
    }
    try {
      const post = await this.rest.getPost(payload.post_id);
      const threadId = threadIdForPost(post);
      this.rememberCardPost(post, threadId);
      return threadId;
    } catch (error) {
      this.logger.debug('Mattermost action callback: could not recover posting thread', {
        error,
        postId: payload.post_id,
      });
      return undefined;
    }
  }

  /** Empty `PostActionIntegrationResponse` — accept the click, change nothing. */
  private actionResponse(): Response {
    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }

  /**
   * Fully-qualified URL Mattermost should POST clicks to, or `undefined` when
   * no callback URL is configured (cards then degrade to markdown).
   *
   * `MATTERMOST_CALLBACK_URL` may be either the host's externally reachable
   * base URL (the webhook route is appended) or the full route already.
   */
  private actionCallbackUrl(): string | undefined {
    if (!this.callbackUrl) {
      return undefined;
    }
    const trimmed = this.callbackUrl.replace(/\/+$/, '');
    return trimmed.includes('/webhook/') ? trimmed : `${trimmed}${WEBHOOK_PATH}`;
  }

  private renderOptions(): RenderOptions {
    return {
      callbackUrl: this.actionCallbackUrl(),
      callbackSecret: this.callbackSecret,
    };
  }

  /**
   * Whether a request targets the interactive-action callback.
   *
   * Accepts the host's own route (`/webhook/mattermost`), the trailing
   * `/actions` segment, and — when a callback URL is configured — the exact
   * path that was written into `integration.url`.
   */
  private isActionCallbackPath(request: Request): boolean {
    let pathname: string;
    try {
      pathname = new URL(request.url).pathname;
    } catch {
      return false;
    }
    const normalized = pathname.replace(/\/+$/, '') || '/';
    if (normalized === WEBHOOK_PATH || normalized.endsWith('/actions')) {
      return true;
    }
    const configured = this.actionCallbackUrl();
    if (!configured) {
      return false;
    }
    try {
      return new URL(configured).pathname.replace(/\/+$/, '') === normalized;
    } catch {
      return false;
    }
  }

  // =========================================================================
  // Internals
  // =========================================================================

  private cacheUser(user: MattermostUser): void {
    this.rememberUser(user.id, {
      userName: user.username,
      fullName: fullNameOf(user),
      isBot: user.is_bot === true,
      resolved: true,
    });
  }

  /** Merge observed facts about a user id, keeping what is already known. */
  private rememberUser(
    userId: string,
    facts: { fullName?: string; isBot?: boolean; resolved?: boolean; userName?: string },
  ): void {
    if (!userId) {
      return;
    }
    const known = this.users.get(userId);
    this.users.set(userId, {
      resolved: known?.resolved ?? false,
      ...known,
      ...(facts.userName ? { userName: facts.userName } : {}),
      ...(facts.fullName ? { fullName: facts.fullName } : {}),
      ...(facts.isBot === undefined ? {} : { isBot: facts.isBot }),
      ...(facts.resolved ? { resolved: true } : {}),
    });
  }

  /** Fetch a user's profile once per process; later sightings hit the cache. */
  private async ensureUserResolved(userId: string): Promise<void> {
    if (!userId || this.users.get(userId)?.resolved) {
      return;
    }
    await this.getUser(userId);
  }

  /** A 26-char id passes through; anything else is a handle to look up. */
  private async resolveUserId(userIdOrHandle: string): Promise<string> {
    const trimmed = userIdOrHandle.trim();
    if (MATTERMOST_ID.test(trimmed)) {
      return trimmed;
    }
    const user = await this.rest.getUserByUsername(trimmed.replace(/^@/, ''));
    this.cacheUser(user);
    return user.id;
  }

  /**
   * The one projection of a Mattermost user onto the SDK's `Author`.
   *
   * **`userId` is always the raw Mattermost user id** (`7mx5jdcr…`), never the
   * username, on every path: inbound messages, action callbacks and reactions.
   * That is not cosmetic. The NanoClaw host keys its `users` table on
   * `<channelType>:<author.userId>` when a message arrives
   * (`modules/permissions` `extractAndUpsertUser`) and re-derives the same
   * string from `ActionEvent.user.userId` to decide whether a card click came
   * from the designated approver (`handleSenderApprovalResponse`,
   * `handleChannelApprovalResponse`). If the two paths projected different
   * identities for one person, every approval click would be logged as an
   * unauthorized clicker and silently dropped. The raw id also wins on merit:
   * usernames are mutable in Mattermost, ids are not.
   *
   * `userName` / `fullName` are display only. They are resolved from the
   * shared {@link users} cache so a person reads the same in a message, on a
   * click and on a reaction — with `fallbackUserName` (the handle carried by
   * whichever frame is in hand) ahead of the last resort, the id itself.
   */
  private projectAuthor(userId: string, options: { fallbackUserName?: string; isBot?: boolean } = {}): Author {
    const known = this.users.get(userId);
    const userName = known?.userName ?? options.fallbackUserName ?? userId;
    return {
      userId,
      userName,
      fullName: known?.fullName ?? userName,
      isBot: options.isBot === true || known?.isBot === true,
      isMe: userId === this.botUserId,
    };
  }

  /**
   * Upload each file to the channel and collect the ids for `CreatePost`.
   *
   * Uploads run before the post exists, which is what lets a Mattermost reply
   * carry its text *and* its files on one post — Slack's `files.uploadV2`
   * publishes a separate message and its adapter has to live with that.
   *
   * A failed upload is logged and skipped rather than failing the whole
   * delivery: losing an attachment is bad, losing the reply it was attached to
   * is worse.
   */
  private async uploadFiles(channelId: string, files: FileUpload[]): Promise<string[]> {
    if (files.length === 0) {
      return [];
    }
    const uploaded = await Promise.all(
      files.map(async (file) => {
        try {
          const info = await this.rest.uploadFile(channelId, file);
          return info.id;
        } catch (error) {
          this.logger.error('Mattermost: file upload failed', {
            filename: file.filename,
            error,
          });
          return undefined;
        }
      }),
    );
    return uploaded.filter((id): id is string => Boolean(id));
  }

  /** Existing file ids of a post plus the freshly uploaded ones, for a patch. */
  private async fileIdsForEdit(postId: string, channelId: string, files: FileUpload[]): Promise<string[] | undefined> {
    const [existing, uploaded] = await Promise.all([
      this.rest.getPost(postId).then(
        (post) => post.file_ids ?? [],
        (error: unknown) => {
          this.logger.debug('Mattermost: could not read existing files before edit', {
            postId,
            error,
          });
          return undefined;
        },
      ),
      this.uploadFiles(channelId, files),
    ]);
    // A patch replaces `file_ids`. If the existing set could not be read,
    // sending only the new ids would silently detach every old file.
    if (!existing || uploaded.length === 0) {
      return undefined;
    }
    return [...existing, ...uploaded];
  }

  /**
   * Find the channel's oldest page using stable post anchors rather than page
   * numbers, which drift when new posts arrive during a long traversal.
   */
  private async fetchOldestChannelPage(
    channelId: string,
    limit: number,
  ): Promise<{ list: MattermostPostList; traversed: boolean }> {
    let list = await this.rest.getChannelPosts(channelId, { per_page: limit });
    let traversed = false;
    const anchors = new Set<string>();
    while (hasMore(list.prev_post_id, list.order.length, limit)) {
      const oldest = list.order.at(-1);
      if (!oldest || anchors.has(oldest)) {
        break;
      }
      anchors.add(oldest);
      const older = await this.rest.getChannelPosts(channelId, {
        before: oldest,
        per_page: limit,
      });
      // With an exact full oldest page, older Mattermost responses that omit
      // edge ids require one probe beyond the boundary. Keep the last valid
      // page rather than replacing it with that empty sentinel response.
      if (older.order.length === 0) {
        break;
      }
      list = older;
      traversed = true;
    }
    return { list, traversed };
  }

  /** Record a post that carries an interactive attachment. */
  private rememberCardPost(post: MattermostPost, threadId: string): void {
    const { attachments: _attachments, ...rest } = post.props ?? {};
    this.cardPosts.set(post.id, { props: rest, threadId });
  }

  /**
   * Props that clear a card's buttons while preserving everything else
   * Mattermost put on the post (`from_bot`, `override_username`, ...).
   *
   * Returns `undefined` for a post this adapter does not know about unless
   * `editIsCard` — plain edits (streaming updates) must not pay a REST read or
   * rewrite props. An edit that itself carries a card is different: the caller
   * is rewriting a card, and when the new one has no actions (a terminal
   * approval card) the old buttons must go even if this process never saw the
   * post — it was posted before a restart and is being closed without a click
   * (expired, resolved elsewhere).
   */
  private async propsClearingCard(postId: string, editIsCard = false): Promise<MattermostPostProps | undefined> {
    const known = this.cardPosts.get(postId);
    if (!known && !editIsCard) {
      return undefined;
    }
    let props = known?.props ?? {};
    if (Object.keys(props).length === 0) {
      // Click-registered entry (see handleWebhook) or a card post from before
      // a restart: the real props were never observed, so read them once
      // rather than blanking them.
      try {
        const post = await this.rest.getPost(postId);
        const { attachments: _attachments, ...rest } = post.props ?? {};
        props = rest;
      } catch (error) {
        this.logger.debug('Mattermost: could not read props before clearing card', {
          postId,
          error,
        });
        // A props patch replaces the object. Clearing attachments without the
        // current props would also erase unrelated server- or plugin-owned
        // values, so leave the post untouched and allow a later edit to retry.
        return undefined;
      }
    }
    return { ...props, attachments: [] };
  }

  private orderedMessages(list: MattermostPostList, threadId: string): Message<MattermostPost>[] {
    // Mattermost returns `order` newest-first; the SDK wants chronological.
    const ordered = [...(list.order ?? [])].reverse();
    const messages: Message<MattermostPost>[] = [];
    for (const id of ordered) {
      const post = list.posts?.[id];
      if (post && !isSystemPost(post)) {
        const message = this.toMessage(post, threadId);
        message.isMention = this.detectTextMention(post);
        messages.push(message);
      }
    }
    return messages;
  }

  private requireBotUserId(): string {
    if (!this.botUserId) {
      throw new Error('Mattermost adapter is not initialized (no bot user id)');
    }
    return this.botUserId;
  }

  /**
   * `@bot` in the text, for posts that arrive without a `posted` frame (REST
   * fetches, `parseMessage`). Frames carry the server's own `mentions` list,
   * which is authoritative and is used instead when present. DM channels
   * never count as mentions, matching `isExplicitMention`.
   */
  private detectTextMention(post: MattermostPost): boolean {
    if (!this.userName || this.channelTypes.get(post.channel_id) === 'D') {
      return false;
    }
    const handle = this.userName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\w@])@${handle}(?![\\w.-])`, 'i').test(post.message ?? '');
  }

  private toMessage(post: MattermostPost, threadId: string): Message<MattermostPost> {
    const editedAt = post.edit_at && post.edit_at > 0 ? new Date(post.edit_at) : undefined;
    const links = toLinks(post);
    return new Message<MattermostPost>({
      id: post.id,
      threadId,
      text: toPlainTextFromMarkdown(post.message ?? ''),
      formatted: toAst(post.message ?? ''),
      raw: post,
      author: this.projectAuthor(post.user_id, {
        // Webhook posts can override the display handle; it is the best name
        // available for a sender that has no Mattermost account of its own.
        fallbackUserName: typeof post.props?.override_username === 'string' ? post.props.override_username : undefined,
        isBot: post.props?.from_bot === 'true' || post.props?.from_webhook === 'true',
      }),
      metadata: {
        dateSent: new Date(post.create_at ?? 0),
        edited: (post.edit_at ?? 0) > 0,
        ...(editedAt ? { editedAt } : {}),
      },
      attachments: this.toAttachments(post),
      ...(links ? { links } : {}),
    });
  }

  /**
   * Map a post's files onto SDK `Attachment`s.
   *
   * `post.metadata.files` is the source: live capture on 2026-07-24 confirms
   * the `posted` WebSocket frame already carries the full `FileInfo` for every
   * file (name, extension, size, mime type), so no extra round trip is needed
   * to describe an attachment — only to download one. Posts that carry
   * `file_ids` without metadata (older servers, trimmed payloads) still yield
   * a downloadable attachment, just an unnamed one.
   *
   * Mattermost file URLs need the bot token, so `url` is the authenticated
   * API location (for consumers that hold the token) and the bytes come from
   * `fetchData`. `fetchMetadata.fileId` is what {@link rehydrateAttachment}
   * rebuilds that closure from after the host has put the message through a
   * JSON round trip.
   */
  private toAttachments(post: MattermostPost): Attachment[] {
    const infos = post.metadata?.files;
    if (infos && infos.length > 0) {
      return infos.map((info) => this.toAttachment(info));
    }
    return (post.file_ids ?? []).map((id) => this.toAttachment({ id, name: id }));
  }

  private toAttachment(info: MattermostFileInfo): Attachment {
    const fileId = info.id;
    return {
      type: attachmentType(info.mime_type),
      name: info.name,
      ...(info.mime_type ? { mimeType: info.mime_type } : {}),
      ...(info.size === undefined ? {} : { size: info.size }),
      ...(info.width === undefined ? {} : { width: info.width }),
      ...(info.height === undefined ? {} : { height: info.height }),
      url: this.rest.fileUrl(fileId),
      fetchMetadata: { fileId },
      fetchData: () => this.rest.getFile(fileId),
    };
  }

  /**
   * Rebuild `fetchData` after an attachment has been serialized and read back
   * (queue / debounce rehydration). The bot token is the only credential
   * involved, so the file id from `fetchMetadata` is enough.
   */
  rehydrateAttachment(attachment: Attachment): Attachment {
    const fileId = attachment.fetchMetadata?.fileId;
    if (!fileId) {
      return attachment;
    }
    return { ...attachment, fetchData: () => this.rest.getFile(fileId) };
  }
}

/**
 * Thread id a post belongs to: the channel for a top-level post, the root
 * post's thread for a reply. A top-level post does **not** open a thread of
 * its own — that would make every channel message its own conversation and
 * leave the agent with no context between two consecutive posts.
 */
function threadIdForPost(post: MattermostPost): string {
  return encodeThreadId({
    channelId: post.channel_id,
    rootId: post.root_id || undefined,
  });
}

/**
 * Whether a page can be continued. The server's edge id is authoritative when
 * the field is present at all (`""` means "nothing beyond"); a server that
 * omits it falls back to the full-page heuristic.
 */
function hasMore(edgeId: string | undefined, pageLength: number, limit: number): boolean {
  if (edgeId !== undefined) {
    return edgeId !== '';
  }
  return pageLength >= limit;
}

function clampLimit(limit: number | undefined): number {
  if (!limit || limit < 1) {
    return DEFAULT_FETCH_LIMIT;
  }
  return Math.min(Math.floor(limit), MAX_PAGE_SIZE);
}

/** Link previews the server resolved for the post, if any. */
function toLinks(post: MattermostPost): LinkPreview[] | undefined {
  const embeds = post.metadata?.embeds;
  if (!embeds || embeds.length === 0) {
    return undefined;
  }
  const links: LinkPreview[] = [];
  for (const embed of embeds) {
    const url = embed.data?.url || embed.url;
    if (!url) {
      continue;
    }
    if (embed.type === 'opengraph') {
      const image = embed.data?.images?.[0];
      links.push({
        url,
        ...(embed.data?.title ? { title: embed.data.title } : {}),
        ...(embed.data?.description ? { description: embed.data.description } : {}),
        ...(embed.data?.site_name ? { siteName: embed.data.site_name } : {}),
        ...(image?.secure_url || image?.url ? { imageUrl: image.secure_url || image.url } : {}),
      });
    } else if (embed.type === 'link' || embed.type === 'image') {
      links.push({ url });
    }
  }
  return links.length > 0 ? links : undefined;
}

/** Classify a file by MIME type, the way the SDK's `Attachment.type` splits. */
function attachmentType(mimeType: string | undefined): Attachment['type'] {
  // Mattermost sends parameters on the type ("text/plain; charset=utf-8").
  const base = (mimeType ?? '').split(';')[0]?.trim() ?? '';
  if (base.startsWith('image/')) {
    return 'image';
  }
  if (base.startsWith('video/')) {
    return 'video';
  }
  if (base.startsWith('audio/')) {
    return 'audio';
  }
  return 'file';
}

function fullNameOf(user: MattermostUser): string {
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ').trim();
  return name || user.nickname || user.username;
}

function visibilityOf(type: MattermostChannelType): ChannelVisibility {
  switch (type) {
    case 'O':
      return 'workspace';
    case 'P':
    case 'D':
    case 'G':
      return 'private';
    default:
      return 'unknown';
  }
}

export type { MattermostChannelInfo };
export { rawChannelId };
