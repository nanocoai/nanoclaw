import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { detectInstalledSkills, refreshInstalledSkills } from './update-skills.js';

const tempRoots: string[] = [];

function temp(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempRoots.push(root);
  return root;
}

function run(cwd: string, command: string, args: string[]): string {
  return execFileSync(command, args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function write(root: string, rel: string, content: string): void {
  const target = path.join(root, rel);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function commit(root: string, message: string): void {
  run(root, 'git', ['add', '.']);
  run(root, 'git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', message]);
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('installed skill detection', () => {
  it('finds channel and provider imports while excluding built-ins', () => {
    const root = temp('nanoclaw-skills-detect-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './slack.js';\n");
    write(root, 'src/providers/index.ts', "import './opencode.js';\n");
    write(root, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\nimport './opencode.js';\n");

    expect(detectInstalledSkills(root)).toEqual([
      { name: 'opencode', skillName: 'add-opencode', kind: 'provider' },
      { name: 'slack', skillName: 'add-slack', kind: 'channel' },
    ]);
  });
});

describe('registry refresh end to end', () => {
  it('uses the container-pinned Bun through pnpm when Bun is unavailable on the host', async () => {
    const root = temp('nanoclaw-skills-bun-fallback-');
    write(root, 'src/channels/index.ts', "import './cli.js';\n");
    write(root, 'src/providers/index.ts', "import './opencode.js';\n");
    write(root, 'container/agent-runner/src/providers/index.ts', "import './claude.js';\nimport './opencode.js';\n");
    write(root, 'container/Dockerfile', 'ARG BUN_VERSION=1.3.12\n');
    write(
      root,
      '.claude/skills/add-opencode/SKILL.md',
      [
        '# Apply',
        '```nc:dep manager:bun cwd:container/agent-runner',
        'example-provider@1.2.3',
        '```',
      ].join('\n'),
    );
    const commands: string[] = [];

    const report = await refreshInstalledSkills(root, 'all', {
      commandAvailable: (command) => command !== 'bun',
      exec: (command) => {
        commands.push(command);
      },
    });

    expect(report.success, JSON.stringify(report, null, 2)).toBe(true);
    expect(commands).toEqual([
      'cd container/agent-runner && pnpm --package=bun@1.3.12 dlx bun add example-provider@1.2.3',
    ]);
  });

  it('refreshes from official upstream when the user fork origin has no registry branch', async () => {
    const seed = temp('nanoclaw-skills-seed-');
    run(seed, 'git', ['init', '-b', 'main']);
    write(seed, 'src/channels/index.ts', "import './cli.js';\n");
    write(
      seed,
      '.claude/skills/add-demo/SKILL.md',
      [
        '---',
        'name: add-demo',
        'description: Test channel.',
        '---',
        '# Apply',
        '```nc:copy from-branch:channels',
        'src/channels/demo.ts',
        '```',
        '```nc:append to:src/channels/index.ts',
        "import './demo.js';",
        '```',
      ].join('\n'),
    );
    commit(seed, 'main');
    run(seed, 'git', ['checkout', '-b', 'channels']);
    write(seed, 'src/channels/demo.ts', 'export const payload = "upstream-current";\n');
    commit(seed, 'registry payload');
    run(seed, 'git', ['checkout', 'main']);

    const official = temp('nanoclaw-skills-official-');
    fs.rmSync(official, { recursive: true });
    run(path.dirname(official), 'git', ['clone', '--bare', seed, official]);
    const fork = temp('nanoclaw-skills-fork-');
    fs.rmSync(fork, { recursive: true });
    run(path.dirname(fork), 'git', ['clone', '--bare', official, fork]);
    run(fork, 'git', ['update-ref', '-d', 'refs/heads/channels']);

    const install = temp('nanoclaw-skills-install-');
    fs.rmSync(install, { recursive: true });
    run(path.dirname(install), 'git', ['clone', fork, install]);
    run(install, 'git', ['remote', 'add', 'upstream', official]);
    write(install, 'src/channels/demo.ts', 'export const payload = "installed-old";\n');
    fs.appendFileSync(path.join(install, 'src/channels/index.ts'), "import './demo.js';\n");
    commit(install, 'install demo channel');

    const report = await refreshInstalledSkills(install);

    expect(report.success, JSON.stringify(report, null, 2)).toBe(true);
    expect(report.remotes).toEqual({ channels: 'upstream' });
    expect(report.skills).toMatchObject([{ name: 'demo', status: 'refreshed' }]);
    expect(fs.readFileSync(path.join(install, 'src/channels/demo.ts'), 'utf8')).toContain('upstream-current');
  });

  it('returns a blocking structured failure for prose-only installed skills', async () => {
    const root = temp('nanoclaw-skills-prose-');
    write(root, 'src/channels/index.ts', "import './cli.js';\nimport './demo.js';\n");
    write(root, '.claude/skills/add-demo/SKILL.md', '# Apply\nCopy the file by hand.\n');

    const report = await refreshInstalledSkills(root);

    expect(report.success).toBe(false);
    expect(report.skills[0]).toMatchObject({ name: 'demo', status: 'failed' });
    expect(report.skills[0].errors.join('\n')).toContain('no structured apply directives');
  });
});
