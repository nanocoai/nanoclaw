/**
 * Bridge so the repo's skill harness (`pnpm run test:skills`) actually covers
 * add-clidash.
 *
 * The payload is a standalone zero-dependency Node tool: its own suite is
 * `node:test` JavaScript under `add/tools/clidash/test/`, which the harness's
 * `*.test.ts` glob cannot collect and vitest could not run anyway (the tests
 * exercise `server.js` over real HTTP with real subprocesses). Rather than port
 * or duplicate them, this shells out to the exact command SKILL.md step 3 tells
 * the installer to run, and fails with the runner's own output.
 *
 * It runs against the skill payload, not an installed copy, so it passes on a
 * pristine checkout — no `/add-clidash` install required.
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const PAYLOAD = join(dirname(fileURLToPath(import.meta.url)), 'add', 'tools', 'clidash');

describe('add-clidash payload', () => {
  it('ships the files SKILL.md step 1 copies into tools/clidash', () => {
    for (const file of ['server.js', 'parsers.js', 'logs.js', 'docs.js', 'activity.js', 'package.json', 'clidash.config.example.json', 'public/app.js', 'public/overview.js', 'public/index.html']) {
      expect(existsSync(join(PAYLOAD, file)), `${file} is missing from the payload`).toBe(true);
    }
  });

  it('passes its own node:test suite (SKILL.md step 3)', async () => {
    const { stdout, stderr } = await execFileAsync(
      process.execPath,
      ['--test', 'test/*.test.js'],
      { cwd: PAYLOAD, timeout: 120_000, maxBuffer: 32 * 1024 * 1024 },
    ).catch((err: Error & { stdout?: string; stderr?: string }) => {
      throw new Error(`node --test failed in ${PAYLOAD}\n\n${err.stdout ?? ''}\n${err.stderr ?? ''}`);
    });
    // node:test's summary lines are `ℹ pass N` (spec reporter) or `# pass N` (tap).
    const output = `${stdout}\n${stderr}`;
    const count = (label: string) => Number(new RegExp(`^[ℹ#] ${label} (\\d+)$`, 'm').exec(output)?.[1] ?? NaN);
    expect(count('fail'), `no failure count in node --test output:\n${output}`).toBe(0);
    // Guards against a glob that silently matches nothing.
    expect(count('pass')).toBeGreaterThan(50);
  }, 180_000);
});
