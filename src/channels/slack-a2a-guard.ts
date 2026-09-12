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
 * Extension seam: admission policies (`addBotInboundPolicy`) can selectively
 * admit bot traffic under their own rules — e.g. the slack-a2a-rooms skill's
 * allowlist + hop-limit + `slack:bot:<bot_id>` re-attribution, or a coding
 * session's surface admitting its fellow members. Policies form a chain in
 * registration order and each answers one of three ways: `admit` (final),
 * `deny` (final — the chain stops, nothing later can re-admit) or `pass`
 * (not this policy's conversation; the next one is asked). A message every
 * policy passes on is dropped. A policy decides *which* bot messages pass
 * and how they are attributed; the guard owns the mechanics (default drop,
 * human pass-through, senderId rewrite, accept accounting). Without any
 * policy, everything bot-authored is dropped. `setBotInboundPolicy` remains
 * as the single-slot form of the same seam for policies written against it;
 * their `drop` answer is a pass.
 *
 * One narrow widening: a platform can deliver an app's system notice (a
 * "view added" line the channel's manager app posts) WITHOUT a `bot_id`, so
 * it looks human to `botAuthorOf`. A policy that knows a conversation may
 * name such a message a notice (`noticeOf`) and the guard drops it before it
 * becomes mail. The human guarantee therefore reads: a non-bot-authored
 * message always reaches the host, except one from a user the service names
 * as a bot in a coding session's surface channel. A policy that throws there
 * names nothing, so a human message is never lost to a policy bug.
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

/**
 * Admission decision for one bot-authored inbound message. `pass` (and its
 * older spelling `drop`) means "not mine — ask the next policy"; `deny` is
 * final and no later policy is asked; `admit` is final too.
 */
export type SlackBotInboundDecision =
  | { action: 'pass' | 'drop'; reason?: string }
  | { action: 'deny'; reason?: string }
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
      /**
       * Called when downstream threw (the message never reached a session),
       * so a budget reserved at admit time can be released.
       */
      onFailed?: () => void;
    };

/** A non-bot-authored message a policy recognises as a platform or app notice, not a person. */
export interface SlackInboundNotice {
  reason: string;
}

/**
 * The narrow surface a feature module (e.g. slack-a2a-rooms) implements to
 * selectively admit bot traffic. Humans are structurally outside the policy's
 * power: `onHumanInbound` is observe-only (e.g. to reset hop counters) and
 * cannot drop or mutate — human pass-through is guaranteed by the guard,
 * not by policy good behavior. The one exception is a message the policy
 * can positively name as a notice (`noticeOf`); see the module comment.
 */
export interface SlackBotInboundPolicy {
  /** Decide one bot-authored inbound message, synchronously or not. A throw (or rejection) is treated as pass. */
  decideBotInbound(ctx: SlackBotInboundContext): SlackBotInboundDecision | Promise<SlackBotInboundDecision>;
  /** Observe a human-authored inbound message. Cannot affect delivery. */
  onHumanInbound?(ctx: SlackInboundContext): void;
  /**
   * Name a non-bot-authored message as a notice the guard should drop (a
   * system line the platform posts on an app's behalf, without a `bot_id`).
   * Null (or a throw) means "not one I know": the message goes on as human.
   */
  noticeOf?(ctx: SlackInboundContext): SlackInboundNotice | null | Promise<SlackInboundNotice | null>;
}

/**
 * The seam version a registrar passes with `addBotInboundPolicy`. Bumped only
 * on a breaking change to the policy shape; a mismatch refuses the
 * registration (logged, never thrown) so a policy built against another
 * shape costs itself and not the channel. Version 2: the chain with
 * tri-state decisions (admit / deny / pass), `noticeOf`, `onFailed`, and
 * decisions that may be promises.
 */
export const BOT_INBOUND_POLICY_SEAM = 2;

/** Undo a registration. */
export type Unregister = () => void;

interface PolicyEntry {
  name: string;
  policy: SlackBotInboundPolicy;
}

/** A refused registration, for the contract helper and operator surfaces. */
export interface BotInboundPolicyRefusal {
  name: string;
  wanted: number;
  got: number | undefined;
}

const policyChain: PolicyEntry[] = [];
const refusals: BotInboundPolicyRefusal[] = [];

/** The name the single-slot form registers under. */
const SINGLE_SLOT = 'set-bot-inbound-policy';

/**
 * Add an admission policy to the chain under a name (one entry per name; a
 * second registration under the same name is refused and logged, never
 * overwritten). Policies are consulted in registration order; the first to
 * admit wins. Returns the undo.
 */
export function addBotInboundPolicy(
  name: string,
  policy: SlackBotInboundPolicy,
  registration: { seam: number },
): Unregister {
  if (registration.seam !== BOT_INBOUND_POLICY_SEAM) {
    refusals.push({ name, wanted: BOT_INBOUND_POLICY_SEAM, got: registration.seam });
    log.error('slack-a2a-guard: bot inbound policy refused — seam version mismatch', {
      name,
      expected: BOT_INBOUND_POLICY_SEAM,
      received: registration.seam,
    });
    return () => {};
  }
  if (policyChain.some((entry) => entry.name === name)) {
    log.error('slack-a2a-guard: bot inbound policy refused — a policy of this name is already registered', { name });
    return () => {};
  }
  const entry: PolicyEntry = { name, policy };
  policyChain.push(entry);
  log.info('slack-a2a-guard: bot inbound policy registered', { name, position: policyChain.length });
  return () => {
    const at = policyChain.indexOf(entry);
    if (at !== -1) policyChain.splice(at, 1);
  };
}

/**
 * The single-slot form of the seam, kept for policies written against it:
 * installs THE policy of that slot (a second call overwrites with a warning,
 * as before), taking its place in the chain when first set. Pass null to
 * clear the slot and, with no other policy registered, restore the default
 * drop-everything behavior.
 */
export function setBotInboundPolicy(policy: SlackBotInboundPolicy | null): void {
  const at = policyChain.findIndex((entry) => entry.name === SINGLE_SLOT);
  if (policy && at !== -1) {
    log.warn('slack-a2a-guard: bot inbound policy overwritten');
    policyChain[at] = { name: SINGLE_SLOT, policy };
    return;
  }
  if (policy) {
    policyChain.push({ name: SINGLE_SLOT, policy });
    return;
  }
  if (at !== -1) policyChain.splice(at, 1);
}

/** The registered policy names, in chain order. */
export function botInboundPolicyNames(): string[] {
  return policyChain.map((entry) => entry.name);
}

/** Every refused registration this process recorded, oldest first. */
export function botInboundPolicyRefusals(): readonly BotInboundPolicyRefusal[] {
  return [...refusals];
}

/**
 * Contract-test helper: a payload's test imports the real channel barrel and
 * asserts its policy is on the chain, with the refusal's reason when not.
 */
export function assertBotInboundPolicy(name: string): void {
  if (policyChain.some((entry) => entry.name === name)) return;
  const refused = refusals.find((r) => r.name === name);
  throw new Error(
    `no bot inbound policy named '${name}' is registered` +
      (refused ? ` (refused: seam ${refused.wanted} expected, ${refused.got ?? 'none'} given)` : ''),
  );
}

/** Test seam. */
export function resetBotInboundPoliciesForTesting(): void {
  policyChain.length = 0;
  refusals.length = 0;
}

/** Ask each policy, in order, to name the message a notice; the first answer wins. */
async function noticeOf(ctx: SlackInboundContext): Promise<{ name: string; notice: SlackInboundNotice } | null> {
  for (const { name, policy } of [...policyChain]) {
    if (!policy.noticeOf) continue;
    try {
      const notice = await policy.noticeOf(ctx);
      if (notice) return { name, notice };
    } catch (err) {
      // A policy that cannot decide names nothing: the message goes on as human.
      log.warn('slack-a2a-guard: noticeOf threw — message treated as human', { name, platformId: ctx.platformId, err });
    }
  }
  return null;
}

/** Let every policy observe a human message; an observer's throw is logged and ignored. */
function observeHuman(ctx: SlackInboundContext): void {
  for (const { name, policy } of [...policyChain]) {
    if (!policy.onHumanInbound) continue;
    try {
      policy.onHumanInbound(ctx);
    } catch (err) {
      log.warn('slack-a2a-guard: onHumanInbound observer threw — human message unaffected', {
        name,
        instanceKey: ctx.instanceKey,
        platformId: ctx.platformId,
        err,
      });
    }
  }
}

/**
 * Walk the chain for one bot-authored message: `admit` and `deny` are final,
 * `pass` (or the older `drop`) hands the message to the next policy, and a
 * policy that throws passes (fail-closed for itself; it cannot admit by
 * accident, and it cannot veto what it could not decide). A message every
 * policy passed on is dropped with every reason, in chain order.
 */
type ChainOutcome =
  | { kind: 'admit'; admit: Extract<SlackBotInboundDecision, { action: 'admit' }>; name: string }
  | { kind: 'deny'; name: string; reason?: string }
  | { kind: 'unclaimed'; reasons: string[] };

async function decideBot(ctx: SlackBotInboundContext): Promise<ChainOutcome> {
  const reasons: string[] = [];
  for (const { name, policy } of [...policyChain]) {
    let decision: SlackBotInboundDecision;
    try {
      decision = await policy.decideBotInbound(ctx);
    } catch (err) {
      log.warn('slack-a2a-guard: admission policy threw — dropping bot-authored inbound for this policy', {
        name,
        instanceKey: ctx.instanceKey,
        platformId: ctx.platformId,
        botId: ctx.botId,
        err,
      });
      reasons.push(`${name}: threw`);
      continue;
    }
    if (decision.action === 'admit') return { kind: 'admit', admit: decision, name };
    if (decision.action === 'deny')
      return { kind: 'deny', name, ...(decision.reason ? { reason: decision.reason } : {}) };
    reasons.push(`${name}: ${decision.reason ?? 'pass'}`);
  }
  return { kind: 'unclaimed', reasons };
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
        const ctx: SlackInboundContext = { instanceKey, platformId, threadId, message };
        // A notice the platform posted on an app's behalf, without a bot_id:
        // a policy that knows the conversation may name it; dropped before it
        // becomes mail. Nothing else about a non-bot message is up to policy.
        const named = await noticeOf(ctx);
        if (named) {
          log.debug('slack-a2a-guard: notice dropped by policy', {
            instanceKey,
            platformId,
            policy: named.name,
            reason: named.notice.reason,
          });
          return;
        }
        // Human message — pass through untouched. Policies may observe it
        // (hop-counter resets), but can neither drop nor mutate it.
        observeHuman(ctx);
        return setup.onInbound(platformId, threadId, message);
      }

      if (policyChain.length === 0) {
        log.debug('slack-a2a-guard: bot-authored inbound dropped — no admission policy installed', {
          instanceKey,
          platformId,
          botId: bot.botId,
        });
        return;
      }

      const outcome = await decideBot({ instanceKey, platformId, threadId, message, botId: bot.botId });
      if (outcome.kind === 'deny') {
        log.info('slack-a2a-guard: bot-authored inbound denied by policy', {
          instanceKey,
          platformId,
          botId: bot.botId,
          policy: outcome.name,
          reason: outcome.reason,
        });
        return;
      }
      if (outcome.kind === 'unclaimed') {
        log.debug('slack-a2a-guard: bot-authored inbound dropped by policy', {
          instanceKey,
          platformId,
          botId: bot.botId,
          reasons: outcome.reasons,
        });
        return;
      }

      const decision = outcome.admit;
      if (decision.senderId) {
        (message.content as Record<string, unknown>).senderId = decision.senderId;
      }
      // Report acceptance only after downstream accepted it — a throw in the
      // host's onInbound must not count a message that never reached a session
      // (and releases whatever the policy reserved when it admitted).
      try {
        await setup.onInbound(platformId, threadId, message);
      } catch (err) {
        decision.onFailed?.();
        throw err;
      }
      decision.onAccepted?.();
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
