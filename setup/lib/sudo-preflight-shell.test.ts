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
  docker?: boolean;
  /** sudo's answers, or absent when sudo isn't installed. */
  sudo?: { cached: boolean; validates: boolean };
  interactive?: boolean;
  env?: Record<string, string>;
  /** nanoclaw.sh's own arguments, which it passes on. */
  args?: string[];
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
  if (m.docker) stub('docker', 'exit 0');
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
    `if sudo_preflight ${(m.args ?? []).map((a) => `'${a}'`).join(' ')}; then echo "rc=0"; else echo "rc=1"; fi`,
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
  it('asks for the password in the open when Node and Docker are missing', () => {
    const r = run({ sudo: needsPassword, interactive: true });
    expect(r.rc).toBe(0);
    expect(r.out).toContain('Setup needs to install Node and Docker');
    expect(r.out).toContain('Linux password');
    expect(r.sudo).toEqual(['-n true', '-v -p   [sudo] password for %p: ']);
  });

  it('names only what is missing', () => {
    expect(run({ node: 'v22.23.4', sudo: needsPassword, interactive: true }).out).toContain('install Docker,');
    expect(run({ docker: true, sudo: needsPassword, interactive: true }).out).toContain('install Node,');
  });

  // install-node.sh puts NodeSource's Node over an outdated system one with sudo.
  it.each(['v20.18.1', 'v22.12.0', 'v24.1.0', 'v26.2.5'])('asks before updating a system Node %s', (node) => {
    const r = run({ node, docker: true, sudo: needsPassword, interactive: true });
    expect(r.out).toContain('Setup needs to install a newer Node,');
    expect(r.sudo).toContain('-v -p   [sudo] password for %p: ');
  });

  it('names a newer Node next to Docker', () => {
    const r = run({ node: 'v22.12.0', sudo: { cached: false, validates: false }, interactive: true });
    expect(r.out).toContain("Couldn't get sudo access to install a newer Node and Docker.");
    expect(r.out).toContain('install a newer Node (minimum 22.23.4 / 24.22.1 / 26.12.1) and Docker yourself');
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
    const r = run({ docker: true, sudo: needsPassword, interactive: true, ...m });
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
    // Docker still counts on its own.
    expect(run({ ...m, sudo: needsPassword, interactive: true }).out).toContain('Setup needs to install Docker,');
  });

  it('stops with a clear message when sudo is refused', () => {
    const r = run({ sudo: { cached: false, validates: false }, interactive: true });
    expect(r.rc).toBe(1);
    expect(r.out).toContain("Couldn't get sudo access to install Node and Docker.");
    expect(r.out).toContain('install Node (minimum 22.23.4 / 24.22.1 / 26.12.1) and Docker yourself');
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
    ['a patched Node and Docker present', { node: 'v24.22.1', docker: true }],
    ['uvx installs Node without sudo and Docker is present', { uvx: true, docker: true }],
  ])('does not touch sudo for %s', (_name, m) => {
    const r = run({ sudo: needsPassword, interactive: true, ...m });
    expect(r.rc).toBe(0);
    expect(r.out).toBe('');
    expect(r.sudo).toEqual([]);
  });

  it('leaves Docker out when the run skips the container step', () => {
    const skipped = { sudo: needsPassword, interactive: true, env: { NANOCLAW_SKIP: 'environment, container' } };
    expect(run({ ...skipped, node: 'v22.23.4' }).sudo).toEqual([]);
    expect(run(skipped).out).toContain('install Node,');
  });

  // setup:auto reads --skip too, and the flag wins over the environment.
  it.each([[['--skip', 'container']], [['--template-path', 'sales/sdr', '--skip=environment,container']]])(
    'honours %j on the command line',
    (args) => {
      expect(run({ node: 'v22.23.4', sudo: needsPassword, interactive: true, args }).sudo).toEqual([]);
    },
  );

  it('lets --skip replace NANOCLAW_SKIP, as setup:auto does', () => {
    const r = run({
      node: 'v22.23.4',
      sudo: needsPassword,
      interactive: true,
      env: { NANOCLAW_SKIP: 'container' },
      args: ['--skip', 'environment'],
    });
    expect(r.out).toContain('install Docker,');
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
    const call = entrypoint.indexOf('if ! sudo_preflight "$@"; then', source);
    const spinner = entrypoint.indexOf('spinner_start "$BOOTSTRAP_LABEL"');
    expect(source).toBeGreaterThan(-1);
    expect(call).toBeGreaterThan(source);
    expect(spinner).toBeGreaterThan(call);
  });
});
