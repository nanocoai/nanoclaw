import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

/**
 * setup/lib/jq.sh's install, run under bash with every command it calls
 * stubbed on an otherwise empty PATH. The bootstrap runs behind a spinner, so
 * it must never prompt: sudo -n only, reusing nanoclaw.sh's pre-flight answer.
 */
const LIB = path.join(process.cwd(), 'setup', 'lib', 'jq.sh');

interface Machine {
  os?: string;
  uid?: number;
  /** The package manager on PATH. */
  pkg?: string;
  jq?: boolean;
  /** Whether sudo -n works (a cached or passwordless sudo), or no sudo at all. */
  sudo?: 'cached' | 'password';
  /** The manager can't find jq until it refreshes its lists (`apt-get update`, `pacman -Sy…`). */
  staleLists?: boolean;
  /** pacman's sync databases exist, i.e. it has synced before. */
  pacmanSynced?: boolean;
  /** pacman-conf is missing, so nothing says where pacman keeps its lists. */
  noPacmanConf?: boolean;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-install-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function stubs(m: Machine): { bin: string; log: string } {
  const bin = path.join(dir, 'bin');
  const log = path.join(dir, 'calls.log');
  const stub = (name: string, body: string): void => {
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  stub('uname', `echo ${m.os ?? 'Linux'}`);
  stub('id', `echo ${m.uid ?? 1000}`);
  stub('env', 'exec /usr/bin/env "$@"');
  if (m.jq) stub('jq', 'exit 0');
  if (m.pkg) {
    stub(
      m.pkg,
      [
        `echo "${m.pkg} $*" >> '${log}'`,
        `case "$*" in *update*) : > '${dir}/updated'; exit 0 ;; -Sy*) : > '${dir}/updated' ;; esac`,
        m.staleLists ? `[ -e '${dir}/updated' ] || exit 100` : '',
        `printf '#!/bin/sh\\n' > '${bin}/jq' && /bin/chmod +x '${bin}/jq'`,
      ].join('\n'),
    );
  }
  if (m.pkg === 'pacman') {
    fs.mkdirSync(path.join(dir, 'pacman', 'sync'), { recursive: true });
    if (m.pacmanSynced) fs.writeFileSync(path.join(dir, 'pacman', 'sync', 'core.db'), '');
    if (!m.noPacmanConf) stub('pacman-conf', `[ "$1" = DBPath ] && echo '${dir}/pacman/'`);
  }
  if (m.sudo) {
    stub(
      'sudo',
      [
        `echo "sudo $*" >> '${log}'`,
        `[ "$1" = "-n" ] || exit 2`,
        m.sudo === 'cached' ? 'shift; exec "$@"' : 'exit 1',
      ].join('\n'),
    );
  }
  return { bin, log };
}

function calls(log: string): string[] {
  return fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

function run(m: Machine): { rc: number; log: string[] } {
  const { bin, log } = stubs(m);
  const res = spawnSync(
    '/bin/bash',
    ['-c', `set -euo pipefail; source '${LIB}'; if ensure_jq; then echo rc=0; else echo rc=1; fi`],
    {
      env: { PATH: bin, HOME: dir },
      encoding: 'utf8',
    },
  );
  expect(res.stderr).toBe('');
  const rc = Number(/rc=(\d)/.exec(res.stdout)?.[1]);
  return { rc, log: calls(log) };
}

describe('jq install (setup/lib/jq.sh)', { timeout: 20_000 }, () => {
  it('installs jq with apt-get through sudo -n, never a prompt', () => {
    const r = run({ pkg: 'apt-get', sudo: 'cached' });
    expect(r.rc).toBe(0);
    expect(r.log).toHaveLength(2);
    expect(r.log[0]).toMatch(/^sudo -n env .*apt-get install -y -qq jq$/);
    expect(r.log[1]).toBe('apt-get install -y -qq jq');
  });

  it('refreshes empty package lists once, then retries', () => {
    const r = run({ pkg: 'apt-get', sudo: 'cached', staleLists: true });
    expect(r.rc).toBe(0);
    expect(r.log.filter((l) => l.startsWith('apt-get'))).toEqual([
      'apt-get install -y -qq jq',
      'apt-get update -qq',
      'apt-get install -y -qq jq',
    ]);
  });

  // A never-synced pacman has no lists, and -Sy alone would be an Arch partial upgrade.
  it('syncs a never-synced pacman with a full -Syu, then installs jq', () => {
    const r = run({ pkg: 'pacman', sudo: 'cached', staleLists: true });
    expect(r.rc).toBe(0);
    expect(r.log.filter((l) => l.startsWith('pacman'))).toEqual([
      'pacman -S --noconfirm --needed jq',
      'pacman -Syu --noconfirm --needed jq',
    ]);
    expect(r.log).toContain('sudo -n pacman -Syu --noconfirm --needed jq');
  });

  it.each<[string, Machine]>([
    ['has synced before', { pacmanSynced: true }],
    ['has no pacman-conf to say where its lists are', { noPacmanConf: true }],
  ])('never upgrades a pacman system that %s', (_name, m) => {
    const r = run({ pkg: 'pacman', sudo: 'cached', staleLists: true, ...m });
    expect(r.rc).toBe(1);
    expect(r.log.filter((l) => l.startsWith('pacman'))).toEqual(['pacman -S --noconfirm --needed jq']);
  });

  // A stub can't check a manager's flags, only that setup finds it and runs it with sudo -n.
  it.each(['dnf', 'yum', 'zypper', 'pacman', 'apk'])('installs jq with %s on distros without apt', (pkg) => {
    const r = run({ pkg, sudo: 'cached' });
    expect(r.rc).toBe(0);
    expect(r.log[0]).toMatch(new RegExp(`^sudo -n env .* ${pkg} .*jq$`));
  });

  it('runs the package manager directly as root', () => {
    const r = run({ uid: 0, pkg: 'apt-get', sudo: 'password' });
    expect(r.rc).toBe(0);
    expect(r.log).toEqual(['apt-get install -y -qq jq']);
  });

  it('uses Homebrew on a Mac without jq, with no sudo', () => {
    const r = run({ os: 'Darwin', pkg: 'brew', sudo: 'password' });
    expect(r.rc).toBe(0);
    expect(r.log).toEqual(['brew install jq']);
  });

  it('does nothing when jq is already there', () => {
    expect(run({ jq: true, pkg: 'apt-get', sudo: 'cached' })).toEqual({ rc: 0, log: [] });
  });

  it.each<[string, Machine]>([
    ['no package manager it knows', { sudo: 'cached' }],
    ['no sudo', { pkg: 'apt-get' }],
  ])('reports jq missing with %s, running nothing', (_name, m) => {
    expect(run(m)).toEqual({ rc: 1, log: [] });
  });

  it('gives up without prompting when sudo needs a password', () => {
    const r = run({ pkg: 'apt-get', sudo: 'password' });
    expect(r.rc).toBe(1);
    expect(r.log.length).toBeGreaterThan(0);
    expect(r.log.every((l) => l.startsWith('sudo -n '))).toBe(true);
  });
});

// The real nanoclaw.sh and setup.sh in a copy of the repo, with Node and pnpm stubbed.
const COPIED = ['nanoclaw.sh', 'setup.sh', 'assets/setup-splash.txt'].concat(
  ['diagnostics', 'jq', 'node-version', 'sudo-preflight'].map((lib) => `setup/lib/${lib}.sh`),
);
const TOOLS = ['bash', 'cat', 'date', 'dirname', 'grep', 'head', 'mkdir', 'mktemp', 'rm', 'sed', 'sleep', 'tail'];

function bootstrap(m: Machine): { rc: number | null; out: string; jqOk?: string; log: string[] } {
  const { bin, log } = stubs(m);
  for (const tool of [...TOOLS, 'tr', 'whoami']) {
    const at = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
    fs.symlinkSync(at, path.join(bin, tool));
  }
  fs.writeFileSync(path.join(bin, 'node'), '#!/bin/sh\n[ "$1" = --version ] && echo v22.23.4\nexit 0\n', {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(bin, 'pnpm'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  // nanoclaw.sh reads the RAM size with awk from /proc/meminfo, which a Mac lacks.
  fs.writeFileSync(path.join(bin, 'awk'), '#!/bin/sh\necho 8192\n', { mode: 0o755 });
  const repo = path.join(dir, 'repo');
  for (const f of COPIED) {
    fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true });
    fs.copyFileSync(path.join(process.cwd(), f), path.join(repo, f));
  }
  const res = spawnSync('/bin/bash', [path.join(repo, 'nanoclaw.sh')], {
    env: { PATH: bin, HOME: dir, NANOCLAW_NO_DIAGNOSTICS: '1' },
    encoding: 'utf8',
  });
  const raw = fs.readFileSync(path.join(repo, 'logs', 'setup-steps', '01-bootstrap.log'), 'utf8');
  return { rc: res.status, out: res.stdout, jqOk: /^JQ_OK: (\w+)$/m.exec(raw)?.[1], log: calls(log) };
}

// On a Google Cloud VM nanoclaw.sh asks at /dev/tty, which a test can't answer.
const onGce = ['product_name', 'sys_vendor'].some((f) => {
  try {
    return /google/i.test(fs.readFileSync(`/sys/class/dmi/id/${f}`, 'utf8'));
  } catch {
    return false;
  }
});

describe.skipIf(onGce)('bootstrap (nanoclaw.sh + setup.sh)', { timeout: 30_000 }, () => {
  it('installs jq, with no note', () => {
    const r = bootstrap({ pkg: 'apt-get', sudo: 'cached' });
    expect(r.rc).toBe(0);
    expect(r.jqOk).toBe('true');
    expect(r.log).toContain('apt-get install -y -qq jq');
    expect(r.out).toContain('Basics ready');
    expect(r.out).not.toContain("Couldn't install jq.");
  });

  it('goes on with a note after "Basics ready" when it cannot install jq', () => {
    const r = bootstrap({});
    expect(r.rc).toBe(0);
    expect(r.jqOk).toBe('false');
    expect(r.out).toMatch(/Basics ready.*\n.*Couldn't install jq\./);
  });

  it('names skills in the note only as examples when more skills run jq', () => {
    const note = /Couldn't install jq\..*/.exec(bootstrap({}).out)?.[0] ?? '';
    const users = skillsRunningJq();
    const named = users.filter((skill) => new RegExp(`\\b${skill.replace(/^add-/, '')}\\b`, 'i').test(note));
    expect(named.length).toBeGreaterThan(0);
    expect(named.length === users.length || /\bincluding\b/.test(note), `${note}\njq skills: ${users}`).toBe(true);
  });
});

/** Skills whose host-side steps or scripts call jq; the container's own skills and payload code don't count. */
function skillsRunningJq(): string[] {
  const root = path.join(process.cwd(), '.claude', 'skills');
  // jq at a line or pipe start, before a flag, a quote or a bare filter like `length`.
  const callsJq = /(^\s*|[|;&(]\s*)jq\s+[-'".\w$]/m;
  return fs
    .readdirSync(root)
    .filter((skill) => fs.statSync(path.join(root, skill)).isDirectory())
    .filter((skill) =>
      (fs.readdirSync(path.join(root, skill), { recursive: true }) as string[]).some((file) => {
        const full = path.join(root, skill, file);
        if (!/\.(md|sh)$/.test(file) || /^(container-skills|payload)\//.test(file)) return false;
        return fs.statSync(full).isFile() && callsJq.test(fs.readFileSync(full, 'utf8'));
      }),
    );
}
