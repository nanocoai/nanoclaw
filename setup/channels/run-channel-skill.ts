/**
 * Generic channel onboarding for setup:auto — the replacement for the bespoke
 * per-channel `run<Channel>Channel` flows.
 *
 * Split of responsibilities (Option A):
 *   - The channel's SKILL.md owns the channel-specific part: install the adapter,
 *     collect credentials, and resolve the wire inputs `owner_handle` +
 *     `platform_id` (e.g. Slack `conversations.open`). The engine surfaces those
 *     resolved values in `ApplyResult.vars`.
 *   - This flow owns the shared part: the operator's agent name + role (the
 *     polish), and the wire itself — `scripts/init-first-agent.ts`, which creates
 *     the agent group, grants the owner role (+ cli_scope=global), creates the
 *     messaging group + wiring, and sends the `/welcome` system instruction.
 *
 * So the wire lives in exactly one place (init-first-agent) and is never
 * duplicated across channel skills.
 */
import { writeFileSync } from 'node:fs';

import * as p from '@clack/prompts';

import { firstFailureHint, fullyApplied } from '../../scripts/skill-apply.js';
import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, backGate, type ChannelFlowResult } from '../lib/back-nav.js';
import { askOperatorRole, type OperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { runSkill, type RunSkillOptions } from '../lib/skill-driver.js';

const DEFAULT_AGENT_NAME = 'Nano';

interface WireArgs {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  role: OperatorRole;
  /** Explicit DM engage regex (e.g. WhatsApp shared-mode "@<name> only" self-chat). */
  engagePattern?: string;
}

async function resolveAgentName(): Promise<string> {
  const preset = process.env.NANOCLAW_AGENT_NAME?.trim();
  if (preset) return preset;
  const answer = ensureAnswer(
    await p.text({
      message: 'What should your assistant be called?',
      placeholder: DEFAULT_AGENT_NAME,
      defaultValue: DEFAULT_AGENT_NAME,
    }),
  );
  return (answer as string).trim() || DEFAULT_AGENT_NAME;
}

/** The shared wire: init-first-agent (group + owner role + cli_scope + wiring + /welcome). */
async function initFirstAgent(args: WireArgs): Promise<boolean> {
  const res = await runQuietChild(
    'init-first-agent',
    'pnpm',
    [
      'exec', 'tsx', 'scripts/init-first-agent.ts',
      '--channel', args.channel,
      '--user-id', args.userId,
      '--platform-id', args.platformId,
      '--display-name', args.displayName,
      '--agent-name', args.agentName,
      '--role', args.role,
      ...(args.engagePattern ? ['--engage-pattern', args.engagePattern] : []),
    ],
    { running: `Wiring ${args.agentName} to your ${args.channel} DMs…`, done: 'Agent wired.' },
    { extraFields: { CHANNEL: args.channel, AGENT_NAME: args.agentName, PLATFORM_ID: args.platformId } },
  );
  return res.ok;
}

export interface ChannelSkillOverrides extends Partial<RunSkillOptions> {
  agentName?: string;
  role?: OperatorRole;
  /** The shared wire; defaults to init-first-agent. Injectable for tests. */
  wire?: (args: WireArgs) => Promise<boolean> | boolean;
  /**
   * Wire only when the skill resolved owner_handle + platform_id this run
   * (Teams: the guarded DM-open steps only run on a fresh create). Resolved →
   * ask agent name/role and wire like any channel; unresolved (a drop-through
   * re-run — the first run's wiring still stands) → skip the wire and let the
   * SKILL's prose own the handoff. The name/role prompts are deferred until
   * after the skill run so the drop-through path asks nothing.
   */
  wireIfResolved?: boolean;
  /**
   * Offer the "← Back to channel selection" gate as the very first prompt,
   * before any side effect (agent-name/role prompts, the skill run, the
   * wire). On back, returns the
   * `BACK_TO_CHANNEL_SELECTION` sentinel and does nothing else. Opt-in so
   * headless callers (and the existing tests) never see the extra prompt.
   */
  offerBack?: boolean;
  /** The first-prompt back gate; defaults to back-nav.ts `backGate`. Injectable for tests. */
  backGate?: (label: string) => Promise<'continue' | typeof BACK_TO_CHANNEL_SELECTION>;
  /** The abort path; defaults to runner.ts `fail` (which exits). Injectable for tests. */
  fail?: (stepName: string, msg: string, hint?: string, rawLogPath?: string) => Promise<never>;
}

export async function runChannelSkill(
  channel: string,
  displayName: string,
  overrides: ChannelSkillOverrides = {},
): Promise<ChannelFlowResult> {
  // First-prompt back gate — the very first thing, before any side effect
  // (agent-name/role prompts, the skill run, the wire).
  // Opt-in via offerBack so headless callers + existing tests are unaffected.
  if (overrides.offerBack) {
    const label = channel.charAt(0).toUpperCase() + channel.slice(1);
    const gate = await (overrides.backGate ?? backGate)(label);
    if (gate === BACK_TO_CHANNEL_SELECTION) return BACK_TO_CHANNEL_SELECTION;
  }

  const projectRoot = overrides.projectRoot ?? process.cwd();
  const failWith = overrides.fail ?? fail;
  // The agent name + role are wire inputs — in wireIfResolved mode, defer the
  // prompts past the skill run (only a fresh create resolves the wire inputs;
  // a drop-through re-run asks nothing).
  const askLater = overrides.wireIfResolved;
  let agentName = askLater ? '' : overrides.agentName ?? (await resolveAgentName());
  let role = askLater ? undefined : overrides.role ?? (await askOperatorRole(channel));

  // Channel-specific: install adapter, collect credentials, resolve the wire
  // inputs. The whole channel-specific procedure lives in the SKILL.md.
  const res = await runSkill(`.claude/skills/add-${channel}`, {
    projectRoot,
    exec: overrides.exec,
    resolveInput: overrides.resolveInput,
    resolveRemote: overrides.resolveRemote,
    // The already-resolved agent name is pre-supplied so a skill that consumes
    // {{agent_name}} (WhatsApp's ASSISTANT_NAME / engage-pattern steps) never
    // re-asks in the wizard; its own prompt still asks on standalone runs. In
    // wireIfResolved mode the name is asked AFTER the skill run, so it stays
    // unbound here. An explicit overrides.inputs.agent_name wins.
    inputs: askLater ? overrides.inputs : { agent_name: agentName, ...overrides.inputs },
    skipEffects: overrides.skipEffects,
    // undefined ⇒ runSkill's default policy handler (TTY-gated spinner + operator
    // note → URL offer → natural-barrier confirm). An injected onEvent replaces
    // that policy entirely; inject confirm/openUrl to observe the default policy.
    onEvent: overrides.onEvent,
    confirm: overrides.confirm,
    openUrl: overrides.openUrl,
    reuse: overrides.reuse ?? true, // offer to reuse credentials already in .env
    // Handoff context for the `?` help-escape: a lone `?` at any of this skill's
    // prompts hands the operator off to interactive Claude scoped to this channel.
    channel: overrides.channel ?? channel,
    step: overrides.step ?? `${channel}-install`,
  });
  if (!fullyApplied(res)) {
    if (res.deferred.length) p.log.warn(`Still needs: ${res.deferred.join(', ')}`);
    // A bounced reason can carry a full stderr dump (a Node stacktrace). The
    // terminal gets ONE line per bounce — the first line, which hostExec
    // composes as `exit <code>: <first stderr line>` — and the full text goes
    // to a raw step log, written only when there's actually more than one line
    // to keep (SSF-004; the reference prose is deliberately not dumped either).
    let rawLog: string | undefined;
    if (res.agentTasks.some((t) => t.reason.includes('\n'))) {
      rawLog = setupLog.stepRawLog(`${channel}-install-bounce`);
      writeFileSync(rawLog, res.agentTasks.map((t) => `## ${t.kind} (line ${t.line})\n${t.reason}\n`).join('\n'));
    }
    for (const t of res.agentTasks) {
      const lines = t.reason.split('\n').map((l) => l.trim()).filter(Boolean);
      const more = lines.length > 1 ? ` (+${lines.length - 1} more lines in ${rawLog})` : '';
      p.log.warn(`Needs an agent (${t.kind}): ${lines[0] ?? t.reason}${more}`);
    }
    // Surface the bounced step's OWN prose as the failure hint + Claude-handoff
    // context (fail() dims the hint and forwards it to offerClaudeOnFailure),
    // instead of a generic "couldn't finish" message. Only a real bounce yields a
    // diagnosis; a purely-deferred run (a missing input) falls back to the generic.
    const diag = firstFailureHint(res);
    await failWith(
      `${channel}-install`,
      diag?.headline ?? `Couldn't finish setting up ${channel}.`,
      diag?.hint ?? 'See logs/setup-steps/ for details, then retry setup.',
      rawLog,
    );
  }

  // Identity confirmation captured by the skill (e.g. add-slack's auth.test).
  if (res.vars.connected_as) p.log.success(`Connected to ${channel} as ${res.vars.connected_as}.`);

  const ownerHandle = res.vars.owner_handle;
  const platformId = res.vars.platform_id;
  if (overrides.wireIfResolved && (!ownerHandle || !platformId)) {
    // Drop-through re-run: the guarded resolve steps were skipped, so there is
    // nothing new to wire — the first run's wiring still stands (verify's
    // pending path covers a truly unwired install).
    return;
  }
  if (!ownerHandle || !platformId) {
    await failWith(
      `${channel}-resolve`,
      `Couldn't resolve your ${channel} address.`,
      'The skill did not produce owner_handle + platform_id.',
    );
  }
  if (overrides.wireIfResolved) {
    agentName = overrides.agentName ?? (await resolveAgentName());
    role = overrides.role ?? (await askOperatorRole(channel));
  }

  // Shared wire — the same procedure for every channel. role is defined here:
  // it's only undefined in an unresolved wireIfResolved run (returned above).
  const wire = overrides.wire ?? initFirstAgent;
  // A skill-resolved engage pattern (WhatsApp shared-mode "@<name> only"
  // self-chat) rides along to init-first-agent's --engage-pattern; unset means
  // the wiring's own DM default applies.
  const ok = await wire({
    channel,
    userId: `${channel}:${ownerHandle}`,
    platformId,
    displayName,
    agentName,
    role: role!,
    engagePattern: res.vars.engage_pattern || undefined,
  });
  if (!ok) {
    await failWith('init-first-agent', `Couldn't finish connecting ${agentName}.`, 'You can retry later with `/init-first-agent`.');
  }
}
