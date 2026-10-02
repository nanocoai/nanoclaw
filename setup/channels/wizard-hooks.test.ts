/**
 * The wizard's per-channel extension points, driven by fixtures.
 *
 *  - Pre-step: a channel feature registers an auto-provision pre-step;
 *    runChannelSkillWithPreStep resolves the agent name, hands it to the
 *    pre-step, and pre-binds whatever inputs it returns onto the install
 *    skill — no channel-name conditionals anywhere in the flow.
 *  - Companion skills: a channel feature declares companion skills;
 *    runChannelSkill applies each after the main install with per-skill
 *    restarts skipped, then performs ONE deferred restart, and degrades with
 *    an actionable re-apply warning on partial failure.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as p from '@clack/prompts';

import { runChannelSkill, runChannelSkillWithPreStep } from './run-channel-skill.js';
import { registerChannelPreStep, registerCompanionSkills } from './companions.js';
import { BACK_TO_CHANNEL_SELECTION } from '../lib/back-nav.js';

/** Write a channel install skill that resolves the wire inputs and, when the
 *  channel needs one, consumes a `token` prompt (validate-gated so only a
 *  `tok-` value binds). Relative skill paths resolve against cwd, so tests
 *  chdir into the scratch root (restored in afterEach). */
function writeChannelSkill(root: string, channel: string): void {
  const dir = join(root, `.claude/skills/add-${channel}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `# Add ${channel}

## Credentials

\`\`\`nc:prompt token validate:^tok-
Paste your ${channel} token.
\`\`\`

## Resolve the owner DM

\`\`\`nc:run capture:owner_handle
${channel}-resolve-owner {{token}}
\`\`\`

\`\`\`nc:run capture:platform_id
${channel}-resolve-dm
\`\`\`
`,
  );
}

/** A companion skill: one install command plus its own effect:restart fence
 *  (skipped by the mechanism, which owns the single deferred restart). */
function writeCompanionSkill(root: string, name: string): void {
  const dir = join(root, `.claude/skills/${name}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `# ${name}

## Install

\`\`\`nc:run
${name}-install
\`\`\`

## Restart

\`\`\`nc:run effect:restart
bash setup/lib/restart.sh
\`\`\`
`,
  );
}

function scratchRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
  return root;
}

/** Exec fixture: records commands, answers the channel skill's resolve runs. */
function makeExec(channel: string, cmds: string[], failOn?: string) {
  return (c: string): string | void => {
    cmds.push(c);
    if (failOn && c.includes(failOn)) throw new Error(`boom: ${failOn}`);
    if (c.startsWith(`${channel}-resolve-owner`)) return 'U777\n';
    if (c === `${channel}-resolve-dm`) return `${channel}:D777\n`;
  };
}

/** failWith seam that throws instead of exiting the process. */
const throwingFail = async (step: string, msg: string): Promise<never> => {
  throw new Error(`fail(${step}): ${msg}`);
};

const originalCwd = process.cwd();
const roots: string[] = [];

afterEach(() => {
  process.chdir(originalCwd);
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  delete process.env.NANOCLAW_AGENT_NAME;
});

describe('runChannelSkillWithPreStep', () => {
  it('a registered pre-step gets the resolved agent name and pre-binds the skill inputs', async () => {
    const root = scratchRoot('wh-prestep-');
    roots.push(root);
    writeChannelSkill(root, 'fixturechan');
    process.chdir(root);

    const preStep = vi.fn(async (_agentName: string) => ({ token: 'tok-prestep' }));
    registerChannelPreStep('fixturechan', preStep);
    // The resolveAgentName pass-through: the preset name reaches the pre-step.
    process.env.NANOCLAW_AGENT_NAME = 'Fixie';

    const cmds: string[] = [];
    const resolveInput = vi.fn(async () => undefined);
    const wired: Array<Record<string, unknown>> = [];

    await runChannelSkillWithPreStep('fixturechan', 'Bob Smith', {
      projectRoot: root,
      exec: makeExec('fixturechan', cmds),
      resolveRemote: () => 'origin',
      resolveInput,
      role: 'owner',
      fail: throwingFail,
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    expect(preStep).toHaveBeenCalledExactlyOnceWith('Fixie');
    // The pre-bound token satisfied the prompt — nothing was asked.
    expect(resolveInput).not.toHaveBeenCalled();
    // ...and fed the skill's own resolve step.
    expect(cmds).toContain('fixturechan-resolve-owner tok-prestep');
    expect(wired).toHaveLength(1);
    expect(wired[0]).toMatchObject({
      channel: 'fixturechan',
      userId: 'fixturechan:U777',
      platformId: 'fixturechan:D777',
      agentName: 'Fixie',
      role: 'owner',
    });
    // No companion declaration for this channel — no deferred restart either.
    expect(cmds.filter((c) => c.includes('restart.sh'))).toHaveLength(0);
  });

  it('offerBack: the back gate is consumed before the pre-step runs', async () => {
    const preStep = vi.fn(async () => ({}));
    registerChannelPreStep('fixturechan-back', preStep);

    const result = await runChannelSkillWithPreStep('fixturechan-back', 'Bob Smith', {
      offerBack: true,
      backGate: async () => BACK_TO_CHANNEL_SELECTION,
      fail: throwingFail,
    });

    expect(result).toBe(BACK_TO_CHANNEL_SELECTION);
    expect(preStep).not.toHaveBeenCalled();
  });

  it('no registered pre-step: delegates to the plain skill flow unchanged', async () => {
    const root = scratchRoot('wh-noprestep-');
    roots.push(root);
    writeChannelSkill(root, 'fixtureplain');
    process.chdir(root);

    const cmds: string[] = [];
    const wired: Array<Record<string, unknown>> = [];

    await runChannelSkillWithPreStep('fixtureplain', 'Bob Smith', {
      projectRoot: root,
      exec: makeExec('fixtureplain', cmds),
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      inputs: { token: 'tok-manual' },
      fail: throwingFail,
      wire: (a) => {
        wired.push(a);
        return true;
      },
    });

    expect(cmds).toContain('fixtureplain-resolve-owner tok-manual');
    expect(wired).toHaveLength(1);
    expect(wired[0]).toMatchObject({ userId: 'fixtureplain:U777', platformId: 'fixtureplain:D777' });
  });
});

describe('companion skills', () => {
  it('declared companions apply after the main install, with ONE deferred restart', async () => {
    const root = scratchRoot('wh-companions-');
    roots.push(root);
    writeChannelSkill(root, 'fixturecomp');
    writeCompanionSkill(root, 'fixture-companion-a');
    writeCompanionSkill(root, 'fixture-companion-b');
    process.chdir(root);
    registerCompanionSkills('fixturecomp', ['fixture-companion-a', 'fixture-companion-b']);

    const cmds: string[] = [];
    await runChannelSkill('fixturecomp', 'Bob Smith', {
      projectRoot: root,
      exec: makeExec('fixturecomp', cmds),
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      inputs: { token: 'tok-x' },
      fail: throwingFail,
      wire: () => true,
    });

    // Both companions ran, after the main skill's resolve steps.
    const aAt = cmds.indexOf('fixture-companion-a-install');
    const bAt = cmds.indexOf('fixture-companion-b-install');
    expect(aAt).toBeGreaterThan(cmds.indexOf('fixturecomp-resolve-dm'));
    expect(bAt).toBeGreaterThan(aAt);
    // Each companion's own effect:restart fence was skipped; the mechanism
    // performed exactly ONE restart, after both.
    const restarts = cmds.filter((c) => c === 'bash setup/lib/restart.sh');
    expect(restarts).toHaveLength(1);
    expect(cmds.indexOf('bash setup/lib/restart.sh')).toBeGreaterThan(bAt);
  });

  it('a partially-failed companion degrades with the exact re-apply command; the restart is held', async () => {
    const root = scratchRoot('wh-degraded-');
    roots.push(root);
    writeChannelSkill(root, 'fixturedeg');
    writeCompanionSkill(root, 'fixture-companion-ok');
    writeCompanionSkill(root, 'fixture-companion-bad');
    process.chdir(root);
    registerCompanionSkills('fixturedeg', ['fixture-companion-ok', 'fixture-companion-bad']);

    const warn = vi.spyOn(p.log, 'warn').mockImplementation(() => {});
    const cmds: string[] = [];
    await runChannelSkill('fixturedeg', 'Bob Smith', {
      projectRoot: root,
      exec: makeExec('fixturedeg', cmds, 'fixture-companion-bad-install'),
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      inputs: { token: 'tok-x' },
      fail: throwingFail,
      wire: () => true,
    });

    // Degraded, not fatal: the warning names the skill and the re-apply command
    // (the driver CLI, which actually applies — not the planner).
    const degraded = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('fixture-companion-bad'));
    expect(degraded).toHaveLength(1);
    expect(degraded[0]).toContain('pnpm exec tsx setup/lib/skill-driver.ts .claude/skills/fixture-companion-bad');
    // The deferred restart is HELD: the failed companion may have copied files
    // and appended barrel imports before failing, and restarting could boot
    // that half-applied state. The operator is told to repair, then restart.
    expect(cmds.filter((c) => c === 'bash setup/lib/restart.sh')).toHaveLength(0);
    const held = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes('Skipping the deferred service restart'));
    expect(held).toHaveLength(1);
  });

  it('no declaration: no companion runs, no deferred restart (unchanged flow)', async () => {
    const root = scratchRoot('wh-nocomp-');
    roots.push(root);
    writeChannelSkill(root, 'fixturenone');
    process.chdir(root);

    const cmds: string[] = [];
    await runChannelSkill('fixturenone', 'Bob Smith', {
      projectRoot: root,
      exec: makeExec('fixturenone', cmds),
      resolveRemote: () => 'origin',
      agentName: 'Nano',
      role: 'owner',
      inputs: { token: 'tok-x' },
      fail: throwingFail,
      wire: () => true,
    });

    expect(cmds.some((c) => c.includes('restart.sh'))).toBe(false);
    expect(cmds.some((c) => c.includes('companion'))).toBe(false);
  });
});
