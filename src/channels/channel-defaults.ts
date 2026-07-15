/**
 * Wiring-creation helpers over channel default declarations.
 *
 * Every path that creates a messaging_group_agents row (ncl, setup wizard,
 * card-approval flow, bootstrap scripts) resolves its engage defaults through
 * resolveWiringDefaults; every path that auto-creates a messaging_groups row
 * resolves its policy through resolveUnknownSenderPolicy. The router's fanout
 * consults resolveThreadPolicy at runtime — threading is the one per-wiring
 * setting that stays live (NULL = inherit the declaration) rather than being
 * snapshotted at creation.
 *
 * Context selection everywhere: isGroup = event.message.isGroup ??
 * (mg.is_group === 1) — NEVER `threadId !== null` (DM sub-threads exist on
 * Slack/Discord, and non-threaded group platforms have null threadIds).
 */
import type { ChannelDefaults } from './adapter.js';
import { getChannelDefaults, hasDeclaredChannelDefaults } from './channel-registry.js';
import { log } from '../log.js';
import type { MessagingGroup } from '../types.js';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Substitute the (regex-escaped) agent name for `{name}` in a declared
 * pattern. A `\b` adjacent to a non-word character can never match, so when
 * the name starts/ends with one (e.g. "Nano!", "Andy (backup)") the adjacent
 * declared boundary is dropped — mirrors selfChatEngagePattern in
 * setup/channels/whatsapp.ts.
 */
function substituteName(pattern: string, name: string): string {
  let out = pattern;
  if (!/^\w/.test(name)) out = out.replaceAll('\\b{name}', '{name}');
  if (!/\w$/.test(name)) out = out.replaceAll('{name}\\b', '{name}');
  return out.replaceAll('{name}', escapeRegex(name));
}

/**
 * Resolve the engage defaults a new wiring should be created with.
 *
 * @param channelKey mg.instance ?? mg.channel_type (getChannelAdapter key discipline)
 * @param isGroup event.message.isGroup ?? mg.is_group === 1 — never derived from threadId
 * @param agentGroupName substituted (regex-escaped) for the `{name}` token in declared patterns
 * @param channelType mg.channel_type — pass when channelKey may be a named
 *   instance so a dead instance still resolves its platform's declaration
 *   (getChannelDefaults' second-arg discipline)
 *
 * mention-sticky is downgraded to mention when the context's declared threads
 * value is false: sticky engagement is keyed on per-thread session existence,
 * so without thread ids it could engage once and never disengage.
 */
export function resolveWiringDefaults(
  channelKey: string,
  isGroup: boolean,
  agentGroupName: string,
  channelType?: string,
): { engage_mode: 'pattern' | 'mention' | 'mention-sticky'; engage_pattern: string | null } {
  const decl = getChannelDefaults(channelKey, channelType);
  const ctx = isGroup ? decl.group : decl.dm;

  let mode = ctx.engageMode;
  if (mode === 'mention-sticky' && !ctx.threads) mode = 'mention';

  if (mode !== 'pattern') return { engage_mode: mode, engage_pattern: null };

  if (!ctx.engagePattern) {
    throw new Error(
      `Channel '${channelKey}' declares engageMode 'pattern' without an engagePattern (${isGroup ? 'group' : 'dm'} context)`,
    );
  }
  return {
    engage_mode: 'pattern',
    engage_pattern: substituteName(ctx.engagePattern, agentGroupName),
  };
}

/** unknown_sender_policy for a messaging_groups row created in this context.
 *  `channelType` follows the same dead-named-instance discipline as
 *  resolveWiringDefaults. */
export function resolveUnknownSenderPolicy(
  channelKey: string,
  isGroup: boolean,
  channelType?: string,
): 'strict' | 'request_approval' | 'public' {
  const decl = getChannelDefaults(channelKey, channelType);
  return (isGroup ? decl.group : decl.dm).unknownSenderPolicy;
}

/**
 * Runtime thread policy for one wiring: does its event-derived address keep
 * thread ids? wiring.threads (0/1, NULL = inherit the declaration) hard-ANDed
 * with the adapter's raw capability — a wiring can opt out of threads on a
 * threaded platform, never opt in on a non-threaded one.
 *
 * Applies ONLY to event-derived addresses. `event.replyTo` is operator intent
 * from the CLI admin transport (src/channels/adapter.ts) and must never be
 * nulled through this policy.
 */
export function resolveThreadPolicy(
  wiringThreads: number | null,
  decl: ChannelDefaults,
  isGroup: boolean,
  supportsThreads: boolean,
): boolean {
  const inherited = (isGroup ? decl.group : decl.dm).threads;
  const wanted = wiringThreads === null ? inherited : wiringThreads !== 0;
  return wanted && supportsThreads;
}

export interface EngageValues {
  engage_mode?: unknown;
  engage_pattern?: unknown;
  threads?: unknown;
}

/**
 * Cross-column validation against the channel's declaration. Shared by every
 * wiring-creation surface (`ncl wirings` create/update, the setup wizard's
 * register step) so a partial update or an explicit flag can't produce a
 * combination create would reject. May mutate `w.engage_mode`: the
 * mention-sticky→mention coercion when the effective thread policy is off —
 * sticky engagement is keyed on per-thread session existence, so without
 * thread ids it would engage once and never disengage.
 *
 * Declaration-derived checks are gated on hasDeclaredChannelDefaults: stale
 * (undeclared) adapters keep the legacy lenient behavior — the fallback
 * declaration is permissive on mentions but its threads value is false when
 * no adapter is live, which would wrongly coerce offline-created wirings.
 */
export function validateEngageAgainstChannel(w: EngageValues, mg: MessagingGroup): void {
  if (
    w.engage_mode === 'pattern' &&
    (w.engage_pattern === undefined || w.engage_pattern === null || w.engage_pattern === '')
  ) {
    throw new Error(`engage_mode 'pattern' requires --engage-pattern (use "." to match every message)`);
  }
  if (w.engage_mode !== 'mention' && w.engage_mode !== 'mention-sticky') return;

  const channelKey = mg.instance ?? mg.channel_type;
  if (!hasDeclaredChannelDefaults(channelKey, mg.channel_type)) return;

  const decl = getChannelDefaults(channelKey, mg.channel_type);
  if (decl.mentions === 'never') {
    throw new Error(
      `engage_mode '${w.engage_mode}' can never engage on channel '${channelKey}' — its adapter declares mentions: 'never' (no mention signal is emitted; use --engage-mode pattern)`,
    );
  }
  if (w.engage_mode === 'mention-sticky') {
    const ctx = mg.is_group === 1 ? decl.group : decl.dm;
    const threads = w.threads === undefined || w.threads === null ? ctx.threads : w.threads !== 0;
    if (!threads) {
      log.warn('mention-sticky requires thread ids — coerced to mention', {
        channel: channelKey,
        messagingGroupId: mg.id,
      });
      w.engage_mode = 'mention';
    }
  }
}
