/**
 * Which node setup.sh and nanoclaw.sh leave first on PATH. Runs the real
 * scripts under bash on a PATH holding only stubs and a few coreutils.
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
const ROOT = path.resolve(libDir, '..', '..');
const LIB = path.join(libDir, 'node-version.sh');

function which(cmd: string): string {
  const r = spawnSync('/bin/sh', ['-c', `command -v ${cmd}`], { encoding: 'utf8' });
  const found = r.stdout.trim();
  if (r.status !== 0 || !found) throw new Error(`${cmd} not found on the test host`);
  return found;
}

const BASH = which('bash');
const TOOLS = ['bash', 'grep', 'head', 'sed', 'tee'].map((tool) => [tool, which(tool)] as const);

let tmp: string;
let bin: string;
let home: string;
let localBin: string;
let keg: string;
let log: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ncl-node-path-'));
  bin = path.join(tmp, 'bin');
  home = path.join(tmp, 'home');
  localBin = path.join(home, '.local', 'bin');
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

function platform(os: 'Linux' | 'Darwin'): void {
  stub(bin, 'uname', `echo ${os}`);
  if (os === 'Darwin') stub(bin, 'brew', `[ "$1" = --prefix ] && echo ${path.dirname(keg)}`);
}

// The system-dir lists point at an empty dir, so the host's own Node never leaks in.
function run(script: string): { status: number | null; out: string } {
  const sys = path.join(tmp, 'sys');
  const env = { PATH: bin, HOME: home, NODE_APT_DIRS: sys, NODE_SYSTEM_DIRS: sys };
  const r = spawnSync(BASH, ['-c', script], { encoding: 'utf8', env });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

const calls = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n') : []);

/** A function's source from setup.sh, so it runs without the rest of the bootstrap. */
function setupFunction(name: string): string {
  const source = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
  const start = source.indexOf(`${name}() {`);
  expect(start, `${name}() not found in setup.sh`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

describe('node_use_patched', () => {
  const pathNode = () => run(`source ${LIB}; node_use_patched; echo "rc=$?"; command -v node`).out.split('\n');

  it('moves a Node that meets the minimum from ~/.local/bin ahead of the PATH one', () => {
    platform('Linux');
    fakeNode(bin, '22.20.0');
    fakeNode(localBin, '24.22.1');
    expect(pathNode()).toEqual(['rc=0', `${localBin}/node`]);
  });

  it("uses Homebrew's keg-only node@22 on macOS", () => {
    platform('Darwin');
    fakeNode(bin, '24.10.0');
    fakeNode(keg, '22.23.4');
    expect(pathNode()).toEqual(['rc=0', `${keg}/node`]);
  });

  it('keeps a PATH Node that meets the minimum in front', () => {
    platform('Linux');
    fakeNode(bin, '24.22.1');
    fakeNode(localBin, '22.23.4');
    expect(pathNode()).toEqual(['rc=0', `${bin}/node`]);
  });

  it('fails and leaves PATH alone when nothing meets the minimum', () => {
    platform('Linux');
    fakeNode(bin, '22.20.0');
    fakeNode(localBin, '22.21.0');
    expect(pathNode()).toEqual(['rc=1', `${bin}/node`]);
  });
});

describe('setup.sh install_deps', () => {
  it("runs pnpm install with the checked Node, not an npm prefix's older one", () => {
    const prefix = path.join(tmp, 'npm-prefix');
    fakeNode(bin, '24.22.1');
    fakeNode(path.join(prefix, 'bin'), '22.20.0');
    stub(path.join(prefix, 'bin'), 'pnpm', `echo "pnpm $1 node=$(node --version)" >> ${log}`);
    stub(bin, 'npm', `[ "$*" = "config get prefix" ] && echo ${prefix} || :`);
    run(`PROJECT_ROOT=${tmp}; LOG_FILE=${tmp}/boot.log; PLATFORM=linux NODE_OK=true; log() { :; }
${setupFunction('install_deps')}
install_deps`);
    expect(calls()).toEqual(['pnpm install node=v24.22.1']);
  });
});

describe('nanoclaw.sh hand-off', () => {
  // The PATH recovery before `exec pnpm ... setup:auto`, which registers the
  // service with `command -v node`; the exec is swapped for a print of it.
  function handoff(): { status: number | null; out: string } {
    const source = fs.readFileSync(path.join(ROOT, 'nanoclaw.sh'), 'utf8');
    const start = source.indexOf('# setup.sh may have just installed Node/npm/pnpm');
    const end = source.indexOf('exec pnpm --silent run setup:auto "$@"');
    expect(start, 'hand-off section not found in nanoclaw.sh').toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const prelude = `set -euo pipefail; PROJECT_ROOT=${ROOT}; red() { printf '%s' "$1"; }; write_abort_entry() { :; }`;
    return run(`${prelude}\n${source.slice(start, end)}echo "HANDOFF $(command -v node)"`);
  }

  it("keeps the checked Node ahead of an npm prefix's older one", () => {
    platform('Linux');
    fakeNode(bin, '24.22.1');
    const prefix = path.join(tmp, 'npm-prefix');
    fakeNode(path.join(prefix, 'bin'), '22.20.0');
    stub(path.join(prefix, 'bin'), 'pnpm', ':');
    stub(bin, 'npm', `[ "$*" = "config get prefix" ] && echo ${prefix}`);
    expect(handoff()).toEqual({ status: 0, out: `HANDOFF ${bin}/node` });
  });

  it('switches to the Node that meets the minimum before npm runs', () => {
    platform('Linux');
    fakeNode(bin, '12.22.12');
    fakeNode(localBin, '24.22.1');
    stub(localBin, 'npm', `echo "npm node=$(node --version)" >> ${log}; echo ${tmp}/no-prefix`);
    expect(handoff()).toEqual({ status: 0, out: `HANDOFF ${localBin}/node` });
    expect(calls()).toEqual(['npm node=v24.22.1']);
  });

  it('keeps a PATH Node that meets the minimum ahead of an older one in ~/.local/bin', () => {
    platform('Linux');
    fakeNode(bin, '22.23.4');
    fakeNode(localBin, '22.12.0');
    expect(handoff().out).toBe(`HANDOFF ${bin}/node`);
  });

  it('hands setup:auto the keg-only node@22 over a PATH Node below the minimum', () => {
    platform('Darwin');
    fakeNode(bin, '24.10.0');
    fakeNode(keg, '22.23.4');
    expect(handoff().out).toBe(`HANDOFF ${keg}/node`);
  });

  it('stops before setup:auto when no Node meets the minimum', () => {
    platform('Linux');
    fakeNode(bin, '24.10.0');
    const r = handoff();
    expect(r.status).toBe(1);
    expect(r.out).toContain('No Node on PATH meets the minimum (22.23.4 / 24.22.1 / 26.12.1).');
    expect(r.out).not.toContain('HANDOFF');
  });
});
