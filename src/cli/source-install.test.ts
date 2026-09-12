import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

import { sourceInstallRefusal } from './source-install.js';

const roots: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('allows a checkout root but refuses packaged runtimes and checkout subdirectories', () => {
  vi.stubEnv('NANOCLAW_SOURCE_INSTALL', 'enabled');
  const root = mkdtempSync(join(tmpdir(), 'source-install-'));
  roots.push(root);
  expect(sourceInstallRefusal(root)).toMatch(/Git checkout/);
  execFileSync('git', ['init', '-q', root]);
  expect(sourceInstallRefusal(root)).toBeUndefined();
  mkdirSync(join(root, 'nested'));
  expect(sourceInstallRefusal(join(root, 'nested'))).toMatch(/root of a Git checkout/);
});

it.each([undefined, 'disabled', '', 'typo'])('refuses an operator policy of %j even in a source checkout', (policy) => {
  vi.stubEnv('NANOCLAW_SOURCE_INSTALL', policy);
  expect(sourceInstallRefusal()).toMatch(/disabled.*deployment/);
});
