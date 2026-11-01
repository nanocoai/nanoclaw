/**
 * Runs the real setup/lib/node-version.sh and setup/install-node.sh under bash,
 * on a PATH holding only stub node / brew / apt-get and a few coreutils.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Each case spawns several bash processes; a loaded machine can pass 5 s.
vi.setConfig({ testTimeout: 20_000 });

const libDir = path.dirname(fileURLToPath(import.meta.url));
const LIB = path.join(libDir, 'node-version.sh');
const INSTALL_NODE = path.resolve(libDir, '..', 'install-node.sh');
const ROOT = path.resolve(libDir, '..', '..');

function which(cmd: string): string {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const found = r.stdout.trim();
  if (r.status !== 0 || !found) throw new Error(`${cmd} not found on the test host`);
  return found;
}

const BASH = which('bash');
const TOOLS = ['dirname', 'mkdir', 'ln'].map((tool) => [tool, which(tool)] as const);

let tmp: string;
let bin: string;
let keg: string;
let log: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-node-version-'));
  bin = path.join(tmp, 'bin');
  keg = path.join(tmp, 'keg', 'bin');
  log = path.join(tmp, 'calls.log');
  fs.mkdirSync(bin);
  for (const [tool, real] of TOOLS) fs.symlinkSync(real, path.join(bin, tool));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

function stub(dir: string, name: string, body: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!${BASH}\n${body}\n`, { mode: 0o755 });
}

/** A `node` in `dir` that reports the version held in `<dir>/.node-version`. */
function fakeNode(dir: string, version: string): void {
  stub(dir, 'node', '[ "$1" = --version ] && read -r v < "${0%/*}/.node-version" && echo "$v"');
  fs.writeFileSync(path.join(dir, '.node-version'), `v${version}\n`);
}

// The system-dir lists point at an empty dir, so the host's own Node never leaks in.
function run(args: string[], env: Record<string, string> = {}): { status: number | null; out: string } {
  const sys = path.join(tmp, 'sys');
  const base = { PATH: bin, HOME: path.join(tmp, 'home'), NODE_APT_DIRS: sys, NODE_SYSTEM_DIRS: sys };
  const r = spawnSync(BASH, args, { encoding: 'utf8', env: { ...base, ...env } });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);
const field = (out: string, name: string) => out.match(new RegExp(`^${name}: (.*)$`, 'm'))?.[1];

describe('node-version.sh', () => {
  it.each([
    ['22.23.4', true, '22'],
    ['v24.22.1', true, '24'],
    ['26.12.1', true, '26'],
    ['27.0.0', true, ''],
    ['22.23.3', false, '22'],
    ['24.22.0', false, '24'],
    ['26.2.5', false, '26'],
    ['20.19.5', false, '22'],
    ['25.3.0', false, ''],
    ['v27.0.0-nightly20261018f88a1d25e9', false, ''],
  ])('%s: meets minimum %s, install line "%s"', (version, meets, line) => {
    const src = 'source "$1"; node_meets_minimum "$2" && echo yes || echo no; node_install_line "$2" || :';
    expect(run(['-c', src, '_', LIB, version]).out.trim()).toBe(`${meets ? 'yes' : 'no'}\n${line}`.trim());
  });
});

describe('setup/install-node.sh', () => {
  function linux(): void {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'curl', `echo "curl $*" >> ${log}`);
    stub(bin, 'sudo', `echo "sudo $*" >> ${log}; [ "$1" = -E ] && shift; exec "$@"`);
    stub(bin, 'apt-get', `echo "apt-get $*" >> ${log}; echo v22.23.4 > ${bin}/.node-version`);
  }

  it('upgrades an unpatched system Node through nodesource on Linux', () => {
    fakeNode(bin, '22.20.0');
    linux();
    const r = run([INSTALL_NODE], { NODE_APT_DIRS: bin });
    expect(field(r.out, 'STATUS')).toBe('installed');
    expect(field(r.out, 'NODE_VERSION')).toBe('v22.23.4');
    // curl and sudo run as one pipeline, so their two lines land in either order.
    expect(calls().slice(0, 2).sort()).toEqual([
      'curl -fsSL https://deb.nodesource.com/setup_22.x',
      'sudo -E /bin/bash -',
    ]);
    expect(calls().slice(2)).toEqual(['sudo apt-get install -y nodejs', 'apt-get install -y nodejs']);
  });

  it("stops before sudo when Linux's Node comes from a version manager", () => {
    fakeNode(bin, '22.20.0');
    linux();
    const r = run([INSTALL_NODE]);
    expect(r.status).toBe(1);
    expect(field(r.out, 'ERROR')).toBe(
      `Node v22.20.0 at ${bin}/node does not meet the minimum (22.23.4 / 24.22.1 / 26.12.1). ` +
        'Update Node in your version manager to 22.23.4 or newer, then re-run setup.',
    );
    expect(calls()).toEqual([]);
  });

  it("installs Homebrew's node@22 on macOS and checks the keg Node", () => {
    fakeNode(bin, '24.10.0');
    stub(bin, 'uname', 'echo Darwin');
    fakeNode(keg, '0.0.0');
    stub(
      bin,
      'brew',
      `echo "brew $*" >> ${log}; case "$1" in --prefix) echo ${path.dirname(keg)} ;; install) echo v22.23.4 > ${keg}/.node-version ;; esac`,
    );
    const r = run([INSTALL_NODE]);
    expect(field(r.out, 'STATUS')).toBe('installed');
    expect(field(r.out, 'NODE_VERSION')).toBe('v22.23.4');
    expect(field(r.out, 'NOTE')).toBe(
      `NanoClaw will use Homebrew's node@22. Your own node (${bin}/node) stays on v24.10.0 until you update it, e.g. brew upgrade node.`,
    );
    expect(calls()).toContain('brew install node@22');
  });

  it('prints no NOTE on macOS when the old Node is the keg node@22 that brew upgrades', () => {
    stub(bin, 'uname', 'echo Darwin');
    fakeNode(keg, '22.20.0');
    stub(
      bin,
      'brew',
      `case "$1" in --prefix) echo ${path.dirname(keg)} ;; install) echo v22.23.4 > ${keg}/.node-version ;; esac`,
    );
    const r = run([INSTALL_NODE], { PATH: `${keg}:${bin}` });
    expect(field(r.out, 'STATUS')).toBe('installed');
    expect(field(r.out, 'NOTE')).toBeUndefined();
  });
});

describe('setup.sh ensure_node', () => {
  function ensureNode(): string {
    const source = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
    const fn = (name: string) => {
      const start = source.indexOf(`${name}() {`);
      expect(start, `${name}() not found in setup.sh`).toBeGreaterThanOrEqual(0);
      return source.slice(start, source.indexOf('\n}', start) + 2);
    };
    const project = path.join(tmp, 'project');
    stub(path.join(project, 'setup'), 'install-node.sh', `echo install-node >> ${log}; exit 1`);
    for (const tool of ['bash', 'sed', 'tee']) fs.symlinkSync(which(tool), path.join(bin, tool));
    const prelude = `source ${LIB}; PROJECT_ROOT=${project}; LOG_FILE=${tmp}/boot.log; log() { :; }`;
    return run(['-c', `${prelude}\n${fn('check_node')}\n${fn('ensure_node')}\nensure_node; echo "NODE_OK=$NODE_OK"`])
      .out.trim()
      .split('\n')
      .pop() as string;
  }

  it('uses a patched system Node behind an old PATH Node instead of installing', () => {
    stub(bin, 'uname', 'echo Linux');
    fakeNode(bin, '22.20.0');
    fakeNode(path.join(tmp, 'sys'), '22.23.4');
    expect(ensureNode()).toBe('NODE_OK=true');
    expect(calls()).toEqual([]);
  });

  it('runs install-node.sh when no installed Node meets the minimum', () => {
    stub(bin, 'uname', 'echo Linux');
    fakeNode(bin, '22.20.0');
    expect(ensureNode()).toBe('NODE_OK=false');
    expect(calls()).toEqual(['install-node']);
  });
});

describe('node_use_patched', () => {
  it('skips an old ~/.local/bin node for the keg-only node@22 on macOS', () => {
    const localBin = path.join(tmp, 'home', '.local', 'bin');
    fakeNode(bin, '22.20.0');
    fakeNode(localBin, '26.8.1');
    fakeNode(keg, '22.23.4');
    stub(bin, 'uname', 'echo Darwin');
    stub(bin, 'brew', `[ "$1" = --prefix ] && echo ${path.dirname(keg)}`);
    const r = run(['-c', `source ${LIB}; node_use_patched; echo "rc=$? $(command -v node)"`]);
    expect(r.out.trim()).toBe(`rc=0 ${keg}/node`);
  });

  it('falls back to the apt-installed system Node behind an old ~/.local/bin node', () => {
    const sys = path.join(tmp, 'sys');
    fakeNode(bin, '22.20.0');
    fakeNode(path.join(tmp, 'home', '.local', 'bin'), '22.12.0');
    fakeNode(sys, '22.23.4');
    stub(bin, 'uname', 'echo Linux');
    const r = run(['-c', `source ${LIB}; node_use_patched; echo "rc=$? $(command -v node)"`]);
    expect(r.out.trim()).toBe(`rc=0 ${sys}/node`);
  });
});

describe('nanoclaw.sh hand-off', () => {
  it('hands setup:auto the keg-only node@22 over an older PATH Node on macOS', () => {
    // The PATH recovery before `exec pnpm ... setup:auto`, which registers the
    // service with `command -v node`; the exec is swapped for a print of it.
    const source = fs.readFileSync(path.join(ROOT, 'nanoclaw.sh'), 'utf8');
    const start = source.indexOf('# setup.sh may have just installed Node/npm/pnpm');
    const end = source.indexOf('exec pnpm --silent run setup:auto "$@"');
    expect(start, 'hand-off section not found in nanoclaw.sh').toBeGreaterThanOrEqual(0);
    fakeNode(bin, '24.10.0');
    fakeNode(keg, '22.23.4');
    stub(bin, 'uname', 'echo Darwin');
    stub(bin, 'brew', `[ "$1" = --prefix ] && echo ${path.dirname(keg)}`);
    const prelude = `set -euo pipefail; PROJECT_ROOT=${ROOT}; red() { printf '%s' "$1"; }; write_abort_entry() { :; }`;
    const r = run(['-c', `${prelude}\n${source.slice(start, end)}echo "HANDOFF $(command -v node)"`]);
    expect(r.out.trim()).toBe(`HANDOFF ${keg}/node`);
  });
});

describe('migrate-v2.sh', () => {
  const source = () => fs.readFileSync(path.join(ROOT, 'migrate-v2.sh'), 'utf8');

  it("reads setup.sh's BOOTSTRAP block, not install-node.sh's lines in the same log", () => {
    const parse = source()
      .split('\n')
      .filter((l) => /^\s+(STATUS|NODE_VERSION)=\$\(awk /.test(l));
    expect(parse).toHaveLength(2);
    const raw = path.join(tmp, 'bootstrap.log');
    fs.writeFileSync(
      raw,
      'STATUS: installed\nNODE_VERSION: v22.23.4\n=== NANOCLAW SETUP: BOOTSTRAP ===\nNODE_VERSION: 22.23.4\nSTATUS: success\n' +
        'STATUS: installed\n',
    );
    fs.symlinkSync(which('awk'), path.join(bin, 'awk'));
    const r = run(['-c', `BOOTSTRAP_RAW=${raw}\n${parse.join('\n')}\necho "$STATUS $NODE_VERSION"`]);
    expect(r.out.trim()).toBe('success 22.23.4');
  });

  it('puts the keg-only node@22 first on macOS before the later steps run', () => {
    const src = source();
    const start = src.indexOf('# Later steps, and the service they register');
    const end = src.indexOf('# setup.sh may have installed pnpm to a prefix');
    expect(start, 'node check not found in migrate-v2.sh').toBeGreaterThanOrEqual(0);
    fakeNode(bin, '22.20.0');
    fakeNode(keg, '22.23.4');
    stub(bin, 'uname', 'echo Darwin');
    stub(bin, 'brew', `[ "$1" = --prefix ] && echo ${path.dirname(keg)}`);
    const prelude = `PROJECT_ROOT=${ROOT}; step_fail() { echo "$1"; }; abort() { exit 1; }`;
    const r = run(['-c', `${prelude}\n${src.slice(start, end)}echo "NEXT $(command -v node)"`]);
    expect(r.out.trim()).toBe(`NEXT ${keg}/node`);
  });
});
