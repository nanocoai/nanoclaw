/**
 * Telegram bot-to-bot admission policy ("doorman").
 *
 * With Telegram's Bot-to-Bot Communication Mode enabled in BotFather, other
 * bots' group messages reach the gateway and engage like human mentions — the
 * Chat SDK skips only self-messages (author.isMe), never other bots. This
 * policy, registered as THE bridge inbound policy for channelType 'telegram',
 * gates bot-authored messages (content.author.isBot === true) down to:
 *
 *   - an explicitly allowlisted chat+topic pair (TELEGRAM_BOT_INBOUND, parsed
 *     as comma-separated `chatId:topic`; chat ids stay strings, topics are
 *     integers), AND
 *   - an addressed message: a platform-confirmed mention (isMention, which
 *     covers `/command@<botname>`) OR a direct reply to the bot's own message
 *     (replyTo.senderUserId === token-prefix bot id), AND
 *   - a per-peer throttle: at most one admitted turn per peer per minGapMs
    (one chatty peer cannot starve the others).
 *
 * Everything else bot-authored is dropped at the door with one host-side log
 * line (reason: wrong_chat | wrong_topic | not_addressed | throttled) — it
 * never reaches the router, so no approvals, no dropped_messages rows, no
 * container wakes. Human traffic (isBot !== true) passes through untouched:
 * the policy is strictly additive over the existing admission paths.
 *
 * Gate order note: this policy sits at the bridge (upstream of the router),
 * so the router's members/unknown-sender gate runs AFTER it. That ordering is
 * deliberate — an ADMITTED bot message from an unregistered sender still
 * reaches the router and lands in dropped_messages there; the doorman only
 * removes traffic that fails chat/topic/addressing/throttle.
 *
 * TELEGRAM_BOT_INBOUND unset ⇒ no policy is registered at all: behavior is
 * exactly pre-feature (rollback = unset + restart).
 */
import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import { registerBridgeInboundPolicy, type BridgeInboundPolicy } from './chat-sdk-bridge.js';

/** One allowlisted chat (+ optional topic). chatId keeps its string form (negative for groups). */
export interface BotAdmissionEntry {
  chatId: string;
  /** undefined = anywhere in the chat (plain groups have no topic dimension; forum groups admit all topics). */
  topic?: number;
}

/**
 * Parse the TELEGRAM_BOT_INBOUND value: comma-separated `chatId:topic` pairs.
 * Malformed entries are warned about and skipped — one bad pair must not
 * disable the others. Type fidelity: chatId is a string (Telegram group ids
 * are negative), topic is parsed as an integer.
 */
export function parseBotInboundEnv(value: string | undefined): BotAdmissionEntry[] {
  if (value === undefined) return [];
  const entries: BotAdmissionEntry[] = [];
  for (const raw of value.split(',')) {
    const part = raw.trim();
    if (!part) continue;
    const match = /^(-?\d+)(?::(\d+))?$/.exec(part);
    if (!match) {
      log.warn('TELEGRAM_BOT_INBOUND: skipping malformed entry (expected chatId or chatId:topic)', { entry: part });
      continue;
    }
    entries.push({
      chatId: match[1],
      topic: match[2] !== undefined ? Number.parseInt(match[2], 10) : undefined,
    });
  }
  return entries;
}

export interface BotAdmissionOptions {
  allow: BotAdmissionEntry[];
  /**
   * The bot's own platform user id for a bridge instance — the reply-to-me
   * match target. Resolved per instanceKey because named instances carry
   * their own tokens; the token prefix before ':' IS the bot user id.
   */
  botUserIdFor: (instanceKey: string) => string | undefined;
  /**
   * The bot's platform username for a bridge instance — the start-anchored
   * command/mention match target. Resolved async (getMe) once per wrap
   * application.
   */
  botUsernameFor: (instanceKey: string) => Promise<string | undefined>;
  /** Minimum gap between admitted turns per peer. Default 30 s. */
  minGapMs?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

/** Escape a username for literal embedding in the addressing regex. */
function escapeUsername(username: string): string {
  return username.replace(/[.*+?${}()|[\]\\]/g, '\\$&');
}

/**
 * Build THE 'telegram' inbound-policy wrap. Each application (once per bridge
 * instance at setup) gets its own throttle closure — per-bot rate state, not
 * shared across bots. An instance whose bot id or username can't be resolved
 * gets no wrap at all: its bridge only exists when its token exists, so this
 * is defense, not a live path.
 */
export function createTelegramBotAdmissionWrap(options: BotAdmissionOptions): BridgeInboundPolicy {
  const minGapMs = options.minGapMs ?? 30_000;
  const now = options.now ?? Date.now;
  return async (setup, instanceKey) => {
    const [botUserId, botUsername] = await Promise.all([
      Promise.resolve(options.botUserIdFor(instanceKey)),
      options.botUsernameFor(instanceKey),
    ]);
    if (!botUserId || !botUsername) {
      log.warn('Bot admission policy inactive: bot identity unresolved for instance', {
        instance: instanceKey,
        hasUserId: botUserId !== undefined,
        hasUsername: botUsername !== undefined,
      });
      return setup;
    }
    // Addressing is start-anchored: the text must OPEN with /cmd@<this-bot> or
    // @<this-bot> (then whitespace or end). Mid-text quotes — prose or code
    // spans — do not address the bot; that is stricter than the adapter's
    // substring isMention and applies to bot-authored messages only.
    const mentionPattern = new RegExp(
      `^\\s*(?:\\/[a-z0-9_]+@${escapeUsername(botUsername)}|@${escapeUsername(botUsername)})(?:\\s|$)`,
      'i',
    );
    const hostOnInbound = setup.onInbound;
    // Throttle window is per PEER, not per bot: one chatty peer cannot starve
    // the others in a 1-to-many setup.
    const lastAdmitBySender = new Map<string, number>();
    return {
      ...setup,
      onInbound(platformId, threadId, message) {
        const content = message.content;
        if (typeof content !== 'object' || content === null || Array.isArray(content)) {
          return hostOnInbound(platformId, threadId, message);
        }
        const record = content as Record<string, unknown>;
        const author = record.author as { userId?: string; isBot?: boolean | string } | undefined;
        if (author?.isBot !== true) {
          return hostOnInbound(platformId, threadId, message);
        }
        const senderBotId = author.userId ?? null;

        const drop = (reason: string, chatId?: string, topic?: number): void => {
          log.info('Telegram bot inbound dropped', { instance: instanceKey, reason, senderBotId, chatId, topic });
        };

        const parts = typeof threadId === 'string' ? threadId.split(':') : [];
        const chatId = parts.length >= 2 ? parts[1] : undefined;
        const entry = chatId !== undefined ? options.allow.find((e) => e.chatId === chatId) : undefined;
        if (!entry) {
          drop('wrong_chat', chatId);
          return;
        }
        const topicRaw = parts[2];
        const topic = topicRaw !== undefined && topicRaw !== '' ? Number.parseInt(topicRaw, 10) : Number.NaN;
        if (entry.topic !== undefined && (!Number.isFinite(topic) || topic !== entry.topic)) {
          drop('wrong_topic', chatId, topic);
          return;
        }

        const text = typeof record.text === 'string' ? record.text : '';
        const anchored = mentionPattern.test(text);
        const replyTo = record.replyTo as { senderUserId?: string; replyToForumTopicAnchor?: boolean } | undefined;
        // Forum-topic anchors are excluded: plain topic posts carry the anchor
        // service message as reply_to_message, so "replied to my message" only
        // counts when the target is real message content.
        const replyToMe =
          replyTo?.senderUserId !== undefined &&
          replyTo.replyToForumTopicAnchor !== true &&
          replyTo.senderUserId === botUserId;
        if (!anchored && !replyToMe) {
          drop('not_addressed', chatId, topic);
          return;
        }

        const t = now();
        const senderKey = senderBotId ?? '';
        if (t - (lastAdmitBySender.get(senderKey) ?? Number.NEGATIVE_INFINITY) < minGapMs) {
          drop('throttled', chatId, topic);
          return;
        }
        lastAdmitBySender.set(senderKey, t);
        log.info('Telegram bot inbound admitted', { instance: instanceKey, senderBotId, chatId, topic });
        // Every admitted bot message stamps isMention so mention-mode wirings
        // engage downstream with zero router changes.
        return hostOnInbound(platformId, threadId, { ...message, isMention: true });
      },
    };
  };
}

/** Token env key for a bridge instance key ('telegram' or 'telegram-<name>'). */
function tokenEnvKey(instanceKey: string): string {
  if (instanceKey === 'telegram') return 'TELEGRAM_BOT_TOKEN';
  const suffix = instanceKey.slice('telegram-'.length).toUpperCase().replace(/-/g, '_');
  return `TELEGRAM_BOT_TOKEN_${suffix}`;
}

/**
 * Resolve a bot's platform username via getMe. undefined on any failure —
 * callers treat that as "policy inactive" for the instance.
 */
export async function fetchBotUsername(token: string): Promise<string | undefined> {
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const json = (await res.json()) as { ok?: boolean; result?: { username?: string } };
    return json.ok ? (json.result?.username ?? undefined) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Env-driven construction: null unless TELEGRAM_BOT_INBOUND yields at least
 * one well-formed entry. `env` is injected so tests stay hermetic (pass a
 * fake `fetchUsername` — the default hits the real getMe); the production
 * path passes the readEnvFile result (see registerTelegramBotAdmission).
 */
export function buildTelegramBotAdmission(
  env: Record<string, string>,
  fetchUsername: (token: string) => Promise<string | undefined> = fetchBotUsername,
): BridgeInboundPolicy | null {
  const allow = parseBotInboundEnv(env.TELEGRAM_BOT_INBOUND);
  if (allow.length === 0) return null;
  return createTelegramBotAdmissionWrap({
    allow,
    botUserIdFor: (instanceKey) => {
      const token = env[tokenEnvKey(instanceKey)];
      return token ? token.split(':')[0] : undefined;
    },
    botUsernameFor: async (instanceKey) => {
      const token = env[tokenEnvKey(instanceKey)];
      return token ? fetchUsername(token) : undefined;
    },
  });
}

/**
 * Production registration, called from ./telegram.js at module load: register
 * the doorman only when the flag is set. Tokens are read for the default bot
 * plus every TELEGRAM_INSTANCES name so per-instance reply matching resolves
 * without a second file read at setup.
 */
export function registerTelegramBotAdmission(): void {
  const declared = readEnvFile(['TELEGRAM_BOT_INBOUND', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_INSTANCES']);
  const keys = new Set(['TELEGRAM_BOT_INBOUND', 'TELEGRAM_BOT_TOKEN']);
  for (const raw of (declared.TELEGRAM_INSTANCES ?? '').split(',')) {
    const name = raw.trim();
    if (!name) continue;
    keys.add(`TELEGRAM_BOT_TOKEN_${name.toUpperCase().replace(/-/g, '_')}`);
  }
  const policy = buildTelegramBotAdmission(readEnvFile([...keys]));
  if (policy) {
    registerBridgeInboundPolicy('telegram', policy);
  }
}
