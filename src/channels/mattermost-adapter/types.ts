/**
 * Mattermost API types used by this adapter.
 *
 * These are hand-written subsets of the Mattermost v4 model, covering only the
 * fields the adapter reads or writes. Shapes were derived from the published
 * Mattermost v4 API model and cross-checked against the type shapes salvaged
 * from nanocoai/nanoclaw PR #546.
 *
 * Field-level shapes are covered by live-captured fixtures and the adapter's
 * real-server round-trip suite.
 */

/** A Mattermost post (message). */
export interface MattermostPost {
  channel_id: string;
  create_at: number;
  delete_at?: number;
  edit_at?: number;
  file_ids?: string[];
  hashtags?: string;
  id: string;
  is_pinned?: boolean;
  last_reply_at?: number;
  message: string;
  metadata?: MattermostPostMetadata;
  original_id?: string;
  parent_id?: string;
  participants?: unknown;
  pending_post_id?: string;
  props?: MattermostPostProps;
  remote_id?: string;
  reply_count?: number;
  root_id?: string;
  /** `""` for regular user messages; `system_*` for join/leave/etc. */
  type?: string;
  update_at?: number;
  user_id: string;
}

export interface MattermostPostMetadata {
  /** Link previews the server resolved for URLs in the message. */
  embeds?: MattermostPostEmbed[];
  files?: MattermostFileInfo[];
  reactions?: MattermostReaction[];
}

/**
 * One entry of `post.metadata.embeds`. `opengraph` embeds carry the resolved
 * page metadata under `data`; `link` and `image` embeds carry only the URL.
 * Shape per the Mattermost v4 model (`PostEmbed` / `OpenGraph`).
 */
export interface MattermostPostEmbed {
  data?: {
    description?: string;
    images?: { secure_url?: string; url?: string }[];
    site_name?: string;
    title?: string;
    url?: string;
  };
  type: 'image' | 'link' | 'message_attachment' | 'opengraph' | 'permalink' | string;
  url?: string;
}

/**
 * Post props. Mattermost allows arbitrary keys; the ones listed are the only
 * ones this adapter reads or writes in P0.
 */
export interface MattermostPostProps {
  /** Set by Mattermost on posts created by bot accounts / incoming webhooks. */
  from_bot?: string;
  from_webhook?: string;
  override_username?: string;
  /** Message attachments — where `CardElement` buttons are rendered. */
  attachments?: MattermostMessageAttachment[];
  [key: string]: unknown;
}

export interface MattermostFileInfo {
  extension?: string;
  /** Set on images. */
  height?: number;
  id: string;
  /** May carry parameters, e.g. `text/plain; charset=utf-8`. */
  mime_type?: string;
  name: string;
  size?: number;
  /** Set on images. */
  width?: number;
}

/** Body returned by UploadFile. */
export interface MattermostFileUploadResponse {
  client_ids?: string[];
  file_infos: MattermostFileInfo[];
}

export interface MattermostReaction {
  /** Empty string on `reaction_removed` frames — see {@link reactionChannelId}. */
  channel_id?: string;
  create_at?: number;
  emoji_name: string;
  post_id: string;
  user_id: string;
}

/** A Mattermost user. */
export interface MattermostUser {
  /** Only present when the requesting token is allowed to see it. */
  email?: string;
  first_name?: string;
  id: string;
  is_bot?: boolean;
  last_name?: string;
  nickname?: string;
  roles?: string;
  username: string;
}

/**
 * Mattermost channel types:
 * - `O` open (public), `P` private, `D` direct message, `G` group message.
 */
export type MattermostChannelType = 'O' | 'P' | 'D' | 'G';

export interface MattermostChannelInfo {
  create_at?: number;
  display_name?: string;
  header?: string;
  id: string;
  name?: string;
  purpose?: string;
  team_id?: string;
  total_msg_count?: number;
  type: MattermostChannelType;
}

/** GetChannelStats. */
export interface MattermostChannelStats {
  channel_id: string;
  files_count?: number;
  guest_count?: number;
  member_count: number;
  pinnedpost_count?: number;
}

/**
 * Paginated post list returned by the channel-posts and thread endpoints.
 *
 * `prev_post_id` / `next_post_id` are the exact pagination signal:
 * `prev_post_id` is the post immediately *older* than the oldest one returned
 * and `next_post_id` the one immediately *newer* than the newest, each `""`
 * when nothing lies beyond. Live-verified against 11.10 on 2026-08-20 (the
 * `has_next` field some clients read does not exist on this endpoint).
 */
export interface MattermostPostList {
  next_post_id?: string;
  /** Post ids, newest first. */
  order: string[];
  posts: Record<string, MattermostPost>;
  prev_post_id?: string;
}

// ---------------------------------------------------------------------------
// Interactive message attachments
// ---------------------------------------------------------------------------

export type MattermostActionStyle = 'default' | 'primary' | 'success' | 'good' | 'warning' | 'danger';

export interface MattermostPostActionIntegration {
  context?: Record<string, unknown>;
  url: string;
}

/** One choice in a `select` {@link MattermostPostAction}. */
export interface MattermostPostActionOption {
  text: string;
  value: string;
}

export interface MattermostPostAction {
  /** Preselected `option.value`. `select` actions only. */
  default_option?: string;
  id?: string;
  integration: MattermostPostActionIntegration;
  name: string;
  /** Choices offered by a `select` action. */
  options?: MattermostPostActionOption[];
  style?: MattermostActionStyle;
  type?: 'button' | 'select';
}

export interface MattermostMessageAttachment {
  actions?: MattermostPostAction[];
  /** Hex colour of the left accent bar, e.g. `#3AA3E3`. */
  color?: string;
  fallback?: string;
  /** Rendered as a (optionally two-column) key/value grid below `text`. */
  fields?: { short?: boolean; title: string; value: string }[];
  /** Large image rendered below the text. */
  image_url?: string;
  pretext?: string;
  text?: string;
  /** Small image rendered to the right of the text. */
  thumb_url?: string;
  title?: string;
  title_link?: string;
}

/**
 * Body Mattermost POSTs to `PostAction.integration.url` when a button is
 * clicked. `context` is whatever the action carried in
 * `integration.context` — for this adapter, `action_id` and (optionally)
 * `value`. Note the server strips `integration` from the copies of the post it
 * hands to clients, so the context never leaves the server-to-us hop.
 *
 * For a `select` action the server *adds* one key of its own to that context:
 * `selected_option`, holding the `value` of the chosen option. That is the
 * only channel a select's answer travels on — there is no top-level field for
 * it (see {@link MattermostPostAction}).
 *
 * Captured from a live Mattermost Team Edition click on 2026-07-24; the
 * capture is checked in as `test/fixtures/post-action-request.json`.
 */
export interface PostActionIntegrationRequest {
  channel_id?: string;
  channel_name?: string;
  context?: Record<string, unknown>;
  /** Populated for `select` actions only; empty string on a button. */
  data_source?: string;
  post_id?: string;
  team_domain?: string;
  team_id?: string;
  /** Short-lived signed token, usable to open an interactive dialog. */
  trigger_id?: string;
  /** The action type that fired, e.g. `"button"`. */
  type?: string;
  user_id?: string;
  user_name?: string;
}

/** Response Mattermost accepts from an action callback. */
export interface PostActionIntegrationResponse {
  ephemeral_text?: string;
  update?: Partial<MattermostPost>;
}

// ---------------------------------------------------------------------------
// WebSocket frames
// ---------------------------------------------------------------------------

/**
 * A Mattermost WebSocket event frame.
 *
 * The quirk that matters: `data.post` is a **JSON-encoded string**, not a
 * nested object, on `posted` / `post_edited` / `post_deleted` events. Same for
 * `data.reaction` on `reaction_added` / `reaction_removed`, and for
 * `data.mentions` (a JSON-encoded array of user ids).
 *
 * Verified against a live Mattermost Team Edition server on 2026-07-24.
 */
export interface MattermostWebSocketEvent {
  broadcast?: {
    channel_id?: string;
    connection_id?: string;
    omit_connection_id?: string;
    omit_users?: Record<string, boolean> | null;
    team_id?: string;
    user_id?: string;
  };
  data?: Record<string, unknown>;
  event: string;
  seq?: number;
}

/**
 * `data` payload of a `posted` frame.
 *
 * `post` and `mentions` are JSON-encoded strings. `mentions` is omitted
 * entirely when nobody is mentioned — and is always present, containing the
 * bot's own id, in DM channels, because Mattermost implicitly mentions the
 * other participant. See {@link isExplicitMention}.
 */
export interface MattermostPostedEventData {
  channel_display_name?: string;
  channel_name?: string;
  channel_type?: MattermostChannelType;
  /** JSON-encoded `string[]` of mentioned user ids. Absent when none. */
  mentions?: string;
  /** JSON-encoded {@link MattermostPost}. */
  post: string;
  /** Sender handle including the leading `@`, e.g. `"@labtestuser"`. */
  sender_name?: string;
  set_online?: boolean;
  team_id?: string;
}

/**
 * `data` payload of a `reaction_added` / `reaction_removed` frame.
 *
 * `reaction` is a JSON-encoded {@link MattermostReaction}. Captured live on
 * 2026-07-24: on `reaction_added` the encoded reaction carries `channel_id`,
 * but on `reaction_removed` that field comes back as `""` — the channel is
 * only reliably available on `broadcast.channel_id`, which is why
 * {@link reactionChannelId} prefers the broadcast.
 */
export interface MattermostReactionEventData {
  /** JSON-encoded {@link MattermostReaction}. */
  reaction: string;
}

/**
 * Channel a reaction frame belongs to.
 *
 * `broadcast.channel_id` first: it is populated on both `reaction_added` and
 * `reaction_removed`, whereas the encoded reaction's own `channel_id` is empty
 * on removals.
 */
export function reactionChannelId(event: MattermostWebSocketEvent, reaction: MattermostReaction | null): string {
  return event.broadcast?.channel_id || reaction?.channel_id || '';
}

/**
 * `data` payload of the `hello` frame the server sends first on every
 * connection. `connection_id` is what a reconnect presents (with the last
 * seen event `seq`) to have missed events replayed. Live-captured 2026-08-20.
 */
export interface MattermostHelloEventData {
  connection_id?: string;
  server_hostname?: string;
  server_version?: string;
}

/** Reply frame to an `authentication_challenge` (and other actions). */
export interface MattermostWebSocketReply {
  data?: Record<string, unknown>;
  error?: { detailed_error?: string; id?: string; message?: string };
  seq_reply: number;
  status: string;
}

export type MattermostWebSocketFrame = MattermostWebSocketEvent | MattermostWebSocketReply;

export function isWebSocketReply(frame: MattermostWebSocketFrame): frame is MattermostWebSocketReply {
  return typeof (frame as MattermostWebSocketReply).seq_reply === 'number';
}

/** Parse a JSON-encoded WebSocket sub-payload, returning null on bad input. */
export function parseEncoded<T>(value: unknown): T | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return JSON.parse(value) as T;
  } catch {
    return null;
  }
}

/** Decode the JSON-encoded `data.mentions` array. Empty when absent. */
export function decodeMentions(data: Record<string, unknown> | undefined): string[] {
  const parsed = parseEncoded<unknown>(data?.mentions);
  return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === 'string') : [];
}

/**
 * Whether a `posted` frame explicitly @-mentions `botUserId`.
 *
 * DM channels are excluded on purpose: Mattermost puts the other participant's
 * id in `data.mentions` for every DM post, mention or not, so treating that as
 * an explicit address would make every DM look like a mention.
 * Live-verified 2026-07-24.
 */
export function isExplicitMention(data: Record<string, unknown> | undefined, botUserId: string | undefined): boolean {
  if (!botUserId) {
    return false;
  }
  if (data?.channel_type === 'D') {
    return false;
  }
  return decodeMentions(data).includes(botUserId);
}
