/**
 * Which node setup.sh, nanoclaw.sh and migrate-v2.sh leave first on PATH, and
 * where they find pnpm. Runs the real scripts under bash on a PATH holding
 * only stubs and a few coreutils.
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
const TOOLS = ['bash', 'cp', 'grep', 'head', 'mkdir', 'sed', 'sleep', 'tail', 'wc'].map(
  (tool) => [tool, which(tool)] as const,
);

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
/** Every function setup.sh defines, without the main part that calls them. */
function setupFunctions(): string {
  const source = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
  const start = source.indexOf('# --- Platform detection ---');
  const end = source.indexOf('# --- Main ---');
  expect(start, 'the functions of setup.sh were not found').toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return source.slice(start, end);
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
  const OLDER = '22.20.0';
  const pnpmStub = () => `echo "pnpm $1 node=$(node --version)" >> ${log}`;
  const logged = () => fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8');
  // What mkdir says differs by system and may name no path. Setup's own line
  // names the folder; mkdir's line and where the log is come right after it.
  const cannotBeCreated = (out: string, folder: string) => {
    const lines = out.split('\n');
    const at = lines.indexOf(`Could not install pnpm: ${folder} cannot be created:`);
    expect(at, `no line says ${folder} cannot be created`).toBeGreaterThanOrEqual(0);
    expect(lines[at + 1]).toMatch(/^ {2}mkdir: .+$/);
    expect(lines[at + 2]).toBe(`Fix that, then re-run setup. mkdir's full output is in ${tmp}/boot.log`);
  };
  const npmThatNeedsRoot = () =>
    stub(
      bin,
      'npm',
      `case "$1" in --version) echo 10.9.0 ;; config) echo ${tmp}/prefix ;; install) echo "npm error code EACCES" >&2; exit 1 ;; esac`,
    );

  // Under setup.sh's own shell options, with the package.json it reads the pnpm pin from.
  function installDeps(): { status: number | null; out: string } {
    fs.writeFileSync(path.join(tmp, 'package.json'), '{\n  "packageManager": "pnpm@10.0.0"\n}\n');
    return run(`set -euo pipefail
PROJECT_ROOT=${tmp}; LOG_FILE=${tmp}/boot.log; PLATFORM=linux NODE_OK=true
log() { echo "$*" >> "$LOG_FILE"; }
${setupFunctions()}
install_deps
echo "DEPS_OK=$DEPS_OK"`);
  }

  it("runs pnpm install with the checked Node, not an npm prefix's older one", () => {
    const prefix = path.join(tmp, 'npm-prefix');
    fakeNode(bin, '24.22.1');
    fakeNode(path.join(prefix, 'bin'), OLDER);
    stub(path.join(prefix, 'bin'), 'pnpm', pnpmStub());
    stub(bin, 'npm', `[ "$*" = "config get prefix" ] && echo ${prefix} || :`);
    installDeps();
    expect(calls()).toEqual(['pnpm install node=v24.22.1']);
  });

  it('keeps the checked Node first when pnpm is found in ~/.local/bin', () => {
    fakeNode(bin, '24.22.1');
    fakeNode(localBin, OLDER);
    stub(localBin, 'pnpm', pnpmStub());
    installDeps();
    expect(calls()).toEqual(['pnpm install node=v24.22.1']);
  });

  it('keeps the checked Node first when corepack puts its shim in ~/.local/bin', () => {
    const shim = path.join(tmp, 'shim');
    fakeNode(bin, '24.22.1');
    fakeNode(localBin, OLDER);
    stub(shim, 'pnpm', pnpmStub());
    // A corepack that can only write where it is told to, as next to a root-owned node.
    stub(bin, 'corepack', `if [ "$2" = --install-directory ]; then cp -p ${shim}/pnpm "$3/pnpm"; fi`);
    installDeps();
    expect(calls()).toEqual(['pnpm install node=v24.22.1']);
  });

  it('keeps the checked Node first when npm installs pnpm under ~/.local', () => {
    const shim = path.join(tmp, 'shim');
    fakeNode(bin, '24.22.1');
    fakeNode(localBin, OLDER);
    stub(shim, 'pnpm', pnpmStub());
    // An npm whose own global prefix is not writable.
    stub(
      bin,
      'npm',
      `[ "$1 $2 $4" = "install -g --prefix" ] && mkdir -p "$5/bin" && cp -p ${shim}/pnpm "$5/bin/pnpm" && echo "added 1 package"`,
    );
    installDeps();
    expect(calls()).toEqual(['pnpm install node=v24.22.1']);
    expect(fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8')).toContain('added 1 package');
  });

  it('names an npm that cannot run as the reason, with its own error, instead of blaming root', () => {
    fakeNode(bin, '24.22.1');
    // What a half-removed npm prints: the first line is not the one that says why.
    stub(
      bin,
      'npm',
      `printf "node:internal/x:1\\n  throw err;\\nError: Cannot find module 'npm-cli.js'\\n" >&2; exit 1`,
    );
    const r = installDeps();
    expect(r.out).toContain(`Could not install pnpm: npm at ${bin}/npm cannot run:`);
    expect(r.out).toMatch(/^ {2}Error: Cannot find module 'npm-cli\.js'$/m);
    expect(r.out).toContain('Reinstall Node.js to get a working npm, then re-run setup.');
    expect(r.out).not.toContain('without root');
    expect(r.out).not.toContain('npm install -g');
    expect(r.out).toContain('DEPS_OK=false');
    expect(r.status).toBe(0);
    const bootLog = fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8');
    expect(bootLog).toContain('npm config get prefix failed');
    expect(bootLog).toContain("Error: Cannot find module 'npm-cli.js'");
  });

  it('shows why npm failed when it runs but cannot install pnpm, also without root', () => {
    fakeNode(bin, '24.22.1');
    // The global prefix is not writable; the try into ~/.local fails for another reason.
    const install = `if [ "$4" = --prefix ]; then echo "npm error code ENOTFOUND" >&2; echo "npm error network request failed" >&2; else echo "npm error code EACCES" >&2; fi; exit 1`;
    stub(
      bin,
      'npm',
      `case "$1" in --version) echo 10.9.0 ;; config) echo ${tmp}/prefix ;; install) ${install} ;; esac`,
    );
    const r = installDeps();
    expect(r.out).toContain('Could not install pnpm: npm failed, also when installing into ~/.local:');
    expect(r.out).toMatch(/^ {2}npm error code ENOTFOUND$/m);
    expect(r.out).toContain(`Fix that, then re-run setup. npm's full output is in ${tmp}/boot.log`);
    expect(r.out).not.toContain('without root');
    expect(r.out).not.toContain('cannot run');
    expect(r.out).not.toContain('EACCES');
    expect(r.out).toContain('DEPS_OK=false');
    const bootLog = fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8');
    expect(bootLog).toContain('npm error code EACCES');
    expect(bootLog).toContain('npm error network request failed');
  });

  it("puts npm's output in the log while npm is still running", () => {
    fakeNode(bin, '24.22.1');
    // The try into ~/.local says one line, then looks for it in the log before it ends.
    const waits = `i=0; until grep -q "npm error still trying" ${tmp}/boot.log || [ $i -ge 30 ]; do sleep 0.1; i=$((i + 1)); done`;
    const install = `[ "$4" = --prefix ] || exit 1; echo "npm error still trying" >&2; ${waits}; grep -q "npm error still trying" ${tmp}/boot.log && echo "npm error the log had it" >&2; exit 1`;
    stub(
      bin,
      'npm',
      `case "$1" in --version) echo 10.9.0 ;; config) echo ${tmp}/prefix ;; install) ${install} ;; esac`,
    );
    const r = installDeps();
    expect(r.out).toContain('Could not install pnpm: npm failed, also when installing into ~/.local:');
    expect(fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8')).toContain('npm error the log had it');
  });

  it("names ~/.local, not npm, with mkdir's own line when ~/.local cannot be made", () => {
    fakeNode(bin, '24.22.1');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.local'), 'a file where the folder should be\n');
    npmThatNeedsRoot();
    const r = installDeps();
    cannotBeCreated(r.out, `${home}/.local`);
    expect(r.out).not.toMatch(/npm failed|without root|npm install -g|EACCES/);
    expect(r.out).toContain('DEPS_OK=false');
    expect(logged()).toMatch(/^mkdir: .+\nCould not create .+\/\.local: mkdir: .+$/m);
  });

  it("shows mkdir's own line as it is, also when it names no path", () => {
    fakeNode(bin, '24.22.1');
    npmThatNeedsRoot();
    // What the mkdir on Ubuntu 26.04 says when a file is in the way.
    fs.rmSync(path.join(bin, 'mkdir'));
    stub(bin, 'mkdir', 'echo "mkdir: Already exists" >&2; exit 1');
    const r = installDeps();
    expect(r.out).toContain(
      `Could not install pnpm: ${home}/.local cannot be created:\n  mkdir: Already exists\nFix that, then re-run setup. mkdir's full output is in ${tmp}/boot.log\n`,
    );
    expect(logged()).toContain(`mkdir: Already exists\nCould not create ${home}/.local: mkdir: Already exists\n`);
  });

  it('says so plainly when npm fails without printing anything', () => {
    fakeNode(bin, '24.22.1');
    stub(bin, 'npm', 'exit 1');
    const r = installDeps();
    expect(r.out).toContain(`Could not install pnpm: npm at ${bin}/npm cannot run:`);
    expect(r.out).toMatch(/^ {2}it printed nothing$/m);
    expect(r.out).toContain('DEPS_OK=false');
    expect(r.status).toBe(0);
  });

  it('shows why corepack failed when it is the only installer, instead of blaming root', () => {
    fakeNode(bin, '24.22.1');
    stub(bin, 'corepack', 'echo "Error: corepack cannot reach the registry" >&2; exit 1');
    const r = installDeps();
    expect(r.out).toContain(`Could not install pnpm: corepack could not put pnpm into ${localBin}:`);
    expect(r.out).toMatch(/^ {2}Error: corepack cannot reach the registry$/m);
    expect(r.out).toContain(`Fix that, then re-run setup. corepack's full output is in ${tmp}/boot.log`);
    expect(r.out).not.toContain('without root');
    expect(r.out).not.toContain('corepack enable');
    expect(r.out).toContain('DEPS_OK=false');
    expect(r.status).toBe(0);
  });

  it("shows the error of corepack's try into ~/.local/bin, not of its first try", () => {
    fakeNode(bin, '24.22.1');
    stub(
      bin,
      'corepack',
      'if [ "$2" = --install-directory ]; then echo "Error: the shim folder is full" >&2; else echo "Error: EACCES next to node" >&2; fi; exit 1',
    );
    const r = installDeps();
    expect(r.out).toMatch(/^ {2}Error: the shim folder is full$/m);
    expect(r.out).not.toContain('EACCES next to node');
    expect(logged()).toContain('Error: EACCES next to node\n');
  });

  it('says so when corepack reports success but leaves no pnpm', () => {
    fakeNode(bin, '24.22.1');
    stub(bin, 'corepack', 'exit 0');
    const r = installDeps();
    expect(r.out).toContain(`Could not install pnpm: corepack could not put pnpm into ${localBin}:`);
    expect(r.out).toMatch(/^ {2}it printed nothing$/m);
    expect(r.out).not.toContain('without root');
  });

  it("puts corepack's output in the log while corepack is still running", () => {
    fakeNode(bin, '24.22.1');
    const waits = `i=0; until grep -q "corepack still trying" ${tmp}/boot.log || [ $i -ge 30 ]; do sleep 0.1; i=$((i + 1)); done`;
    stub(
      bin,
      'corepack',
      `[ "$2" = --install-directory ] || exit 1; echo "corepack still trying" >&2; ${waits}; grep -q "corepack still trying" ${tmp}/boot.log && echo "Error: the log had it" >&2; exit 1`,
    );
    installDeps();
    expect(fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8')).toContain('Error: the log had it');
  });

  it("names ~/.local/bin, not corepack, with mkdir's own line when ~/.local/bin cannot be made", () => {
    fakeNode(bin, '24.22.1');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.local'), 'a file where the folder should be\n');
    // Its first try says this too; that line is in the log before mkdir's.
    stub(bin, 'corepack', 'echo "Error: not the reason pnpm is missing" >&2; exit 1');
    const r = installDeps();
    cannotBeCreated(r.out, localBin);
    expect(r.out).not.toMatch(/not the reason|corepack could not|without root|corepack enable/);
    expect(logged()).toContain('Error: not the reason pnpm is missing\n');
    expect(logged()).toMatch(/^mkdir: .+\nCould not create .+\/\.local\/bin: mkdir: .+$/m);
  });

  it('gives the last failure when corepack and then npm both fail without root', () => {
    fakeNode(bin, '24.22.1');
    stub(bin, 'corepack', 'echo "Error: corepack is broken" >&2; exit 1');
    stub(
      bin,
      'npm',
      `case "$1" in --version) echo 10.9.0 ;; config) echo ${tmp}/prefix ;; install) echo "npm error code ENOTFOUND" >&2; exit 1 ;; esac`,
    );
    const r = installDeps();
    expect(r.out).toContain('Could not install pnpm: npm failed, also when installing into ~/.local:');
    expect(r.out).toMatch(/^ {2}npm error code ENOTFOUND$/m);
    expect(r.out).not.toContain('corepack is broken');
  });

  it('says there is nothing to install pnpm with when corepack and npm are both missing', () => {
    fakeNode(bin, '24.22.1');
    const r = installDeps();
    expect(r.out).toContain('Could not install pnpm: there is no corepack and no npm on PATH to install it with.');
    expect(r.out).toContain('Reinstall Node.js, which brings npm, then re-run setup.');
    expect(r.out).not.toContain('without root');
    expect(r.out).not.toContain('npm install -g');
    expect(r.out).toContain('DEPS_OK=false');
  });

  it('still suggests the try into ~/.local when npm installed pnpm where it cannot be found', () => {
    fakeNode(bin, '24.22.1');
    // The global install reports success, yet pnpm is nowhere this script looks.
    stub(bin, 'npm', `case "$1" in config) echo ${tmp}/prefix ;; esac`);
    const r = installDeps();
    expect(r.out).toContain('Could not install pnpm without root. Run this, then re-run setup:');
    expect(r.out).toContain('npm install -g pnpm@10.0.0 --prefix ~/.local');
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

  it('still hands off when npm cannot report its prefix', () => {
    platform('Linux');
    fakeNode(bin, '24.22.1');
    stub(bin, 'npm', 'exit 1');
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

describe('migrate-v2.sh after bootstrap', () => {
  // From the end of the setup.sh run to the search for the v1 install: the
  // PATH recovery every later step, and the service they register, runs on.
  function afterBootstrap(): { status: number | null; out: string } {
    const source = fs.readFileSync(path.join(ROOT, 'migrate-v2.sh'), 'utf8');
    const end = source.indexOf('# ─── phase 0b');
    const bootstrapEnd = 'abort "bootstrap"\nfi\n';
    const start = source.lastIndexOf(bootstrapEnd, end);
    expect(end, 'phase 0b not found in migrate-v2.sh').toBeGreaterThanOrEqual(0);
    expect(start, 'end of the bootstrap step not found in migrate-v2.sh').toBeGreaterThanOrEqual(0);
    const prelude = `set -uo pipefail; PROJECT_ROOT=${ROOT}; step_fail() { echo "FAIL $1"; }; abort() { echo "ABORT $1"; exit 1; }`;
    const section = source.slice(start + bootstrapEnd.length, end);
    return run(`${prelude}\n${section}echo "NODE $(command -v node)"; echo "PNPM $(command -v pnpm)"`);
  }

  it("keeps the checked Node ahead of an npm prefix's older one", () => {
    platform('Linux');
    fakeNode(bin, '24.22.1');
    const prefix = path.join(tmp, 'npm-prefix');
    fakeNode(path.join(prefix, 'bin'), '22.20.0');
    stub(path.join(prefix, 'bin'), 'pnpm', ':');
    stub(bin, 'npm', `[ "$*" = "config get prefix" ] && echo ${prefix}`);
    expect(afterBootstrap()).toEqual({ status: 0, out: `NODE ${bin}/node\nPNPM ${prefix}/bin/pnpm` });
  });

  it('finds the pnpm setup.sh left in ~/.local/bin, behind the checked Node', () => {
    platform('Linux');
    fakeNode(bin, '24.22.1');
    fakeNode(localBin, '22.20.0');
    stub(localBin, 'pnpm', ':');
    expect(afterBootstrap()).toEqual({ status: 0, out: `NODE ${bin}/node\nPNPM ${localBin}/pnpm` });
  });
});
