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

function setupFn(name: string): string {
  const source = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
  const start = source.indexOf(`${name}() {`);
  expect(start, `${name}() not found in setup.sh`).toBeGreaterThanOrEqual(0);
  return source.slice(start, source.indexOf('\n}', start) + 2);
}

function addTools(...tools: string[]): void {
  for (const tool of tools) fs.symlinkSync(which(tool), path.join(bin, tool));
}

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

  it.each([
    ['24.22.1', true],
    ['26.13.0', false],
  ])('links Node %s corepack into ~/.local/bin only when it ships one (%s)', (version, shipsCorepack) => {
    const home = path.join(tmp, 'home');
    const localBin = path.join(home, '.local', 'bin');
    const lts = path.join(tmp, 'lts', 'bin');
    fakeNode(bin, '20.19.5');
    stub(bin, 'uname', 'echo Linux');
    fakeNode(lts, version);
    for (const tool of ['npm', 'npx', ...(shipsCorepack ? ['corepack'] : [])]) stub(lts, tool, 'exit 0');
    // node runs through the ~/.local/bin symlink, so fakeNode reads its version from there.
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(path.join(localBin, '.node-version'), `v${version}\n`);
    stub(bin, 'uvx', `ln -s ${path.dirname(lts)} "$5"`);
    const r = run([INSTALL_NODE]);
    expect(field(r.out, 'STATUS')).toBe('installed');
    expect(fs.readdirSync(localBin).includes('corepack')).toBe(shipsCorepack);
    if (shipsCorepack) {
      expect(fs.readlinkSync(path.join(localBin, 'corepack'))).toBe(path.join(home, 'node', 'bin', 'corepack'));
    }
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
    const project = path.join(tmp, 'project');
    stub(path.join(project, 'setup'), 'install-node.sh', `echo install-node >> ${log}; exit 1`);
    addTools('bash', 'sed', 'tee');
    const prelude = `source ${LIB}; PROJECT_ROOT=${project}; LOG_FILE=${tmp}/boot.log; log() { :; }`;
    return run([
      '-c',
      `${prelude}\n${setupFn('check_node')}\n${setupFn('ensure_node')}\nensure_node; echo "NODE_OK=$NODE_OK"`,
    ])
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

// What corepack prints when it can't verify the pnpm it downloaded, by cause.
const SHIM_ERRORS = {
  bad: 'Cannot find matching keyid',
  tampered: 'Signature does not match',
  corrupt: 'Mismatch hashes. Expected abc, got def',
};
type ShimKind = 'ok' | keyof typeof SHIM_ERRORS;

describe('setup.sh install_deps', () => {
  let home: string;
  let localBin: string;
  const shim = (kind: ShimKind) => path.join(tmp, 'shims', `pnpm-${kind}`);

  beforeEach(() => {
    home = path.join(tmp, 'home');
    localBin = path.join(home, '.local', 'bin');
    fs.mkdirSync(path.join(tmp, 'project'));
    fs.writeFileSync(path.join(tmp, 'project', 'package.json'), '{\n  "packageManager": "pnpm@10.34.5"\n}\n');
    const shims = path.join(tmp, 'shims');
    stub(shims, 'pnpm-ok', `echo "pnpm $*" >> ${log}; [ "$1" = --version ] && echo 10.34.5; exit 0`);
    for (const [kind, error] of Object.entries(SHIM_ERRORS)) {
      stub(shims, `pnpm-${kind}`, `echo "pnpm $*" >> ${log}; echo 'Internal Error: ${error}' >&2; exit 1`);
    }
    addTools('grep', 'head', 'sed');
  });

  /** `corepack enable` links a pnpm shim next to itself, or into --install-directory; `.readonly` there fails it. */
  function fakeCorepack(dir: string, kind: ShimKind): void {
    stub(
      dir,
      'corepack',
      [
        `echo "corepack $*" >> ${log}`,
        '[ "$1" = enable ] || exit 0',
        'dir="${0%/*}"',
        '[ "${2:-}" = --install-directory ] && dir="$3"',
        '[ -e "$dir/.readonly" ] && { echo "EACCES: permission denied" >&2; exit 1; }',
        `ln -sf ${shim(kind)} "$dir/pnpm"`,
      ].join('\n'),
    );
  }

  /** `npm install -g pnpm@x [--prefix p]` links a working pnpm into `<prefix>/bin`. */
  function fakeNpm(dir: string, prefix: string, fails = false): void {
    stub(
      dir,
      'npm',
      [
        `echo "npm $*" >> ${log}`,
        fails ? 'exit 1' : '',
        'case "$1" in',
        `  config) echo ${prefix} ;;`,
        `  install) p=${prefix}; [ "\${4:-}" = --prefix ] && p="$5"; mkdir -p "$p/bin" && ln -sf ${shim('ok')} "$p/bin/pnpm" ;;`,
        'esac',
      ].join('\n'),
    );
  }

  function installDeps(pathDirs: string[]): { out: string; deps: string | undefined } {
    const prelude =
      `set -euo pipefail; PROJECT_ROOT=${tmp}/project; LOG_FILE=${tmp}/boot.log; ` +
      'PLATFORM=linux; NODE_OK=true; log() { :; }';
    const fns = ['probe_pnpm', 'pnpm_installable', 'install_deps'].map(setupFn).join('\n');
    const script = `${prelude}\n${fns}\ninstall_deps; echo "DEPS_OK=$DEPS_OK"`;
    const r = run(['-c', script], { PATH: [...pathDirs, bin].join(':') });
    return { out: r.out, deps: r.out.trim().split('\n').pop() };
  }

  const npmCalls = () => calls().filter((c) => c.startsWith('npm '));

  it('probes a working pnpm twice and leaves it in place', () => {
    const nodeBin = path.join(tmp, 'node', 'bin');
    fakeCorepack(nodeBin, 'ok');
    fs.symlinkSync(shim('ok'), path.join(nodeBin, 'pnpm'));
    fakeNpm(nodeBin, path.join(tmp, 'node'));
    expect(installDeps([nodeBin]).deps).toBe('DEPS_OK=true');
    expect(calls().filter((c) => c === 'pnpm --version')).toHaveLength(2);
    expect(npmCalls()).toEqual([]);
  });

  it("uses the new Node's corepack ahead of an older one later on PATH", () => {
    const stale = path.join(tmp, 'usr-local', 'bin');
    fakeCorepack(stale, 'bad');
    fakeCorepack(localBin, 'ok');
    fakeNpm(localBin, path.join(home, 'node'));
    expect(installDeps([localBin, stale]).deps).toBe('DEPS_OK=true');
    expect(calls()).toContain('pnpm install --frozen-lockfile');
    expect(npmCalls()).toEqual([]);
  });

  it('falls back to npm, without re-running corepack, when its pnpm shim fails to run', () => {
    const stale = path.join(tmp, 'usr-local', 'bin');
    const nodePnpm = path.join(home, 'node', 'bin', 'pnpm');
    fakeCorepack(stale, 'bad');
    fakeNpm(localBin, path.join(home, 'node'));
    // install-node.sh links ~/.local/bin/pnpm before the target exists.
    fs.symlinkSync(nodePnpm, path.join(localBin, 'pnpm'));
    expect(installDeps([localBin, stale]).deps).toBe('DEPS_OK=true');
    expect(calls().filter((c) => c.startsWith('corepack '))).toEqual(['corepack enable']);
    expect(npmCalls()).toContain('npm install -g pnpm@10.34.5');
    // nanoclaw.sh runs ~/.local/bin/pnpm next, so it must not be a broken corepack shim.
    expect(fs.readlinkSync(path.join(localBin, 'pnpm'))).toBe(nodePnpm);
  });

  it("puts npm's global prefix on PATH when the npm install lands outside it", () => {
    const nodeBin = path.join(tmp, 'node', 'bin');
    fakeNpm(nodeBin, path.join(tmp, 'npm-global'));
    expect(installDeps([nodeBin]).deps).toBe('DEPS_OK=true');
    expect(npmCalls()).toEqual(['npm install -g pnpm@10.34.5', 'npm config get prefix']);
  });

  it('retries corepack into ~/.local/bin when it cannot write next to itself', () => {
    const sysBin = path.join(tmp, 'usr', 'bin');
    fakeCorepack(sysBin, 'ok');
    fs.writeFileSync(path.join(sysBin, '.readonly'), '');
    expect(installDeps([sysBin]).deps).toBe('DEPS_OK=true');
    expect(calls()).toContain(`corepack enable --install-directory ${localBin} pnpm`);
    expect(fs.readlinkSync(path.join(localBin, 'pnpm'))).toBe(shim('ok'));
  });

  it('prints the npm recovery command instead of aborting when pnpm is broken and npm fails', () => {
    const stale = path.join(tmp, 'usr-local', 'bin');
    fs.mkdirSync(stale, { recursive: true });
    fs.symlinkSync(shim('bad'), path.join(stale, 'pnpm'));
    fakeNpm(stale, path.join(tmp, 'usr-local'), true);
    const r = installDeps([stale]);
    expect(r.deps).toBe('DEPS_OK=false');
    expect(r.out).toContain('  npm install -g pnpm@10.34.5 --prefix ~/.local');
  });

  it.each(['tampered', 'corrupt'] as const)(
    'stops without npm or corepack retries when corepack rejects a %s pnpm download',
    (kind) => {
      const nodeBin = path.join(tmp, 'node', 'bin');
      fakeCorepack(nodeBin, kind);
      fakeNpm(nodeBin, path.join(tmp, 'node'));
      const r = installDeps([nodeBin]);
      expect(r.deps).toBe('DEPS_OK=false');
      expect(r.out).toContain('Corepack refused the pnpm download: its signature or checksum did not verify.');
      expect(calls().filter((c) => c.startsWith('corepack '))).toEqual(['corepack enable']);
      expect(npmCalls()).toEqual([]);
      expect(fs.readFileSync(path.join(tmp, 'boot.log'), 'utf8')).toContain(SHIM_ERRORS[kind]);
    },
  );
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
  // The PATH recovery before `exec pnpm ... setup:auto`; the exec is swapped for a print.
  function handOff(): string {
    const source = fs.readFileSync(path.join(ROOT, 'nanoclaw.sh'), 'utf8');
    const start = source.indexOf('# setup.sh may have just installed Node/npm/pnpm');
    const end = source.indexOf('exec pnpm --silent run setup:auto "$@"');
    expect(start, 'hand-off section not found in nanoclaw.sh').toBeGreaterThanOrEqual(0);
    const prelude = `set -euo pipefail; PROJECT_ROOT=${ROOT}; red() { printf '%s' "$1"; }; write_abort_entry() { :; }`;
    return run(['-c', `${prelude}\n${source.slice(start, end)}echo "HANDOFF $(command -v node)"`]).out.trim();
  }

  it('hands setup:auto the keg-only node@22 over an older PATH Node on macOS', () => {
    // setup:auto registers the service with `command -v node`.
    fakeNode(bin, '24.10.0');
    fakeNode(keg, '22.23.4');
    stub(bin, 'uname', 'echo Darwin');
    stub(bin, 'brew', `[ "$1" = --prefix ] && echo ${path.dirname(keg)}`);
    expect(handOff()).toBe(`HANDOFF ${keg}/node`);
  });

  it('reaches the hand-off when npm cannot report its global prefix', () => {
    fakeNode(bin, '22.23.4');
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'npm', `echo "npm $*" >> ${log}; exit 1`);
    expect(handOff()).toBe(`HANDOFF ${bin}/node`);
    expect(calls()).toEqual(['npm config get prefix']);
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
