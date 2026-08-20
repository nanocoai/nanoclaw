/**
 * Behaviour of the mnemon registration call — payload guard of `add-mnemon`.
 *
 * Installed to `container/agent-runner/src/mnemon/setup.test.ts` (Bun runner:
 * this tree's tests import from `bun:test`, not vitest).
 *
 * A stub `mnemon` on PATH records the argv it was handed, so these cases assert
 * the exact command the container runs — not that some string exists in some
 * file. The companion `startup.test.ts` proves the call is reached from the
 * entry module the host's spawn argv actually names.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { ensureMnemonSetup } from './setup.js';

let tmp: string;
let argvLog: string;
const realPath = process.env.PATH;

/** Write a stub `mnemon` that appends its argv to `argvLog` and exits `code`. */
function stubMnemon(code: number): void {
  const bin = path.join(tmp, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const stub = path.join(bin, 'mnemon');
  fs.writeFileSync(
    stub,
    ['#!/bin/sh', `printf '%s\\n' "$*" >> "${argvLog}"`, 'echo "stub stdout"', `exit ${code}`, ''].join('\n'),
  );
  fs.chmodSync(stub, 0o755);
  process.env.PATH = bin;
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mnemon-setup-'));
  argvLog = path.join(tmp, 'argv.log');
});

afterEach(() => {
  process.env.PATH = realPath;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function recordedArgv(): string[] {
  return fs.existsSync(argvLog) ? fs.readFileSync(argvLog, 'utf8').trim().split('\n') : [];
}

describe('ensureMnemonSetup', () => {
  it('runs the non-interactive, user-wide claude-code setup for the claude provider', () => {
    stubMnemon(0);
    const outcome = ensureMnemonSetup('claude', () => {});
    expect(outcome).toEqual({ status: 'registered', target: 'claude-code' });
    // --yes: no TTY in a container. --global: $HOME/.claude is the mounted,
    // host-backed dir, whereas a project-local install would land in the
    // ephemeral cwd and vanish with the container.
    expect(recordedArgv()).toEqual(['setup --target claude-code --yes --global']);
  });

  it('accepts the provider name in whatever case the runner resolved it', () => {
    stubMnemon(0);
    expect(ensureMnemonSetup('CLAUDE', () => {}).status).toBe('registered');
  });

  it('reports a missing binary instead of throwing, so the runner still starts', () => {
    // The image was never rebuilt with the Dockerfile layer.
    process.env.PATH = path.join(tmp, 'empty');
    const logged: string[] = [];
    expect(ensureMnemonSetup('claude', (m) => logged.push(m))).toEqual({ status: 'binary-missing' });
    expect(logged.join(' ')).toContain('build.sh');
  });

  it('reports a failing setup instead of throwing, and says memory is off', () => {
    stubMnemon(3);
    const logged: string[] = [];
    const outcome = ensureMnemonSetup('claude', (m) => logged.push(m));
    expect(outcome.status).toBe('failed');
    expect(logged.join(' ')).toContain('memory stays off');
  });

  it('does not invoke mnemon at all for a provider this install does not wire', () => {
    stubMnemon(0);
    const outcome = ensureMnemonSetup('opencode', () => {});
    expect(outcome).toEqual({ status: 'unsupported-provider', provider: 'opencode' });
    expect(recordedArgv()).toEqual([]);
  });
});
