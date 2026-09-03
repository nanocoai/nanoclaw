/**
 * Per-channel wizard extension registries — the trunk seams that keep
 * setup/auto.ts and run-channel-skill.ts free of channel-specific imports
 * and conditionals.
 *
 * Two registrations, both consulted generically by the channel flow:
 *
 *  - Auto-provision pre-step: runs BEFORE the channel's install skill
 *    and may return pre-bound skill `inputs` (e.g. when the channel's app /
 *    credentials can be obtained programmatically). The resolved agent name
 *    is passed in — for platforms where it doubles as the provisioned app's
 *    name. Returning undefined means "walk the manual path"; the skill flow
 *    then prompts as usual. Pre-steps own their prompts and must never throw
 *    for expected declines.
 *
 *  - Companion skills: additional skills applied right after the
 *    channel's main install skill, each with per-skill restarts skipped and
 *    ONE deferred service restart after all of them (see
 *    run-channel-skill.ts). For channels whose full payload is bigger than
 *    the adapter install itself.
 *
 * Registration import point: a channel feature payload appends its
 * self-registration import below (same discipline as the src/channels/index.ts
 * adapter barrel) — trunk ships none.
 */

import { registerSlackAutoProvision } from './slack-auto-register.js';
import { registerTelegramPreStep } from './telegram-pre-step.js';

/**
 * A channel's auto-provision pre-step. `agentName` is the operator's resolved
 * assistant name. Resolves to the skill inputs to pre-bind, or undefined for
 * the manual walkthrough.
 */
export type ChannelPreStep = (agentName: string) => Promise<Record<string, string> | undefined>;

const preSteps = new Map<string, ChannelPreStep>();
const companionSkills = new Map<string, readonly string[]>();

/** Register the auto-provision pre-step for a channel (last write wins). */
export function registerChannelPreStep(channel: string, step: ChannelPreStep): void {
  preSteps.set(channel, step);
}

export function getChannelPreStep(channel: string): ChannelPreStep | undefined {
  return preSteps.get(channel);
}

/**
 * Declare the companion skills applied after a channel's main install skill,
 * in order (skill directory names under `.claude/skills/`; last write wins).
 */
export function registerCompanionSkills(channel: string, skills: readonly string[]): void {
  companionSkills.set(channel, skills);
}

export function getCompanionSkills(channel: string): readonly string[] {
  return companionSkills.get(channel) ?? [];
}

// ── Feature self-registration imports (appended by channel install skills) ──

// Registrations shipped with trunk. The register function is passed in
// (rather than the shim importing it) so each shim stays cycle-free.
registerSlackAutoProvision(registerChannelPreStep, registerCompanionSkills);
registerTelegramPreStep(registerChannelPreStep);
