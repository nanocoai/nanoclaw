/**
 * Executed-path guard for the mnemon wiring — `add-mnemon`'s load-bearing test.
 *
 * Installed to `container/agent-runner/src/mnemon/startup.test.ts` (Bun runner).
 *
 * This test does not read a file and look for a string. It *runs* the entry
 * module the host's spawn argv names (`bun run /app/src/index.ts`, whose host
 * side is `container/agent-runner/src/index.ts`) with a stub `mnemon` first on
 * PATH, and asserts the stub was invoked. So it goes red for the whole family
 * of failures where the setup call exists somewhere that never executes —
 * which is exactly how this skill was broken before: the call lived in
 * `container/entrypoint.sh`, a file the spawn path overrides and never runs.
 * A grep-the-shell-script test stayed green through 100% inert installs.
 *
 * Outside a container the runner aborts a few statements later — there is no
 * /workspace to open a mailbox in — so this asserts the invocation, never the
 * exit code. The call is placed before the mailbox opens for exactly this
 * reason as well as the ordering one: memory registration depends on nothing
 * but $HOME.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

/** container/agent-runner/src — this file lives in src/mnemon/. */
const RUNNER_SRC = path.resolve(import.meta.dir, '..');

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-startup-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('the agent-runner entry module registers mnemon on start', () => {
  it('invokes mnemon setup when the real entry module runs', async () => {
    const argvLog = path.join(tmp, 'argv.log');
    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(
      path.join(bin, 'mnemon'),
      ['#!/bin/sh', `printf '%s\\n' "$*" >> "${argvLog}"`, 'exit 0', ''].join('\n'),
    );
    fs.chmodSync(path.join(bin, 'mnemon'), 0o755);

    const child = spawn(process.execPath, ['run', path.join(RUNNER_SRC, 'index.ts')], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    try {
      const deadline = Date.now() + 30_000;
      while (!fs.existsSync(argvLog) && Date.now() < deadline) {
        if (child.exitCode !== null && !fs.existsSync(argvLog)) break;
        await new Promise((r) => setTimeout(r, 100));
      }
    } finally {
      child.kill('SIGKILL');
    }

    expect(fs.existsSync(argvLog), `mnemon was never invoked. Runner stderr:\n${stderr}`).toBe(true);
    expect(fs.readFileSync(argvLog, 'utf8').trim().split('\n')).toEqual(['setup --target claude-code --yes --global']);
  }, 45_000);
});
