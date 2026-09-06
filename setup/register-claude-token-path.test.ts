/**
 * Pin the PATH-before-guard ordering in setup/register-claude-token.sh
 * (#3354 bug 2).
 *
 * onecli installs into ~/.local/bin, which a non-login shell (headless ssh
 * command) does not have on PATH. The script's `command -v onecli` guard
 * used to run before any PATH fix — the fix lived only inside the
 * claude-not-found branch further down — so a good install failed with
 * "onecli not found" whenever setup ran non-interactively.
 *
 * The test runs the real script under bash with HOME pointed at a fixture
 * whose ~/.local/bin holds a stub `onecli`, and a PATH that deliberately
 * lacks it. Passing the guard proves the PATH fix now precedes it; the
 * script is then allowed to stop at the next dependency probe.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(setupDir, 'register-claude-token.sh');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-register-token-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function runScript(opts: { onecliInLocalBin: boolean }): { status: number | null; stderr: string } {
  const home = path.join(tmpDir, 'home');
  const localBin = path.join(home, '.local', 'bin');
  const sysBin = path.join(tmpDir, 'sysbin');
  fs.mkdirSync(localBin, { recursive: true });
  fs.mkdirSync(sysBin, { recursive: true });

  // Minimal system PATH: bash internals need coreutils; symlink the ones the
  // preamble uses so ~/.local/bin is the ONLY place onecli can come from.
  for (const tool of ['bash', 'dirname', 'uname', 'mktemp', 'rm', 'cp', 'grep', 'cat']) {
    const real = spawnSync('which', [tool], { encoding: 'utf8' }).stdout.trim();
    if (real) fs.symlinkSync(real, path.join(sysBin, tool));
  }

  if (opts.onecliInLocalBin) {
    fs.writeFileSync(path.join(localBin, 'onecli'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });
  }
  // No `script` binary on PATH: with the onecli guard passed and claude
  // "present", the run stops deterministically at the PTY-capture probe.
  fs.writeFileSync(path.join(localBin, 'claude'), '#!/usr/bin/env bash\nexit 0\n', { mode: 0o755 });

  const res = spawnSync('bash', [scriptPath], {
    encoding: 'utf8',
    env: { HOME: home, PATH: sysBin },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { status: res.status, stderr: res.stderr ?? '' };
}

describe('register-claude-token.sh non-login PATH (#3354 bug 2)', () => {
  it('finds onecli in ~/.local/bin even when PATH lacks it', () => {
    const { stderr } = runScript({ onecliInLocalBin: true });
    // The old bug: exit 1 with "onecli not found" before any PATH fix ran.
    expect(stderr).not.toContain('onecli not found');
    // Guard passed; the run stops at the next dependency (script(1)),
    // proving execution got past the previously failing point.
    expect(stderr).toContain('script(1) is required');
  });

  it('still fails cleanly when onecli is genuinely absent', () => {
    const { status, stderr } = runScript({ onecliInLocalBin: false });
    expect(status).toBe(1);
    expect(stderr).toContain('onecli not found');
  });
});
