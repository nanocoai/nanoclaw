/**
 * Slack bot-authored inbound guard — default drop at the bridge boundary.
 *
 * Where bot-authored messages die upstream: neither `@chat-adapter/slack` nor
 * the Chat SDK core drops a *sibling* bot's messages — the only bot filter in
 * that stack is `author.isMe` (chat core `handleIncomingMessage`, fed by the
 * Slack adapter's `isMessageFromSelf`, keyed on this app's own
 * `bot_id`/`botUserId`). A sibling or foreign bot's message arrives with
 * `bot_id` set, `isMe: false`, `isBot: true`, flows through the bridge into
 * the router, and only then dies at the permissions access gate: its sender
 * resolves to `slack:<bot_id>`, which is never a member, so the messaging
 * group's `unknown_sender_policy` drops it (and, on the default
 * `request_approval` policy, spams an approval card). Two bots wired into the
 * same room can also feed each other into a loop.
 *
 * This guard replaces that implicit downstream drop with an explicit one at
 * the bridge boundary: bot-authored inbound is DROPPED by default, with a
 * debug log — the safe default every Slack install wants. Human-authored
 * messages are never touched.
 *
 * Extension seam: an optional admission policy (`setBotInboundPolicy`) can
 * selectively admit bot traffic under its own rules — e.g. the
 * slack-a2a-rooms skill's allowlist + hop-limit + `slack:bot:<bot_id>`
 * re-attribution. The policy decides *which* bot messages pass and how they
 * are attributed; the guard owns the mechanics (default drop, human
 * pass-through, senderId rewrite, accept accounting). Without a policy,
 * everything bot-authored is dropped.
 *
 * Registration: the guard registers itself for the `slack` channel type via
 * the bridge's inbound-policy seam (`registerBridgeInboundPolicy`) on barrel
 * import, so it applies to every Slack bridge instance — and only to Slack.
 */
import { log } from '../log.js';
import type { ChannelSetup, InboundMessage } from './adapter.js';
import * as chatSdkBridge from './chat-sdk-bridge.js';

// ---------------------------------------------------------------------------
// Bot-author detection
// ---------------------------------------------------------------------------

/**
 * Extract the bot author of a bridge-serialized message, or null for human
 * (or unattributable) messages. Keyed on the Slack event's `bot_id` presence,
 * which the adapter projects to `author.isBot` / `author.userId` — sibling-bot
 * messages arrive as plain `message` events with `bot_id` set and subtype
 * null, so this is the only reliable bot marker.
 */
export function botAuthorOf(message: InboundMessage): { botId: string } | null {
  const content =
    typeof message.content === 'object' && message.content !== null
      ? (message.content as Record<string, unknown>)
      : undefined;
  const author =
    content && typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  if (author?.isBot !== true) return null;
  const botId = typeof author.userId === 'string' ? author.userId : undefined;
  return botId ? { botId } : null;
}

// ---------------------------------------------------------------------------
// Admission-policy seam (feature-side extension point)
// ---------------------------------------------------------------------------

/** Inbound context handed to the admission policy. */
export interface SlackInboundContext {
  /**
   * The bridge's registry key (`config.instance ?? 'slack'`). The wrap runs
   * once per bridge instance, so per-bot-identity policy state keys off this.
   */
  instanceKey: string;
  /** Adapter channel id as the bridge reports it (`slack:C0…`). */
  platformId: string;
  threadId: string | null;
  message: InboundMessage;
}

/** Bot-authored inbound context — adds the authoring bot's id. */
export interface SlackBotInboundContext extends SlackInboundContext {
  /** Slack `bot_id` of the authoring bot (adapter's `author.userId`). */
  botId: string;
}

/** Admission decision for one bot-authored inbound message. */
export type SlackBotInboundDecision =
  | { action: 'drop'; reason?: string }
  | {
      action: 'admit';
      /**
       * When set, replaces `content.senderId` before routing (e.g.
       * `slack:bot:<bot_id>`). The permissions module uses a senderId that
       * already contains a `:` verbatim (see extractAndUpsertUser), so the
       * users row becomes distinguishable from human `slack:U…` ids.
       */
      senderId?: string;
      /**
       * Called only after downstream accepted the message (the host's
       * onInbound resolved without throwing). Use for accept accounting —
       * e.g. a hop budget must not be consumed by a message that never
       * reached a session.
       */
      onAccepted?: () => void;
    };

/**
 * The narrow surface a feature module (e.g. slack-a2a-rooms) implements to
 * selectively admit bot traffic. Humans are structurally outside the policy's
 * power: `onHumanInbound` is observe-only (e.g. to reset hop counters) and
 * cannot drop or mutate — human pass-through is guaranteed by the guard,
 * not by policy good behavior.
 */
export interface SlackBotInboundPolicy {
  /** Decide one bot-authored inbound message. A throw is treated as drop. */
  decideBotInbound(ctx: SlackBotInboundContext): SlackBotInboundDecision;
  /** Observe a human-authored inbound message. Cannot affect delivery. */
  onHumanInbound?(ctx: SlackInboundContext): void;
}

let botInboundPolicy: SlackBotInboundPolicy | null = null;

/**
 * Install THE admission policy for bot-authored Slack inbound (single
 * provider — a second installation overwrites with a warning, mirroring the
 * bridge registry's hook discipline). Pass null to clear and restore the
 * default drop-everything behavior.
 */
export function setBotInboundPolicy(policy: SlackBotInboundPolicy | null): void {
  if (policy && botInboundPolicy) {
    log.warn('slack-a2a-guard: bot inbound policy overwritten');
  }
  botInboundPolicy = policy;
}

// ---------------------------------------------------------------------------
// The ChannelSetup wrap
// ---------------------------------------------------------------------------

/**
 * Wrap a Slack bridge's ChannelSetup so its onInbound applies the bot guard:
 * human-authored messages pass through byte-identical; bot-authored messages
 * are dropped unless the installed admission policy admits them. Shaped as a
 * `BridgeInboundPolicy` — applied once per bridge instance at bridge setup.
 */
export function wrapSlackBotGuard(setup: ChannelSetup, instanceKey: string): ChannelSetup {
  return {
    ...setup,
    async onInbound(platformId: string, threadId: string | null, message: InboundMessage) {
      const bot = botAuthorOf(message);

      if (!bot) {
        // Human message — pass through untouched. The policy may observe it
        // (hop-counter resets), but can neither drop nor mutate it.
        if (botInboundPolicy?.onHumanInbound) {
          try {
            botInboundPolicy.onHumanInbound({ instanceKey, platformId, threadId, message });
          } catch (err) {
            log.warn('slack-a2a-guard: onHumanInbound observer threw — human message unaffected', {
              instanceKey,
              platformId,
              err,
            });
          }
        }
        return setup.onInbound(platformId, threadId, message);
      }

      if (!botInboundPolicy) {
        log.debug('slack-a2a-guard: bot-authored inbound dropped — no admission policy installed', {
          instanceKey,
          platformId,
          botId: bot.botId,
        });
        return;
      }

      let decision: SlackBotInboundDecision;
      try {
        decision = botInboundPolicy.decideBotInbound({ instanceKey, platformId, threadId, message, botId: bot.botId });
      } catch (err) {
        // Fail closed: a buggy policy must not fail open into approval spam.
        log.warn('slack-a2a-guard: admission policy threw — dropping bot-authored inbound', {
          instanceKey,
          platformId,
          botId: bot.botId,
          err,
        });
        return;
      }

      if (decision.action !== 'admit') {
        log.debug('slack-a2a-guard: bot-authored inbound dropped by policy', {
          instanceKey,
          platformId,
          botId: bot.botId,
          reason: decision.reason,
        });
        return;
      }

      if (decision.senderId) {
        (message.content as Record<string, unknown>).senderId = decision.senderId;
      }
      // Report acceptance only after downstream accepted it — a throw in the
      // host's onInbound must not count a message that never reached a session.
      const result = await setup.onInbound(platformId, threadId, message);
      decision.onAccepted?.();
      return result;
    },
  };
}

// ---------------------------------------------------------------------------
// Self-registration (barrel-import side effect)
// ---------------------------------------------------------------------------

type BridgeInboundPolicyRegistrar = (
  channelType: string,
  wrap: (setup: ChannelSetup, instanceKey: string) => ChannelSetup,
) => void;

/**
 * Register the guard as THE bridge inbound policy for the `slack` channel
 * type. Non-Slack bridges are untouched — the bridge applies a policy only to
 * the channel type it was registered for.
 */
export function registerSlackBotGuard(register: BridgeInboundPolicyRegistrar): void {
  register('slack', wrapSlackBotGuard);
}

// Registers on import through the bridge's inbound-policy seam (on this
// branch since the main sync).
registerSlackBotGuard(chatSdkBridge.registerBridgeInboundPolicy);
