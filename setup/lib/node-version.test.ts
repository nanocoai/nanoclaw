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
    for (const tool of ['bash', 'sed', 'tail', 'tee', 'wc']) fs.symlinkSync(which(tool), path.join(bin, tool));
    const prelude = `source ${LIB}; PROJECT_ROOT=${project}; LOG_FILE=${tmp}/boot.log; log() { :; }`;
    const fns = ['log_end_line', 'log_mark', 'log_error_line', 'check_node', 'ensure_node'].map(fn).join('\n');
    return run(['-c', `${prelude}\n${fns}\nensure_node; echo "NODE_OK=$NODE_OK"`])
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

  // setup.sh runs under `set -euo pipefail`, where a Node that cannot start used
  // to end the script inside check_node with nothing said.
  function ensureNodeStrict(
    installed = 'exit 1',
    call = 'ensure_node',
  ): { status: number | null; out: string; log: string } {
    // Every function setup.sh defines, without the main part that calls them.
    const source = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
    const fns = source.slice(source.indexOf('# --- Platform detection ---'), source.indexOf('# --- Main ---'));
    expect(fns).toContain('ensure_node() {');
    const project = path.join(tmp, 'project');
    // What install-node.sh does here: fail, unless the case says what it leaves behind.
    stub(path.join(project, 'setup'), 'install-node.sh', `echo install-node >> ${log}; ${installed}`);
    for (const tool of ['bash', 'chmod', 'sed', 'tail', 'tee', 'wc']) {
      // A case may have put its own stub of a tool there.
      if (!fs.existsSync(path.join(bin, tool))) fs.symlinkSync(which(tool), path.join(bin, tool));
    }
    const bootLog = path.join(tmp, 'boot.log');
    const prelude = `set -euo pipefail; source ${LIB}; PROJECT_ROOT=${project}; LOG_FILE=${bootLog}; log() { echo "$*" >> "$LOG_FILE"; }`;
    const r = run(['-c', `${prelude}\n${fns}\n${call}; echo "NODE_OK=$NODE_OK NODE_VERSION=$NODE_VERSION"`]);
    return { ...r, log: fs.existsSync(bootLog) ? fs.readFileSync(bootLog, 'utf8') : '' };
  }

  it.each([
    // What the loader prints for a Node built against a newer glibc.
    ['its libraries do not match', 'echo "node: version GLIBC_2.28 not found (required by node)" >&2; exit 1'],
    ['it crashes with a stack', 'printf "node:internal/x:1\\n  throw err;\\nError: boom\\n" >&2; exit 1'],
  ])('says why and what to do when the only Node cannot start: %s', (_case, body) => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', body);

    const r = ensureNodeStrict();

    expect(r.out).toContain(`Node at ${bin}/node cannot start:`);
    expect(r.out).toMatch(/^ {2}(node: version GLIBC_2\.28 not found \(required by node\)|Error: boom)$/m);
    expect(r.out).toContain('Remove it, or put a Node that works (22.23.4 / 24.22.1 / 26.12.1 or newer) ahead of it');
    expect(r.out).toContain('NODE_OK=false NODE_VERSION=cannot_start');
    expect(r.status).toBe(0);
    expect(r.log).toContain(`Node at ${bin}/node cannot start: `);
    // install-node.sh asks the PATH Node for its version; it has none to give.
    expect(calls()).toEqual([]);
  });

  it("keeps the Node's whole error in the log and shows one line of it", () => {
    stub(bin, 'uname', 'echo Linux');
    // No newline at the end, as some loaders print.
    stub(
      bin,
      'node',
      `printf 'dyld: Library not loaded\\n  Referenced from: node\\n  Reason: image not found' >&2; exit 1`,
    );

    const r = ensureNodeStrict();

    expect(r.out).toMatch(/^ {2}dyld: Library not loaded$/m);
    expect(r.out).not.toContain('Reason: image not found');
    expect(r.log).toContain('  Referenced from: node\n  Reason: image not found\n');
  });

  it('runs a Node that cannot start once, not a second time to read its error', () => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', `echo node-run >> ${log}; echo "node: version GLIBC_2.28 not found" >&2; exit 1`);

    const r = ensureNodeStrict('exit 1', 'check_node');

    expect(calls()).toEqual(['node-run']);
    expect(r.out).toContain('NODE_OK=false NODE_VERSION=cannot_start');
    expect(r.log).toContain(
      `node: version GLIBC_2.28 not found\nNode at ${bin}/node cannot start: node: version GLIBC_2.28`,
    );
  });

  it('shows what a Node that cannot start printed on stdout', () => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', 'echo "node: this build cannot run here"; exit 1');

    const r = ensureNodeStrict();

    expect(r.out).toMatch(/^ {2}node: this build cannot run here$/m);
    expect(r.log).toContain('node: this build cannot run here\n');
  });

  it('does not show an error the log already held', () => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', 'echo "node: cannot run here" >&2; exit 1');
    fs.writeFileSync(path.join(tmp, 'boot.log'), 'Error: left by an earlier step\n');

    const r = ensureNodeStrict();

    expect(r.out).toMatch(/^ {2}node: cannot run here$/m);
    expect(r.out).not.toContain('earlier step');
  });

  it('does not show an older error when the log lines cannot be counted', () => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', 'exit 1');
    stub(bin, 'wc', 'exit 1');
    fs.writeFileSync(path.join(tmp, 'boot.log'), 'Error: left by an earlier step\n');

    const r = ensureNodeStrict();

    expect(r.out).toContain(`Node at ${bin}/node cannot start:`);
    expect(r.out).not.toContain('earlier step');
    expect(r.out).toContain('NODE_OK=false NODE_VERSION=cannot_start');
    expect(r.status).toBe(0);
  });

  it('takes the version of a Node that works and also prints on stderr', () => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', `echo "ERROR: ld.so: object 'x.so' cannot be preloaded: ignored." >&2; echo v22.23.4`);

    const r = ensureNodeStrict();

    expect(r.out).toContain('NODE_OK=true NODE_VERSION=22.23.4');
    expect(r.out).not.toContain('cannot start');
    expect(r.log).toContain("ERROR: ld.so: object 'x.so' cannot be preloaded: ignored.\n");
    expect(calls()).toEqual([]);
  });

  it('says so when the only Node is a file that cannot be executed at all', () => {
    stub(bin, 'uname', 'echo Linux');
    fs.writeFileSync(path.join(bin, 'node'), '#!/nonexistent/interpreter\n', { mode: 0o755 });

    const r = ensureNodeStrict();

    expect(r.out).toContain(`Node at ${bin}/node cannot start:`);
    expect(r.out).toContain('NODE_OK=false NODE_VERSION=cannot_start');
    expect(calls()).toEqual([]);
  });

  it('says so when the Node an install leaves behind cannot start', () => {
    stub(bin, 'uname', 'echo Linux');
    const r = ensureNodeStrict(
      `printf '#!${BASH}\\necho "node: version GLIBC_2.28 not found" >&2; exit 1\\n' > ${bin}/node; chmod +x ${bin}/node`,
    );

    expect(calls()).toEqual(['install-node']);
    expect(r.out).toContain(`Node at ${bin}/node cannot start:`);
    expect(r.out).toMatch(/^ {2}node: version GLIBC_2\.28 not found$/m);
    expect(r.out).toContain('NODE_OK=false NODE_VERSION=cannot_start');
  });

  it('uses a Node that works from a known place when the PATH one cannot start', () => {
    stub(bin, 'uname', 'echo Linux');
    stub(bin, 'node', 'echo "node: version GLIBC_2.28 not found (required by node)" >&2; exit 1');
    fakeNode(path.join(tmp, 'sys'), '22.23.4');

    const r = ensureNodeStrict();

    expect(r.out).toContain('NODE_OK=true NODE_VERSION=22.23.4');
    expect(r.out).not.toContain('cannot start');
    expect(r.log).toContain(`Node at ${bin}/node cannot start: `);
    expect(calls()).toEqual([]);
  });

  it('still installs under strict mode when the PATH Node is only too old', () => {
    stub(bin, 'uname', 'echo Linux');
    fakeNode(bin, '22.20.0');

    const r = ensureNodeStrict();

    expect(r.out).toContain('NODE_OK=false NODE_VERSION=22.20.0');
    expect(calls()).toEqual(['install-node']);
  });
});

describe('setup.sh log_error_line', () => {
  // Under setup.sh's own shell options. `before` is in the log at the mark;
  // `said` is what a tool then writes to it.
  // `wc`, when given, is the body of a stub that stands in for the real one.
  function logErrorLine(
    said: string,
    before: string | null = '',
    wc?: string,
    mark = 'log_mark',
  ): { status: number | null; out: string; log: string } {
    const source = fs.readFileSync(path.join(ROOT, 'setup.sh'), 'utf8');
    const start = source.indexOf('log_end_line() {');
    const last = source.indexOf('log_error_line() {');
    expect(start, 'log_end_line() not found in setup.sh').toBeGreaterThanOrEqual(0);
    expect(last, 'log_error_line() not found in setup.sh').toBeGreaterThan(start);
    const fns = source.slice(start, source.indexOf('\n}', last) + 2);
    fs.symlinkSync(which('tail'), path.join(bin, 'tail'));
    if (wc === undefined) fs.symlinkSync(which('wc'), path.join(bin, 'wc'));
    else stub(bin, 'wc', wc);
    const bootLog = path.join(tmp, 'boot.log');
    if (before !== null) fs.writeFileSync(bootLog, before);
    const writes = said ? `printf '%s' $'${said}' >> "$LOG_FILE"` : ':';
    const r = run([
      '-c',
      `set -euo pipefail\nLOG_FILE=${bootLog}\n${fns}\n${mark}\n${writes}\nlog_error_line\necho "[$ERROR_LINE]"`,
    ]);
    return { ...r, log: fs.existsSync(bootLog) ? fs.readFileSync(bootLog, 'utf8') : '' };
  }

  it.each([
    ['the first line that names an error', 'node:internal/x:1\\n  throw err;\\nError: boom\\n  at y\\n', 'Error: boom'],
    ['an npm error line', '\\nnpm error code EACCES\\nnpm error syscall mkdir\\n', 'npm error code EACCES'],
    [
      'the first line with anything on it when none names an error',
      '\\n\\nlibfoo.so.1: not found\\nmore\\n',
      'libfoo.so.1: not found',
    ],
    ['a single line that has no newline', 'loader: missing lib', 'loader: missing lib'],
    ['nothing for no output', '', ''],
  ])('gives %s', (_case, said, line) => {
    const r = logErrorLine(said, '[a time] an earlier log line\n');
    expect({ status: r.status, out: r.out }).toEqual({ status: 0, out: `[${line}]\n` });
  });

  it('reads only what the log gained after the mark', () => {
    const r = logErrorLine('loader: missing lib\\nError: the real one\\n', 'Error: from an earlier step\nmore\n');
    expect(r.out).toBe('[Error: the real one]\n');
  });

  it('keeps a last log line that had no newline at the mark out of what it reads', () => {
    const r = logErrorLine('npm error code E1\\n', 'one\nError: old, with no newline');
    expect(r.out).toBe('[npm error code E1]\n');
    expect(r.log).toBe('one\nError: old, with no newline\nnpm error code E1\n');
  });

  it('gives nothing when the tool printed nothing, whatever the log held', () => {
    const r = logErrorLine('', 'Error: old, with no newline');
    expect(r.out).toBe('[]\n');
  });

  it('ends a last line that has no newline, so the next log line starts on its own', () => {
    const r = logErrorLine('loader: missing lib');
    expect(r.out).toBe('[loader: missing lib]\n');
    expect(r.log).toBe('loader: missing lib\n');
  });

  it('gives nothing, and does not stop the script, when there is no log', () => {
    const r = logErrorLine('', null);
    expect({ status: r.status, out: r.out }).toEqual({ status: 0, out: '[]\n' });
  });

  it('reads a log the tool made, when there was none at the mark', () => {
    const r = logErrorLine('loader: missing lib\\n', null);
    expect(r.out).toBe('[loader: missing lib]\n');
  });

  // No count is not line 0: from there the whole log would read as this step's.
  it.each([
    ['fails', 'exit 1', ''],
    ['fails, also for a step that printed', 'exit 1', 'npm error code E1\\n'],
    ['prints a count, then fails', 'echo 0; exit 1', ''],
    ['prints no count', 'echo "wc: cannot count"', ''],
  ])('gives nothing, not an older error line, when wc %s', (_case, wc, said) => {
    const r = logErrorLine(said, 'Error: old unrelated step\n', wc);
    expect({ status: r.status, out: r.out }).toEqual({ status: 0, out: '[]\n' });
  });

  it('gives nothing, and does not stop the script, when no mark was taken', () => {
    const r = logErrorLine('', 'Error: old unrelated step\n', undefined, ':');
    expect({ status: r.status, out: r.out }).toEqual({ status: 0, out: '[]\n' });
  });

  it('takes the count as BSD wc prints it, padded with spaces', () => {
    const r = logErrorLine('npm error code E1\\n', 'Error: old unrelated step\n', 'echo "       1"');
    expect(r.out).toBe('[npm error code E1]\n');
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
