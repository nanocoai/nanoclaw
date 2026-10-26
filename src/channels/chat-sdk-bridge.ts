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
  type CardChild,
  type CardElement,
  type Adapter,
  type AssistantContextChangedEvent,
  type AssistantThreadStartedEvent,
  type ConcurrencyStrategy,
  type Message as ChatMessage,
} from 'chat';
import { log } from '../log.js';
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
      log.warn('Agent-DM opened handler failed', { channelId: event.channelId, err }),
    );
  } catch (err) {
    log.warn('Agent-DM opened handler threw', { channelId: event.channelId, err });
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

/** Extract reply context from a platform-specific raw message. Return null if no reply. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ReplyContextExtractor = (raw: Record<string, any>) => ReplyContext | null;

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
        channelId: event.channelId,
        userId: event.userId,
        err,
      }),
    );
  } catch (err) {
    log.error('Membership handler threw', {
      channelType: event.channelType,
      channelId: event.channelId,
      userId: event.userId,
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
  /** Platform-specific reply context extraction. */
  extractReplyContext?: ReplyContextExtractor;
  /**
   * Recover readable content the platform adapter left only in `message.raw`.
   * The returned text is appended to the message body and persisted; the raw
   * provider payload is still dropped.
   */
  extractRawText?: RawTextExtractor;
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
   * title plus card text (after escapeCardText) it shows in full. Shorthand
   * for cardFits; a longer card overflows the same way.
   */
  maxCardTextLength?: number;
  /**
   * Whether the platform shows this exact card with nothing cut or rejected.
   * An ask_question card that doesn't fit posts its full text first as
   * button-less cards, then a short card with the buttons; if any part can't
   * fit, nothing posts (CardTooLongError). A resolved card that doesn't fit
   * keeps less text. Unset, every card fits.
   */
  cardFits?: (card: CardElement) => boolean;
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

interface PlannedCard {
  card: CardElement;
  fallbackText: string;
}

interface QuestionCardPlan {
  /** Button-less cards posted first when the whole card doesn't fit. */
  parts: PlannedCard[];
  /** The card with the buttons, and its title and text for the fallback. */
  card: CardElement;
  title: string;
  text: string;
}

/** Title for the button card when the request's own title doesn't fit it. */
const OVERFLOW_TITLE = 'Approval request';
/** Smallest text block an overflow split goes down to before giving up. */
const MIN_OVERFLOW_BLOCK = 250;
/** Each part is a message: more risks chat rate limits and is too long to review in a chat. */
const MAX_OVERFLOW_PARTS = 5;
const overflowNotice = (ref: string, parts: number) =>
  `The full request is in the ${parts === 1 ? 'message' : `${parts} messages`} marked ref ${ref} above.`;
const stoppedNotice = (ref: string, posted: number, parts: number) =>
  `Request ref ${ref} stopped after part ${posted} of ${parts}. It can't be answered until all its parts and buttons arrive.`;
/** How long a partly posted overflow card waits for a retry to resume it. */
const OVERFLOW_RESUME_MS = 60 * 60_000;
/** How long a failed delivery waits for its stopped note before reporting the failure. */
const STOPPED_NOTE_WAIT_MS = 5_000;

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
      // A cut mid-line before backticks would turn them into a fence line.
      const badCut = (n: number) =>
        isHighSurrogate(rest.charCodeAt(n - 1)) ||
        (rest[n - 1] === '`' && rest[n] === '`') ||
        (rest[n - 1] !== '\n' && /^ {0,3}```/.test(rest.slice(n, n + 6)));
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

/** The longest start of `raw`, ending in "…", that `ok` accepts; never splits a surrogate pair. */
function longestStart(raw: string, ok: (shortened: string) => boolean): string {
  const shortened = (n: number) => `${raw.slice(0, n > 0 && isHighSurrogate(raw.charCodeAt(n - 1)) ? n - 1 : n)}…`;
  let lo = 0;
  let hi = raw.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ok(shortened(mid))) lo = mid;
    else hi = mid - 1;
  }
  return shortened(lo);
}

export function splitForLimit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > limit) {
    let cut = remaining.lastIndexOf('\n\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf('\n', limit);
    if (cut <= 0) cut = remaining.lastIndexOf(' ', limit);
    if (cut <= 0) cut = limit;
    chunks.push(remaining.slice(0, cut).trimEnd());
    remaining = remaining.slice(cut).trimStart();
  }
  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
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
  const cardTextsOf = (card: CardElement): string[] =>
    card.children.flatMap((child) => (child.type === 'text' ? [child.content] : []));
  const fits = (card: CardElement): boolean =>
    (config.maxCardTextLength === undefined ||
      !cardQuestionTooLong(card.title ?? '', cardTextsOf(card).join('\n'), config.maxCardTextLength)) &&
    (config.cardFits?.(card) ?? true);
  const partLabel = (ref: string, i: number, n: number) => cardText(`Request ref ${ref}, part ${i} of ${n}`);
  const textCard = (title: string, blocks: string[]) =>
    Card({ ...(title ? { title } : {}), children: blocks.map((block) => CardText(block)) });

  /**
   * How an ask_question card goes out: whole when it fits; otherwise its full
   * text as button-less parts, then a short card with the buttons. Every part
   * is checked before anything posts, so buttons never sit next to cut text,
   * and every part is labelled so concurrent requests can't be mixed up.
   */
  function planQuestionCard(
    questionId: string,
    title: string,
    question: string,
    actions: CardChild,
    escape: (t: string) => string = cardText,
  ): QuestionCardPlan {
    const withButtons = (t: string, blocks: string[]) =>
      Card({ title: t, children: [...blocks.map((block) => CardText(block)), actions] });
    const whole = withButtons(title, splitCardText(question, escape, CARD_TEXT_BLOCK_LENGTH));
    if (fits(whole)) return { parts: [], card: whole, title, text: escape(question) };
    // A title too long for a part moves into the text, under a fixed title.
    const widest = partLabel(questionId, MAX_OVERFLOW_PARTS, MAX_OVERFLOW_PARTS);
    const partTitle = fits(textCard(title, [widest])) ? title : OVERFLOW_TITLE;
    const body = partTitle === title ? question : `${title}\n\n${question}`;
    for (let limit = CARD_TEXT_BLOCK_LENGTH; limit >= MIN_OVERFLOW_BLOCK; limit = Math.floor(limit / 2)) {
      const blocks = splitIfPossible(body, escape, limit);
      const parts = blocks && packParts(partTitle, questionId, blocks);
      if (!parts) continue;
      const notice = [cardText(overflowNotice(questionId, parts.length))];
      const cardTitle = [title, OVERFLOW_TITLE].find((t) => fits(withButtons(t, notice)));
      if (cardTitle === undefined) throw new CardTooLongError('the approval card does not fit this channel');
      return { parts, card: withButtons(cardTitle, notice), title: cardTitle, text: notice.join('\n') };
    }
    throw new CardTooLongError('the request is too long to show in full on this channel');
  }

  /** A split that can't be made at this size yields nothing, so a smaller size is tried next. */
  function splitIfPossible(text: string, escape: (t: string) => string, limit: number): string[] | undefined {
    try {
      return splitCardText(text, escape, limit);
    } catch (err) {
      if (err instanceof CardTooLongError) return undefined;
      throw err;
    }
  }

  /**
   * Greedily packs blocks into button-less cards that each fit, labelled with
   * the whole question id (unique per request), or undefined.
   */
  function packParts(title: string, ref: string, blocks: string[]): PlannedCard[] | undefined {
    const widest = partLabel(ref, MAX_OVERFLOW_PARTS, MAX_OVERFLOW_PARTS);
    const parts = [{ title, blocks: [] as string[] }];
    if (!fits(textCard(title, [widest]))) return undefined;
    for (const block of blocks) {
      const current = parts[parts.length - 1];
      if (fits(textCard(current.title, [widest, ...current.blocks, block]))) {
        current.blocks.push(block);
      } else if (fits(textCard('', [widest, block]))) {
        parts.push({ title: '', blocks: [block] });
      } else {
        return undefined;
      }
    }
    if (parts.length > MAX_OVERFLOW_PARTS) return undefined;
    const labelled = parts.map((part, i) => {
      const texts = [partLabel(ref, i + 1, parts.length), ...part.blocks];
      return { card: textCard(part.title, texts), fallbackText: [part.title, ...texts].filter(Boolean).join('\n\n') };
    });
    return labelled.every((part) => fits(part.card)) ? labelled : undefined;
  }

  /**
   * Overflow progress per question: parts already posted, so a retry resumes
   * instead of reposting, and the button card's id once delivered, so a repeat
   * of the same request doesn't post it again. Deliveries of one question run
   * one at a time.
   */
  const overflowProgress = new Map<
    string,
    { key: string; posted: number; noted: boolean; at: number; deliveredId?: string | null }
  >();
  const overflowRuns = new Map<string, Promise<unknown>>();

  async function postQuestionCard(tid: string, questionId: string, plan: QuestionCardPlan, fallbackText: string) {
    const previous = overflowRuns.get(questionId) ?? Promise.resolve();
    const run = previous
      .catch(() => undefined)
      .then(() =>
        plan.parts.length
          ? postOverflowOnce(tid, questionId, plan, fallbackText)
          : postWholeCard(tid, questionId, plan, fallbackText),
      );
    overflowRuns.set(questionId, run);
    try {
      return await run;
    } finally {
      if (overflowRuns.get(questionId) === run) overflowRuns.delete(questionId);
    }
  }

  async function postWholeCard(tid: string, questionId: string, plan: QuestionCardPlan, fallbackText: string) {
    const result = await adapter.postMessage(tid, { card: plan.card, fallbackText });
    overflowProgress.delete(questionId);
    return result?.id;
  }

  /**
   * Posts an overflowed card's parts, then its buttons. When posting stops
   * partway, one short note (postMessage, which every adapter has; edits and
   * deletes are not universal) says the request can't be answered yet.
   */
  async function postOverflowOnce(tid: string, questionId: string, plan: QuestionCardPlan, fallbackText: string) {
    // The exact cards: text, button ids, labels and styles.
    const key = createHash('sha256')
      .update(JSON.stringify([tid, plan.parts, plan.card, fallbackText]))
      .digest('hex');
    const now = Date.now();
    for (const [id, entry] of overflowProgress) {
      if (id !== questionId && !overflowRuns.has(id) && now - entry.at > OVERFLOW_RESUME_MS)
        overflowProgress.delete(id);
    }
    const saved = overflowProgress.get(questionId);
    if (saved?.key === key && saved.deliveredId !== undefined) return saved.deliveredId ?? undefined;
    const progress = saved?.key === key ? saved : { key, posted: 0, noted: false, at: now };
    progress.at = now;
    overflowProgress.set(questionId, progress);
    try {
      for (; progress.posted < plan.parts.length; progress.posted++) {
        await adapter.postMessage(tid, plan.parts[progress.posted]);
      }
      const result = await adapter.postMessage(tid, { card: plan.card, fallbackText });
      progress.deliveredId = result?.id ?? null;
      progress.at = Date.now();
      return result?.id;
    } catch (err) {
      if (progress.posted > 0 && !progress.noted) {
        const note = cardText(stoppedNotice(questionId, progress.posted, plan.parts.length));
        const card = textCard('', [note]);
        if (fits(card)) {
          // A stalled note must not hold back the failure (a gateway denies on it).
          let timer: NodeJS.Timeout | undefined;
          await Promise.race([
            adapter.postMessage(tid, { card, fallbackText: note }).then(
              () => (progress.noted = true),
              (noteErr: unknown) => log.warn('Failed to post a stopped-card note', { questionId, err: noteErr }),
            ),
            new Promise<void>((resolve) => {
              timer = setTimeout(resolve, STOPPED_NOTE_WAIT_MS);
              timer.unref?.();
            }),
          ]);
          clearTimeout(timer);
        }
      }
      throw err;
    }
  }

  // The resolved card replaces the buttons: the full request when it fits,
  // else the request ref (its overflow parts carry it) and the resolution.
  /** The longest start of a resolution, escaped and ending in "…", that `ok` accepts. */
  /** Every clicked card resolves the same way, on every channel: escaped and within its limits. */
  const editClickedCard = (
    threadId: string,
    messageId: string,
    questionId: string | undefined,
    clicked: { title: string; question: string; selectedLabel: string; actorName: string },
  ) =>
    adapter.editMessage(
      threadId,
      messageId,
      terminalMessage(
        { title: clicked.title, question: clicked.question, resolution: clicked.selectedLabel },
        questionId,
        clicked.actorName ? ` by ${clicked.actorName}` : '',
      ),
    );

  /**
   * `tail` (who decided) is kept whole whenever the resolution must be
   * shortened; only the start before it is cut.
   */
  const terminalMessage = (spec: TerminalApprovalCard, questionId?: string, tail = '') => {
    const shortened = (ok: (resolution: string) => boolean) =>
      cardText(`${longestStart(spec.resolution, (start) => ok(cardText(`${start}${tail}`)))}${tail}`);
    // One text block; a longer resolution keeps its start (the decision) and its tail.
    const withinBlock = (r: string) => r.length <= CARD_TEXT_BLOCK_LENGTH;
    const escaped = cardText(`${spec.resolution}${tail}`);
    const resolution = withinBlock(escaped) ? escaped : shortened(withinBlock);
    const full: TerminalApprovalCard = {
      ...spec,
      question: cardText(spec.question),
      questionBlocks: spec.question ? splitCardText(spec.question, cardText, CARD_TEXT_BLOCK_LENGTH) : undefined,
      resolution,
    };
    if (fits(buildTerminalApprovalCard(full))) return terminalApprovalMessage(full);
    const titles = [spec.title, OVERFLOW_TITLE, ''];
    const card = (title: string, blocks: string[]): TerminalApprovalCard => ({
      title,
      question: blocks.join('\n'),
      questionBlocks: blocks,
      resolution,
    });
    const firstFit = (cards: TerminalApprovalCard[]) => cards.find((c) => fits(buildTerminalApprovalCard(c)));
    // A request posted in parts above: point to them.
    if (questionId !== undefined && overflowProgress.get(questionId)?.deliveredId !== undefined) {
      const ref = firstFit(titles.map((title) => card(title, [cardText(`Request ref ${questionId}`)])));
      if (ref) return terminalApprovalMessage(ref);
    }
    // Otherwise the full request under a shorter title, then its start marked as cut (the card is resolved).
    const fullFit = firstFit(titles.map((title) => card(title, full.questionBlocks ?? [])));
    if (fullFit) return terminalApprovalMessage(fullFit);
    const blocksOf = (text: string) => splitIfPossible(text, cardText, CARD_TEXT_BLOCK_LENGTH) ?? [];
    for (const title of spec.question ? titles : []) {
      const fitsWith = (shortened: string) => fits(buildTerminalApprovalCard(card(title, blocksOf(shortened))));
      if (fitsWith('…')) return terminalApprovalMessage(card(title, blocksOf(longestStart(spec.question, fitsWith))));
    }
    const alone = firstFit(titles.map((title) => card(title, [])));
    if (alone) return terminalApprovalMessage(alone);
    // Nothing else fits: keep the start of the resolution, and its tail.
    const last = shortened(
      (r) =>
        withinBlock(r) &&
        fits(buildTerminalApprovalCard({ title: '', question: '', questionBlocks: [], resolution: r })),
    );
    return terminalApprovalMessage({ title: '', question: '', questionBlocks: [], resolution: last });
  };
  /** Registry/routing key for this bridge — also the app-context cache
   *  namespace. Default instances key by the platform name. */
  const instanceKey = config.instance ?? adapter.name;
  let chat: Chat;
  let state: SqliteStateAdapter;
  let setupConfig: ChannelSetup;
  let gatewayAbort: AbortController | null = null;

  async function messageToInbound(
    message: ChatMessage,
    isMention: boolean,
    isGroup?: boolean,
  ): Promise<InboundMessage> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const serialized = message.toJSON() as Record<string, any>;

    // Download attachment data before serialization loses fetchData()
    if (message.attachments && message.attachments.length > 0) {
      const enriched = [];
      for (const att of message.attachments) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const entry: Record<string, any> = {
          type: att.type,
          name: att.name,
          mimeType: att.mimeType,
          size: att.size,
          width: (att as unknown as Record<string, unknown>).width,
          height: (att as unknown as Record<string, unknown>).height,
        };
        if (att.fetchData) {
          try {
            entry.data = attachmentBytesToBase64(await att.fetchData());
          } catch (err) {
            log.warn('Failed to download attachment', { type: att.type, err });
          }
        }
        enriched.push(entry);
      }
      serialized.attachments = enriched;
    }

    // Recover platform content the Chat SDK omitted, while raw is still here.
    if (message.raw) {
      appendRawText(serialized, message.raw as Record<string, unknown>, config.extractRawText);
    }

    // Extract reply context via platform-specific hook
    if (config.extractReplyContext && message.raw) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const replyTo = config.extractReplyContext(message.raw as Record<string, any>);
      if (replyTo) serialized.replyTo = replyTo;
    }

    // Project chat-sdk's nested author into the flat sender fields the router
    // expects (see src/router.ts extractAndUpsertUser). Native adapters already
    // populate these directly; this brings chat-sdk adapters in line.
    const author = serialized.author as { userId?: string; fullName?: string; userName?: string } | undefined;
    if (author) {
      const name = author.fullName ?? author.userName;
      serialized.senderId = author.userId;
      serialized.sender = name;
      serialized.senderName = name;
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
    };
  }

  const bridge: ChannelAdapter = {
    name: config.instance ?? adapter.name,
    channelType: adapter.name, // unchanged — semantic platform key
    instance: config.instance, // undefined ⇒ default instance

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
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(
          channelId,
          thread.id,
          await messageToInbound(message, message.isMention === true, true),
        );
      });

      // @mention in an unsubscribed thread — SDK-confirmed bot mention.
      chat.onNewMention(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, true, true));
      });

      // DMs — by definition addressed to the bot. Thread id flows through
      // unmodified (Slack users can open sub-threads inside a DM); whether it
      // is honored is policy, not transport: the channel's declared
      // dm.threads default (ChannelDefaults) or a per-wiring threads override
      // decides at router fanout whether replies land in-thread or all DM
      // sub-threads collapse into the one DM session.
      chat.onDirectMessage(async (thread, message) => {
        const channelId = adapter.channelIdFromThreadId(thread.id);
        log.info('Inbound DM received', {
          adapter: adapter.name,
          channelId,
          sender: (message.author as any)?.fullName ?? (message.author as any)?.userId ?? 'unknown',
          threadId: thread.id,
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
        await setupConfig.onInbound(channelId, dmThreadId, inbound);
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
        const channelId = adapter.channelIdFromThreadId(thread.id);
        await setupConfig.onInbound(channelId, thread.id, await messageToInbound(message, false, true));
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
        // No render: already resolved (a late or repeated click), or a pending row
        // without stored render metadata. The host decides; the card stays as it is.
        if (!render || render.deferResolution) {
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
        try {
          await editClickedCard(event.threadId, event.messageId, questionId, {
            title,
            question: render?.question ?? '',
            selectedLabel,
            actorName,
          });
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

        // Start local HTTP server to receive forwarded Gateway events (including interactions)
        const webhookUrl = await startLocalWebhookServer(gatewayAdapter, setupConfig, config.botToken, editClickedCard);

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
            terminalMessage(
              terminalCard as TerminalApprovalCard,
              typeof content.questionId === 'string' ? content.questionId : undefined,
            ),
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
        // per-block cap cuts it. A card the channel can't show whole posts its
        // text first and the buttons after (planQuestionCard). Questions an
        // agent asks itself keep their own markup (`fromAgent`).
        const escape = content.fromAgent === true ? (t: string) => t : cardText;
        const options: NormalizedOption[] = normalizeOptions(content.options as never);
        const actions = Actions(
          // Encode button id/value with the option index rather than the
          // full value. Telegram caps callback_data at 64 bytes, and
          // long values (e.g. ISO datetimes, URLs) push the JSON payload
          // well past that. The onAction handlers resolve the index back
          // to the real value via resolveQuestionRender(questionId).
          options.map((opt, idx) =>
            Button({ id: `ncq:${questionId}:${idx}`, label: opt.label, value: String(idx), style: opt.style }),
          ),
        );
        const plan = planQuestionCard(questionId, title, question, actions, escape);
        const fallbackText = `${plan.title}\n\n${plan.text}\nOptions: ${options.map((o) => o.label).join(', ')}`;
        return await postQuestionCard(tid, questionId, plan, fallbackText);
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
          const result = await adapter.postMessage(
            tid,
            attachFiles ? { markdown: chunk, files: fileUploads } : { markdown: chunk },
          );
          if (i === 0) firstId = result?.id;
        }
        return firstId;
      } else if (message.files && message.files.length > 0) {
        // Files only, no text
        const fileUploads = message.files.map((f: { data: Buffer; filename: string }) => ({
          data: f.data,
          filename: f.filename,
        }));
        const result = await adapter.postMessage(tid, { markdown: '', files: fileUploads });
        return result?.id;
      }
    },

    async setTyping(platformId: string, threadId: string | null) {
      const tid = threadId ?? platformId;
      await adapter.startTyping(tid);
    },

    async teardown() {
      gatewayAbort?.abort();
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
 * Start a local HTTP server to receive forwarded Gateway events.
 * This is needed because the Gateway listener in webhook-forwarding mode
 * sends ALL raw events (including INTERACTION_CREATE for button clicks)
 * to the webhookUrl, which we handle here.
 *
 * Loopback is not a trust boundary, so only our own Gateway listener may post
 * here: it sends the bot token in x-discord-gateway-token on every forward.
 */
type EditClickedCard = (
  threadId: string,
  messageId: string,
  questionId: string | undefined,
  clicked: { title: string; question: string; selectedLabel: string; actorName: string },
) => Promise<unknown>;

function startLocalWebhookServer(
  adapter: GatewayAdapter,
  setupConfig: ChannelSetup,
  botToken: string | undefined,
  editClickedCard: EditClickedCard,
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
        handleForwardedEvent(body, adapter, setupConfig, botToken, editClickedCard)
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
  botToken: string | undefined,
  editClickedCard: EditClickedCard,
): Promise<void> {
  let event: { type: string; data: Record<string, unknown> };
  try {
    event = JSON.parse(body);
  } catch {
    return;
  }

  // Handle interaction events (button clicks) — not handled by adapter's handleForwardedGatewayEvent
  if (event.type === 'GATEWAY_INTERACTION_CREATE' && event.data) {
    const interaction = event.data;
    // type 3 = MessageComponent (button/select)
    if (interaction.type === 3) {
      const customId = (interaction.data as Record<string, unknown>)?.custom_id as string;
      // In guilds the clicker is at interaction.member.user; in DMs it's interaction.user directly.
      const user =
        ((interaction.member as Record<string, unknown>)?.user as Record<string, string> | undefined) ??
        (interaction.user as Record<string, string> | undefined);
      const interactionId = interaction.id as string;
      const interactionToken = interaction.token as string;
      /** Answers within Discord's 3 s; a failed ack must never drop the decision dispatched after it. */
      const ack = async (response: Record<string, unknown>) => {
        try {
          const result = await fetch(
            `https://discord.com/api/v10/interactions/${interactionId}/${interactionToken}/callback`,
            { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response) },
          );
          if (!result.ok) log.error('Failed to acknowledge interaction', { status: result.status });
          // eslint-disable-next-line no-catch-all/no-catch-all -- the decision is dispatched either way
        } catch (err) {
          log.error('Failed to acknowledge interaction', { err });
        }
      };

      // Parse the selected option from custom_id. The adapter writes
      // `${buttonId}\n${value}` (Chat SDK 4.41+); older cards carry the id alone.
      const delimiter = customId?.indexOf('\n') ?? -1;
      const actionId = delimiter === -1 ? customId : customId.slice(0, delimiter);
      const encodedValue = delimiter === -1 ? undefined : customId.slice(delimiter + 1);
      let questionId: string | undefined;
      let tail: string | undefined;
      if (actionId?.startsWith('ncq:')) {
        const colonIdx = actionId.indexOf(':', 4); // after "ncq:"
        if (colonIdx !== -1) {
          questionId = actionId.slice(4, colonIdx);
          tail = actionId.slice(colonIdx + 1);
        }
      }

      // Update the card to show the selected answer and remove buttons
      const originalEmbeds =
        ((interaction.message as Record<string, unknown>)?.embeds as Array<Record<string, unknown>>) || [];
      const originalDescription = (originalEmbeds[0]?.description as string) || '';
      const render = questionId ? await resolveQuestionRender(questionId) : undefined;
      // Discord custom_id mirrors the new index-based encoding (see Button
      // construction). Decode back to the real option value for downstream.
      const selectedOption = resolveSelectedOption(render, encodedValue ?? tail, tail);
      if (!questionId || !render) {
        // Not one of our questions, already resolved (a late, repeated or
        // re-delivered click), or a pending row without stored render metadata:
        // ack, let the host decide, and leave the card as it is.
        await ack({ type: 6 });
        if (questionId && selectedOption) {
          setupConfig.onAction(questionId, selectedOption, user?.id || '', {
            messageId: (interaction.message as Record<string, unknown> | undefined)?.id as string | undefined,
            platformId: interaction.channel_id as string | undefined,
          });
        }
        return;
      }
      if (render?.deferResolution && questionId) {
        await ack({ type: 6 });
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
      const messageId = (interaction.message as Record<string, unknown> | undefined)?.id as string | undefined;
      // Ack and remove the buttons in the same call (UPDATE_MESSAGE with components
      // only: the embed stays, so no length limit can reject it), before the decision.
      await ack({ type: 7, data: { components: [] } });

      // Record the decision before any card update, which can fail or stall.
      // An empty value counts when it is a real option's value.
      if (questionId && (selectedOption || render?.options.some((option) => option.value === selectedOption))) {
        setupConfig.onAction(questionId, selectedOption, user?.id || '', {
          messageId,
          platformId: interaction.channel_id as string | undefined,
        });
      }

      // Then the card text, in the background so a stalled update can't hold
      // this event: edited like every resolved card, escaped and within the limits.
      if (messageId) {
        void (async () => {
          try {
            const threadId = adapter.encodeThreadId({
              guildId: (interaction.guild_id as string | undefined) || '@me',
              channelId: interaction.channel_id as string,
            });
            await editClickedCard(threadId, messageId, questionId, {
              title: cardTitle,
              question: render?.question ?? originalDescription,
              selectedLabel,
              actorName,
            });
          } catch (err) {
            log.error('Failed to update interaction', { err });
          }
        })();
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
