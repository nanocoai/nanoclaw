// The headless engine entry `ncl skills` and pipelines drive: list / plan /
// apply as JSON, with the preconditions, the checkout lock, and the journal
// rollback that keep a host checkout from ending up half-installed. Everything
// runs against a scratch root with a recording exec — no network, no real
// commands.
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { assertSkillName } from '../src/cli/skill-report.js';
import { applyHeadless, applyLockPath, listSkills, parseCli, planHeadless } from './skill-headless.js';

const DEMO_SKILL = `---
name: add-demo
description: "Demo install skill for the headless engine tests."
---

# Demo

## Copy
\`\`\`nc:copy
resources/demo.ts -> src/channels/demo.ts
\`\`\`

## Register
\`\`\`nc:append to:src/channels/index.ts
import './demo.js';
\`\`\`

## Credentials
\`\`\`nc:prompt handle
Your demo handle.
\`\`\`
\`\`\`nc:prompt token secret
Paste the demo token.
\`\`\`
\`\`\`nc:env-set
DEMO_HANDLE={{handle}}
\`\`\`
\`\`\`nc:env-set
DEMO_TOKEN={{token}}
\`\`\`

## Build and validate
\`\`\`nc:run effect:build
pnpm run build
\`\`\`
\`\`\`nc:run effect:test
pnpm exec vitest run src/channels/demo.test.ts
\`\`\`

## Restart
\`\`\`nc:run effect:restart
bash setup/lib/restart.sh
\`\`\`
`;

/** The shape of a channel skill: copy, register, a pinned dependency (whose undo is a command), a test. */
const DEP_SKILL = `---
name: add-dep
description: Install skill with a pinned dependency.
---

# Dep

## Copy
\`\`\`nc:copy
resources/dep.ts -> src/channels/dep.ts
\`\`\`
\`\`\`nc:append to:src/channels/index.ts
import './dep.js';
\`\`\`

## Dependencies
\`\`\`nc:dep
left-pad@1.3.0
\`\`\`

## Validate
\`\`\`nc:run effect:test
pnpm exec vitest run src/channels/dep.test.ts
\`\`\`
`;

const PROSE_SKILL = `---
name: prose-only
description: A workflow with no structured steps.
---

# Prose only

Read the logs and think hard.
`;

let root: string;

function skill(name: string, md: string, files: Record<string, string> = {}): void {
  const dir = join(root, '.claude', 'skills', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'SKILL.md'), md);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(dir, rel, '..'), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
}

const recording = (failOn?: RegExp) => {
  const cmds: string[] = [];
  return {
    cmds,
    exec: (c: string): string | void => {
      cmds.push(c);
      if (failOn && failOn.test(c)) throw new Error(`boom: ${c}`);
    },
  };
};

const DEMO_INPUTS = { handle: 'U1', token: 'shh' };

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'nc-headless-'));
  mkdirSync(join(root, 'src', 'channels'), { recursive: true });
  mkdirSync(join(root, 'src', 'providers'), { recursive: true });
  mkdirSync(join(root, 'container', 'agent-runner', 'src', 'providers'), { recursive: true });
  writeFileSync(join(root, 'src', 'channels', 'index.ts'), "import './cli.js';\n");
  writeFileSync(join(root, 'src', 'providers', 'index.ts'), '// provider barrel\n');
  writeFileSync(join(root, 'container', 'agent-runner', 'src', 'providers', 'index.ts'), "import './claude.js';\n");
  writeFileSync(join(root, '.env'), 'EXISTING=1\n');
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}\n');
  skill('add-demo', DEMO_SKILL, { 'resources/demo.ts': 'export const demo = true;\n' });
  skill('add-dep', DEP_SKILL, { 'resources/dep.ts': 'export const dep = 2;\n' });
  skill('prose-only', PROSE_SKILL);
});

afterEach(() => {
  rmSync(applyLockPath(root), { force: true });
  rmSync(root, { recursive: true, force: true });
});

describe('skill names', () => {
  it('accepts directory names and rejects anything that could escape .claude/skills', () => {
    expect(() => assertSkillName('add-demo')).not.toThrow();
    for (const bad of ['../etc', 'Add-Demo', 'a b', '', '-x', 'x/y'])
      expect(() => assertSkillName(bad)).toThrow(/invalid skill name/);
  });
});

describe('list', () => {
  it('reports only structured skills, with kind, install state, prompts, and caller-owned effects', () => {
    const rows = listSkills(root);
    expect(rows.map((r) => r.name)).toEqual(['add-demo', 'add-dep']);
    expect(rows[0]).toMatchObject({
      description: 'Demo install skill for the headless engine tests.',
      kind: 'other',
      installed: false,
      prompts: 2,
      secretPrompts: 1,
      callerOwnedEffects: ['restart'],
    });
    expect(rows[1].callerOwnedEffects).toEqual([]);
  });

  it('marks a skill installed once its barrel import is present', () => {
    writeFileSync(join(root, 'src', 'channels', 'index.ts'), "import './cli.js';\nimport './demo.js';\n");
    expect(listSkills(root)[0]).toMatchObject({ installed: true, kind: 'channel' });
  });

  it('keeps the catalog when one skill’s frontmatter does not parse', () => {
    skill(
      'bad-yaml',
      "---\nname: bad-yaml\ndescription: Deploy: staging\n---\n\n```nc:append to:src/channels/index.ts\nimport './bad.js';\n```\n",
    );
    const rows = listSkills(root);
    expect(rows.map((r) => r.name)).toEqual(['add-demo', 'add-dep', 'bad-yaml']);
    expect(rows[2].description).toBe('');
  });
});

describe('plan', () => {
  it('lists the steps and the prompts with their secret flag, without writing', () => {
    const plan = planHeadless(root, 'add-demo');
    expect(plan.prompts).toEqual([
      { var: 'handle', secret: false, question: 'Your demo handle.' },
      { var: 'token', secret: true, question: 'Paste the demo token.' },
    ]);
    expect(plan.callerOwnedEffects).toEqual(['restart']);
    expect(plan.steps.some((s) => s.kind === 'copy' && s.status === 'apply')).toBe(true);
    expect(existsSync(join(root, 'src', 'channels', 'demo.ts'))).toBe(false);
  });

  it('rejects an unknown skill', () => {
    expect(() => planHeadless(root, 'add-nope')).toThrow(/unknown skill/);
  });
});

describe('apply', () => {
  it('applies the structured steps, leaves caller-owned effects pending, and hides the secret', async () => {
    const { cmds, exec } = recording();
    const report = await applyHeadless(root, 'add-demo', { inputs: DEMO_INPUTS, exec });
    expect(report.status).toBe('applied');
    expect(readFileSync(join(root, 'src', 'channels', 'demo.ts'), 'utf8')).toContain('demo = true');
    expect(readFileSync(join(root, 'src', 'channels', 'index.ts'), 'utf8')).toContain("import './demo.js';");
    const env = readFileSync(join(root, '.env'), 'utf8');
    expect(env).toContain('DEMO_HANDLE=U1');
    expect(env).toContain('DEMO_TOKEN=shh');
    expect(cmds).toEqual(['pnpm run build', 'pnpm exec vitest run src/channels/demo.test.ts']);
    expect(report.pendingEffects).toEqual([
      { effect: 'restart', line: expect.any(Number), command: 'bash setup/lib/restart.sh' },
    ]);
    expect(report.vars).toEqual({ handle: 'U1' }); // the secret never surfaces
    expect(existsSync(applyLockPath(root))).toBe(false); // the checkout lock is released
  });

  it('refuses secret inputs on the agent path before touching anything', async () => {
    const { cmds, exec } = recording();
    const report = await applyHeadless(root, 'add-demo', { inputs: DEMO_INPUTS, noSecretInputs: true, exec });
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(/secret inputs are refused.*token/);
    expect(cmds).toEqual([]);
    expect(existsSync(join(root, 'src', 'channels', 'demo.ts'))).toBe(false);
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('EXISTING=1\n');
  });

  it('rolls the journal back when a step fails, leaving the tree as it was', async () => {
    const { exec } = recording(/vitest/);
    const report = await applyHeadless(root, 'add-demo', { inputs: DEMO_INPUTS, exec });
    expect(report.status).toBe('rolled-back');
    expect(report.failure?.headline).toMatch(/Build and validate/);
    expect(existsSync(join(root, 'src', 'channels', 'demo.ts'))).toBe(false);
    expect(readFileSync(join(root, 'src', 'channels', 'index.ts'), 'utf8')).toBe("import './cli.js';\n");
    expect(readFileSync(join(root, '.env'), 'utf8')).toBe('EXISTING=1\n');
  });

  it('reports a rollback that fails instead of throwing the report away', async () => {
    const { exec } = recording(/vitest|pnpm remove/);
    const report = await applyHeadless(root, 'add-dep', { exec });
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(/rollback failed: .*pnpm remove/);
    expect(report.failure?.headline).toMatch(/Validate/);
    expect(report.applied.length).toBeGreaterThan(0);
  });

  it('keeps the partial tree only when asked', async () => {
    const { exec } = recording(/vitest/);
    const report = await applyHeadless(root, 'add-demo', { inputs: DEMO_INPUTS, keepPartial: true, exec });
    expect(report.status).toBe('failed');
    expect(existsSync(join(root, 'src', 'channels', 'demo.ts'))).toBe(true);
  });

  it('reports a missing input as deferred and still rolls back', async () => {
    const { exec } = recording();
    const report = await applyHeadless(root, 'add-demo', { inputs: { handle: 'U1' }, exec });
    expect(report.status).toBe('rolled-back');
    expect(report.deferred.join(' ')).toMatch(/token/);
  });

  it('refuses a prose-only skill instead of guessing', async () => {
    const report = await applyHeadless(root, 'prose-only', { exec: recording().exec });
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(/no structured apply directives/);
  });

  it('refuses to run while another apply holds the checkout, and takes over a stale lock', async () => {
    const lock = applyLockPath(root);
    writeFileSync(lock, String(process.pid)); // a live owner
    let report = await applyHeadless(root, 'add-demo', { inputs: DEMO_INPUTS, exec: recording().exec });
    expect(report.status).toBe('failed');
    expect(report.error).toMatch(new RegExp(`another skill apply is running.*pid ${process.pid}`));
    expect(existsSync(join(root, 'src', 'channels', 'demo.ts'))).toBe(false);

    writeFileSync(lock, '999999999'); // an owner that no longer exists
    report = await applyHeadless(root, 'add-demo', { inputs: DEMO_INPUTS, exec: recording().exec });
    expect(report.status).toBe('applied');
    expect(existsSync(lock)).toBe(false);
  });

  describe('refresh', () => {
    it('needs a git work tree, and a clean one, unless told otherwise', async () => {
      const report = await applyHeadless(root, 'add-dep', { refresh: true, exec: recording().exec });
      expect(report.status).toBe('failed');
      expect(report.error).toMatch(/not a git work tree/);
    });

    it('is never rolled back — the files it overwrote were already installed', async () => {
      writeFileSync(join(root, 'src', 'channels', 'dep.ts'), 'export const dep = 1; // installed earlier\n');
      writeFileSync(join(root, 'src', 'channels', 'index.ts'), "import './cli.js';\nimport './dep.js';\n");
      const { exec } = recording(/pnpm (add|install)/);
      const report = await applyHeadless(root, 'add-dep', { refresh: true, allowDirty: true, exec });
      expect(report.status).toBe('failed');
      expect(report.error).toMatch(/never rolled back/);
      expect(readFileSync(join(root, 'src', 'channels', 'dep.ts'), 'utf8')).toContain('dep = 2'); // re-copied, kept
      expect(readFileSync(join(root, 'src', 'channels', 'index.ts'), 'utf8')).toContain("import './dep.js';");
    });
  });
});

describe('cli parsing', () => {
  it('reads the subcommand, skill, and flags', () => {
    const cli = parseCli([
      'apply',
      'add-demo',
      '--root',
      '/tmp/x',
      '--inputs',
      '{"handle":"U1"}',
      '--refresh',
      '--no-secret-inputs',
      '--keep-partial',
      '--allow-dirty',
    ]);
    expect(cli).toMatchObject({
      command: 'apply',
      skill: 'add-demo',
      root: '/tmp/x',
      inputs: { handle: 'U1' },
      refresh: true,
      noSecretInputs: true,
      keepPartial: true,
      allowDirty: true,
    });
  });

  it('rejects non-object inputs and unknown flags', () => {
    expect(() => parseCli(['apply', 'x', '--inputs', '[1]'])).toThrow(/JSON object/);
    expect(() => parseCli(['apply', 'x', '--bogus'])).toThrow(/unknown flag/);
    expect(() => parseCli(['apply', 'x', '--skip-effects', 'restart'])).toThrow(/unknown flag/);
  });
});
