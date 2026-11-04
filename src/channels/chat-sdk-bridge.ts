/**
 * Chat SDK bridge — wraps a Chat SDK adapter + Chat instance
 * to conform to the NanoClaw ChannelAdapter interface.
 *
 * Used by Discord, Slack, and other Chat SDK-supported platforms.
 */
import { createHash, timingSafeEqual } from 'crypto';
import http from 'http';

import {
  Chat,
  Card,
  CardText,
  Actions,
  Button,
  LinkButton,
  type Attachment,
  type CardChild,
  type Adapter,
  type AdapterPostableMessage,
  type RawMessage,
  type AssistantContextChangedEvent,
  type AssistantThreadStartedEvent,
  type ConcurrencyStrategy,
  type Message as ChatMessage,
  type ReactionEvent,
} from 'chat';
import { log } from '../log.js';
import { logId } from '../log-id.js';
import { emitEngineEvent } from '../engine/events.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import { registerWebhookAdapter } from '../webhook-server.js';
import { CardTooLongError, cardQuestionTooLong, normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, InboundMessage } from './adapter.js';
import { INSTANCE_KEY_RE } from './channel-registry.js';
import { resolveQuestionRender, dispatchQuestionAction } from './question-render-registry.js';

/** Adapter with optional gateway support (e.g., Discord). */
interface GatewayAdapter extends Adapter {
  startGatewayListener?(
    options: { waitUntil?: (task: Promise<unknown>) => void },
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
}

/** Adapter that can expose authenticated transport liveness to host status. */
interface ConnectionAwareAdapter extends Adapter {
  isConnected?(): boolean;
}

/** Reply context extracted from a platform's raw message. */
export interface ReplyContext {
  text: string;
  sender: string;
  /**
   * Platform message id of the parent (the message being replied to). The
   * router uses this to engage on reply-to-bot in `mention` / `mention-sticky`
   * modes — matching v1's `requires_trigger` behavior where a reply to the
   * bot's prior message counts as a trigger even without an @mention.
   */
  messageId?: string;
  /**
   * Set by reply-chain-walking extractors when an ancestor in the chain
   * is bot *participation* that has no resolvable bot-outbound id to put
   * in `messageId` — specifically an ancestor that @-mentions the bot
   * but was authored by a human (e.g. someone replies to "@Optimus do
   * X"). `messageId`'s `wasDeliveredByBot` lookup can't see that (no bot
   * outbound row), so the walker flags it here and the router treats it
   * as a reply-to-bot trigger directly. v1 achieved the same UX by
   * prepending `@ASSISTANT_NAME` to such messages; v2 keeps the signal
   * structured. Only meaningful in `mention` / `mention-sticky` modes.
   */
  botInChain?: boolean;
  /**
   * Reply-chain ancestors ABOVE the direct parent, nearest-first
   * (`ancestors[0]` is the grandparent, `ancestors[1]` the
   * great-grandparent, …). The direct parent stays in `text`/`sender`.
   *
   * Populated by chain-walking extractors (Discord's `fetchAncestor`
   * loop) so multi-level reply threads keep their full context EMBEDDED
   * in the inbound message. v2 serializes the parent's text into every
   * message, so depth-1 context already survives session rotation; this
   * extends that property to the whole chain (the H-D2 prompt-context
   * gap — deeper ancestors used to be recoverable only if they happened
   * to still be in the prompt window). Bounded by the walker's depth cap.
   */
  ancestors?: Array<{ sender: string; text: string; messageId?: string }>;
  /**
   * Optional attachments from the quoted parent message. Extractors should
   * populate this when the platform embeds the parent raw message (Telegram
   * `reply_to_message`, Discord `referenced_message`, etc.) and the parent
   * carried media/files. The bridge fetches these through the same enrichment
   * path as direct message attachments, appends them to `content.attachments`,
   * and strips this field from `content.replyTo` so the prompt gets both the
   * quote and the actual bytes without bloating the reply metadata object.
   */
  attachments?: Attachment[];
}

/**
 * Extract reply context from a platform-specific raw message. Return null if no reply.
 *
 * May return a Promise — extractors that need to walk the reply chain via
 * platform API calls (Discord's `messages.fetch`) can be async. Sync
 * extractors continue to work unchanged.
 */
export type ReplyContextExtractor = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  raw: Record<string, any>,
) => ReplyContext | null | Promise<ReplyContext | null>;

interface RawAttachmentLike {
  filename?: unknown;
  content_type?: unknown;
  size?: unknown;
  url?: unknown;
  width?: unknown;
  height?: unknown;
}

interface RawMessageSnapshotLike {
  message?: {
    attachments?: unknown;
  };
}

function attachmentTypeForMime(mimeType: string | undefined): string {
  if (!mimeType) return 'file';
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

/**
 * Some Discord Gateway MESSAGE_CREATE payloads, including voice messages, carry
 * `raw.attachments[]` even when the Chat SDK adapter fails to materialize
 * `message.attachments`. Normalize that raw shape into the same attachment
 * contract the rest of the bridge already enriches.
 */
export function rawAttachmentsToSdkAttachments(raw: Record<string, unknown> | undefined): Attachment[] {
  const rawAttachments = collectRawAttachments(raw);
  if (rawAttachments.length === 0) return [];

  return rawAttachments
    .map((att): Attachment | null => {
      if (!att || typeof att !== 'object') return null;
      const record = att as RawAttachmentLike;
      const mimeType = typeof record.content_type === 'string' ? record.content_type : undefined;
      const url = typeof record.url === 'string' ? record.url : undefined;
      const name = typeof record.filename === 'string' && record.filename.trim() ? record.filename : 'attachment';
      return {
        type: attachmentTypeForMime(mimeType),
        name,
        mimeType,
        size: typeof record.size === 'number' ? record.size : undefined,
        width: typeof record.width === 'number' ? record.width : undefined,
        height: typeof record.height === 'number' ? record.height : undefined,
        ...(url ? { url } : {}),
      } as Attachment;
    })
    .filter((att): att is Attachment => att !== null);
}

function collectRawAttachments(raw: Record<string, unknown> | undefined): unknown[] {
  if (!raw) return [];
  const attachments: unknown[] = [];
  if (Array.isArray(raw.attachments)) {
    attachments.push(...raw.attachments);
  }
  if (Array.isArray(raw.message_snapshots)) {
    for (const snapshot of raw.message_snapshots as RawMessageSnapshotLike[]) {
      const snapshotAttachments = snapshot?.message?.attachments;
      if (Array.isArray(snapshotAttachments)) {
        attachments.push(...snapshotAttachments);
      }
    }
  }
  return attachments;
}

function hasForwardedMessageSnapshot(raw: unknown): boolean {
  return (
    !!raw &&
    typeof raw === 'object' &&
    Array.isArray((raw as Record<string, unknown>).message_snapshots) &&
    ((raw as Record<string, unknown>).message_snapshots as unknown[]).length > 0
  );
}

/**
 * A MESSAGE_POLL_VOTE_ADD / MESSAGE_POLL_VOTE_REMOVE gateway event, parsed
 * from the forwarded Discord payload. `guildId` is absent for DM polls —
 * the bridge ignores those (the DirectMessagePolls intent is not requested
 * and the DM thread encoding differs).
 */
export interface PollVoteEvent {
  guildId?: string;
  channelId: string;
  messageId: string;
  userId: string;
  answerId?: number;
  added: boolean;
}

/**
 * Freshly rendered poll state returned by `fetchPollUpdate`. `text` is the
 * full re-rendered summary (question, per-option counts, voter names);
 * `sender`/`senderId` optionally attribute the update to the poll's author
 * so the container formatter has a sender to display.
 */
export interface PollUpdateContent {
  text: string;
  sender?: string;
  senderId?: string;
}

// ---------------------------------------------------------------------------
// Agent-DM opened hook (assistant_thread_started)
// ---------------------------------------------------------------------------

/** The user opened an agent DM (assistant thread started). Registered by the
 *  host to (re)assert onboarding prompts at a moment the user is provably
 *  looking — prompt sets made before the DM was ever opened may not render. */
export interface AgentDmOpenedEvent {
  instance: string;
  channelId: string;
}

let agentDmOpenedHandler: ((event: AgentDmOpenedEvent) => void | Promise<void>) | null = null;

export function setAgentDmOpenedHandler(fn: (event: AgentDmOpenedEvent) => void | Promise<void>): void {
  agentDmOpenedHandler = fn;
}

function dispatchAgentDmOpened(event: AgentDmOpenedEvent): void {
  if (!agentDmOpenedHandler) return;
  try {
    Promise.resolve(agentDmOpenedHandler(event)).catch((err) =>
      log.warn('Agent-DM opened handler failed', { channelId: logId(event.channelId), err }),
    );
  } catch (err) {
    log.warn('Agent-DM opened handler threw', { channelId: logId(event.channelId), err });
  }
}

// ---------------------------------------------------------------------------
// Agent-mode app context
// ---------------------------------------------------------------------------

/** One "what the user is viewing" entity, rendered by the container formatter. */
export interface AppContextEntity {
  type: string;
  id: string;
}

/**
 * Latest assistant context per (instance, DM channel, user), attached to the
 * NEXT inbound DM message as content.app_context and consumed. Platforms
 * whose DM surface materializes threads and reports client context send
 * app_context as its own event (assistant_thread_started /
 * assistant_thread_context_changed), not on the message payload, so the
 * bridge has to hold it across the event → message gap. Short TTL: a stale
 * "viewing X" is worse than none.
 */
const APP_CONTEXT_TTL_MS = 5 * 60 * 1000;
const appContextCache = new Map<string, { entities: AppContextEntity[]; at: number }>();

/** Channel ids arrive both raw ("D0123") and platform-encoded ("slack:D0123")
 *  depending on the emitting path — key on the final segment so both match. */
function appContextKey(instance: string, channelId: string, userId: string): string {
  const channel = channelId.includes(':') ? channelId.slice(channelId.lastIndexOf(':') + 1) : channelId;
  return `${instance}|${channel}|${userId}`;
}

/**
 * Derive ordered entities from an SDK assistant event. The installed chat
 * core (4.41.1) parses assistant_thread_started /
 * assistant_thread_context_changed into a `context` object (channelId/teamId/threadEntryPoint — the legacy assistant
 * context shape) with no entities array; prefer a real `entities` array
 * whenever a future SDK forwards the platform's ordered agent-context
 * entities.
 */
export function appContextEntities(
  event: AssistantThreadStartedEvent | AssistantContextChangedEvent,
): AppContextEntity[] {
  const raw = event as unknown as Record<string, unknown>;
  const direct = raw.entities ?? (raw.context as Record<string, unknown> | undefined)?.entities;
  if (Array.isArray(direct)) {
    return direct
      .map((e) => {
        const entity = e as Record<string, unknown> | null;
        const type = typeof entity?.type === 'string' ? entity.type : '';
        const idValue = entity?.id ?? entity?.channel_id ?? entity?.entity_id;
        const id = typeof idValue === 'string' ? idValue : '';
        return { type, id };
      })
      .filter((e) => e.type !== '' && e.id !== '');
  }
  const channelId = event.context?.channelId;
  return typeof channelId === 'string' && channelId ? [{ type: 'channel', id: channelId }] : [];
}

export function cacheAppContext(
  instance: string,
  channelId: string,
  userId: string,
  entities: AppContextEntity[],
  now = Date.now(),
): void {
  const key = appContextKey(instance, channelId, userId);
  if (entities.length === 0) {
    appContextCache.delete(key);
    return;
  }
  appContextCache.set(key, { entities, at: now });
}

/** Consume the cached context (single-shot: it describes what the user was
 *  viewing when they sent the NEXT message, not every message after). */
export function takeAppContext(
  instance: string,
  channelId: string,
  userId: string,
  now = Date.now(),
): AppContextEntity[] | undefined {
  const key = appContextKey(instance, channelId, userId);
  const hit = appContextCache.get(key);
  if (!hit) return undefined;
  appContextCache.delete(key);
  if (now - hit.at > APP_CONTEXT_TTL_MS) return undefined;
  return hit.entities;
}

/**
 * Attach the cached app context to an inbound DM message's content JSON
 * (content.app_context = { entities: [...] }). A context the SDK attached
 * directly on the message payload wins — the cache only fills the
 * event → message gap.
 */
export function attachAppContext(
  content: Record<string, unknown>,
  instance: string,
  channelId: string,
  userId: string | undefined,
): void {
  if (content.app_context) return;
  if (!userId) return;
  const entities = takeAppContext(instance, channelId, userId);
  if (entities && entities.length > 0) {
    content.app_context = { entities };
  }
}

/**
 * Base64-encode attachment bytes. Adapters may return ArrayBuffer (Telegram
 * since 4.39), whose toString() yields "[object ArrayBuffer]", not bytes.
 */
export function attachmentBytesToBase64(data: Buffer | ArrayBuffer | Uint8Array): string {
  if (Buffer.isBuffer(data)) return data.toString('base64');
  if (data instanceof Uint8Array) return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString('base64');
  return Buffer.from(data).toString('base64');
}

/**
 * Root-thread a top-level DM message: on platforms whose DM surface
 * materializes conversation threads (agent-view semantics), every top-level
 * DM message is the root of a conversation thread — replying in-thread and
 * setting per-thread status on that ts is what OPENS the thread in the
 * client. Such adapters map top-level DM messages to an EMPTY threadTs
 * (`…:<channel>:`), so without this the thread never materializes: no
 * in-thread reply, no status target, no per-thread session.
 *
 * The message id is the platform ts for chat-sdk adapters, so appending it to
 * the dangling `:` yields the canonical thread id. Plain (non-agent) DM
 * wirings are unaffected downstream: the router strips thread ids when the
 * wiring's thread policy is off, restoring today's top-level behavior.
 */
export function normalizeDmThreadId(threadId: string, messageId: string): string {
  if (threadId.endsWith(':') && messageId && !messageId.includes(':')) {
    return threadId + messageId;
  }
  return threadId;
}

/**
 * Recover readable content a platform adapter left only in `message.raw`.
 *
 * The bridge drops `raw` before persisting (it can be very large), so anything
 * the adapter did not project into `Message.toJSON()` is lost at that point.
 * A platform that carries readable content outside the normal text — Slack
 * puts pasted tables in `attachments[].blocks[]` — returns it here as text.
 * Return null when there is nothing to recover.
 */
export type RawTextExtractor = (raw: Record<string, unknown>) => string | null;
// ---------------------------------------------------------------------------
// Membership hook
// ---------------------------------------------------------------------------

/**
 * A member joined (or left) a channel/group conversation one of our bridge
 * instances is in. Forwarded from the Chat SDK's member_joined_channel
 * dispatch; `left` is reserved for member_left_channel, which the installed
 * chat core (4.41.1) does NOT dispatch — see the TODO at the
 * onMemberJoinedChannel registration in setup().
 */
export interface MembershipEvent {
  /** Adapter-instance key of the bridge that saw the event (defaults to the
   *  platform name for default instances). */
  instance: string;
  /** Semantic platform key (`adapter.name`) — the key membership handlers
   *  are registered under. */
  channelType: string;
  channelId: string;
  userId: string;
  inviterId?: string;
  left?: boolean;
}

export type MembershipHandler = (event: MembershipEvent) => void | Promise<void>;

const membershipHandlers = new Map<string, MembershipHandler>();

/**
 * Register THE membership handler for a channel type (single registration —
 * one channel-side module owns it; a second registration for the same
 * channel type overwrites with a warning, mirroring the router's hook
 * discipline). The bridge invokes it fire-and-forget for every membership
 * event on every bridge instance of that channel type; errors are logged,
 * never thrown into SDK dispatch. With no handler registered the bridge
 * behaves exactly as before.
 */
export function setMembershipHandler(channelType: string, fn: MembershipHandler): void {
  if (membershipHandlers.has(channelType)) {
    log.warn('Membership handler overwritten', { channelType });
  }
  membershipHandlers.set(channelType, fn);
}

function dispatchMembership(event: MembershipEvent): void {
  const handler = membershipHandlers.get(event.channelType);
  if (!handler) return;
  try {
    Promise.resolve(handler(event)).catch((err) =>
      log.error('Membership handler failed', {
        channelType: event.channelType,
        channelId: logId(event.channelId),
        userId: logId(event.userId),
        err,
      }),
    );
  } catch (err) {
    log.error('Membership handler threw', {
      channelType: event.channelType,
      channelId: logId(event.channelId),
      userId: logId(event.userId),
      err,
    });
  }
}

// ---------------------------------------------------------------------------
// Inbound policy registration
// ---------------------------------------------------------------------------

/**
 * Wrap of the host's `ChannelSetup`, applied at bridge setup time. Every
 * inbound dispatch path (onSubscribedMessage / onNewMention / onDirectMessage
 * / onNewMessage) funnels through the stored setup's `onInbound`, so a policy
 * that wraps `onInbound` intercepts them all at a single point — e.g. to
 * drop, re-attribute, or rate-limit bot-authored messages before routing.
 *
 * `instanceKey` is the bridge's registry key (`config.instance ??
 * adapter.name`): the wrap runs once per bridge instance, so policy state
 * captured in the returned closure is naturally per-instance (= per bot
 * identity when several bridges share one platform).
 */
export type BridgeInboundPolicy = (setup: ChannelSetup, instanceKey: string) => ChannelSetup | Promise<ChannelSetup>;

const bridgeInboundPolicies = new Map<string, BridgeInboundPolicy>();

/**
 * Register THE inbound policy for a channel type (single registration — the
 * owning module registers on barrel import; a second registration overwrites
 * with a warning, mirroring the router's hook discipline). Bridges whose
 * channel type has no registered policy are unaffected.
 */
export function registerBridgeInboundPolicy(channelType: string, wrap: BridgeInboundPolicy): void {
  if (bridgeInboundPolicies.has(channelType)) {
    log.warn('Bridge inbound policy overwritten', { channelType });
  }
  bridgeInboundPolicies.set(channelType, wrap);
}

export interface ChatSdkBridgeConfig {
  verbatim?: ChannelAdapter['verbatim'];
  adapter: Adapter;
  /**
   * Adapter-instance name for running multiple bridges of one platform
   * (e.g. several Slack apps in one workspace). Defaults to the platform
   * name. Drives the registry key, the webhook route (/webhook/<instance>),
   * and the Chat SDK state namespace. channelType is NOT affected — user
   * identity, formatting, and container config stay keyed on the platform.
   * Must be URL-safe: non-empty, only letters, digits, '.', '_' or '-'.
   */
  instance?: string;
  concurrency?: ConcurrencyStrategy;
  /** Bot token for authenticating forwarded Gateway events (required for interaction handling). */
  botToken?: string;
  /**
   * This bot's platform user id (Discord application/user id). When set,
   * `messageToInbound` stamps it onto the inbound row as `botUserId` so
   * the container-side `isAddressedTurn` can tell an @mention of THIS
   * bot from an @mention of a different participant. Without it the
   * SDK's `message.isMention` boolean is "a mention exists" (true for
   * `<@anyone>`), which made a message @mentioning another bot look like
   * Optimus was addressed → silent turn → spurious "[degraded — addressed
   * turn produced no output]" (AI Friends, 2026-05-19). Discord sets
   * this; platforms whose SDK `isMention` is already self-specific
   * (Telegram) leave it undefined and keep the permissive behavior.
   */
  botUserId?: string;
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Recover readable content the platform adapter left only in `message.raw`.
   * The returned text is appended to the message body and persisted; the raw
   * provider payload is still dropped.
   */
  extractRawText?: RawTextExtractor;
  /**
   * Platform-specific poll serialization. Discord delivers a native poll as a
   * structured `poll` object on the raw payload with NO text body — without
   * this hook the agent sees a blank message (v2 regression; v1 rendered polls
   * via formatPollSummary). When set, the bridge calls it with the raw payload
   * and appends the returned summary to the message text so the container agent
   * can read the poll's question, options, and vote counts. Returns null when
   * the raw payload carries no poll. Discord wires this; other platforms leave
   * it undefined. May return a Promise — extractors that need an authenticated
   * REST round-trip (voter names, a referenced poll message's final results)
   * are awaited, mirroring `extractReplyContext`.
   */
  extractPollSummary?: (raw: Record<string, unknown>) => string | null | Promise<string | null>;
  /**
   * Live poll vote-count refresh. When set, the bridge consumes forwarded
   * MESSAGE_POLL_VOTE_ADD / MESSAGE_POLL_VOTE_REMOVE gateway events (which
   * reach the local webhook server only when the platform adapter requests
   * the GuildMessagePolls intent), debounces them per poll message, and calls
   * this hook to re-fetch and re-render the poll's current state. The result
   * is injected as an accumulate-only inbound row (`isBackfill: true` — never
   * wakes the agent) whose id is content-addressed, so an unchanged re-render
   * dedupes against the session DB's ON CONFLICT(id) DO NOTHING insert instead
   * of stacking duplicate context. Return null to suppress (e.g. message no
   * longer exists, has no poll, or fetch failed). Guild polls only — DM vote
   * events carry no guild_id and are dropped before this hook runs.
   */
  fetchPollUpdate?: (event: PollVoteEvent) => Promise<PollUpdateContent | null>;
  /**
   * Last-resort visibility for platform content the bridge has NO handler for.
   * Runs only when a message would otherwise reach the agent with EMPTY text
   * (every known extractor — text, attachments, poll — produced nothing) yet the
   * raw payload carries a recognizable-but-unhandled element (interactive
   * components/buttons, an unknown embed type, a sticker, …). Returns a short
   * human-legible stub like "[unsupported content: poll]" so the agent SEES that
   * something arrived it can't read — the precondition for it to escalate via
   * report_unfulfillable. Without this, a silently-dropped feature produces a
   * blank message the agent can't perceive as a gap (the 2026-06-08 Discord-poll
   * blind spot). Returns null when there's genuinely nothing unhandled (an
   * ordinarily-empty message — e.g. an attachment-only post already covered
   * above — must NOT be stubbed). Discord wires this; other platforms may.
   */
  describeUnsupportedContent?: (raw: Record<string, unknown>) => string | null;
  /**
   * Whether this platform uses threads as the primary conversation unit.
   * See `ChannelAdapter.supportsThreads`. Declared by the calling channel
   * skill, not inferred, because some platforms (Discord) can be used either
   * way and the default depends on installation style.
   */
  supportsThreads: boolean;
  /**
   * Declared wiring-time defaults for this channel. Copied verbatim onto the
   * returned ChannelAdapter, exactly like supportsThreads. See
   * `ChannelAdapter.defaults`.
   */
  defaults?: ChannelDefaults;
  /**
   * Optional transform applied to outbound text/markdown before it reaches the
   * adapter. Used by channels that need to sanitize for a platform-specific
   * quirk (e.g. Telegram's legacy Markdown parse mode).
   */
  transformOutboundText?: (text: string) => string;
  /**
   * Optional escape for host-built ask_question card text (open and resolved
   * cards). Approval cards mix host wording with untrusted values (agent
   * arguments, sender names); channels whose card text is raw platform markup
   * set this. Questions an agent asks itself (`fromAgent`) keep their markup.
   */
  escapeCardText?: (text: string) => string;
  /**
   * For a platform that caps a whole card's text: the longest ask_question
   * title plus card text (after escapeCardText) it shows in full. A longer
   * card is refused with CardTooLongError. Unset, long card text is posted
   * in several text blocks, each under CARD_TEXT_BLOCK_LENGTH.
   */
  maxCardTextLength?: number;
  /**
   * Maximum text length the underlying adapter accepts in a single message.
   * When set, the bridge splits outbound text longer than this on paragraph
   * → line → hard-char boundaries and posts multiple messages. Without this,
   * adapters like Discord (2000) and Telegram (4096) silently truncate
   * mid-response. The returned id is the first chunk's id so subsequent edits
   * and reactions still target the head of the reply.
   */
  maxTextLength?: number;
}

/**
 * Split `text` into chunks no larger than `limit`, preferring paragraph
 * breaks, then line breaks, then a hard character cut as a last resort.
 * Preserves code fences only structurally — a fenced block that straddles a
 * chunk boundary will render as two independent blocks on the receiving
 * platform, which is the same behavior as manually re-opening a fence.
 */
/**
 * Decode the actual option value from a button callback. Buttons are encoded
 * with an integer index (to keep under Telegram's 64-byte callback_data cap),
 * and the real value is looked up via `resolveQuestionRender(questionId)`.
 * Falls back to treating the tail as a literal value so old in-flight cards
 * (encoded before this shortening landed) still resolve.
 */
function resolveSelectedOption(
  render: { options: NormalizedOption[] } | undefined,
  eventValue: string | undefined,
  tail: string | undefined,
): string {
  const candidate = eventValue ?? tail ?? '';
  if (render && /^\d+$/.test(candidate)) {
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
  }
  return candidate;
}

/**
 * Decode Chat SDK Discord's wire-level custom id. Since adapter v4.29,
 * Discord buttons encode both fields as `<actionId>\n<value>` because the
 * platform exposes only `custom_id`. Normal webhook handling decodes this in
 * the adapter, but the Gateway forwarding path below intentionally handles
 * interactions before the adapter and therefore must mirror that decode.
 */
export function decodeDiscordCustomId(customId: string): { actionId: string; value?: string } {
  const delimiterIndex = customId.indexOf('\n');
  if (delimiterIndex === -1) return { actionId: customId };
  return {
    actionId: customId.slice(0, delimiterIndex),
    value: customId.slice(delimiterIndex + 1),
  };
}

/**
 * Convert common HTML inline tags to Markdown. Discord, Telegram, Slack all
 * parse Markdown, never HTML — so any literal `<code>X</code>` an agent emits
 * renders as visible angle-brackets. Conversion happens before chunking so
 * size budgets land on rendered text. Self-closing `<br>` becomes a newline;
 * unknown tag pairs are unwrapped (kept inner content); unknown self-closing
 * tags are dropped. Standalone `<` / `>` (math, generics in code) are
 * preserved by the alpha-name guard.
 */
export function htmlToMarkdown(text: string): string {
  if (!text) return text;
  let out = text;
  out = out.replace(
    /<a\s+[^>]*href\s*=\s*"([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, label) => `[${(label as string).trim() || (href as string)}](${href})`,
  );
  out = out.replace(
    /<a\s+[^>]*href\s*=\s*'([^']*)'[^>]*>([\s\S]*?)<\/a>/gi,
    (_m, href, label) => `[${(label as string).trim() || (href as string)}](${href})`,
  );
  out = out.replace(
    /<pre>\s*<code(?:\s+[^>]*)?>([\s\S]*?)<\/code>\s*<\/pre>/gi,
    (_m, body) => `\n\`\`\`\n${(body as string).trim()}\n\`\`\`\n`,
  );
  out = out.replace(
    /<pre(?:\s+[^>]*)?>([\s\S]*?)<\/pre>/gi,
    (_m, body) => `\n\`\`\`\n${(body as string).trim()}\n\`\`\`\n`,
  );
  out = out.replace(/<code(?:\s+[^>]*)?>([\s\S]*?)<\/code>/gi, (_m, body) => `\`${body as string}\``);
  out = out.replace(/<(?:b|strong)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:b|strong)>/gi, (_m, body) => `**${body as string}**`);
  out = out.replace(/<(?:i|em)(?:\s+[^>]*)?>([\s\S]*?)<\/(?:i|em)>/gi, (_m, body) => `*${body as string}*`);
  out = out.replace(/<br\s*\/?>/gi, '\n');
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g, (_m, _tag, body) => body as string);
  out = out.replace(/<([a-zA-Z][a-zA-Z0-9-]*)(?:\s+[^>]*)?\/?>/g, '');
  return out;
}

/**
 * Size-aware chunking with code-fence carryover. Tries paragraph (\n\n) →
 * single newline → sentence end → word boundary, falling back to a hard cut.
 * If a chunk ends with an open ``` fence, closes it on the head and reopens
 * with the original lang tag on the tail so each chunk renders as a valid
 * code block on the platform.
 *
 * Reject boundaries that are too close to the start (within 25% of budget)
 * to avoid emitting a tiny head + huge tail when a paragraph break sits
 * near the very beginning of the budget window.
 */
const SPLIT_TOLERANCE = 0.25;
interface TerminalApprovalCard {
  title: string;
  question: string;
  /** The question as separate text blocks, when it was split to fit. */
  questionBlocks?: string[];
  resolution: string;
}

/**
 * Keep an approval's full context after it resolves. The muted resolution
 * replaces the actions row, making the card visibly inactive without
 * discarding the request an admin decided on.
 */
export function buildTerminalApprovalCard({ title, question, questionBlocks, resolution }: TerminalApprovalCard) {
  const children: CardChild[] = [];
  for (const block of questionBlocks ?? (question ? [question] : [])) children.push(CardText(block));
  children.push(CardText(resolution, { style: 'muted' }));
  return Card({ title, children });
}

function terminalApprovalMessage(spec: TerminalApprovalCard) {
  return {
    card: buildTerminalApprovalCard(spec),
    fallbackText: [spec.title, spec.question, spec.resolution].filter(Boolean).join('\n\n'),
  };
}

/**
 * Longest text in one card text block. Some platforms cap each block, and an
 * adapter can still lengthen text (emoji names) after the bridge measures it.
 */
export const CARD_TEXT_BLOCK_LENGTH = 2000;

const FENCE = '```';
/** A fence opens or closes only at the start of a line; backticks mid-line are text. */
const FENCE_LINE = /^ {0,3}```/gm;

/**
 * Split card text into blocks of at most `limit` characters after `escape`, so
 * a per-block cap never cuts one. Prefers a line break near the limit, never
 * splits a surrogate pair or a fence marker, and closes and reopens a code
 * fence that spans two blocks.
 */
export function splitCardText(text: string, escape: (t: string) => string, limit: number): string[] {
  const blocks: string[] = [];
  let rest = text;
  let reopen = false;
  const render = (raw: string) => {
    const body = (reopen ? `${FENCE}\n` : '') + raw;
    const open = (body.match(FENCE_LINE)?.length ?? 0) % 2 === 1;
    return { block: escape(open ? `${body}\n${FENCE}` : body), open };
  };
  const fits = (n: number) => render(rest.slice(0, n)).block.length <= limit;
  while (rest) {
    let cut = rest.length;
    if (!fits(cut)) {
      // Longest prefix that fits; the search only ever keeps lengths that fit.
      let lo = 0;
      let hi = rest.length - 1;
      while (lo < hi) {
        const mid = Math.ceil((lo + hi) / 2);
        if (fits(mid)) lo = mid;
        else hi = mid - 1;
      }
      cut = lo;
      const afterLine = rest.lastIndexOf('\n', cut - 1) + 1;
      if (afterLine > cut / 2 && fits(afterLine)) cut = afterLine;
      // Backing off a fence marker can change which fences close, so recheck.
      const badCut = (n: number) => isHighSurrogate(rest.charCodeAt(n - 1)) || (rest[n - 1] === '`' && rest[n] === '`');
      while (cut > 0 && (badCut(cut) || !fits(cut))) cut--;
      if (cut === 0) throw new CardTooLongError('the request cannot be split into card text blocks');
    }
    const { block, open } = render(rest.slice(0, cut));
    blocks.push(block);
    rest = rest.slice(cut);
    reopen = open;
  }
  return blocks;
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

export function splitForLimit(text: string, limit: number): string[] {
  // Normalize HTML before chunking so split boundaries land on rendered text.
  text = htmlToMarkdown(text);
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;
  let carryFence: string | null = null;

  while (remaining.length > 0) {
    const prefix = carryFence ?? '';
    const budget = limit - prefix.length;

    if (prefix.length + remaining.length <= limit) {
      chunks.push(prefix + remaining);
      break;
    }

    const cut = findCut(remaining, budget, SPLIT_TOLERANCE);
    const head = remaining.slice(0, cut.headEnd);
    const tail = remaining.slice(cut.tailStart);

    const fenceState = scanFenceState(prefix + head);
    if (fenceState.open) {
      const closed = (prefix + head).trimEnd() + '\n```';
      chunks.push(closed);
      carryFence = '```' + fenceState.lang + '\n';
    } else {
      chunks.push(prefix + head);
      carryFence = null;
    }

    remaining = tail;
  }

  return chunks;
}

interface SplitCut {
  headEnd: number;
  tailStart: number;
}

function findCut(text: string, budget: number, tolerance: number): SplitCut {
  const minAccept = Math.floor(budget * (1 - tolerance));
  const window = text.slice(0, budget);

  // Closed code-fence boundary: prefer a `\n```\n` boundary regardless of tier.
  const fenceIdx = window.lastIndexOf('\n```\n');
  if (fenceIdx >= 0) {
    const end = fenceIdx + 5;
    return { headEnd: end, tailStart: end };
  }

  const tiers: Array<() => SplitCut | null> = [
    () => {
      const idx = window.lastIndexOf('\n\n');
      if (idx < 0) return null;
      return { headEnd: idx, tailStart: skipLeading(text, idx, /\n/) };
    },
    () => {
      const idx = window.lastIndexOf('\n');
      if (idx < 0) return null;
      return { headEnd: idx, tailStart: skipLeading(text, idx, /\n/) };
    },
    () => {
      const m = window.match(/[.!?](?:\s|$)(?=[^.!?]*$)/);
      if (!m || m.index === undefined) return null;
      const afterPunct = m.index + 1;
      return {
        headEnd: afterPunct,
        tailStart: skipLeading(text, afterPunct, /\s/),
      };
    },
    () => {
      const m = window.match(/\s(?=\S*$)/);
      if (!m || m.index === undefined) return null;
      return {
        headEnd: m.index,
        tailStart: skipLeading(text, m.index, /\s/),
      };
    },
  ];

  for (const tier of tiers) {
    const cut = tier();
    if (cut && cut.headEnd >= minAccept) return cut;
  }

  return { headEnd: budget, tailStart: budget };
}

function skipLeading(text: string, start: number, re: RegExp): number {
  let i = start;
  while (i < text.length && re.test(text[i])) i++;
  return i;
}

function scanFenceState(text: string): { open: boolean; lang: string } {
  const fenceRe = /^```([^\n]*)$/gm;
  let open = false;
  let lang = '';
  let m: RegExpExecArray | null;
  while ((m = fenceRe.exec(text)) !== null) {
    if (open) {
      open = false;
      lang = '';
    } else {
      open = true;
      lang = m[1].trim();
    }
  }
  return { open, lang };
}

/**
 * Discord's Get Channel Messages API hard-caps the `limit` query param
 * at 100 (docs.discord.com/developers/resources/message — "Max number
 * of messages to return (1-100)"); 101+ is a fatal 400, code 50035
 * NUMBER_TYPE_MAX. A caller asking recoverMissedMessages for a larger
 * window must therefore page, not request one oversized fetch.
 *
 * Returns the clamped per-page `pageSize` (1..100) and a `maxPages`
 * budget that covers the caller's intended `limit` worth of messages
 * with slack, while still bounding a misbehaving adapter whose cursor
 * never terminates. Pure — unit-tested directly.
 */
export const RECOVERY_PER_PAGE_MAX = 100;

export function recoveryPageBudget(limit: number): {
  pageSize: number;
  maxPages: number;
} {
  const pageSize = Math.min(Math.max(1, limit), RECOVERY_PER_PAGE_MAX);
  const maxPages = Math.max(1, Math.ceil(limit / pageSize)) + 5;
  return { pageSize, maxPages };
}

/**
 * Platform-confirmed "this bot was addressed" for a message fetched over
 * REST by recovery. Discord's REST parser never sets `isMention` (only the
 * Gateway path does), so a recovered @mention used to land as silent
 * context (AI Friends, 2026-10-28). Mirrors the live Gateway semantics:
 * an explicit mention of this bot's user id, or a DM from a human (live
 * DMs dispatch through onDirectMessage with isMention=true). Messages by
 * this or any other bot are never mentions. Without `botUserId` (platforms
 * whose SDK flag is already authoritative) only the SDK flag counts, so
 * non-Discord recovery keeps its old behaviour.
 */
export function fetchedMessageIsMention(
  message: Pick<ChatMessage, 'isMention' | 'author' | 'raw'>,
  opts: { botUserId?: string; isDM: boolean },
): boolean {
  if (message.isMention === true) return true;
  if (!opts.botUserId) return false;
  const author = message.author as { isBot?: boolean | 'unknown'; isMe?: boolean } | undefined;
  if (author?.isMe === true || author?.isBot === true) return false;
  if (opts.isDM) return true;
  const mentions = (message.raw as { mentions?: Array<{ id?: string } | null> } | undefined)?.mentions;
  return Array.isArray(mentions) && mentions.some((m) => m?.id === opts.botUserId);
}

/**
 * Bounded FIFO set of platform message ids this bridge already forwarded
 * (live or recovered). Recovery skips ids in it, so a reconnect pass — or
 * several back to back — never re-routes a message the router already saw
 * in this process, even when the host's own dedupe lags.
 */
export function createRecentIdSet(capacity: number): { has(id: string): boolean; add(id: string): void } {
  const ids = new Set<string>();
  return {
    has: (id) => ids.has(id),
    add(id) {
      if (ids.has(id)) return;
      ids.add(id);
      if (ids.size > capacity) ids.delete(ids.values().next().value as string);
    },
  };
}

export const RECENT_INBOUND_ID_CAPACITY = 10_000;

/**
 * Detects Gateway reconnects that can lose events. Discord's READY starts a
 * fresh session (events sent while disconnected are never redelivered);
 * RESUMED replays them, so it closes a gap without recovery. The first
 * READY of a bridge is the initial connect, which host startup recovery
 * covers. The gap starts at the first listener end since the last session
 * (the reschedule loop) or, for a re-identify inside one listener run, at
 * the last forwarded event. Pure over an injected clock — unit-tested.
 */
export function createGatewayReconnectTracker(opts: {
  now?: () => number;
  onReconnect: (gap: { disconnectedAtMs: number; reconnectedAtMs: number }) => void;
}): { onEvent(type: string): void; onListenerEnded(): void } {
  const now = opts.now ?? Date.now;
  let sawReady = false;
  let lastEventAtMs: number | null = null;
  let disconnectedAtMs: number | null = null;
  return {
    onListenerEnded() {
      if (disconnectedAtMs === null) disconnectedAtMs = now();
    },
    onEvent(type) {
      const t = now();
      if (type === 'GATEWAY_READY') {
        if (sawReady) {
          opts.onReconnect({ disconnectedAtMs: disconnectedAtMs ?? lastEventAtMs ?? t, reconnectedAtMs: t });
        }
        sawReady = true;
        disconnectedAtMs = null;
      } else if (type === 'GATEWAY_RESUMED') {
        disconnectedAtMs = null;
      }
      lastEventAtMs = t;
    },
  };
}

/**
 * True when a chat-sdk message was authored by the bot itself.
 *
 * Chat-sdk re-ingests every message in a channel — including the bot's
 * own outbound — as a fresh `chat-sdk` inbound row. The SDK flags
 * self-authored messages on the nested author: `isMe` (this identity is
 * the connected client) and, for the same identity, `isBot`. Surfacing
 * this as the envelope's `isBotMessage` lets the router's loopback gate
 * (`router.ts` isBotLoopback → the engage-skip) drop it. Without it, a
 * reply-shaped self-message (the bot quoting a user it just answered)
 * reaches `isReplyToOurBot` → trigger=1 → an "addressed" turn with
 * nothing to answer → the `sent===0 && addressed` safety-net emits a
 * spurious "[degraded — addressed turn produced no output]" with no
 * prompt/trigger behind it (observed live in AI Friends 2026-05-18).
 * `dbdcc476` fixed the sender-identity half of this bot-clobber bug and
 * explicitly flagged `isBotMessage` as still unset on this path.
 *
 * Conservative: only `true` on an explicit self/bot marker. An absent or
 * false marker (a normal human message, or an SDK that doesn't populate
 * it) returns `false` so real messages are never silently dropped.
 */
export function isSelfAuthoredChatSdkMessage(author: { isMe?: boolean; isBot?: boolean } | undefined | null): boolean {
  return author?.isMe === true || author?.isBot === true;
}

export async function enrichAttachments(attachments: Attachment[]): Promise<Array<Record<string, unknown>>> {
  const enriched: Array<Record<string, unknown>> = [];
  for (const att of attachments) {
    const entry: Record<string, unknown> = {
      type: att.type,
      name: att.name,
      mimeType: att.mimeType,
      size: att.size,
      width: (att as unknown as Record<string, unknown>).width,
      height: (att as unknown as Record<string, unknown>).height,
      ...(typeof att.url === 'string' && { url: att.url }),
    };
    // Two paths to populate `data`:
    //   (1) `fetchData()` — preferred when the adapter exposes it;
    //       handles auth automatically (Slack private URLs etc.).
    //   (2) `url` fallback — public CDN URLs (Discord attachments).
    //       Discord's chat-adapter populates `url` but does NOT expose
    //       `fetchData`, so without this fallback every Discord image
    //       lands in the container with metadata only and the agent
    //       sees no bytes ("I can't pull the screenshot in"). Observed
    //       live on 2026-05-09 with Adrian's Google-reconnect
    //       screenshot in boysnight.
    let buffer: Buffer | null = null;
    if (att.fetchData) {
      try {
        // Adapters may return ArrayBuffer (Telegram since 4.39); see attachmentBytesToBase64.
        const data: Buffer | ArrayBuffer | Uint8Array = await att.fetchData();
        buffer = Buffer.isBuffer(data)
          ? data
          : data instanceof Uint8Array
            ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
            : Buffer.from(data);
      } catch (err) {
        log.warn('Failed to fetchData attachment', { type: att.type, name: att.name, err });
      }
    }
    if (!buffer && att.url) {
      try {
        const res = await fetch(att.url);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status} ${res.statusText}`);
        }
        buffer = Buffer.from(await res.arrayBuffer());
      } catch (err) {
        log.warn('Failed to fetch attachment by url', {
          type: att.type,
          name: att.name,
          url: att.url,
          err,
        });
      }
    }
    if (buffer) {
      // Resize oversized images (>~3.5MB raw) so the base64 payload
      // stays under Anthropic's 5MB per-image cap. Static formats
      // (JPEG/PNG/WebP) get resized to 1024px-max + JPEG q85;
      // animated formats need ffmpeg (next branch). Mirrors v1's
      // `resizeToJpegBuffer` in apps/nanoclaw/src/shared/image-processing.ts.
      if (att.type === 'image' && att.mimeType) {
        const { maybeResizeImage } = await import('../media/image-processing.js');
        buffer = await maybeResizeImage(buffer, att.mimeType);
      }
      // Animated content transcode — see media/image-processing.ts for
      // the full rationale. Three cases land here:
      //   1. Tenor/Giphy "gifv" embeds classified as images while carrying
      //      mimeType='video/mp4'. Real type='video' MP4s bypass this branch
      //      and reach session-manager's video processing pass.
      //   2. WhatsApp "GIFs": att.type='image' mimeType='image/gif' but
      //      the bytes are MP4-encoded video under Baileys. Same 400.
      //   3. Oversize real GIFs: att.type='image' mimeType='image/gif',
      //      >3.5 MB raw, sharp can't shrink while preserving motion.
      // On success the attachment is rewritten as image/gif so the
      // container's extractImageAttachments sees an accepted format;
      // on failure (ffmpeg missing/failed/output oversize) we drop the
      // bytes so the agent doesn't get an attachment reference pointing
      // at content Anthropic will reject. v1 parity.
      if (att.mimeType) {
        const { shouldTranscodeAnimated, maybeTranscodeAnimated } = await import('../media/image-processing.js');
        if (shouldTranscodeAnimated(att.type, att.mimeType, buffer.length)) {
          const result = await maybeTranscodeAnimated(buffer, att.mimeType);
          if (result.ok && result.buffer && result.mimeType) {
            buffer = result.buffer;
            entry.mimeType = result.mimeType;
            entry.type = 'image';
          } else {
            log.warn('Animated attachment transcode failed; dropping bytes', {
              name: att.name,
              sourceType: att.type,
              sourceMime: att.mimeType,
              reason: result.reason,
            });
            // Skip the data payload. The bridge still emits the metadata
            // entry below — but without `data`, the container poll-loop's
            // image extractor passes over it and the agent sees nothing
            // rather than a broken reference.
            buffer = null;
          }
        }
      }
      if (buffer) entry.data = buffer.toString('base64');
      // Audio transcription is no longer done here. The engine's
      // session-manager.extractAttachmentFiles runs a single
      // transcription pass for every adapter (chat-sdk channels +
      // native WhatsApp). Doing it inline here would re-transcribe
      // the same buffer; doing it host-side meant standalone
      // NanoClaw silently skipped it for lack of host wiring. Both
      // issues resolved by the engine-side single site.
    } else if (att.type === 'image' || att.type === 'video' || att.type === 'audio') {
      // Loud failure for media types — text/file we can fall through
      // and the agent's formatter will render `[file: name]`. Media
      // without bytes is silently broken from the agent's POV
      // (the recurring "I can't pull the screenshot" failure mode).
      log.error('Attachment media bytes unavailable — agent will see metadata only', {
        type: att.type,
        name: att.name,
        hasFetchData: !!att.fetchData,
        hasUrl: !!att.url,
      });
    }
    enriched.push(entry);
  }
  return enriched;
}

/**
 * Append platform-rescued text to the serialized body, before `raw` is dropped.
 * No extractor, or nothing recovered, leaves the body byte-identical.
 */
export function appendRawText(
  serialized: Record<string, unknown>,
  raw: Record<string, unknown>,
  extract?: RawTextExtractor,
): void {
  if (!extract) return;
  const extra = extract(raw);
  if (!extra) return;
  const text = typeof serialized.text === 'string' ? serialized.text : '';
  serialized.text = text ? `${text}\n\n${extra}` : extra;
}

export function createChatSdkBridge(config: ChatSdkBridgeConfig): ChannelAdapter {
  const { adapter } = config;
  // The instance name becomes a webhook route segment (the route regex is
  // [^/?]+) and ':' is the state-namespace delimiter — reject anything that
  // would break either, at construction time rather than at first webhook.
  // Positive allow-list (not a deny-list): also rejects '' and
  // whitespace-only names, which are config bugs — '' is falsy, so it
  // would skip a truthiness guard, dead-end the webhook route, and
  // collapse the state namespace into the default instance's keyspace.
  if (config.instance !== undefined && !INSTANCE_KEY_RE.test(config.instance)) {
    throw new Error(
      `chat-sdk bridge instance ${JSON.stringify(config.instance)} must be URL-safe: ` +
        `non-empty, only letters, digits, '.', '_' or '-'`,
    );
  }
  const transformText = (t: string): string => (config.transformOutboundText ? config.transformOutboundText(t) : t);
  const cardText = (t: string): string => (config.escapeCardText ? config.escapeCardText(t) : t);
  const terminalMessage = (spec: TerminalApprovalCard) =>
    terminalApprovalMessage({
      ...spec,
      question: cardText(spec.question),
      questionBlocks: spec.question ? splitCardText(spec.question, cardText, CARD_TEXT_BLOCK_LENGTH) : undefined,
      resolution: cardText(spec.resolution),
    });
  /** Registry/routing key for this bridge — also the app-context cache
   *  namespace. Default instances key by the platform name. */
  const instanceKey = config.instance ?? adapter.name;
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  let gatewayAbort: AbortController | null = null;
  let pollVoteDebouncer: PollVoteDebouncer | null = null;
  // Every message id forwarded to onInbound (live or recovered); recovery
  // skips these so reconnect replays are exactly-once per process.
  const forwardedIds = createRecentIdSet(RECENT_INBOUND_ID_CAPACITY);

  /** Hand a chat message to the host; remember its id once accepted. */
  async function forwardMessage(channelId: string, threadId: string | null, inbound: InboundMessage): Promise<void> {
    await setupConfig.onInbound(channelId, threadId, inbound);
    forwardedIds.add(inbound.id);
  }

  async function messageToInbound(
    message: ChatMessage,
    isMention: boolean,
    isGroup?: boolean,
  ): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData().
    const sdkAttachments =
      message.attachments && message.attachments.length > 0
        ? message.attachments
        : rawAttachmentsToSdkAttachments(message.raw as Record<string, unknown> | undefined);
    const enrichedAttachments = sdkAttachments.length > 0 ? await enrichAttachments(sdkAttachments) : [];
    if (enrichedAttachments.length > 0) {
      serialized.attachments = enrichedAttachments;
    }

    // Recover platform content the Chat SDK omitted, while raw is still here.
    if (message.raw) {
      appendRawText(serialized, message.raw as Record<string, unknown>, config.extractRawText);
    }

    // Extract reply context via platform-specific hook. Awaited so async
    // extractors (e.g. Discord's reply-chain walker) can fetch ancestors
    // before we hand the serialized message to the router.
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = await config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) {
        const { attachments, ...replyContext } = replyTo;
        serialized.replyTo = replyContext;
        if (attachments && attachments.length > 0) {
          const quoted = await enrichAttachments(attachments);
          serialized.attachments = [...enrichedAttachments, ...quoted];
        }
      }
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as
      | { userId?: string; fullName?: string; userName?: string; isMe?: boolean; isBot?: boolean }
      | undefined;
    if (author) {
      const name = author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
    }

    // Detect the bot's own message bouncing back so the router's loopback
    // gate drops it instead of self-triggering an empty "addressed" turn.
    // Full rationale + incident chain on isSelfAuthoredChatSdkMessage.
    const authoredBySelf = isSelfAuthoredChatSdkMessage(author);
    // Narrower signal: THIS bot's own outbound (the connected client),
    // distinct from any-bot (`authoredBySelf` also catches a *different*
    // bot via author.isBot). Only this-bot self-echo is dropped from the
    // store by the router — it is pure status spam with no self-context
    // value, and unbounded it floods the dev-DM inbound queue (Teddy DM
    // 2026-06-03). Other-bot messages still accumulate as channel context.
    const authoredByThisBot = author?.isMe === true;

    // Stamp this bot's platform id into the row content so the
    // container-side isAddressedTurn can distinguish an @mention of THIS
    // bot from an @mention of a different participant. The SDK's
    // top-level `isMention` is only "a mention exists" — true for
    // `<@anyone>` — so on its own it made a message @mentioning another
    // bot look like this bot was addressed (→ silent turn → spurious
    // "[degraded]" in AI Friends 2026-05-19). Only set when known
    // (Discord); absent on platforms that don't supply it, where
    // isAddressedTurn keeps its permissive isMention behavior.
    if (config.botUserId) serialized.botUserId = config.botUserId;
    if (authoredBySelf) serialized.isBotMessage = true;

    // Serialize a native poll into the message text. Discord delivers a poll
    // as a structured object on `raw.poll` with an EMPTY text body, so without
    // this the agent receives a blank message (v1 rendered it via
    // formatPollSummary; the v2 chat-sdk path dropped it). Append the summary
    // to whatever text exists (normally none) so the agent can read and reason
    // about the poll. Best-effort: a formatter throw must not drop the message.
    if (config.extractPollSummary && message.raw) {
      try {
        const pollSummary = await config.extractPollSummary(message.raw as Record<string, unknown>);
        if (pollSummary) {
          const existing = typeof serialized.text === 'string' ? serialized.text.trim() : '';
          serialized.text = existing ? `${existing}\n\n${pollSummary}` : pollSummary;
        }
      } catch (err) {
        log.warn('extractPollSummary failed; message kept without poll text', {
          messageId: message.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Last-resort visibility for unhandled content. If, after every extractor
    // above, the message STILL has no text AND no usable attachments, but the
    // raw payload carries something we don't render (interactive components, an
    // unknown embed type, …), surface a stub so the agent perceives the gap and
    // can escalate via report_unfulfillable. Gated on genuinely-empty so a
    // normal attachment-only post (already represented via content.attachments)
    // is never stubbed. Best-effort: a describer throw must not drop the message.
    const hasText = typeof serialized.text === 'string' && serialized.text.trim().length > 0;
    const hasAttachments = Array.isArray(serialized.attachments) && serialized.attachments.length > 0;
    const describeUnsupportedContent = config.describeUnsupportedContent;
    const shouldDescribeUnsupported =
      describeUnsupportedContent &&
      message.raw &&
      !hasText &&
      (!hasAttachments || hasForwardedMessageSnapshot(message.raw));
    if (shouldDescribeUnsupported) {
      try {
        const stub = describeUnsupportedContent(message.raw as Record<string, unknown>);
        if (stub) {
          serialized.text = stub;
          log.info('Surfaced unsupported content as a stub for agent visibility', {
            messageId: message.id,
            stub,
          });
        }
      } catch (err) {
        log.warn('describeUnsupportedContent failed; message kept as-is', {
          messageId: message.id,
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Drop raw to save DB space (can be very large)
    serialized.raw = undefined;

    return {
      id: message.id,
      kind: 'chat-sdk',
      content: serialized,
      timestamp: message.metadata.dateSent.toISOString(),
      isMention,
      isGroup,
      ...(authoredBySelf && { isBotMessage: true }),
      ...(authoredByThisBot && { isSelfMessage: true }),
    };
  }

  /**
   * Build an inbound `kind: 'reaction'` message from a Chat SDK
   * `ReactionEvent`. Works uniformly across every Chat SDK platform
   * (Discord, Slack, Telegram, Teams, …) — the SDK normalizes the
   * platform's raw reaction wire format into this one shape.
   *
   * `content.replyTo.messageId` carries the *reacted-to* message's platform
   * id. This deliberately reuses the same field the router's reply-to-bot
   * detection (`isReplyToOurBot` → `wasDeliveredByBot`) already consults, so
   * a reaction on one of the bot's own messages becomes a soft trigger with
   * zero new router plumbing. `content.text` is a human-legible summary used
   * as a fallback by readers that don't special-case the reaction shape;
   * the formatter renders the structured fields instead.
   *
   * `id` is namespaced with `:rx:<added>:<emoji>` so adding then removing
   * the same emoji on the same message produces two distinct
   * `messages_in.id`s (the PK is per-session) rather than the remove
   * silently colliding with and dropping the add.
   */
  function reactionToInbound(event: ReactionEvent): InboundMessage {
    const author = event.user as { userId?: string; fullName?: string; userName?: string } | undefined;
    const senderName = author?.fullName ?? author?.userName;
    const emojiName = event.emoji?.name ?? event.rawEmoji;
    const verb = event.added ? 'reacted with' : 'removed reaction';
    return {
      id: `${event.messageId}:rx:${event.added ? 'add' : 'del'}:${emojiName}`,
      kind: 'reaction',
      content: {
        operation: 'reaction_received',
        added: event.added,
        emoji: emojiName,
        rawEmoji: event.rawEmoji,
        // Reacted-to message id, surfaced both as the explicit field and via
        // replyTo so the router's existing reply-to-bot path resolves it.
        reactedToMessageId: event.messageId,
        replyTo: { messageId: event.messageId },
        senderId: author?.userId,
        sender: senderName,
        senderName,
        text: `${senderName ?? 'Someone'} ${verb} ${emojiName}`,
      },
      timestamp: new Date().toISOString(),
      isMention: false,
    };
  }

  const bridge: ChannelAdapter = {
    name: config.instance ?? adapter.name,
    channelType: adapter.name, // unchanged — semantic platform key
    instance: config.instance, // undefined ⇒ default instance

    // Host-provided exact path; normal delivery intentionally never uses it.
    verbatim: config.verbatim,
    supportsThreads: config.supportsThreads,
    defaults: config.defaults,

    async setup(hostConfig: ChannelSetup) {
      // Apply the registered inbound policy (if any) for this channel type.
      // Wrapping here — the single point every dispatch path reads back
      // through — means one policy covers onSubscribedMessage, onNewMention,
      // onDirectMessage and onNewMessage alike.
      const inboundPolicy = bridgeInboundPolicies.get(adapter.name);
      setupConfig = inboundPolicy ? await inboundPolicy(hostConfig, instanceKey) : hostConfig;

      // State namespace: ONLY for a named non-default instance. A skill
      // that explicitly names the primary instance after the platform
      // (instance === adapter.name) still lands on the legacy UNPREFIXED
      // keyspace — prefixing the default would orphan every live install's
      // chat_sdk_subscriptions/kv/locks/lists rows.
      state = new SqliteStateAdapter(config.instance && config.instance !== adapter.name ? config.instance : undefined);

      chat = new Chat({
        adapters: { [adapter.name]: adapter },
        userName: adapter.userName || 'NanoClaw',
        concurrency: config.concurrency ?? 'concurrent',
        state,
        logger: 'silent',
      });

      // Detect platform-driven chat-id reassignments (Telegram's
      // `migrate_to_chat_id` service event, fired when a basic group is
      // upgraded to a supergroup). When we see one, the chat we know as
      // `channelIdFromThreadId(thread.id)` is dead — Telegram has assigned
      // it a brand-new id and the old id immediately stops accepting sends.
      // Notify the host so it can rewrite messaging_groups.platform_id +
      // refresh per-session routing before continuing. We do NOT also
      // forward the migrate event as a normal user message: it has no text,
      // and our pre-`migrate_to_chat_id`-detection behavior was to bounce
      // a "your message came through blank" reply to the now-dead old id,
      // which fails three times and gets given up on permanently.
      //
      // Returns true if the event was handled as a migration (caller skips).
      // Lives inside `setup` so it closes over `adapter` + `setupConfig`.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const maybeHandleChatMigration = async (message: any, threadId: string): Promise<boolean> => {
        const newChatId = message?.raw?.migrate_to_chat_id;
        if (typeof newChatId !== 'number' && typeof newChatId !== 'string') return false;
        const oldPlatformId = adapter.channelIdFromThreadId(threadId);
        // Mirror the adapter's `telegram:<chatId>` encoding rather than
        // reusing channelIdFromThreadId (which would need a synthetic
        // thread id). Channel-type prefix keeps us aligned with the
        // single known emitter (Telegram); other channels that grow
        // analogous events will follow the same prefix convention.
        const newPlatformId = `${adapter.name}:${newChatId}`;
        if (newPlatformId === oldPlatformId) return true;
        log.info('Chat platform-id migration detected', {
          channelType: adapter.name,
          oldPlatformId: logId(oldPlatformId),
          newPlatformId: logId(newPlatformId),
        });
        try {
          await setupConfig.onChatMigrated?.(adapter.name, oldPlatformId, newPlatformId);
        } catch (err) {
          log.error('onChatMigrated handler threw', {
            channelType: adapter.name,
            oldPlatformId: logId(oldPlatformId),
            newPlatformId: logId(newPlatformId),
            err,
          });
        }
        return true;
      };

      // Four SDK dispatch paths — bridge just forwards. All per-wiring
      // engage / accumulate / drop / subscribe decisions live in the host
      // router (src/router.ts routeInbound / evaluateEngage). The bridge
      // only resolves channel ids and sets the platform-confirmed isMention
      // flag that routeInbound evaluates; the router calls back into
      // bridge.subscribe(...) when a mention-sticky wiring engages.

      // Subscribed threads — every message in a thread we've previously
      // engaged. Carry the SDK's `message.isMention` through so mention-mode
      // wirings still fire on in-thread mentions.
      chat.onSubscribedMessage(async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await forwardMessage(channelId, thread.id, await messageToInbound(message, message.isMention === true, true));
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await forwardMessage(channelId, thread.id, await messageToInbound(message, true, true));
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // unmodified (Slack users can open sub-threads inside a DM); whether it
      // is honored is policy, not transport: the channel's declared
      // dm.threads default (ChannelDefaults) or a per-wiring threads override
      // decides at router fanout whether replies land in-thread or all DM
      // sub-threads collapse into the one DM session.
      chat.onDirectMessage(async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId: logId(channelId),
          // Hashed user id only: display names and raw ids stay out of the log.
          sender: logId((message.author as any)?.userId) ?? 'unknown',
          threadId: logId(thread.id),
        });
        const inbound = await messageToInbound(message, true, false);
        // Agent-mode app context: DM-only by platform design.
        attachAppContext(
          inbound.content as Record<string, unknown>,
          instanceKey,
          channelId,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (message.author as any)?.userId,
        );
        const dmThreadId = normalizeDmThreadId(thread.id, message.id);
        await forwardMessage(channelId, dmThreadId, inbound);
      });

      // Plain messages in unsubscribed threads.
      //
      // Chat SDK dispatch (handling-events.mdx §"Handler dispatch order") is
      // exclusive: subscribed → onSubscribedMessage; unsubscribed+mention →
      // onNewMention; unsubscribed+pattern-match → onNewMessage. Registering
      // with `/[\s\S]*/` lets the router see every plain message (including
      // media-only messages with empty text) on every unsubscribed thread the
      // getMessagingGroupWithAgentCount (~1 DB read) for unwired channels,
      // so forwarding every one is cheap enough to not need a bridge-side
      // flood gate.
      chat.onNewMessage(/[\s\S]*/, async (thread, message) => {
        if (await maybeHandleChatMigration(message, thread.id)) return;
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await forwardMessage(channelId, thread.id, await messageToInbound(message, false, true));
      });

      // Emoji reactions (add + remove), all Chat SDK platforms. No emoji
      // filter — we forward every reaction; the router decides whether it's
      // a soft trigger (reaction on our own message) or silent accumulate
      // context (reaction between other users). thread.id flows through as
      // the channel/thread id exactly like onNewMessage so the reaction
      // lands in the same session as the message it targets.
      chat.onReaction(async (event: ReactionEvent) => {
        const channelId = adapter.channelIdFromThreadId(event.threadId);
        await setupConfig.onInbound(channelId, event.threadId, reactionToInbound(event));
      });

      // Agent-mode assistant context: cache the latest "what the user is
      // viewing" per (channel, user). The installed chat core (4.41.1)
      // dispatches assistant_thread_started and
      // assistant_thread_context_changed into these handlers. Agent-view
      // app_context_changed goes to onAppContextChanged, not registered here.
      const rememberAppContext = (event: AssistantThreadStartedEvent | AssistantContextChangedEvent): void => {
        cacheAppContext(instanceKey, event.channelId, event.userId, appContextEntities(event));
      };
      chat.onAssistantThreadStarted((event) => {
        rememberAppContext(event);
        dispatchAgentDmOpened({ instance: instanceKey, channelId: event.channelId });
      });
      chat.onAssistantContextChanged(rememberAppContext);

      // Membership events: forwarded to the handler registered for this
      // channel type (setMembershipHandler); no-op when none is registered.
      // The chat core dispatches only member_joined_channel;
      // member_left_channel arrives at the adapter but has no SDK handler
      // in 4.41.1.
      // TODO(member-left): when the chat core grows an onMemberLeftChannel
      // dispatch, register it here and forward with { left: true } — the
      // MembershipEvent type and dispatchMembership already carry it.
      chat.onMemberJoinedChannel((event) => {
        dispatchMembership({
          instance: instanceKey,
          channelType: adapter.name,
          channelId: event.channelId,
          userId: event.userId,
          inviterId: event.inviterId,
        });
      });

      // Handle button clicks (ask_user_question)
      chat.onAction(async (event) => {
        if (await dispatchQuestionAction(event, adapter, instanceKey)) return;
        if (!event.actionId.startsWith('ncq:')) return;
        const parts = event.actionId.split(':');
        if (parts.length < 3) return;
        const questionId = parts[1];
        const tail = parts.slice(2).join(':');
        const userId = event.user?.userId || '';

        // Resolve render metadata BEFORE dispatching onAction (which deletes the row).
        const render = await resolveQuestionRender(questionId);
        // New format: button id/value is an integer index into options (kept
        // short to fit Telegram's 64-byte callback_data cap). Old format:
        // the full value is embedded in actionId/value directly.
        const selectedOption = resolveSelectedOption(render, event.value, tail);
        if (render?.deferResolution) {
          setupConfig.onAction(questionId, selectedOption, userId, {
            instance: instanceKey,
            messageId: event.messageId,
            platformId: adapter.channelIdFromThreadId(event.threadId),
          });
          return;
        }
        const title = render?.title ?? '❓ Question';
        const matched = render?.options.find((o) => o.value === selectedOption);
        const selectedLabel = matched?.selectedLabel ?? selectedOption ?? '(clicked)';

        // Update the card to show the selected answer, who acted, and remove buttons
        const actorName = event.user?.userName || event.user?.fullName || '';
        const resolution = actorName ? `${selectedLabel} by ${actorName}` : selectedLabel;
        try {
          const tid = event.threadId;
          await adapter.editMessage(
            tid,
            event.messageId,
            render?.question
              ? terminalMessage({ title, question: render.question, resolution })
              : { markdown: `${title}\n\n${resolution}` },
          );
        } catch (err) {
          log.warn('Failed to update card after action', { err });
        }

        setupConfig.onAction(questionId, selectedOption, userId, {
          instance: instanceKey,
          messageId: event.messageId,
          platformId: adapter.channelIdFromThreadId(event.threadId),
        });
      });

      await chat.initialize();

      // Test seam: unit tests drive the SDK's public process* dispatchers
      // (processAssistantContextChanged, …) against the handlers registered
      // above without a live platform. Not part of the ChannelAdapter
      // contract.
      (bridge as unknown as { _chat?: Chat })._chat = chat;

      // Start Gateway listener for adapters that support it (e.g., Discord)
      const gatewayAdapter = adapter as GatewayAdapter;
      if (gatewayAdapter.startGatewayListener) {
        gatewayAbort = new AbortController();

        // Live poll vote refresh — one debouncer per bridge instance so each
        // Discord workspace keeps its own timer map. The flush asks the host
        // to re-render current poll state and injects it as accumulate-only
        // context (see pollUpdateInbound for id/dedupe semantics).
        if (config.fetchPollUpdate) {
          const fetchPollUpdate = config.fetchPollUpdate;
          // Defensive: a re-entrant setup() must not strand the previous
          // instance's pending timers.
          pollVoteDebouncer?.clear();
          pollVoteDebouncer = createPollVoteDebouncer(POLL_UPDATE_DEBOUNCE_MS, async (vote) => {
            const update = await fetchPollUpdate(vote);
            if (!update || !update.text.trim()) return;
            const { channelThreadId, inbound } = pollUpdateInbound(
              adapter.name,
              vote,
              update,
              new Date().toISOString(),
            );
            await setupConfig.onInbound(adapter.channelIdFromThreadId(channelThreadId), channelThreadId, inbound);
          });
        }

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        // Reconnect gap → ask the host to replay what the dead session
        // missed (ChannelSetup.onReconnected). Best-effort: a host error
        // must never break event forwarding.
        const reconnects = createGatewayReconnectTracker({
          onReconnect: ({ disconnectedAtMs, reconnectedAtMs }) => {
            log.info('Gateway reconnected with a new session; requesting gap recovery', {
              adapter: adapter.name,
              instance: config.instance,
              gapMs: reconnectedAtMs - disconnectedAtMs,
            });
            const onReconnected = setupConfig.onReconnected;
            if (!onReconnected) return;
            void Promise.resolve()
              .then(() =>
                onReconnected.call(setupConfig, {
                  channelType: adapter.name,
                  instance: config.instance,
                  disconnectedAt: new Date(disconnectedAtMs).toISOString(),
                  reconnectedAt: new Date(reconnectedAtMs).toISOString(),
                }),
              )
              .catch((err) => log.warn('onReconnected handler threw', { adapter: adapter.name, err }));
          },
        });

        const webhookUrl = await startLocalWebhookServer(
          gatewayAdapter,
          setupConfig,
          config.botToken,
          pollVoteDebouncer ?? undefined,
          (type) => reconnects.onEvent(type),
        );

        // Exponential backoff capped at 1h. Without this, an unrecoverable
        // failure (e.g., TokenInvalid) restarts ~10×/sec and Discord's
        // Cloudflare layer issues a multi-hour IP block. A run that lasts
        // longer than 5 minutes counts as healthy and resets the counter.
        let consecutiveFailures = 0;
        const startGateway = () => {
          if (gatewayAbort?.signal.aborted) return;
          const startedAt = Date.now();
          // Capture the long-running listener promise via waitUntil
          let listenerPromise: Promise<unknown> | undefined;
          void gatewayAdapter.startGatewayListener!(
            {
              waitUntil: (p: Promise<unknown>) => {
                listenerPromise = p;
              },
            },
            24 * 60 * 60 * 1000,
            gatewayAbort!.signal,
            webhookUrl,
          ).then(() => {
            // startGatewayListener resolves immediately with a Response;
            // the actual work is in the listenerPromise passed to waitUntil
            if (!listenerPromise) return;
            const reschedule = (err?: unknown) => {
              if (gatewayAbort?.signal.aborted) return;
              reconnects.onListenerEnded();
              const ranForMs = Date.now() - startedAt;
              if (ranForMs > 5 * 60 * 1000) consecutiveFailures = 0;
              else consecutiveFailures++;
              const delayMs = Math.min(60 * 60 * 1000, 2 ** consecutiveFailures * 1000);
              if (err) {
                log.error('Gateway listener error, retrying', {
                  adapter: adapter.name,
                  err,
                  consecutiveFailures,
                  delayMs,
                });
              } else {
                log.info('Gateway listener expired, restarting', {
                  adapter: adapter.name,
                  consecutiveFailures,
                  delayMs,
                });
              }
              setTimeout(startGateway, delayMs);
            };
            void listenerPromise.then(() => reschedule()).catch(reschedule);
          });
        };
        startGateway();
        log.info('Gateway listener started', { adapter: adapter.name });
      } else if ('runtimeMode' in adapter && adapter.runtimeMode === 'polling') {
        // Polling adapters (Telegram) pull updates themselves; a route here
        // would only bind the shared webhook port for nothing. Read after
        // initialize(): the adapter resolves mode 'auto' there.
        log.info('Polling adapter: no webhook route registered', { adapter: adapter.name });
      } else {
        // Non-gateway adapters (Slack, Teams, GitHub, etc.) — register on the
        // shared webhook server. The handler key stays adapter.name (the
        // Chat instance's webhooks map is keyed by it); the route segment is
        // the instance, so each same-platform bridge gets its own URL (and
        // its own signing secret — platforms sign per-app).
        registerWebhookAdapter(chat, adapter.name, config.instance ?? adapter.name);
      }

      log.info('Chat SDK bridge initialized', { adapter: adapter.name });
    },

    async deliver(platformId: string, threadId: string | null, message): Promise<string | undefined> {
      // platformId is already in the adapter's encoded format (e.g. "telegram:6037840640",
      // "discord:guildId:channelId") — use it directly as the thread ID
      const tid = threadId ?? platformId;
      const content = message.content as Record<string, unknown>;
      // inReplyTo carries the inbound message id we're replying to. Router
      // namespaces messages_in.id as `<platform-msg-id>:<agent-group-id>`
      // (see router.messageIdForAgent) — strip that suffix so the adapter
      // gets the raw platform message id Discord/etc. expect for native
      // reply chains. Empty/null → no reply pill.
      const replyToRaw = message.inReplyTo ?? null;
      // Telegram's platform id is itself composite (<chatId>:<messageId>).
      // Other adapters (including Discord) use a single segment.
      const replyTo = replyToRaw
        ? replyToRaw
            .split(':')
            .slice(0, adapter.name === 'telegram' ? 2 : 1)
            .join(':') || null
        : null;
      const postReply = (post: AdapterPostableMessage, target: string | null) => {
        if (adapter.name === 'telegram' && target) {
          // Telegram 4.41+ accepts the native reply target as argument three,
          // not the Discord-specific post.replyTo field. It builds
          // reply_parameters with allow_sending_without_reply for deleted parents.
          const telegram = adapter as Adapter & {
            postMessage(
              threadId: string,
              message: AdapterPostableMessage,
              replyToMessageId: string,
            ): Promise<RawMessage<unknown>>;
          };
          return telegram.postMessage(tid, post, target);
        }
        return adapter.postMessage(tid, post);
      };

      if (content.operation === 'edit' && content.messageId) {
        const render =
          typeof content.questionId === 'string' ? await resolveQuestionRender(content.questionId) : undefined;
        if (render?.renderTerminal && content.terminalCard) {
          const terminal = content.terminalCard as { resolution: string };
          await adapter.editMessage(tid, content.messageId as string, render.renderTerminal(terminal.resolution));
          return;
        }
        const terminalCard = content.terminalCard as Partial<TerminalApprovalCard> | undefined;
        if (
          terminalCard &&
          typeof terminalCard.title === 'string' &&
          typeof terminalCard.question === 'string' &&
          typeof terminalCard.resolution === 'string'
        ) {
          await adapter.editMessage(
            tid,
            content.messageId as string,
            terminalMessage(terminalCard as TerminalApprovalCard),
          );
        } else {
          await adapter.editMessage(tid, content.messageId as string, {
            markdown: transformText((content.text as string) || (content.markdown as string) || ''),
          });
        }
        return;
      }

      if (content.operation === 'reaction' && content.messageId && content.emoji) {
        await adapter.addReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      if (content.operation === 'remove_reaction' && content.messageId && content.emoji) {
        await adapter.removeReaction(tid, content.messageId as string, content.emoji as string);
        return;
      }

      if (content.operation === 'delete' && content.messageId) {
        await adapter.deleteMessage(tid, content.messageId as string);
        return;
      }

      // Ask question card — render as Card with buttons
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = content.title as string;
        const question = content.question as string;
        if (!title) {
          log.error('ask_question missing required title — skipping delivery', { questionId });
          return;
        }
        const render = content.requirePresentation ? await resolveQuestionRender(questionId) : undefined;
        if (render?.renderMessage) {
          const result = await adapter.postMessage(tid, render.renderMessage(questionId));
          return result?.id;
        }
        if (content.requirePresentation) throw new Error('Approval presentation adapter is unavailable');
        // Long text goes out as several blocks, measured after escaping, so no
        // per-block cap cuts it. A platform that caps the whole card refuses
        // what it can't show, counting the fences the split adds.
        // Questions an agent asks itself keep their own markup (`fromAgent`).
        const escape = content.fromAgent === true ? (t: string) => t : cardText;
        const text = escape(question);
        const blocks = splitCardText(question, escape, CARD_TEXT_BLOCK_LENGTH);
        if (config.maxCardTextLength !== undefined) {
          const tooLong = cardQuestionTooLong(title, blocks.join('\n'), config.maxCardTextLength);
          if (tooLong) throw new CardTooLongError(tooLong);
        }
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        const card = Card({
          title,
          children: [
            ...blocks.map((block) => CardText(block)),
            Actions(
              // Encode button id/value with the option index rather than the
              // full value. Telegram caps callback_data at 64 bytes, and
              // long values (e.g. ISO datetimes, URLs) push the JSON payload
              // well past that. The onAction handlers resolve the index back
              // to the real value via resolveQuestionRender(questionId).
              options.map((opt, idx) =>
                Button({ id: `ncq:${questionId}:${idx}`, label: opt.label, value: String(idx), style: opt.style }),
              ),
            ),
          ],
        });
        const result = await adapter.postMessage(tid, {
          card,
          fallbackText: `${title}\n\n${text}\nOptions: ${options.map((o) => o.label).join(', ')}`,
        });
        return result?.id;
      }

      // Display card (send_card MCP tool) — returns immediately, no callback flow.
      // Non-URL actions are dropped: send_card's contract is fire-and-forget, so a
      // callback button would have nowhere to land. URL actions render as link buttons.
      // The runner filters these against LINK_ACTION_SCHEMA before writing the row;
      // the checks below still stand because any producer can write this payload.
      if (content.type === 'card' && content.card && typeof content.card === 'object') {
        const cardSpec = content.card as Record<string, unknown>;
        const title = (cardSpec.title as string) || '';
        const fallbackText = (content.fallbackText as string) || (cardSpec.description as string) || title || '';

        const cardChildren: CardChild[] = [];
        if (typeof cardSpec.description === 'string' && cardSpec.description) {
          cardChildren.push(CardText(cardSpec.description));
        }
        if (Array.isArray(cardSpec.children)) {
          for (const child of cardSpec.children) {
            if (typeof child === 'string' && child) {
              cardChildren.push(CardText(child));
            } else if (
              child &&
              typeof child === 'object' &&
              typeof (child as Record<string, unknown>).text === 'string'
            ) {
              cardChildren.push(CardText((child as Record<string, string>).text));
            }
          }
        }
        if (Array.isArray(cardSpec.actions)) {
          const linkButtons = (cardSpec.actions as Array<Record<string, unknown> | null | undefined>)
            .filter(
              (a): a is Record<string, unknown> =>
                !!a &&
                typeof a === 'object' &&
                typeof a.url === 'string' &&
                !!a.url &&
                typeof a.label === 'string' &&
                !!a.label,
            )
            .map((a) => {
              const style = a.style;
              const safeStyle: 'primary' | 'danger' | 'default' | undefined =
                style === 'primary' || style === 'danger' || style === 'default' ? style : undefined;
              return LinkButton({
                label: a.label as string,
                url: a.url as string,
                style: safeStyle,
              });
            });
          if (linkButtons.length > 0) {
            cardChildren.push(Actions(linkButtons));
          }
        }

        if (cardChildren.length === 0 && !title) {
          log.warn('send_card payload empty, skipping delivery');
          return;
        }

        const card = Card({ title, children: cardChildren });
        const result = await adapter.postMessage(tid, { card, fallbackText });
        return result?.id;
      }

      // Normal message
      const rawText = (content.markdown as string) || (content.text as string);
      const text = rawText ? transformText(rawText) : rawText;
      if (text) {
        // Attach files if present (FileUpload format: { data, filename })
        const fileUploads = message.files?.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        // Split if over the adapter's max length. Files ride on the first
        // chunk so the head of the reply still carries them.
        const chunks =
          config.maxTextLength && text.length > config.maxTextLength
            ? splitForLimit(text, config.maxTextLength)
            : [text];
        let firstId: string | undefined;
        for (let i = 0; i < chunks.length; i++) {
          const chunk = chunks[i];
          const attachFiles = i === 0 && fileUploads && fileUploads.length > 0;
          // Reply pill goes on the first chunk only — subsequent chunks are
          // contiguous follow-ups, not separate replies to the same parent.
          const replyForChunk = i === 0 ? replyTo : null;
          const post = attachFiles ? { markdown: chunk, files: fileUploads } : { markdown: chunk };
          if (replyForChunk) (post as Record<string, unknown>).replyTo = replyForChunk;
          // Discord-only: pass suppressEmbeds through so the patched chat-adapter
          // can set message flags = 4 (SUPPRESS_EMBEDS). Other adapters ignore
          // unknown postable fields.
          if (message.suppressEmbeds) {
            (post as Record<string, unknown>).suppressEmbeds = true;
          }
          const result = await postReply(post, replyForChunk);
          if (i === 0) firstId = result?.id;
        }
        return firstId;
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        const post: Record<string, unknown> = { markdown: '', files: fileUploads };
        if (replyTo) post.replyTo = replyTo;
        const result = await postReply(post as never, replyTo);
        return result?.id;
      }
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid);
    },

    async teardown() {
      gatewayAbort?.abort();
      pollVoteDebouncer?.clear();
      await chat.shutdown();
      log.info('Chat SDK bridge shut down', { adapter: adapter.name });
    },

    isConnected() {
      const probe = (adapter as ConnectionAwareAdapter).isConnected;
      return probe ? probe.call(adapter) : true;
    },

    async subscribe(_platformId: string, threadId: string) {
      // Chat SDK's subscription state lives on the StateAdapter (not on the
      // Chat instance itself). SqliteStateAdapter.subscribe is idempotent —
      // a second call on an already-subscribed thread is a no-op. threadId
      // is the SDK's thread id, which is what the router already has from
      // the original inbound event.
      await state.subscribe(threadId);
    },

    async recoverMissedMessages({
      platformId,
      lookbackMs,
      limit,
    }: {
      platformId: string;
      lookbackMs: number;
      limit: number;
    }): Promise<{ recoveredCount: number; earliestTimestamp?: string; alreadyHandledCount?: number }> {
      // No-op if setup hasn't run yet — the host must finish setup before
      // recovery makes sense (we need onInbound to replay through).
      if (!setupConfig) return { recoveredCount: 0 };

      // Adapters that don't expose fetchMessages (or where the gateway's
      // resume protocol is the source of truth) can't recover; the host
      // checks for this method's presence so a clean no-op is fine here too.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adapterAny = adapter as any;
      if (typeof adapterAny.fetchMessages !== 'function') {
        return { recoveredCount: 0 };
      }

      // platformId is the adapter's encoded thread id for non-threaded
      // platforms (Telegram/WhatsApp use it directly). For threaded
      // platforms (Discord/Slack), recovery operates per-thread because
      // fetchMessages takes a thread id, and the host calls this once per
      // platformId it owns; threaded recovery of every thread inside a
      // guild is an explicit follow-up if/when the host tracks that level.
      const threadId = platformId;
      const cutoffMs = Date.now() - lookbackMs;

      let recoveredCount = 0;
      let alreadyHandledCount = 0;
      let earliestTimestamp: string | undefined;
      const isDM = typeof adapterAny.isDM === 'function' && adapterAny.isDM(threadId) === true;

      // Per-page cap. Discord's Get Channel Messages API hard-caps the
      // `limit` query param at 100 (400 code 50035 NUMBER_TYPE_MAX
      // otherwise), so a caller asking for more than that recovered
      // *nothing* for the whole thread. Clamp the page size and instead
      // walk backward page-by-page via the FetchResult cursor until we
      // cross the lookback cutoff — this honors a window larger than one
      // page without ever sending an out-of-range limit. See
      // recoveryPageBudget for the Discord cap rationale.
      const { pageSize, maxPages: MAX_PAGES } = recoveryPageBudget(limit);

      try {
        let cursor: string | undefined;
        let reachedCutoff = false;
        const channelId = adapter.channelIdFromThreadId(threadId);

        for (let page = 0; page < MAX_PAGES && !reachedCutoff; page++) {
          const result = await adapterAny.fetchMessages(threadId, {
            limit: pageSize,
            direction: 'backward',
            ...(cursor ? { cursor } : {}),
          });
          const messages = (result?.messages ?? []) as ChatMessage[];
          if (messages.length === 0) break;

          // chat-sdk returns messages in chronological order (oldest
          // first within the page). Replay in the same order so seq-based
          // dedup and inbound.db PK collisions resolve naturally.
          for (const message of messages) {
            const sentAt = message.metadata?.dateSent?.getTime?.();
            // Pre-cutoff message: we've walked past the window. Older
            // pages are strictly older, so stop after this page.
            if (!sentAt || sentAt < cutoffMs) {
              reachedCutoff = true;
              continue;
            }

            // Already forwarded by this bridge (live, or an earlier
            // recovery pass): never route it twice.
            if (forwardedIds.has(message.id)) {
              alreadyHandledCount += 1;
              continue;
            }

            const timestamp = message.metadata.dateSent.toISOString();
            if (!earliestTimestamp || timestamp < earliestTimestamp) {
              earliestTimestamp = timestamp;
            }
            recoveredCount += 1;

            // We don't know whether the historical message belongs to a
            // subscribed thread at recovery time. Forward through onInbound
            // with isMention from fetchedMessageIsMention (REST-fetched
            // messages carry no SDK flag) and isGroup undefined so the
            // router's existing classification path runs. The router's
            // dedup PK on (session_id, message_id) handles re-routing of
            // messages processed before this process started.
            await forwardMessage(
              channelId,
              threadId,
              await messageToInbound(message, fetchedMessageIsMention(message, { botUserId: config.botUserId, isDM })),
            );
          }

          // No further pages, or the adapter doesn't support cursoring.
          cursor = result?.nextCursor;
          if (!cursor) break;
        }
      } catch (err) {
        log.warn('recoverMissedMessages threw', {
          adapter: adapter.name,
          platformId: logId(platformId),
          err: err instanceof Error ? err.message : String(err),
        });
        return { recoveredCount, earliestTimestamp, alreadyHandledCount };
      }

      return { recoveredCount, earliestTimestamp, alreadyHandledCount };
    },
  };

  // Only expose openDM when the underlying Chat SDK adapter implements it.
  // Delegate straight to adapter.openDM rather than going through chat.openDM:
  // the latter dispatches via inferAdapterFromUserId, which only recognizes
  // Discord snowflakes, Slack U-ids, Teams 29:-ids, and gChat users/-ids, and
  // throws for everything else (Telegram numeric ids, iMessage, Matrix, …).
  // Calling adapter.openDM directly also preserves the adapter's native
  // platform_id encoding via channelIdFromThreadId (e.g. "telegram:<chatId>"),
  // which matches what onInbound stores in messaging_groups — avoiding a
  // duplicate-row / decode-error cascade at delivery time. See user-dm.ts for
  // the direct-addressable fallback when the adapter has no openDM at all.
  if (adapter.openDM) {
    bridge.openDM = async (userHandle: string): Promise<string> => {
      const threadId = await adapter.openDM!(userHandle);
      return adapter.channelIdFromThreadId(threadId);
    };
  }

  return bridge;
}

/**
 * Trailing debounce for poll vote bursts. A flurry of votes (poll just
 * posted, everyone answering at once) collapses into one refresh 30s after
 * the last vote, instead of one REST fetch + one context row per click.
 */
const POLL_UPDATE_DEBOUNCE_MS = 30_000;

export interface PollVoteDebouncer {
  onVote(vote: PollVoteEvent): void;
  clear(): void;
}

/**
 * Parse a forwarded MESSAGE_POLL_VOTE_ADD / MESSAGE_POLL_VOTE_REMOVE gateway
 * payload. Returns null when the payload is missing the fields we need or
 * the event type isn't a poll vote.
 */
export function parsePollVoteGatewayEvent(type: string, data: Record<string, unknown>): PollVoteEvent | null {
  const added = type === 'GATEWAY_MESSAGE_POLL_VOTE_ADD';
  if (!added && type !== 'GATEWAY_MESSAGE_POLL_VOTE_REMOVE') return null;
  if (typeof data.channel_id !== 'string' || typeof data.message_id !== 'string') return null;
  return {
    guildId: typeof data.guild_id === 'string' ? data.guild_id : undefined,
    channelId: data.channel_id,
    messageId: data.message_id,
    userId: typeof data.user_id === 'string' ? data.user_id : '',
    answerId: typeof data.answer_id === 'number' ? data.answer_id : undefined,
    added,
  };
}

/** FNV-1a over the rendered text — stable id component for state-identical re-renders. */
export function pollVoteContentHash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * Build the synthetic inbound row for a refreshed poll state.
 *
 * - The id is content-addressed (`<pollMsgId>:pollupdate:<hash(text)>`): the
 *   session DB inserts with ON CONFLICT(id) DO NOTHING, so re-rendering an
 *   unchanged poll (vote added then removed, host restart replay) silently
 *   dedupes instead of stacking identical context rows. There is no
 *   inbound-edit path — each state change is a NEW row by design.
 * - `isBackfill: true` is the router contract for accumulate-only: store with
 *   trigger=0, never run engagement. A vote is ambient context, not a wake.
 * - The thread id mirrors the Discord adapter's `encodeThreadId` guild form
 *   (`<adapter>:<guildId>:<channelId>`). Polls inside a Discord thread will
 *   address the thread id in the channel slot — accepted: the REST fetch
 *   works either way and threaded polls are rare.
 */
export function pollUpdateInbound(
  adapterName: string,
  vote: PollVoteEvent,
  update: PollUpdateContent,
  timestamp: string,
): { channelThreadId: string; inbound: InboundMessage } {
  const channelThreadId = `${adapterName}:${vote.guildId}:${vote.channelId}`;
  return {
    channelThreadId,
    inbound: {
      id: `${vote.messageId}:pollupdate:${pollVoteContentHash(update.text)}`,
      kind: 'chat-sdk',
      content: {
        text: update.text,
        sender: update.sender,
        senderName: update.sender,
        senderId: update.senderId,
      },
      timestamp,
      isMention: false,
      isGroup: true,
      isBackfill: true,
    },
  };
}

/**
 * Per-poll trailing debounce. Guild polls only — DM vote events have no
 * guild_id (and would need the DirectMessagePolls intent anyway). The flush
 * callback re-fetches current state, so only the LATEST vote event per poll
 * is kept. Flush errors are contained here: a failed REST fetch must never
 * become an unhandled rejection inside the webhook server.
 */
export function createPollVoteDebouncer(
  delayMs: number,
  flush: (vote: PollVoteEvent) => Promise<void>,
): PollVoteDebouncer {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  return {
    onVote(vote: PollVoteEvent) {
      if (!vote.guildId) return;
      const key = `${vote.channelId}:${vote.messageId}`;
      const existing = timers.get(key);
      if (existing) clearTimeout(existing);
      timers.set(
        key,
        setTimeout(() => {
          timers.delete(key);
          flush(vote).catch((err) => {
            log.warn('Poll update flush failed', {
              messageId: vote.messageId,
              err: err instanceof Error ? err.message : String(err),
            });
          });
        }, delayMs),
      );
    },
    clear() {
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
    },
  };
}

/**
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 *
 * Loopback is not a trust boundary, so only our own Gateway listener may post
 * here: it sends the bot token in x-discord-gateway-token on every forward.
 */
function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
  pollVotes?: PollVoteDebouncer,
  onGatewayEvent?: (type: string) => void,
): Promise<string> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (!gatewayTokenMatches(req.headers['x-discord-gateway-token'], botToken)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end('{"error":"unauthorized"}');
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        const body = Buffer.concat(chunks).toString();
        handleForwardedEvent(body, adapter, setupConfig, botToken, pollVotes, onGatewayEvent)
          .then(() => {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end('{"ok":true}');
          })
          .catch((err) => {
            log.error('Webhook server error', { err });
            res.writeHead(500);
            res.end('{"error":"internal"}');
          });
      });
    });

    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/webhook`;
      log.info('Local webhook server started', { port: addr.port });
      resolve(url);
    });
  });
}

/** Constant-time check; hashing first keeps the lengths equal. No token configured means no match. */
function gatewayTokenMatches(header: string | string[] | undefined, botToken: string | undefined): boolean {
  if (!botToken || typeof header !== 'string') return false;
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(header), digest(botToken));
}

async function handleForwardedEvent(
  body: string,
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken?: string,
  pollVotes?: PollVoteDebouncer,
  onGatewayEvent?: (type: string) => void,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  if (typeof event?.type === 'string') {
    try {
      onGatewayEvent?.(event.type);
    } catch (err) {
      log.warn('Gateway event observer threw', { err });
    }
  }

  // Live poll vote events (arrive only when the adapter requests the
  // GuildMessagePolls intent). Consumed here — the adapter's handleWebhook
  // has no handler for them, and the debounce keeps a vote burst from
  // becoming one REST fetch per click.
  if (event.type === 'GATEWAY_MESSAGE_POLL_VOTE_ADD' || event.type === 'GATEWAY_MESSAGE_POLL_VOTE_REMOVE') {
    if (pollVotes && event.data) {
      const vote = parsePollVoteGatewayEvent(event.type, event.data);
      if (vote) pollVotes.onVote(vote);
    }
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string | undefined;
      if (!customId) return;
      const decodedCustomId = decodeDiscordCustomId(customId);
      // In guilds the clicker is at interaction.member.user; in DMs it's interaction.user directly.
      const user =
        ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
        (interaction.user as Record<string, string> | undefined);
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;

      // Parse the selected option from custom_id
      let questionId: string | undefined;
      let tail: string | undefined;
      if (decodedCustomId.actionId.startsWith('ncq:')) {
        const colonIdx = decodedCustomId.actionId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = decodedCustomId.actionId.slice(4, colonIdx);
          tail = decodedCustomId.actionId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds =
        ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      const render = questionId ? await resolveQuestionRender(questionId) : undefined;
      // Discord custom_id mirrors the new index-based encoding (see Button
      // construction). Decode back to the real option value for downstream.
      const selectedOption = resolveSelectedOption(render, decodedCustomId.value, tail);
      if (render?.deferResolution && questionId) {
        await fetch(`https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ type: 6 }),
        });
        setupConfig.onAction(questionId, selectedOption, user?.id || '', {
          messageId: (interaction.message as Record<string, unknown> | undefined)?.id as string | undefined,
          platformId: interaction.channel_id as string | undefined,
        });
        return;
      }
      const cardTitle = render?.title ?? ((originalEmbeds[0]?.title as string) || '❓ Question');
      const matchedOpt = render?.options.find((o) => o.value === selectedOption);
      const selectedLabel = matchedOpt?.selectedLabel ?? selectedOption ?? customId;
      const actorName = user?.global_name || user?.username || '';
      const resolution = actorName ? `${selectedLabel} by ${actorName}` : selectedLabel;
      try {
        const response = await fetch(
          `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              type: 7, // UPDATE_MESSAGE — acknowledge + update in one call
              data: {
                embeds: [
                  {
                    title: cardTitle,
                    description: originalDescription || render?.question || '',
                    footer: { text: resolution },
                  },
                ],
                components: [], // remove buttons
              },
            }),
          },
        );
        // The interaction callback edits Discord directly, bypassing the shared
        // delivery adapter. Observe only an acknowledged update, not a click.
        const messageId = (interaction.message as Record<string, unknown> | undefined)?.id;
        if (response.ok && typeof messageId === 'string' && typeof interaction.channel_id === 'string') {
          emitEngineEvent('channel.outbound_observed', {
            channelType: 'discord',
            platformId: `${adapter.name}:${typeof interaction.guild_id === 'string' ? interaction.guild_id : '@me'}:${interaction.channel_id}`,
            threadId: null,
            messageId,
            operation: 'edit',
            text: [cardTitle, originalDescription || render?.question || '', resolution].filter(Boolean).join('\n\n'),
            ts: new Date().toISOString(),
          });
        }
      } catch (err) {
        log.error('Failed to update interaction', { err });
      }

      // Dispatch to host
      if (questionId && selectedOption) {
        setupConfig.onAction(questionId, selectedOption, user?.id || '', {
          messageId: (interaction.message as Record<string, unknown> | undefined)?.id as string | undefined,
          platformId: interaction.channel_id as string | undefined,
        });
      }
      return;
    }
  }

  // Forward other events to the adapter's webhook handler for normal processing
  const fakeRequest = new Request('http://localhost/webhook', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-discord-gateway-token': botToken || '',
    },
    body,
  });
  await adapter.handleWebhook(fakeRequest, {});
}
