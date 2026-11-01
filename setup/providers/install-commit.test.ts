import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

vi.mock('../../scripts/provider-contract-verifier.js', async (original) => ({
  ...(await original<object>()),
  verifyProviderContracts: vi.fn(async () => ({ status: 'passed', checks: [] })),
}));
import { applyProviderSkill } from './install.js';

const SKILL = path.join('.claude', 'skills', 'add-demo');
const cwd = process.cwd();
let root = '';

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

beforeEach(() => {
  vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null');
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
  vi.stubEnv('NANOCLAW_SETUP_COMMIT', '');
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-commit-'));
  fs.mkdirSync(path.join(root, SKILL, 'payload'), { recursive: true });
  fs.writeFileSync(path.join(root, SKILL, 'payload', 'demo.ts'), 'export const demo = 1;\n');
  fs.writeFileSync(
    path.join(root, SKILL, 'SKILL.md'),
    [
      '---',
      'name: add-demo',
      'description: Demo provider.',
      'metadata:',
      '  nanoclaw-provider: demo',
      '  nanoclaw-provider-label: Demo',
      '  nanoclaw-provider-hint: test only',
      "  nanoclaw-provider-offered: 'false'",
      '  nanoclaw-provider-image: local-required',
      '---',
      '',
      '```nc:copy',
      'payload/demo.ts -> src/providers/demo.ts',
      '```',
      '',
    ].join('\n'),
  );
  git('init', '-q');
  git('add', '-A');
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
  process.chdir(root);
});

afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

it('commits the provider payload setup applies, leaving the checkout updatable', async () => {
  const { blockers } = await applyProviderSkill(SKILL, root);

  expect(blockers).toEqual([]);
  expect(git('status', '--porcelain')).toBe('');
  expect(git('log', '-1', '--format=%s')).toBe('setup: apply add-demo');
  expect(git('show', '--name-only', '--format=', 'HEAD')).toBe('src/providers/demo.ts');
});
