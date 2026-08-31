/**
 * Pin setup/lib/restart.sh's macOS branch (#2583): `launchctl kickstart` only
 * operates on loaded services, so an unloaded plist made the old one-liner
 * silently no-op — the script reported a restart that never happened and the
 * next wiring step died on a dead CLI socket.
 *
 * The real restart_darwin() is extracted from the script and run under bash
 * with a stub `launchctl` on PATH that records its argv and scripts the
 * `print` probe's exit code, so all three states are exercised: loaded,
 * unloaded-but-installed, and never-installed.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const libDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(libDir, 'restart.sh');

function extractRestartDarwin(): string {
  const source = fs.readFileSync(scriptPath, 'utf8');
  const start = source.indexOf('restart_darwin() {');
  expect(start, 'restart_darwin() not found in restart.sh').toBeGreaterThanOrEqual(0);
  const end = source.indexOf('\n}', start);
  expect(end, 'unterminated restart_darwin()').toBeGreaterThan(start);
  return source.slice(start, end + 2);
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-restart-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Run restart_darwin with a stubbed launchctl.
 * @param printExit exit code of `launchctl print` (0 = service loaded)
 * @param plistInstalled whether the plist file exists on disk
 */
function runRestartDarwin(printExit: number, plistInstalled: boolean): string[] {
  const binDir = path.join(tmpDir, 'bin');
  const home = path.join(tmpDir, 'home');
  const callLog = path.join(tmpDir, 'calls.log');
  fs.mkdirSync(binDir, { recursive: true });
  fs.mkdirSync(path.join(home, 'Library', 'LaunchAgents'), { recursive: true });

  const label = 'com.nanoclaw-v2-testslug';
  if (plistInstalled) {
    fs.writeFileSync(path.join(home, 'Library', 'LaunchAgents', `${label}.plist`), '<plist/>');
  }

  const stub = `#!/usr/bin/env bash
echo "$@" >> ${JSON.stringify(callLog)}
if [ "$1" = "print" ]; then exit ${printExit}; fi
exit 0
`;
  fs.writeFileSync(path.join(binDir, 'launchctl'), stub, { mode: 0o755 });

  const script = `
    set -u
    launchd_label() { printf '%s' ${JSON.stringify(label)}; }
    ${extractRestartDarwin()}
    restart_darwin
  `;
  execFileSync('bash', ['-c', script], {
    env: { ...process.env, PATH: `${binDir}:${process.env.PATH}`, HOME: home },
    stdio: 'ignore',
  });

  return fs.existsSync(callLog) ? fs.readFileSync(callLog, 'utf8').trim().split('\n') : [];
}

describe('restart.sh restart_darwin', () => {
  it('kickstarts -k when the service is loaded (previous behavior preserved)', () => {
    const calls = runRestartDarwin(0, true);
    expect(calls[0]).toMatch(/^print gui\//);
    expect(calls[1]).toMatch(/^kickstart -k gui\/.*com\.nanoclaw-v2-testslug$/);
    expect(calls).toHaveLength(2);
  });

  it('bootstraps the plist then kickstarts when unloaded but installed — the #2583 state', () => {
    const calls = runRestartDarwin(113, true);
    expect(calls[0]).toMatch(/^print gui\//);
    expect(calls[1]).toMatch(/^bootstrap gui\/\d+ .*com\.nanoclaw-v2-testslug\.plist$/);
    expect(calls[2]).toMatch(/^kickstart gui\/.*com\.nanoclaw-v2-testslug$/);
    // The bare (non--k) kickstart: bootstrap already started RunAtLoad jobs,
    // kickstart only demand-starts a job launchd left pended.
    expect(calls[2]).not.toContain('-k');
  });

  it('does nothing beyond the probe when the service was never installed', () => {
    const calls = runRestartDarwin(113, false);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatch(/^print gui\//);
  });
});
