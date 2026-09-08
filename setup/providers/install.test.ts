import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  bunVersion: undefined as string | undefined,
  commands: [] as string[],
  verify: vi.fn(async () => ({ status: 'passed', checks: [] })),
}));
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return {
    ...actual,
    execFileSync: () => {
      if (fixture.bunVersion) return fixture.bunVersion;
      throw new Error('Bun is absent from host');
    },
    execSync: (command: string, options: object) => {
      fixture.commands.push(command);
      return command.startsWith('node -e ') ? actual.execSync(command, options) : '';
    },
  };
});
vi.mock('../../scripts/provider-contract-verifier.js', async (original) => ({
  ...(await original<object>()),
  verifyProviderContracts: fixture.verify,
}));
import { applyProviderSkill } from './install.js';
import { applySkill, fullyApplied } from '../../scripts/skill-apply.js';
import { parseDirectives } from '../../scripts/skill-directives.js';
import { execSync } from 'node:child_process';

const roots: string[] = [];
const skill = path.join('.claude', 'skills', 'add-opencode');
function root(seam = 1) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-setup-install-'));
  roots.push(root);
  fs.cpSync(path.join(process.cwd(), skill), path.join(root, skill), { recursive: true });
  for (const file of [
    'src/provider-contracts/index.ts',
    'src/providers/index.ts',
    'setup/providers/index.ts',
    'container/agent-runner/src/providers/index.ts',
    'container/agent-runner/src/provider-contracts/index.ts',
  ]) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), "import './claude.js';\n");
  }
  fs.writeFileSync(
    path.join(root, 'src/provider-contracts/registry.ts'),
    `export const PROVIDER_HOST_CONTRACT_SEAM_VERSION = ${seam};\n`,
  );
  fs.writeFileSync(path.join(root, 'container/cli-tools.json'), '[]\n');
  fs.writeFileSync(path.join(root, 'container/agent-runner/package.json'), '{"dependencies":{}}\n');
  fs.writeFileSync(path.join(root, 'container/Dockerfile'), 'ARG BUN_VERSION=1.4.0\n');
  fs.writeFileSync(path.join(root, '.env'), 'DEFAULT_AGENT_PROVIDER=claude\nOTHER=keep\n');
  return root;
}
function tree(root: string) {
  const entries: Record<string, string> = {};
  function visit(directory: string) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(filename);
      else entries[path.relative(root, filename)] = fs.readFileSync(filename, 'utf8');
    }
  }
  visit(root);
  return entries;
}
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  fixture.commands.length = 0;
  fixture.verify.mockClear();
  fixture.bunVersion = undefined;
});

describe('OpenCode setup installation and refresh', () => {
  it('does not count its compatibility predicate as a payload change on an installed provider', async () => {
    const directory = root();
    await applyProviderSkill(skill, directory);
    fs.writeFileSync(
      path.join(directory, 'container/agent-runner/package.json'),
      '{"dependencies":{"@opencode-ai/sdk":"1.18.25"}}',
    );
    const before = tree(directory);
    fixture.commands.length = 0;
    const result = await applyProviderSkill(skill, directory);
    expect(result.blockers).toEqual([]);
    expect(result.changed).toBe(false);
    expect(tree(directory)).toEqual(before);
    expect(fixture.commands).toHaveLength(1);
    expect(fixture.commands[0]).toMatch(/^node -e /);
  });

  it('keeps an installed Codex payload and pins without contacting its registry branch', async () => {
    const directory = root();
    const codexSkill = '.claude/skills/add-codex';
    fs.cpSync(codexSkill, path.join(directory, codexSkill), { recursive: true });
    const directives = parseDirectives(fs.readFileSync(path.join(codexSkill, 'SKILL.md'), 'utf8'));
    for (const directive of directives) {
      if (directive.kind === 'copy') {
        for (const file of directive.body) {
          fs.mkdirSync(path.dirname(path.join(directory, file)), { recursive: true });
          fs.writeFileSync(path.join(directory, file), `// installed local customization: ${file}\n`);
        }
      } else if (directive.kind === 'append') {
        fs.appendFileSync(path.join(directory, String(directive.attrs.to)), directive.body.join('\n') + '\n');
      } else if (directive.kind === 'json-merge') {
        fs.writeFileSync(path.join(directory, String(directive.attrs.into)), `[${directive.body.join('\n')}]`);
      }
    }
    const before = tree(directory);
    const result = await applyProviderSkill(codexSkill, directory);
    expect(result.blockers).toEqual([]);
    expect(result.changed).toBe(false);
    expect(fixture.commands).toEqual([]);
    expect(tree(directory)).toEqual(before);
  });

  it('uses the pinned Bun when the host has a different version', async () => {
    fixture.bunVersion = '1.3.0';
    const result = await applyProviderSkill(skill, root());
    expect(result.blockers).toEqual([]);
    expect(fixture.commands.some((command) => command.includes('pnpm --package=bun@1.4.0 dlx bun add'))).toBe(true);
  });

  it('installs from its skill on a host without Bun and leaves build/auth to the caller', async () => {
    const directory = root();
    const result = await applyProviderSkill(skill, directory);
    expect(result.blockers).toEqual([]);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(path.join(directory, 'setup/providers/index.ts'), 'utf8')).toContain(
      "import './opencode.js';",
    );
    expect(
      fixture.commands.some((command) =>
        /pnpm --package=bun@1\.4\.0 dlx bun add @opencode-ai\/sdk@1\.18\.25/.test(command),
      ),
    ).toBe(true);
    expect(
      fixture.commands.some((command) => /bun run typecheck|container\/build.sh|provider-auth/.test(command)),
    ).toBe(false);
    expect(fs.readFileSync(path.join(directory, '.env'), 'utf8')).toBe('DEFAULT_AGENT_PROVIDER=claude\nOTHER=keep\n');
  });

  it('refreshes existing files and CLI/dependency pins without duplicating registration', async () => {
    const directory = root();
    await applyProviderSkill(skill, directory);
    fs.writeFileSync(path.join(directory, 'scripts/opencode-auth.ts'), 'old payload');
    fs.writeFileSync(
      path.join(directory, 'container/agent-runner/package.json'),
      '{"dependencies":{"@opencode-ai/sdk":"1.4.17"}}',
    );
    fs.writeFileSync(path.join(directory, 'container/cli-tools.json'), '[{"name":"opencode-ai","version":"1.4.17"}]');
    const result = await applyProviderSkill(skill, directory, { mode: 'refresh' });
    expect(result.blockers).toEqual([]);
    expect(result.changed).toBe(true);
    expect(fs.readFileSync(path.join(directory, 'scripts/opencode-auth.ts'), 'utf8')).toContain('runOpenCodeSetupAuth');
    expect(JSON.parse(fs.readFileSync(path.join(directory, 'container/cli-tools.json'), 'utf8'))).toEqual([
      { name: 'opencode-ai', version: '1.18.25', onlyBuilt: true },
    ]);
    expect(fixture.commands.filter((command) => command.includes('bun add @opencode-ai/sdk@1.18.25'))).toHaveLength(2);
    expect(
      fs.readFileSync(path.join(directory, 'setup/providers/index.ts'), 'utf8').match(/import '.\/opencode.js'/g),
    ).toHaveLength(1);
  });

  it.each(['install', 'refresh'] as const)(
    'refuses unsupported core during %s with zero file or dependency changes',
    async (mode) => {
      const directory = root(99);
      const before = tree(directory);
      const result = await applySkill(skill, directory, {
        mode,
        skipEffects: ['build', 'test', 'external'],
        exec: (command) => execSync(command, { cwd: directory, encoding: 'utf8' }),
      });
      expect(fullyApplied(result)).toBe(false);
      expect(tree(directory)).toEqual(before);
      expect(fixture.commands).toHaveLength(1);
    },
  );
});
