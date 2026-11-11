// Behavior tests for the /add-resend skill's steps.
//
// The conformance suite proves the skill's `nc:` fences apply against a stubbed
// exec; it says nothing about what the shell inside them does. These tests take
// the real commands OUT of the SKILL.md and run them under POSIX `sh` in a
// throwaway project root, with a stub `pnpm` first on PATH (the real one never
// runs).
//
// The contract under test (the skill's prose says the same):
//   - the test step and the troubleshooting command go red when either Resend
//     test file is missing. vitest drops a file filter that matches nothing as
//     long as another filter matches, so each file gets its own run.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseDirectives } from './skill-directives.js';

const SKILL_MD = path.resolve(__dirname, '../.claude/skills/add-resend/SKILL.md');
const md = fs.readFileSync(SKILL_MD, 'utf8');
const directives = parseDirectives(md);

const REGISTRATION_TEST = 'src/channels/resend-registration.test.ts';
const DELIVERY_TEST = 'src/channels/resend.test.ts';

// The commands under test, as written in the document.
const testStep = directives.filter((d) => d.kind === 'run' && d.attrs.effect === 'test').flatMap((d) => d.body);
const troubleshooting = /^\*\*Adapter installed but nothing flows\.\*\* Run `([^`]+)`/m.exec(md)?.[1] ?? '';

// Follows vitest's file-filter rule: a run exits 0 when at least one named file
// exists and 1 only when none do.
const PNPM_STUB = `#!/bin/sh
echo "pnpm $*" >> "$CALLS"
[ "$1 $2 $3" = "exec vitest run" ] || exit 0
shift 3
for f in "$@"; do [ -f "$f" ] && exit 0; done
echo "No test files found, exiting with code 1" >&2
exit 1
`;

let root: string;
let bin: string;
let calls: string;

function write(rel: string, content = ''): void {
  fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
  fs.writeFileSync(path.join(root, rel), content);
}

function sh(cmd: string): number {
  const r = spawnSync('sh', ['-c', cmd], {
    cwd: root,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls },
    encoding: 'utf8',
  });
  return r.status ?? 1;
}

// The engine runs a step's lines one by one and stops at the first that fails.
function runStep(cmds: string[]): number {
  for (const cmd of cmds) {
    const status = sh(cmd);
    if (status !== 0) return status;
  }
  return 0;
}

const vitestCalls = () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).join('\n');

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-resend-'));
  bin = path.join(root, 'bin');
  calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(bin, 'pnpm'), PNPM_STUB, { mode: 0o755 });
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('add-resend: the document carries the commands under test', () => {
  it('has a test step and a troubleshooting command that name both test files', () => {
    for (const text of [testStep.join('\n'), troubleshooting]) {
      expect(text).toContain(REGISTRATION_TEST);
      expect(text).toContain(DELIVERY_TEST);
    }
  });
});

describe('add-resend: a missing test file is red', () => {
  const commands: Array<[string, () => number]> = [
    ['the test step', () => runStep(testStep)],
    ['the troubleshooting command', () => sh(troubleshooting)],
  ];

  it.each(commands)('%s passes with both test files in place', (_name, run) => {
    write(REGISTRATION_TEST);
    write(DELIVERY_TEST);
    expect(run()).toBe(0);
    expect(vitestCalls()).toContain(REGISTRATION_TEST);
    expect(vitestCalls()).toContain(DELIVERY_TEST);
  });

  // An install from before resend.test.ts existed has only the registration test.
  it.each(commands)('%s fails when resend.test.ts is missing', (_name, run) => {
    write(REGISTRATION_TEST);
    expect(run()).not.toBe(0);
  });

  it.each(commands)('%s fails when resend-registration.test.ts is missing', (_name, run) => {
    write(DELIVERY_TEST);
    expect(run()).not.toBe(0);
  });
});
