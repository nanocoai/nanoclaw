import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = process.cwd();
const TSX = path.join(ROOT, 'node_modules', '.bin', 'tsx');
const REAL_ENTRY = path.join(ROOT, 'setup', 'auto.ts');

let fixtureRoot: string;

beforeEach(() => {
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-auto-entry-'));
});

afterEach(() => {
  fs.rmSync(fixtureRoot, { recursive: true, force: true });
});

describe('setup/auto.ts module entry guard', () => {
  it('runs main() when the checkout is reached through a symlink', () => {
    // nanoclaw.sh builds PROJECT_ROOT from bash's logical pwd, so it execs an
    // absolute $PROJECT_ROOT/setup/auto.ts that still carries the symlink.
    // Node resolves symlinks for import.meta.url but not for process.argv[1],
    // so a guard comparing the two raw paths is false through a symlinked
    // checkout: main() never runs and --help and --uninstall exit 0 having
    // done nothing. --help exercises the identical guard without destroying
    // anything.
    const linkedRoot = path.join(fixtureRoot, 'checkout');
    fs.symlinkSync(ROOT, linkedRoot);
    const linkedEntry = path.join(linkedRoot, 'setup', 'auto.ts');
    // The symlink must be a genuinely different literal path onto the same
    // file, otherwise this test would prove nothing.
    expect(linkedEntry).not.toBe(REAL_ENTRY);
    expect(fs.realpathSync(linkedEntry)).toBe(fs.realpathSync(REAL_ENTRY));

    const result = spawnSync(TSX, [linkedEntry, '--help'], {
      cwd: linkedRoot,
      env: { ...process.env, NANOCLAW_NO_DIAGNOSTICS: '1' },
      encoding: 'utf8',
      timeout: 15_000,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Usage: bash nanoclaw.sh');
    expect(result.stdout).toContain('--uninstall');
  }, 15_000);
});
