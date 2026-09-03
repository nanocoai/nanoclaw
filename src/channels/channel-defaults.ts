/**
 * Wiring-creation helpers over channel default declarations.
 *
 * Every path that creates a messaging_group_agents row (ncl, setup wizard,
 * card-approval flow, bootstrap scripts) resolves its defaults through
 * resolveWiringDefaults, taking the columns it doesn't set itself; every path
 * that auto-creates a messaging_groups row resolves its policy through
 * resolveUnknownSenderPolicy. The router's fanout
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

/** What resolveWiringDefaults produces — the wiring-row columns a creation
 *  path stamps from the channel declaration. `threads` null = leave the
 *  column NULL (inherit the declaration at fanout time). */
export interface WiringDefaults {
  engage_mode: 'pattern' | 'mention' | 'mention-sticky';
  engage_pattern: string | null;
  session_mode: 'shared' | 'per-thread';
  threads: number | null;
}

/**
 * Resolve the defaults a new wiring should be created with: the engage
 * fields, plus the declared session_mode (ChannelContextDefaults.sessionMode)
 * and the threads stamp it derives — sessionMode 'per-thread' stamps
 * threads = 1 (per-thread sessions structurally require honored thread ids),
 * anything else leaves the column NULL (inherit). Undeclared adapters resolve
 * behavior-faithfully — session_mode 'shared', threads null (column stays
 * NULL = inherit) — so a trunk update alone changes nothing.
 *
 * @param channelKey mg.instance ?? mg.channel_type (getChannelAdapter key discipline)
 * @param isGroup event.message.isGroup ?? mg.is_group === 1 — never derived from threadId
 * @param agentGroupName substituted (regex-escaped) for the `{name}` token in declared patterns
 * @param channelType mg.channel_type — pass when channelKey may be a named
 *   instance so a dead instance still resolves its platform's declaration
 *   (getChannelDefaults' second-arg discipline)
 *
 * mention-sticky is downgraded to mention when the wiring being created
 * won't honor thread ids — the derived threads stamp when present, else the
 * context's inherit `threads` value: sticky engagement is keyed on
 * per-thread session existence, so without thread ids it could engage once
 * and never disengage.
 */
export function resolveWiringDefaults(
  channelKey: string,
  isGroup: boolean,
  agentGroupName: string,
  channelType?: string,
): WiringDefaults {
  const decl = getChannelDefaults(channelKey, channelType);
  const ctx = isGroup ? decl.group : decl.dm;

  const session: Pick<WiringDefaults, 'session_mode' | 'threads'> = {
    session_mode: ctx.sessionMode ?? 'shared',
    // Derived, not declared: per-thread sessions structurally require honored
    // thread ids, so the stamp is a code invariant of the session mode.
    threads: ctx.sessionMode === 'per-thread' ? 1 : null,
  };

  // The effective thread policy for the wiring being created: the derived
  // stamp wins over the inherit value (mirrors validateEngageAgainstChannel).
  const effectiveThreads = session.threads === null ? ctx.threads : true;

  let mode = ctx.engageMode;
  if (mode === 'mention-sticky' && !effectiveThreads) mode = 'mention';

  if (mode !== 'pattern') return { engage_mode: mode, engage_pattern: null, ...session };

  if (!ctx.engagePattern) {
    throw new Error(
      `Channel '${channelKey}' declares engageMode 'pattern' without an engagePattern (${isGroup ? 'group' : 'dm'} context)`,
    );
  }
  return {
    engage_mode: 'pattern',
    engage_pattern: substituteName(ctx.engagePattern, agentGroupName),
    ...session,
  };
}

/** unknown_sender_policy for a messaging_groups row created in this context.
 *  `channelType` follows the same dead-named-instance discipline as
 *  resolveWiringDefaults. */
export function resolveUnknownSenderPolicy(
  channelKey: string,
  isGroup: boolean,
  channelType?: string,
): 'strict' | 'request_approval' | 'decline_notify' | 'public' {
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
  session_mode?: unknown;
}

/**
 * Cross-column validation against the channel's declaration. Shared by every
 * wiring-creation surface (`ncl wirings` create/update, the setup wizard's
 * register step) so a partial update or an explicit flag can't produce a
 * combination create would reject — including session_mode 'per-thread' on a
 * wiring whose thread policy resolves off. May mutate `w.engage_mode`: the
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

  // per-thread sessions structurally require honored thread ids — reject the
  // incoherent combination rather than storing it. Creation paths that resolve
  // through the declaration derive threads=1 from sessionMode 'per-thread'
  // (resolveWiringDefaults), so only explicit flags can reach this: an
  // explicit threads=false, or NULL-inherit on a context whose declared
  // `threads` is false. Undeclared (stale) adapters stay lenient on the
  // inherit arm, same as the mention checks below.
  if (w.session_mode === 'per-thread') {
    const key = mg.instance ?? mg.channel_type;
    const explicit = w.threads !== undefined && w.threads !== null;
    const honored = explicit
      ? w.threads !== 0 && w.threads !== false
      : !hasDeclaredChannelDefaults(key, mg.channel_type) ||
        (mg.is_group === 1
          ? getChannelDefaults(key, mg.channel_type).group
          : getChannelDefaults(key, mg.channel_type).dm
        ).threads;
    if (!honored) {
      throw new Error(
        `session_mode 'per-thread' requires honored thread ids, but this wiring's thread policy resolves off ` +
          (explicit
            ? `(explicit threads=false)`
            : `(threads is NULL and channel '${key}' declares threads: false for its ${mg.is_group === 1 ? 'group' : 'dm'} context)`) +
          ` — set --threads true, or keep session_mode 'shared'`,
      );
    }
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
