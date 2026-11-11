// The conformance suite proves the /add-resend fences apply against a stubbed
// exec, not what the shell inside them does. These tests take the commands out
// of the SKILL.md and run them under `sh` in a throwaway root, with stub `pnpm`
// and `git` first on PATH: the real pnpm never runs and nothing is fetched.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySkill } from './skill-apply.js';
import { parseDirectives } from './skill-directives.js';

const SKILL_MD = path.resolve(__dirname, '../.claude/skills/add-resend/SKILL.md');
const md = fs.readFileSync(SKILL_MD, 'utf8');
const directives = parseDirectives(md);

const ADAPTER = 'src/channels/resend.ts';
const REGISTRATION_TEST = 'src/channels/resend-registration.test.ts';
const DELIVERY_TEST = 'src/channels/resend.test.ts';
const BARREL = 'src/channels/index.ts';

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

// Stands in for the `channels` branch: `fetch` fails unless FETCH=ok, and `show`
// serves the files under $BRANCH.
const GIT_STUB = `#!/bin/sh
echo "git $*" >> "$CALLS"
case "$1" in
  fetch)
    [ "$FETCH" = ok ] && exit 0
    echo "fatal: unable to access the remote" >&2
    exit 128
    ;;
  show) cat "$BRANCH/\${2#*:}" ;;
esac
`;

const OLD_ADAPTER = '// an adapter from before the registration export\nexport {};\n';
const NEW_ADAPTER = 'export const resendRegistration = {};\n';

let root: string;
let bin: string;
let calls: string;
let branch: string;

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

const callLog = () => fs.readFileSync(calls, 'utf8').split('\n').filter(Boolean).join('\n');

const read = (rel: string) => fs.readFileSync(path.join(root, rel), 'utf8');
const channelFiles = () => fs.readdirSync(path.join(root, 'src/channels')).sort();

// An install that already has the channel wired: the barrel imports the adapter
// and the package is in place, so only the copy step has work to do.
function installed(adapter: string | null): void {
  write('package.json', JSON.stringify({ dependencies: { '@resend/chat-sdk-adapter': '0.3.0' } }));
  write(BARREL, "import './cli.js';\nimport './resend.js';\n");
  write(REGISTRATION_TEST);
  if (adapter !== null) write(ADAPTER, adapter);
}

// Applies the real SKILL.md, running every command for real against the stubs.
// No prompt answers are given, so the credential and wiring steps wait.
function apply(fetch: 'ok' | 'fails') {
  return applySkill(path.dirname(SKILL_MD), root, {
    resolveRemote: () => 'origin',
    exec: (cmd) =>
      execFileSync('sh', ['-c', cmd], {
        cwd: root,
        env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls, BRANCH: branch, FETCH: fetch },
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
  });
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-resend-'));
  bin = path.join(root, 'bin');
  calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  fs.writeFileSync(calls, '');
  fs.writeFileSync(path.join(bin, 'pnpm'), PNPM_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(bin, 'git'), GIT_STUB, { mode: 0o755 });
  branch = path.join(root, 'channels-branch');
  for (const [rel, content] of [
    [ADAPTER, NEW_ADAPTER],
    [DELIVERY_TEST, '// delivery test\n'],
    [REGISTRATION_TEST, '// registration test\n'],
  ]) {
    fs.mkdirSync(path.dirname(path.join(branch, rel)), { recursive: true });
    fs.writeFileSync(path.join(branch, rel), content);
  }
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
    expect(callLog()).toContain(REGISTRATION_TEST);
    expect(callLog()).toContain(DELIVERY_TEST);
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

describe('add-resend: re-running on an install with an older resend.ts', () => {
  it('swaps the older adapter for the current one when the copy works', async () => {
    installed(OLD_ADAPTER);
    const res = await apply('ok');
    expect(res.agentTasks).toEqual([]);
    expect(read(ADAPTER)).toBe(NEW_ADAPTER);
    expect(channelFiles()).toEqual(['index.ts', 'resend-registration.test.ts', 'resend.test.ts', 'resend.ts']);
  });

  it('leaves the older adapter in place when the copy fails', async () => {
    installed(OLD_ADAPTER);
    const res = await apply('fails');
    // The copy is the one real failure; build and test are held back behind it.
    expect(res.agentTasks.filter((t) => !t.reason.startsWith('skipped:')).map((t) => t.kind)).toEqual(['copy']);
    expect(read(ADAPTER)).toBe(OLD_ADAPTER);
    expect(channelFiles()).toEqual(['index.ts', 'resend-registration.test.ts', 'resend.ts']);
  });

  it('puts back an adapter that a cut-off earlier run left set aside', async () => {
    installed(null);
    write(`${ADAPTER}.old`, OLD_ADAPTER);
    await apply('fails');
    expect(read(ADAPTER)).toBe(OLD_ADAPTER);
    expect(channelFiles()).toEqual(['index.ts', 'resend-registration.test.ts', 'resend.ts']);
  });

  it('adds no failure of its own when a first install cannot fetch', async () => {
    write('package.json', JSON.stringify({ dependencies: { '@resend/chat-sdk-adapter': '0.3.0' } }));
    write(BARREL, "import './cli.js';\n");
    const res = await apply('fails');
    expect(res.agentTasks.filter((t) => !t.reason.startsWith('skipped:')).map((t) => t.kind)).toEqual(['copy']);
    expect(channelFiles()).toEqual(['index.ts']);
  });

  it('does not touch or re-fetch a current adapter', async () => {
    installed(NEW_ADAPTER);
    write(DELIVERY_TEST);
    const res = await apply('fails');
    expect(res.agentTasks).toEqual([]);
    expect(read(ADAPTER)).toBe(NEW_ADAPTER);
    expect(callLog()).not.toContain('git fetch');
    expect(channelFiles()).toEqual(['index.ts', 'resend-registration.test.ts', 'resend.test.ts', 'resend.ts']);
  });
});
