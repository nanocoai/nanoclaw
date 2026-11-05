import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * nanoclaw.sh's sudo pre-flight, run under bash with every command it calls
 * stubbed on an otherwise empty PATH. A real terminal can't be had under
 * vitest, so "interactive" cases replace the terminal check after sourcing.
 */
const LIB = path.join(process.cwd(), 'setup', 'lib', 'sudo-preflight.sh');

interface Machine {
  os?: string;
  uid?: number;
  /** `node --version` of the Node on PATH, or absent. */
  node?: string;
  /** Where that Node lives: the system dir NodeSource replaces (default) or a version manager's. */
  nodeFrom?: 'system' | 'manager';
  /** `node --version` of a Node in ~/.local/bin, off PATH. */
  localNode?: string;
  uvx?: boolean;
  /** jq on PATH, or only in ~/.local/bin (off PATH until setup:auto adds it). */
  jq?: 'path' | 'local';
  /** The package manager on PATH that setup would install jq with. */
  pkg?: string;
  /** sudo's answers, or absent when sudo isn't installed. */
  sudo?: { cached: boolean; validates: boolean };
  interactive?: boolean;
  env?: Record<string, string>;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sudo-preflight-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(m: Machine): { rc: number; out: string; sudo: string[] } {
  // A fresh machine per run, so stubs from an earlier run in the same test don't leak.
  const machine = fs.mkdtempSync(path.join(dir, 'machine-'));
  const bin = path.join(machine, 'bin');
  // Stand-ins for /usr/bin and an nvm-style dir; the host's own Node dirs never leak in.
  const system = path.join(machine, 'usr', 'bin');
  const manager = path.join(machine, '.nvm', 'bin');
  const sudoLog = path.join(machine, 'sudo.log');
  const stub = (name: string, body: string, where = bin): void => {
    fs.mkdirSync(where, { recursive: true });
    fs.writeFileSync(path.join(where, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  fs.mkdirSync(system, { recursive: true });
  stub('uname', `echo ${m.os ?? 'Linux'}`);
  stub('id', `echo ${m.uid ?? 1000}`);
  if (m.node) stub('node', `echo ${m.node}`, m.nodeFrom === 'manager' ? manager : system);
  if (m.localNode) stub('node', `echo ${m.localNode}`, path.join(machine, '.local', 'bin'));
  if (m.uvx) stub('uvx', 'exit 0');
  if (m.jq === 'path') stub('jq', 'exit 0');
  if (m.jq === 'local') stub('jq', 'exit 0', path.join(machine, '.local', 'bin'));
  if (m.pkg) stub(m.pkg, 'exit 0');
  if (m.sudo) {
    stub(
      'sudo',
      [
        `echo "$*" >> '${sudoLog}'`,
        `[ "$1" = "-n" ] && exit ${m.sudo.cached ? 0 : 1}`,
        `[ "$1" = "-v" ] && exit ${m.sudo.validates ? 0 : 1}`,
        'exit 2',
      ].join('\n'),
    );
  }

  // Same shell options as nanoclaw.sh, which sources the library.
  const script = [
    'set -euo pipefail',
    'dim() { printf "%s" "$1"; }',
    'red() { printf "%s" "$1"; }',
    `source '${LIB}'`,
    m.interactive ? 'sudo_preflight_interactive() { return 0; }' : '',
    'if sudo_preflight; then echo "rc=0"; else echo "rc=1"; fi',
  ].join('\n');
  const res = spawnSync('/bin/bash', ['-c', script], {
    env: {
      PATH: [bin, manager, system].join(':'),
      HOME: machine,
      NODE_APT_DIRS: system,
      NODE_SYSTEM_DIRS: system,
      ...m.env,
    },
    encoding: 'utf8',
  });
  expect(res.stderr).toBe('');
  const out = res.stdout;
  const rc = /rc=(\d)/.exec(out)?.[1];
  const sudo = fs.existsSync(sudoLog) ? fs.readFileSync(sudoLog, 'utf8').split('\n').filter(Boolean) : [];
  return { rc: Number(rc), out: out.replace(/rc=\d\n$/, ''), sudo };
}

const needsPassword = { cached: false, validates: true };

// Each case spawns bash, sometimes twice; the default 5 s is tight on a loaded runner.
describe('sudo pre-flight (nanoclaw.sh)', { timeout: 20_000 }, () => {
  it('asks for the password in the open when Node is missing', () => {
    const r = run({ sudo: needsPassword, interactive: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('Setup needs to install Node, so it will ask for your Linux password');
    expect(r.sudo).toEqual(['-n true', '-v -p   [sudo] password for %p: ']);
  });

  // setup:auto asks for Docker right before its container step, with ~/.local/bin on PATH.
  it('leaves Docker to the container step', () => {
    const r = run({ node: 'v22.23.4', sudo: needsPassword, interactive: true });
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
    expect(run({ sudo: needsPassword, interactive: true }).out).not.toContain('Docker');
  });

  // install-node.sh puts NodeSource's Node over an outdated system one with sudo.
  it.each(['v20.18.1', 'v22.12.0', 'v24.1.0', 'v26.2.5'])('asks before updating a system Node %s', (node) => {
    const r = run({ node, sudo: needsPassword, interactive: true });
    expect(r.out).toContain('Setup needs to install a newer Node,');
    expect(r.sudo).toContain('-v -p   [sudo] password for %p: ');
  });

  it('names a newer Node when sudo is refused for one', () => {
    const r = run({ node: 'v22.12.0', sudo: { cached: false, validates: false }, interactive: true });
    expect(r.out).toContain("Couldn't get sudo access to install a newer Node.");
    expect(r.out).toContain('install a newer Node (minimum 22.23.4 / 24.22.1 / 26.12.1) yourself first.');
  });

  // install-node.sh stops without sudo for these, or setup.sh never runs it.
  it.each<[string, Machine]>([
    ['a patched Node', { node: 'v22.23.4' }],
    ["a version manager's outdated Node", { node: 'v22.12.0', nodeFrom: 'manager' }],
    ['a patched Node in ~/.local/bin behind an outdated PATH one', { node: 'v22.12.0', localNode: 'v22.23.4' }],
    ['a patched Node in ~/.local/bin and none on PATH', { localNode: 'v24.22.1' }],
    ['uvx with an outdated system Node', { node: 'v22.12.0', uvx: true }],
    ['Node 23', { node: 'v23.11.0' }],
    ['Node 25', { node: 'v25.1.0' }],
    ['a pre-release Node', { node: 'v24.0.0-nightly20260401abcdef' }],
  ])('does not ask to install Node for %s', (_name, m) => {
    const r = run({ sudo: needsPassword, interactive: true, ...m });
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
  });

  it('stops with a clear message when sudo is refused', () => {
    const r = run({ sudo: { cached: false, validates: false }, interactive: true });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("Couldn't get sudo access to install Node.");
    expect(r.out).toContain('install Node (minimum 22.23.4 / 24.22.1 / 26.12.1) yourself first.');
  });

  it('does not ask when sudo works without a password', () => {
    const r = run({ sudo: { cached: true, validates: false }, interactive: true });
    expect(r.rc).toBe(0);
    expect(r.out).toBe('');
    expect(r.sudo).toEqual(['-n true']);
  });

  it.each<[string, Machine]>([
    ['root', { uid: 0 }],
    ['macOS', { os: 'Darwin' }],
    ['a patched Node', { node: 'v24.22.1' }],
    ['uvx, which installs Node without sudo', { uvx: true }],
  ])('does not touch sudo for %s', (_name, m) => {
    const r = run({ sudo: needsPassword, interactive: true, ...m });
    expect(r.rc).toBe(0);
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
  });

  // The bootstrap installs jq with sudo -n, so it needs the same answer.
  it('asks to install jq when it is missing and a package manager can install it', () => {
    const r = run({ node: 'v22.23.4', pkg: 'apt-get', sudo: needsPassword, interactive: true });
    expect(r.out).toContain('Setup needs to install jq, so it will ask for your Linux password');
    expect(r.sudo).toEqual(['-n true', '-v -p   [sudo] password for %p: ']);
  });

  it('names Node and jq together', () => {
    const fresh = { pkg: 'apt-get', sudo: needsPassword, interactive: true };
    expect(run(fresh).out).toContain('Setup needs to install Node and jq,');
    expect(run({ ...fresh, node: 'v22.12.0' }).out).toContain('Setup needs to install a newer Node and jq,');
  });

  // These install Node without sudo; jq still needs it.
  it.each<[string, Machine]>([
    ["a version manager's Node", { node: 'v22.12.0', nodeFrom: 'manager' }],
    ['uvx', { uvx: true }],
  ])('asks for jq alone with %s', (_name, m) => {
    expect(run({ ...m, pkg: 'dnf', sudo: needsPassword, interactive: true }).out).toContain(
      'Setup needs to install jq,',
    );
  });

  it.each<[string, Machine]>([
    ['jq on PATH', { jq: 'path', pkg: 'apt-get' }],
    ['jq in ~/.local/bin, off PATH', { jq: 'local', pkg: 'apt-get' }],
    ['no package manager setup knows', {}],
    ['root', { uid: 0, pkg: 'apt-get' }],
    ['macOS with Homebrew', { os: 'Darwin', pkg: 'brew' }],
  ])('does not ask for jq with %s', (_name, m) => {
    const r = run({ node: 'v22.23.4', sudo: needsPassword, interactive: true, ...m });
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
  });

  // Only skills need jq, so a user without sudo can still install NanoClaw.
  it('goes on without jq when sudo is refused and only jq needed it', () => {
    const r = run({ node: 'v22.23.4', pkg: 'apt-get', sudo: { cached: false, validates: false }, interactive: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('Going on without jq for now.');
    expect(r.out).not.toContain("Couldn't get sudo access");
  });

  it('names jq when sudo is refused', () => {
    const r = run({ pkg: 'apt-get', sudo: { cached: false, validates: false }, interactive: true });
    expect(r.out).toContain("Couldn't get sudo access to install Node and jq.");
    expect(r.out).toContain('install Node (minimum 22.23.4 / 24.22.1 / 26.12.1) and jq yourself first.');
  });

  it('keeps the old behaviour without a terminal, never prompting', () => {
    const r = run({ sudo: needsPassword });
    expect(r.rc).toBe(0);
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
  });

  it('leaves a machine without sudo to the installers, as before', () => {
    const r = run({ interactive: true });
    expect(r.rc).toBe(0);
    expect(r.out).toBe('');
  });

  it('runs in nanoclaw.sh before the bootstrap spinner starts', () => {
    const entrypoint = fs.readFileSync(path.join(process.cwd(), 'nanoclaw.sh'), 'utf8');
    const source = entrypoint.indexOf('source "$PROJECT_ROOT/setup/lib/sudo-preflight.sh"');
    const call = entrypoint.indexOf('if ! sudo_preflight; then', source);
    const spinner = entrypoint.indexOf('spinner_start "$BOOTSTRAP_LABEL"');
    expect(source).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(source);
    expect(spinner).toBeGreaterThan(call);
  });
});
