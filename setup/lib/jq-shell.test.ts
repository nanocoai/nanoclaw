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
  /** apt-get can't find jq until `apt-get update` runs (a fresh distro). */
  staleLists?: boolean;
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jq-install-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

function run(m: Machine): { rc: number; log: string[] } {
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
        `case "$*" in *update*) : > '${dir}/updated'; exit 0 ;; esac`,
        m.staleLists ? `[ -e '${dir}/updated' ] || exit 100` : '',
        `printf '#!/bin/sh\\n' > '${bin}/jq' && /bin/chmod +x '${bin}/jq'`,
      ].join('\n'),
    );
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
  const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
  return { rc, log: calls };
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

  it.each([
    ['dnf', 'dnf install -y -q jq'],
    ['yum', 'yum install -y -q jq'],
    ['zypper', 'zypper --non-interactive --quiet install jq'],
    ['pacman', 'pacman -S --noconfirm --needed jq'],
    ['apk', 'apk add --quiet jq'],
  ])('uses %s on distros without apt', (pkg, call) => {
    const r = run({ pkg, sudo: 'cached' });
    expect(r.rc).toBe(0);
    expect(r.log).toContain(call);
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

describe('bootstrap wiring', () => {
  const setupSh = fs.readFileSync(path.join(process.cwd(), 'setup.sh'), 'utf8');
  const entrypoint = fs.readFileSync(path.join(process.cwd(), 'nanoclaw.sh'), 'utf8');

  it('setup.sh installs jq and reports it in the status block', () => {
    expect(setupSh).toContain('source "$PROJECT_ROOT/setup/lib/jq.sh"');
    expect(setupSh).toMatch(/ensure_jq >> "\$LOG_FILE" 2>&1/);
    expect(setupSh).toContain('JQ_OK: $JQ_OK');
  });

  it('nanoclaw.sh says so after the bootstrap when jq is still missing', () => {
    const ready = entrypoint.indexOf('spinner_success "Basics ready"');
    const check = entrypoint.indexOf('grep_field JQ_OK "$BOOTSTRAP_RAW"');
    expect(ready).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(ready);
  });
});
