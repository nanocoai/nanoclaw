/**
 * `ncl skills` — the install path for capability skills, exposed to agents
 * with admin approval.
 *
 * Trunk ships channels, providers, and other capabilities as install skills
 * whose mechanical steps are `nc:` directive fences. The setup wizard applies
 * them through the directive engine; this resource gives the same engine an
 * `ncl` surface, so a NanoClaw agent can request an install from chat (held
 * for an admin's approval like every other write verb), an operator can run
 * one from a terminal, and a pipeline can script it. The host applies the
 * skill to its own checkout; the caller-owned effects — the service restart,
 * interactive steps, wiring — are reported back instead of executed.
 *
 * Credentials never ride this path from an agent: an input that answers a
 * `secret` prompt is refused by the guard before any approval card or row
 * exists, and the engine refuses it again as defense in depth.
 */
import { registerResource, validateArgs, type ColumnDef } from '../crud.js';
import {
  assertSkillName,
  errorMessage,
  isPlainObject,
  needsRestart,
  type SkillApplyReport,
  type SkillPlan,
  type SkillSummary,
} from '../skill-report.js';
import { hostServiceDefined, restartHost, runSkillHeadless } from '../skill-runner.js';
import { sourceInstallRefusal } from '../source-install.js';

/** The skill directory name — the trailing positional, which the dispatcher hands over as `id`. */
function skillId(args: Record<string, unknown>): string {
  const id = String(args.id ?? '');
  assertSkillName(id);
  return id;
}

const APPLY_ARGS: ColumnDef[] = [
  { name: 'id', type: 'string', description: 'Skill directory name, e.g. add-codex.', required: true },
  { name: 'inputs', type: 'json', description: 'JSON object of prompt var → answer.' },
  {
    name: 'refresh',
    type: 'boolean',
    description: 'Re-copy payload files and re-pin dependencies even when present (clean tree required).',
    default: false,
  },
  {
    name: 'restart',
    type: 'boolean',
    description: 'Restart the host service after a successful apply.',
    default: false,
  },
];

type RestartOutcome =
  | 'requested' // deferred until this reply has left; runs setup/lib/restart.sh
  | 'unmanaged' // asked for, but no launchd/systemd definition exists for this checkout
  | 'not-requested';

type SkillApplyResponse = SkillApplyReport & { restart: RestartOutcome };

function formatPlan(data: unknown): string {
  const plan = data as SkillPlan;
  const lines = plan.steps.map(
    (s) => `${String(s.n).padStart(2)}. ${s.status.padEnd(11)} ${s.kind.padEnd(9)} ${s.detail}`,
  );
  if (plan.prompts.length > 0) {
    lines.push('', 'Inputs:');
    for (const p of plan.prompts) lines.push(`  ${p.var}${p.secret ? ' (secret — operator only)' : ''}: ${p.question}`);
  }
  const effects = plan.callerOwnedEffects;
  if (effects.length > 0) lines.push('');
  if (effects.includes('restart')) lines.push('Requires a host restart after apply (--restart).');
  if (effects.includes('step')) lines.push('Has an interactive step — finish it with the setup wizard.');
  if (effects.includes('wire')) lines.push('Wires a chat to an agent — the wiring is reported, not run.');
  if (effects.includes('external')) lines.push('External setup (including authentication) must be completed on the host.');
  return lines.join('\n');
}

function formatApply(data: unknown): string {
  const r = data as SkillApplyResponse;
  const lines = [`${r.skill}: ${r.status}`];
  if (r.error) lines.push(`  ${r.error}`);
  if (r.failure) {
    lines.push(`  failed at: ${r.failure.headline}`);
    // The hint opens with the section heading again; show its first line of substance.
    const detail = r.failure.hint.split('\n').find((l) => l.trim() && !l.startsWith('#') && l !== r.failure?.headline);
    if (detail) lines.push(`  ${detail}`);
  }
  if (r.applied.length) lines.push(`  applied ${r.applied.length} step(s), skipped ${r.skipped.length}`);
  if (r.deferred.length) lines.push(`  waiting for input: ${r.deferred.join('; ')}`);
  for (const t of r.agentTasks) lines.push(`  needs an agent (line ${t.line}): ${t.reason}`);
  for (const p of r.pendingEffects) lines.push(`  not run (${p.effect}): ${p.command.split('\n')[0]}`);
  if (r.status === 'rolled-back') lines.push('  journaled files restored; build output and arbitrary command effects are not covered — verify before restarting');
  if (r.status === 'needs-setup') {
    lines.push('  code installed; setup is pending — the host was not restarted');
    lines.push(`  finish the pending steps at the host terminal using .claude/skills/${r.skill}/SKILL.md`);
  }
  if (r.restart === 'requested') lines.push('  host restart requested');
  else if (r.restart === 'unmanaged') {
    lines.push('  no launchd/systemd service is defined for this checkout — restart the host by hand to load it');
  } else if (r.status === 'applied' && needsRestart(r)) lines.push('  restart the host to load it (or pass --restart)');
  return lines.join('\n');
}

registerResource({
  name: 'skill',
  plural: 'skills',
  description:
    'Capability install skills (channels, providers, tools) and the engine that applies them. ' +
    "`apply` runs a skill's structured steps on the host: copy its files, wire its registration, install its pinned " +
    'dependencies, build, and run its tests. Credentials, external setup, interactive steps, and wiring stay with the operator. ' +
    'Packaged or source-install-disabled deployments must use their release workflow. ' +
    'From a container, apply is held for admin approval and credential inputs are refused; those are entered on the host.',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        'List the install skills the engine can apply, with whether each is already installed.\n\n' +
        'Only skills with structured (nc:) steps appear — a prose-only skill needs a coding agent.',
      examples: ['ncl skills list'],
      args: [],
      handler: async () => await runSkillHeadless<SkillSummary[]>(['list']),
    },
    plan: {
      access: 'open',
      description:
        'Show what applying a skill would do, without writing anything: each step and whether it is already ' +
        'satisfied, the inputs it asks for (secret ones are operator-only), and whether a restart follows.',
      examples: ['ncl skills plan add-telegram'],
      args: [{ name: 'id', type: 'string', description: 'Skill directory name, e.g. add-telegram.', required: true }],
      handler: async (args) => await runSkillHeadless<SkillPlan>(['plan', skillId(args)]),
      formatHuman: formatPlan,
    },
    apply: {
      access: 'approval',
      description:
        'Apply an install skill to this NanoClaw checkout: copy files, append registrations, install pinned ' +
        'dependencies, build, test. Failed code steps use the rollback journal. Missing inputs and external or interactive ' +
        'setup leave code installed with status needs-setup and the pending steps to finish on the host. Wiring is also operator-owned; ' +
        'pass --restart to restart only after a fully applied result (needs a launchd or ' +
        "systemd service). --inputs answers the skill's prompts as a JSON object; from a container, inputs for " +
        'secret prompts are refused — the operator enters credentials on the host. --refresh re-copies an installed ' +
        "skill's files and re-pins its dependencies; it needs a clean working tree and is never rolled back.",
      examples: [
        'ncl skills apply add-codex --restart',
        'ncl skills apply add-telegram --inputs \'{"owner_handle":"12345678"}\'',
      ],
      args: APPLY_ARGS,
      // Before the hold, so nothing malformed is carded and a credential never
      // reaches a card or the pending_approvals row: an agent's inputs may
      // answer plain prompts, never secret ones. The approved replay skips the
      // prompt check — the engine refuses secrets itself on the agent path.
      refuse: async (args, _actor, { replay }) => {
        const refusal = sourceInstallRefusal();
        if (refusal) return refusal;
        let inputs: unknown;
        try {
          skillId(args);
          inputs = validateArgs(APPLY_ARGS, args).inputs;
        } catch (e) {
          return errorMessage(e);
        }
        if (inputs !== undefined && !isPlainObject(inputs))
          return '--inputs must be a JSON object of prompt var → answer';
        const keys = Object.keys(inputs ?? {});
        if (replay || keys.length === 0) return undefined;
        let plan: SkillPlan;
        try {
          plan = await runSkillHeadless<SkillPlan>(['plan', skillId(args)]);
        } catch (e) {
          return `cannot check the inputs for ${String(args.id)}: ${errorMessage(e)}`;
        }
        const secret = plan.prompts.filter((p) => p.secret && keys.includes(p.var)).map((p) => p.var);
        if (secret.length === 0) return undefined;
        return `--inputs answers secret prompt(s) ${secret.join(', ')}: credentials are entered by the operator on the host, never relayed through chat`;
      },
      handler: async (args, ctx): Promise<SkillApplyResponse> => {
        const refusal = sourceInstallRefusal();
        if (refusal) throw new Error(refusal);
        const argv = ['apply', skillId(args)];
        if (args.inputs !== undefined) {
          if (!isPlainObject(args.inputs)) throw new Error('--inputs must be a JSON object of prompt var → answer');
          argv.push('--inputs', JSON.stringify(args.inputs));
        }
        if (args.refresh === true) argv.push('--refresh');
        if (ctx.caller === 'agent') argv.push('--no-secret-inputs');
        const report = await runSkillHeadless<SkillApplyReport>(argv);

        let restart: RestartOutcome = 'not-requested';
        if (report.status === 'applied' && args.restart === true) {
          if (hostServiceDefined()) {
            ctx.defer(restartHost); // after the reply has left (HandlerContext.defer)
            restart = 'requested';
          } else {
            restart = 'unmanaged';
          }
        }
        return { ...report, restart };
      },
      formatHuman: formatApply,
    },
  },
});
