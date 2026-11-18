// Tool skills attach their key with OneCLI agent grants. On a gateway without
// grants (1.42) a saved key reaches every agent and the attach answers 404, so
// the skills check the gateway and CLI before asking for or saving a key.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const ROOT = path.resolve(__dirname, '..');
const GATE = path.join(ROOT, '.claude/skills/add-onecli/scripts/check-grants-gateway.sh');
const GATE_CMD = (skill: string) => `sh .claude/skills/add-onecli/scripts/check-grants-gateway.sh ${skill}`;

let home: string;
beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'grants-gate-'));
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function gate(opts: {
  version?: string;
  health?: boolean;
  modes?: string[];
  grants?: boolean;
  apiHost?: string;
  cli?: boolean;
  configFails?: boolean;
  listFails?: boolean;
}) {
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin, { recursive: true });
  fs.writeFileSync(
    path.join(bin, 'curl'),
    `#!/bin/sh\n${opts.health === false ? 'exit 7' : `echo '{"status":"ok","version":"${opts.version ?? '1.45.0'}"}'`}\n`,
    { mode: 0o755 },
  );
  const agents = JSON.stringify({
    data: (opts.modes ?? ['selective']).map((m, i) => ({ id: `oc-${i}`, identifier: `ag-${i}`, secretMode: m })),
  });
  fs.writeFileSync(
    path.join(bin, 'onecli'),
    `#!/bin/sh
echo "onecli $*" >> "${home}/calls.log"
case "$1 $2" in
  "config get") ${opts.configFails ? 'exit 3' : `echo '{"key":"api-host","value":"${opts.apiHost ?? 'http://172.17.0.1:10254'}"}'`} ;;
  "agents list") ${opts.listFails ? 'echo "401 Unauthorized" >&2; exit 1' : `echo '${agents}'`} ;;
  "agents grants") [ "${opts.grants === false ? 'no' : 'yes'}" = yes ] || { echo "unknown command" >&2; exit 2; } ;;
  *) exit 9 ;;
esac
`,
    { mode: 0o755 },
  );
  // Without a CLI, drop every PATH entry that holds a real onecli.
  if (opts.cli === false) fs.rmSync(path.join(bin, 'onecli'));
  const rest = (process.env.PATH ?? '')
    .split(':')
    .filter((d) => opts.cli !== false || !fs.existsSync(path.join(d, 'onecli')));
  const r = spawnSync('sh', [GATE, '/add-vercel'], {
    env: { PATH: [bin, ...rest].join(':'), HOME: home },
    encoding: 'utf8',
  });
  const calls = fs.existsSync(path.join(home, 'calls.log'))
    ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n')
    : [];
  return { ...r, calls };
}

describe('OneCLI grants gate', () => {
  it('passes the pinned 1.45 gateway with every agent converted and a CLI that has grants', () => {
    const r = gate({});
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe('1.45.0');
  });

  it.each([
    ['a 1.42 gateway', { version: '1.42.0' }, 'older than 1.44'],
    ['an agent still in all mode', { modes: ['selective', 'all'] }, 'still in all mode'],
    ['a CLI without agents grants', { grants: false }, "no 'agents grants' command"],
    ['an unreachable gateway', { health: false }, 'could not reach the OneCLI gateway'],
    ['a newer gateway', { version: '1.46.0' }, 'newer than the pinned 1.45'],
    ['a three-digit minor', { version: '1.100.0' }, 'newer than the pinned 1.45'],
    ['a two-digit major', { version: '10.0.0' }, 'newer than the pinned 1.45'],
    ['a gateway that reports version unknown', { version: 'unknown' }, "reports version 'unknown'"],
    ['a CLI without an api-host', { apiHost: '' }, 'no api-host'],
    ['no onecli CLI', { cli: false }, 'is not installed'],
  ])('refuses %s and writes nothing', (_name, opts, message) => {
    const r = gate(opts);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(message);
    expect(r.stderr).toContain('Nothing was written to OneCLI');
    expect(r.stderr).toContain('/add-vercel');
    expect(r.calls.some((c) => /secrets (create|update)|grants attach/.test(c))).toBe(false);
  });
});

describe('OneCLI grants gate messages', () => {
  it('says a 1.44 gateway has grants but is not the pin', () => {
    const r = gate({ version: '1.44.2' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('has agent grants but is not the pinned 1.45');
    expect(r.stderr).not.toContain('no agent grants');
  });

  it('says a gateway older than 1.44 has no agent grants', () => {
    expect(gate({ version: '1.42.0' }).stderr).toContain('older than 1.44 and has no agent grants');
  });

  it('names the CLI setup, not the gateway, when the api-host cannot be read', () => {
    const r = gate({ apiHost: '' });
    expect(r.stderr).toContain('onecli config set api-host');
    expect(r.stderr).not.toContain('needs the pinned OneCLI gateway');
  });

  it('says the config read failed, not that no api-host is set, when the CLI cannot read it', () => {
    const r = gate({ configFails: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('`onecli config get api-host` failed');
    expect(r.stderr).not.toContain('no api-host set');
  });

  it('says to start the gateway or fix the api-host, not to upgrade it, when the gateway is unreachable', () => {
    const r = gate({ health: false });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('start the OneCLI gateway');
    expect(r.stderr).toContain('onecli config set api-host');
    expect(r.stderr).not.toContain('needs the pinned OneCLI gateway');
  });

  it.each(['1.45.0-rc1', '1.45.10-rc1', '1.45.0+build', '1.45.', '1.45.0.1'])(
    'refuses the pre-release or build %s like any other',
    (v) => {
      const r = gate({ version: v });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain(`is ${v}, not a 1.45 release`);
    },
  );

  it.each(['1.45.0', '1.45.3', '1.45.10', '1.45.123'])('passes the 1.45 release %s', (v) => {
    const r = gate({ version: v });
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(v);
  });

  it('names the key from .env in the sign-in hint, as the api-host hint does', () => {
    const r = gate({ listFails: true });
    // Quotes go: NanoClaw's own .env reader accepts a quoted value.
    expect(r.stderr).toContain(
      "`grep '^ONECLI_API_KEY=' .env | cut -d= -f2- | tr -d '\"'\"'\" | onecli auth login >/dev/null 2>&1 && echo signed in || echo 'sign-in failed' >&2`",
    );
    expect(r.stderr).not.toContain('--api-key');
    expect(r.stderr).not.toContain('<token>');
  });

  it('says to sign the CLI in, not to upgrade the gateway, when listing agents fails', () => {
    const r = gate({ listFails: true });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('onecli auth login');
    expect(r.stderr).not.toContain('needs the pinned OneCLI gateway');
  });

  it('names the pinned CLI when no onecli CLI is installed', () => {
    const r = gate({ cli: false });
    expect(r.stderr).toContain('needs the pinned onecli CLI, 2.11.0');
    expect(r.stderr).not.toContain('needs the pinned OneCLI gateway');
  });

  it('does not call a gateway that reports version unknown newer than the pin', () => {
    expect(gate({ version: 'unknown' }).stderr).not.toContain('newer than');
  });

  it('names the CLI, not the gateway, when only the CLI is too old', () => {
    const r = gate({ grants: false });
    expect(r.stderr).toContain('needs the pinned onecli CLI, 2.11.0');
    expect(r.stderr).not.toContain('needs the pinned OneCLI gateway');
  });
});

describe('tool skills check the gateway before asking for a key', () => {
  it('/add-vercel runs the gate before asking for the token and before saving it', () => {
    const doc = fs.readFileSync(path.join(ROOT, '.claude/skills/add-vercel/SKILL.md'), 'utf8');
    const at = doc.indexOf(GATE_CMD('/add-vercel'));
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(doc.indexOf('vercel.com/account/tokens'));
    expect(at).toBeLessThan(doc.indexOf('onecli secrets create'));
  });

  it('/add-tavily-tool removes an earlier upgrade block when the gate fails', () => {
    const doc = fs.readFileSync(path.join(ROOT, '.claude/skills/add-tavily-tool/SKILL.md'), 'utf8');
    const phase = doc.slice(
      doc.indexOf('## Phase 5: Install the upgrade path'),
      doc.indexOf('Resolve the OneCLI dashboard URL'),
    );
    expect(phase).toMatch(/remove[^.]*tavily-upgrade:start/i);
    // Running agents keep the old block in their prompt until they restart.
    expect(phase).toMatch(/restart each group you removed it from/i);
  });

  it('/add-tavily-tool runs the gate before installing the paid-key upgrade path', () => {
    const doc = fs.readFileSync(path.join(ROOT, '.claude/skills/add-tavily-tool/SKILL.md'), 'utf8');
    const at = doc.indexOf(GATE_CMD('/add-tavily-tool'));
    expect(at).toBeGreaterThan(doc.indexOf('## Phase 5: Install the upgrade path'));
    expect(at).toBeLessThan(doc.indexOf('Resolve the OneCLI dashboard URL'));
  });
});
