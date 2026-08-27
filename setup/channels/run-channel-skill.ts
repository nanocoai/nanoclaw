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
 *     polish), and the wire itself — `scripts/init-first-agent.ts`, which resolves
 *     or creates the agent group, grants the owner role (+ cli_scope=global),
 *     creates the messaging group + wiring, and sends the `/welcome` system instruction.
 *
 * So the wire lives in exactly one place (init-first-agent) and is never
 * duplicated across channel skills.
 */
import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import * as p from '@clack/prompts';

import { firstFailureHint, fullyApplied } from '../../scripts/skill-apply.js';
import * as setupLog from '../logs.js';
import { BACK_TO_CHANNEL_SELECTION, backGate, type ChannelFlowResult } from '../lib/back-nav.js';
import { askOperatorRole, type OperatorRole } from '../lib/role-prompt.js';
import { ensureAnswer, fail, runQuietChild } from '../lib/runner.js';
import { channelsRemote, hostExec, runSkill, type RunSkillOptions } from '../lib/skill-driver.js';
import { clearTemplatePick } from '../templates.js';
import { getChannelPreStep, getCompanionSkills } from './companions.js';

const DEFAULT_AGENT_NAME = 'Nano';

const CHANNELS_BRANCH = 'channels';

/**
 * Trunk ships no channel payloads, and that includes companion skill
 * directories — a declared companion may exist only on the channels registry
 * branch (e.g. the flag-gated Slack agents skills). Materialize an absent
 * directory from there — the same remote resolution and fetch/show mechanics
 * the skill engine uses for `from-branch` payload copies — so runSkill has a
 * document to apply. A directory already in the checkout short-circuits with
 * no git traffic. Returns false when the skill can't be produced; the caller
 * warns and skips it.
 */
export function materializeCompanionSkill(
  skill: string,
  projectRoot: string,
  deps: { exec?: (command: string) => string; resolveRemote?: () => string } = {},
): boolean {
  const dir = `.claude/skills/${skill}`;
  // Key the short-circuit on SKILL.md, not the directory: a directory left by
  // an interrupted materialization would otherwise read as installed, and a
  // missing SKILL.md parses as zero directives — "fully applied" while the
  // feature is absent.
  if (existsSync(join(projectRoot, dir, 'SKILL.md'))) return true;
  const exec =
    deps.exec ??
    ((command: string) =>
      execSync(command, { cwd: projectRoot, stdio: ['ignore', 'pipe', 'pipe'] }).toString());
  try {
    const remote = (deps.resolveRemote ?? channelsRemote(projectRoot))();
    exec(`git fetch ${remote} ${CHANNELS_BRANCH}`);
    const files = exec(`git ls-tree -r --name-only '${remote}/${CHANNELS_BRANCH}' -- '${dir}'`)
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (files.length === 0) return false;
    for (const file of files) {
      mkdirSync(dirname(join(projectRoot, file)), { recursive: true });
      exec(`git show '${remote}/${CHANNELS_BRANCH}:${file}' > '${file}'`);
    }
    return true;
  } catch {
    // Leave no partial directory behind — the SKILL.md short-circuit above
    // makes a leftover half-fetched dir permanent on the next run. Deleting
    // is safe here: this path only runs when the skill was absent on entry.
    rmSync(join(projectRoot, dir), { recursive: true, force: true });
    return false;
  }
}

/**
 * Apply a channel's declared companion skills (setup/channels/companions.ts)
 * after its main install skill. Some channel payloads are bigger than the
 * adapter install itself — capabilities that live in their own skills and
 * used to be applied by hand, which is exactly how a fresh install ships a
 * half-working channel. Applying the declared list here makes finishing setup
 * mean the whole payload actually works.
 *
 * Per-skill restarts are skipped and ONE deferred restart runs after all of
 * them — MANDATORY, and the reason `skipEffects: ['restart']` is safe: the
 * main channel skill restarts the host BEFORE the companions run, so without
 * a restart HERE nothing ever reloads after them. That failure mode is
 * invisible on disk and brutal to diagnose — every file is correct, but the
 * live process still holds the ESM-cached pre-edit modules.
 *
 * A companion that doesn't fully apply degrades, not fails: the channel's
 * main install still works, so warn with the exact re-apply command instead
 * of aborting setup.
 */
async function applyCompanionSkills(
  channel: string,
  projectRoot: string,
  overrides: ChannelSkillOverrides,
): Promise<void> {
  const companions = getCompanionSkills(channel);
  let applied = false;
  let degraded = false;
  for (const skill of companions) {
    if (!materializeCompanionSkill(skill, projectRoot)) {
      degraded = true;
      p.log.warn(
        `Companion skill ${skill} is not in this checkout and could not be fetched from the ` +
          `${CHANNELS_BRANCH} branch. The ${channel} channel works, but the capability that ` +
          `skill adds is missing until you fetch and apply it: ` +
          `pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/${skill}`,
      );
      continue;
    }
    const res = await runSkill(`.claude/skills/${skill}`, {
      projectRoot,
      exec: overrides.exec,
      resolveRemote: overrides.resolveRemote,
      // Skip per-skill restarts; this function performs ONE after all, below.
      skipEffects: overrides.skipEffects ?? ['restart'],
      onEvent: overrides.onEvent,
      confirm: overrides.confirm,
      openUrl: overrides.openUrl,
      step: `${channel}-${skill}`,
    });
    if (fullyApplied(res)) {
      applied = true;
      continue;
    }
    degraded = true;
    // Degraded, not fatal: the main channel install still works. Name the
    // skill and the exact re-apply command so the warning is actionable.
    p.log.warn(
      `Couldn't fully apply companion skill ${skill}. The ${channel} channel works, but the ` +
        `capability that skill adds stays degraded until you re-apply it: ` +
        `pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/${skill}`,
    );
  }

  if (!applied) return;
  if (degraded) {
    // A half-applied companion may have copied files and appended barrel
    // imports before failing its build or tests — restarting could boot that
    // state. The channel itself already works (its own restart ran before the
    // companions), so hold the deferred restart until the operator repairs.
    p.log.warn(
      'Skipping the deferred service restart: a companion skill did not fully apply. ' +
        'Re-apply it with the command above, then restart: bash setup/lib/restart.sh',
    );
    return;
  }
  try {
    await (overrides.exec ?? hostExec(projectRoot))('bash setup/lib/restart.sh');
  } catch {
    p.log.warn(
      'Applied the companion skills but could not restart the service. Their changes stay ' +
        'inactive until you restart it: bash setup/lib/restart.sh',
    );
  }
}

interface WireArgs {
  channel: string;
  userId: string;
  platformId: string;
  displayName: string;
  agentName: string;
  role: OperatorRole;
  agentGroupId?: string;
  /** Explicit DM engage regex (e.g. WhatsApp shared-mode "@<name> only" self-chat). */
  engagePattern?: string;
  /** Adapter instance registry key (e.g. telegram-mega) when the skill wired a named bot; unset = default instance. */
  instance?: string;
}

export async function resolveAgentName(): Promise<string> {
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
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      args.channel,
      '--user-id',
      args.userId,
      '--platform-id',
      args.platformId,
      '--display-name',
      args.displayName,
      '--agent-name',
      args.agentName,
      '--role',
      args.role,
      ...(args.agentGroupId ? ['--agent-group-id', args.agentGroupId] : []),
      ...(args.engagePattern ? ['--engage-pattern', args.engagePattern] : []),
      ...(args.instance ? ['--instance', args.instance] : []),
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
   * Clears any persisted template pick after a targeted wire. Modern setup
   * clears it when the operator chooses an action; this remains idempotent for
   * re-exec and direct-driver paths. Injectable so tests never touch .env.
   */
  clearTemplatePick?: () => void;
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
  let agentName = askLater ? '' : (overrides.agentName ?? (await resolveAgentName()));
  let role = askLater ? undefined : (overrides.role ?? (await askOperatorRole(channel)));

  // Channel-specific: install adapter, collect credentials, resolve the wire
  // inputs. The whole channel-specific procedure lives in the SKILL.md.
  const res = await runSkill(`.claude/skills/add-${channel}`, {
    projectRoot,
    exec: overrides.exec,
    execStream: overrides.execStream,
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
      const lines = t.reason
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean);
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

  // Declared companion skills: apply the rest of the channel's payload (see
  // setup/channels/companions.ts). After the main install, so files the
  // companions edit or import already exist.
  await applyCompanionSkills(channel, projectRoot, overrides);

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
  const templateAgentGroupId = process.env.NANOCLAW_TEMPLATE_AGENT_ID?.trim() || undefined;
  const ok = await wire({
    channel,
    userId: `${channel}:${ownerHandle}`,
    platformId,
    displayName,
    agentName,
    role: role!,
    agentGroupId: templateAgentGroupId,
    engagePattern: res.vars.engage_pattern || undefined,
    instance: res.vars.instance || undefined,
  });
  if (!ok) {
    await failWith(
      'init-first-agent',
      `Couldn't finish connecting ${agentName}.`,
      'You can retry later with `/init-first-agent`.',
    );
  }
  // Idempotently clear any legacy/re-exec template pick after the targeted
  // wire succeeds. Pinned by run-channel-skill.test.ts.
  if (templateAgentGroupId) (overrides.clearTemplatePick ?? clearTemplatePick)();
}

/**
 * The wizard's channel entry point: consult the channel's registered
 * auto-provision pre-step (setup/channels/companions.ts) before its install
 * skill. No registration ⇒ exactly runChannelSkill — the common case, and
 * every channel's behavior today.
 *
 * With a pre-step, the opening order mirrors runChannelSkill's own: the back
 * gate first (before any side effect — the pre-step owns prompts of its own),
 * then the agent name — resolved up front because it doubles as the
 * provisioned app's name — then the pre-step. Whatever inputs it returns
 * pre-bind the skill's prompts; undefined means the manual path, and the
 * skill flow prompts as usual. Explicit `overrides.inputs` win over pre-bound
 * values.
 */
export async function runChannelSkillWithPreStep(
  channel: string,
  displayName: string,
  overrides: ChannelSkillOverrides = {},
): Promise<ChannelFlowResult> {
  const preStep = getChannelPreStep(channel);
  if (!preStep) return runChannelSkill(channel, displayName, overrides);

  if (overrides.offerBack) {
    const label = channel.charAt(0).toUpperCase() + channel.slice(1);
    const gate = await (overrides.backGate ?? backGate)(label);
    if (gate === BACK_TO_CHANNEL_SELECTION) return BACK_TO_CHANNEL_SELECTION;
  }
  const agentName = overrides.agentName ?? (await resolveAgentName());
  const preBound = await preStep(agentName);
  return runChannelSkill(channel, displayName, {
    ...overrides,
    offerBack: false,
    agentName,
    inputs: { ...preBound, ...overrides.inputs },
  });
}
