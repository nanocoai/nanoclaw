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
import { getChannelDefaults } from './channel-registry.js';

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Resolve the engage defaults a new wiring should be created with.
 *
 * @param channelKey mg.instance ?? mg.channel_type (getChannelAdapter key discipline)
 * @param isGroup event.message.isGroup ?? mg.is_group === 1 — never derived from threadId
 * @param agentGroupName substituted (regex-escaped) for the `{name}` token in declared patterns
 *
 * mention-sticky is downgraded to mention when the context's declared threads
 * value is false: sticky engagement is keyed on per-thread session existence,
 * so without thread ids it could engage once and never disengage.
 */
export function resolveWiringDefaults(
  channelKey: string,
  isGroup: boolean,
  agentGroupName: string,
): { engage_mode: 'pattern' | 'mention' | 'mention-sticky'; engage_pattern: string | null } {
  const decl = getChannelDefaults(channelKey);
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
    engage_pattern: ctx.engagePattern.replaceAll('{name}', escapeRegex(agentGroupName)),
  };
}

/** unknown_sender_policy for a messaging_groups row created in this context. */
export function resolveUnknownSenderPolicy(
  channelKey: string,
  isGroup: boolean,
): 'strict' | 'request_approval' | 'public' {
  const decl = getChannelDefaults(channelKey);
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
