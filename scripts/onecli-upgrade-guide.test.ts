// Behavior tests for the save commands in the OneCLI upgrade guide.
//
// The guide is handed to a coding agent verbatim, so its one-liners are the
// product. These tests take the two commands that write ONECLI_VERSION to
// ~/.onecli/.env (upgrade and rollback) OUT of the guide, fill the placeholder,
// and run them against a throwaway HOME. An empty value must never reach the
// file: the stock compose file then falls back to `latest`.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GUIDE = path.resolve(__dirname, '../.claude/skills/add-onecli/payload/docs/onecli-upgrades.md');
const saveLines = fs
  .readFileSync(GUIDE, 'utf8')
  .split('\n')
  .filter((l) => l.includes('echo "ONECLI_VERSION=$P"'));
const saveLine = (placeholder: RegExp): string => {
  const hits = saveLines.filter((l) => placeholder.test(l));
  if (hits.length !== 1) throw new Error(`expected exactly one save command for ${placeholder}, found ${hits.length}`);
  return hits[0];
};
const UPGRADE = /P=<onecli-gateway pin from [^>]+>/;
const ROLLBACK = /P=<old-version>/;

let home: string;
let envFile: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-guide-'));
  fs.mkdirSync(path.join(home, '.onecli'));
  envFile = path.join(home, '.onecli', '.env');
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

function save(placeholder: RegExp, value: string, shell = 'sh') {
  const cmd = saveLine(placeholder).replace(placeholder, () => `P=${value}`);
  return spawnSync(shell, ['-c', cmd], { env: { PATH: process.env.PATH ?? '', HOME: home }, encoding: 'utf8' });
}

describe('OneCLI upgrade guide: save commands', () => {
  it('names the pin file by its full path in every placeholder', () => {
    const guide = fs.readFileSync(GUIDE, 'utf8');
    expect(guide).not.toMatch(/pin from versions\.json/);
    expect(saveLines).toHaveLength(2);
  });

  it('backs up the gateway database before the pull and restart', () => {
    const guide = fs.readFileSync(GUIDE, 'utf8');
    const backup = guide.split('\n').filter((l) => l.includes('pg_dump'));
    expect(backup).toHaveLength(1);
    expect(backup[0]).not.toMatch(/!|\s#\s/);
    expect(guide.indexOf(backup[0])).toBeLessThan(guide.indexOf('docker compose pull onecli'));
    expect(spawnSync('sh', ['-n', '-c', backup[0]]).status).toBe(0);
  });

  // `docker` is a stub that prints what a complete, cut-off, or failed dump would.
  it.each([
    ['complete', 'echo "-- PostgreSQL database dump complete"', true],
    ['cut off', 'echo "CREATE TABLE x"', false],
    ['failed', 'echo "CREATE TABLE x"; exit 1', false],
  ])('backup keeps the file only for a complete dump: %s', (_name, body, kept) => {
    const backup = fs
      .readFileSync(GUIDE, 'utf8')
      .split('\n')
      .filter((l) => l.includes('pg_dump'))[0];
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    const r = spawnSync('sh', ['-c', backup], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
      encoding: 'utf8',
    });
    const files = fs.readdirSync(home).filter((f) => f.startsWith('onecli-db-backup-'));
    expect(r.status === 0).toBe(kept);
    expect(files).toHaveLength(kept ? 1 : 0);
    if (kept) expect(fs.statSync(path.join(home, files[0])).mode & 0o777).toBe(0o600);
    else expect(r.stderr).toContain('Backup failed, nothing saved');
  });

  // An unquoted `!` is history expansion when pasted into interactive zsh or bash.
  // So is a trailing `#` comment in zsh, where it is a parse error.
  it('save commands contain no `!` and no trailing comment', () => {
    for (const l of saveLines) expect(l).not.toMatch(/!|\s#\s/);
  });

  it('a refused rollback save does not go on to restart the gateway', () => {
    fs.writeFileSync(envFile, 'ONECLI_VERSION=\n');
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$@" >> "${home}/docker.log"\n`, { mode: 0o755 });
    const cmd = saveLine(ROLLBACK).replace(ROLLBACK, 'P=');
    const r = spawnSync('sh', ['-c', cmd], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(fs.existsSync(path.join(home, 'docker.log'))).toBe(false);
  });

  for (const shell of ['sh', 'bash']) {
    it(`upgrade save writes the pin and keeps other settings (${shell})`, () => {
      fs.writeFileSync(envFile, 'ONECLI_BIND_HOST=172.17.0.1\nONECLI_VERSION=1.41.0\n', { mode: 0o600 });
      const r = save(UPGRADE, '1.42.0', shell);
      expect(r.status).toBe(0);
      expect(fs.readFileSync(envFile, 'utf8')).toBe('ONECLI_BIND_HOST=172.17.0.1\nONECLI_VERSION=1.42.0\n');
      expect(fs.statSync(envFile).mode & 0o777).toBe(0o600);
    });

    it(`upgrade save refuses an empty pin and leaves .env alone (${shell})`, () => {
      const before = 'ONECLI_BIND_HOST=172.17.0.1\nONECLI_VERSION=1.41.0\n';
      fs.writeFileSync(envFile, before);
      const r = save(UPGRADE, '', shell);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('Not saved');
      expect(fs.readFileSync(envFile, 'utf8')).toBe(before);
      expect(fs.existsSync(`${envFile}.new`)).toBe(false);
    });
  }

  it('upgrade save does not create .env when the pin is empty', () => {
    expect(save(UPGRADE, '').status).not.toBe(0);
    expect(fs.existsSync(envFile)).toBe(false);
  });

  it.each(['latest', 'null', '1.42', '1..42', '.1.42', '1.42.', 'v1.42.0', '"1.42.0 x"'])(
    'upgrade save refuses a non-version value: %s',
    (value) => {
      fs.writeFileSync(envFile, 'ONECLI_VERSION=1.41.0\n');
      expect(save(UPGRADE, value).status).not.toBe(0);
      expect(fs.readFileSync(envFile, 'utf8')).toBe('ONECLI_VERSION=1.41.0\n');
    },
  );

  it.each(['1.41.0', 'rollback'])('rollback save accepts %s', (value) => {
    fs.writeFileSync(envFile, 'ONECLI_VERSION=1.42.0\n');
    // Keep only the save: the rest of the line restarts the gateway.
    const cmd = saveLine(ROLLBACK)
      .replace(ROLLBACK, () => `P=${value}`)
      .replace(/\) && env -u .*$/, ')');
    expect(spawnSync('sh', ['-c', cmd], { env: { PATH: process.env.PATH ?? '', HOME: home } }).status).toBe(0);
    expect(fs.readFileSync(envFile, 'utf8')).toBe(`ONECLI_VERSION=${value}\n`);
  });

  it.each(['', 'latest', '"1.41.0 x"'])('rollback save refuses: [%s]', (value) => {
    fs.writeFileSync(envFile, 'ONECLI_VERSION=1.42.0\n');
    const r = save(ROLLBACK, value);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Not saved');
    expect(fs.readFileSync(envFile, 'utf8')).toBe('ONECLI_VERSION=1.42.0\n');
  });

  it('the migration warning sends the reader back to the pin, not to the old version', () => {
    const warning = fs
      .readFileSync(GUIDE, 'utf8')
      .split('\n')
      .find((l) => l.startsWith('**If a gateway newer than the pin'));
    expect(warning).toContain('back on the pin (step 2)');
    expect(warning).not.toContain('step 4');
  });
});

// The pre-upgrade check, taken out of the guide and run against a stub `onecli`
// that prints the given draft/published rules and project default.
describe('OneCLI upgrade guide: pre-upgrade check', () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const CHECK = 'GW="$GW" sh .claude/skills/add-onecli/scripts/pre-upgrade-check.sh';
  const SCRIPT = path.resolve(__dirname, '../.claude/skills/add-onecli/scripts/pre-upgrade-check.sh');

  type Rule = Record<string, unknown>;
  const rule = (over: Rule = {}): Rule => ({
    name: 'app rule',
    action: 'allow',
    isDefault: false,
    source: 'custom',
    rateLimit: null,
    conditions: null,
    targets: [{ kind: 'app', provider: 'github' }],
    ...over,
  });

  function check(opts: {
    rules?: Rule[];
    published?: Rule[];
    def?: string;
    defRaw?: string;
    fail?: string;
    raw?: string;
    hint?: boolean;
    gw?: string | null;
  }) {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const rules = (st: string) => {
      const list = st === 'published' ? (opts.published ?? opts.rules ?? []) : (opts.rules ?? []);
      return JSON.stringify(opts.hint ? { hint: 'project rules', data: list } : list);
    };
    fs.writeFileSync(path.join(home, 'draft.json'), opts.raw ?? rules('draft'));
    fs.writeFileSync(path.join(home, 'published.json'), opts.raw ?? rules('published'));
    fs.writeFileSync(
      path.join(home, 'default.json'),
      opts.defRaw ?? JSON.stringify({ isDefault: true, action: opts.def ?? 'allow' }),
    );
    fs.writeFileSync(
      path.join(bin, 'onecli'),
      `#!/bin/sh
echo "$ONECLI_API_HOST $*" >> "${home}/onecli.log"
case "$1 $2 $3" in
  "policy rules list") [ "${opts.fail ?? ''}" = rules ] && { echo '{"error":"unauthorized"}' >&2; exit 1; }; cat "${home}/$5.json" ;;
  "policy default get") [ "${opts.fail ?? ''}" = default ] && exit 1; cat "${home}/default.json" ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    const gw = opts.gw === undefined ? 'http://172.17.0.1:10254' : opts.gw;
    return spawnSync('sh', [SCRIPT], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, ...(gw === null ? {} : { GW: gw }) },
      encoding: 'utf8',
    });
  }

  it('warns, before the pin is written, that every NanoClaw sharing the gateway needs code that grants credentials', () => {
    const at = guide.search(/every NanoClaw install that shares this gateway/i);
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(guide.indexOf(saveLine(UPGRADE)));
  });

  it('is one command and runs before the pin is written to ~/.onecli/.env', () => {
    expect(guide.split('\n').filter((l) => l === CHECK)).toHaveLength(1);
    expect(guide.indexOf(CHECK)).toBeLessThan(guide.indexOf(saveLine(UPGRADE)));
  });

  it('passes a policy the conversion keeps: app rules, connection session policies, blocklist rows', () => {
    const r = check({
      rules: [
        rule(),
        rule({ name: 'repo scope', conditions: { repositories: ['a/b'] } }),
        rule({ name: 'empty conditions', conditions: [] }),
        rule({ name: 'blocked host', source: 'blocklist', targets: [{ kind: 'network', hostPattern: 'x.test' }] }),
        rule({ name: 'block with limit', action: 'block', rateLimit: 5 }),
        rule({ name: 'plain secret allow', targets: [{ kind: 'secret', secretId: 's1' }] }),
      ],
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK: the conversion deletes nothing');
  });

  it.each([
    [
      'a network rule',
      rule({
        name: 'Dial: blocked agents',
        action: 'block',
        targets: [{ kind: 'network', hostPattern: 'api.getdial.ai' }],
      }),
    ],
    [
      'a behavioral rule',
      rule({ name: 'only weekdays', conditions: [{ field: 'time', op: 'in', value: 'weekdays' }] }),
    ],
    ['an allow rule with a rate limit', rule({ name: 'limited', rateLimit: 10 })],
    [
      'a block rule on a secret',
      rule({ name: 'no openai key', action: 'block', targets: [{ kind: 'secret', secretId: 's1' }] }),
    ],
    [
      'an approval rule on a secret',
      rule({ name: 'ask first', requireApproval: true, targets: [{ kind: 'secret', secretId: 's1' }] }),
    ],
  ])('stops on %s', (_name, finding) => {
    const r = check({ rules: [rule(), finding] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(`rule: ${String(finding.action)}  ${String(finding.name)}`);
  });

  it('the guide hands the Detect step’s unexported GW to the script', () => {
    const r = spawnSync(
      'sh',
      [
        '-c',
        `GW=http://from-detect.test:1; ${CHECK.replace('sh .claude', `sh ${path.resolve(__dirname, '..')}/.claude`)}`,
      ],
      {
        env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH ?? ''}`, HOME: home },
        encoding: 'utf8',
      },
    );
    expect(r.stdout).toContain('Checking the policy at http://from-detect.test:1');
  });

  it('asks the gateway being upgraded ($GW), and stops before any call when GW is unset', () => {
    expect(check({ gw: 'http://gw.example:10254' }).status).toBe(0);
    const log = fs.readFileSync(path.join(home, 'onecli.log'), 'utf8').trim().split('\n');
    expect(log.every((l) => l.startsWith('http://gw.example:10254 policy '))).toBe(true);
    fs.rmSync(path.join(home, 'onecli.log'));
    const r = check({ gw: null });
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('OK:');
    expect(fs.existsSync(path.join(home, 'onecli.log'))).toBe(false);
  });

  it('stops when the draft has unpublished changes, which the conversion would publish', () => {
    const block = rule({ name: 'no github writes', action: 'block' });
    const r = check({ rules: [], published: [block] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('unpublished changes');
    expect(
      check({ rules: [block], published: [{ ...block, id: 'pub-1', status: 'published', generation: 3 }] }).status,
    ).toBe(0);
    // Per-copy fields a gateway may add or change never count as an unpublished change.
    const copy = {
      ...block,
      id: 'pub-2',
      logicalId: 'l1',
      updatedAt: '2026-10-19',
      createdAt: 'x',
      description: 'note',
    };
    expect(check({ rules: [{ ...block, logicalId: 'l1' }], published: [copy] }).status).toBe(0);
    // A change to what the rule does is one.
    expect(check({ rules: [block], published: [{ ...block, identities: [{ type: 'agent', id: 'a2' }] }] }).status).toBe(
      1,
    );
  });

  it('a rule listing several agents or targets in another order is not an unpublished change', () => {
    const agents = [
      { type: 'agent', id: 'a1' },
      { type: 'agent', id: 'a2' },
      { type: 'agent', id: 'a3' },
    ];
    const targets = [
      { kind: 'app', provider: 'github' },
      { kind: 'app', provider: 'gitlab' },
    ];
    const draft = rule({ name: 'shared apps', identities: agents, targets });
    const published = rule({
      name: 'shared apps',
      // Same set, other order, keys in another order: how a published copy can come back.
      identities: [agents[2], { id: 'a1', type: 'agent' }, agents[1]],
      targets: [{ provider: 'gitlab', kind: 'app' }, targets[0]],
    });
    const r = check({ rules: [draft], published: [published] });
    expect(r.stdout).not.toContain('unpublished changes');
    expect(r.status).toBe(0);
    // A different set is still a change.
    const other = rule({ name: 'shared apps', identities: [agents[0], agents[1]], targets });
    expect(check({ rules: [draft], published: [other] }).status).toBe(1);
  });

  it('stops on a block project default', () => {
    const r = check({ def: 'block' });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('default: block');
  });

  it('stops on a finding only the published rules carry, and reads the CLI hint envelope', () => {
    const net = rule({ name: 'egress', targets: [{ kind: 'network', hostPattern: 'h.test' }] });
    expect(check({ rules: [], published: [net] }).status).toBe(1);
    expect(check({ rules: [net], hint: true }).status).toBe(1);
  });

  it.each([
    ['the rules list fails', { fail: 'rules' }],
    ['the default read fails', { fail: 'default' }],
    ['the output is not JSON', { raw: 'Unauthorized' }],
    ['the rules output is empty', { raw: '' }],
    ['the rules output is not a list', { raw: '{"error":"x"}' }],
    ['the default is empty', { defRaw: '' }],
    ['the default is null', { defRaw: 'null' }],
    ['the default has no action', { defRaw: '{}' }],
  ])('stops, never reports OK, when %s', (_name, opts) => {
    const r = check(opts);
    expect(r.status).not.toBe(0);
    expect(r.stdout).not.toContain('OK:');
    expect(r.stderr).toContain('STOP');
  });
});

// The restore command, taken out of the guide and run against a stub `docker`.
describe('OneCLI upgrade guide: restoring the backup', () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const restoreLines = guide.split('\n').filter((l) => l.includes('psql -q -v ON_ERROR_STOP=1'));
  const PLACEHOLDER = /F=<backup file from step 2>/;

  function restore(file: string, dockerBody = '') {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'docker'), `#!/bin/sh\necho "$*" >> "${home}/docker.log"\n${dockerBody}\n`, {
      mode: 0o755,
    });
    const cmd = restoreLines[0].replace(PLACEHOLDER, () => `F=${file}`);
    return spawnSync('sh', ['-c', cmd], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home },
      encoding: 'utf8',
    });
  }
  const dockerLog = () =>
    fs.existsSync(path.join(home, 'docker.log'))
      ? fs.readFileSync(path.join(home, 'docker.log'), 'utf8').trim().split('\n')
      : [];

  it('is one command, comes after the rollback save, and has no `!` or trailing comment', () => {
    expect(restoreLines).toHaveLength(1);
    expect(guide.indexOf(restoreLines[0])).toBeGreaterThan(guide.indexOf(saveLine(ROLLBACK)));
    expect(restoreLines[0]).not.toMatch(/!|\s#\s/);
  });

  it.each([
    ['a missing file', () => path.join(home, 'nope.sql')],
    ['an empty file', () => (fs.writeFileSync(path.join(home, 'empty.sql'), ''), path.join(home, 'empty.sql'))],
  ])('refuses %s before touching the gateway', (_name, file) => {
    const r = restore(file());
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Not restored');
    expect(dockerLog()).toEqual([]);
  });

  it('stops the gateway, recreates the database, loads the backup, then starts the gateway', () => {
    const file = path.join(home, 'onecli-db-backup.sql');
    fs.writeFileSync(file, '-- PostgreSQL database dump complete\n');
    expect(restore(file).status).toBe(0);
    const log = dockerLog();
    expect(log[0]).toBe('compose stop onecli');
    expect(log[1]).toMatch(/^compose exec -T postgres sh -c dropdb .* && createdb /);
    expect(log[2]).toMatch(/^compose exec -T postgres sh -c psql -q -v ON_ERROR_STOP=1 /);
    expect(log[3]).toBe('compose up -d');
  });

  it('does not start the gateway on a database that failed to load', () => {
    const file = path.join(home, 'onecli-db-backup.sql');
    fs.writeFileSync(file, 'broken\n');
    const r = restore(file, 'case "$*" in *psql*) exit 3;; esac');
    expect(r.status).not.toBe(0);
    expect(dockerLog()).not.toContain('compose up -d');
  });
});

// Dial spends money and reaches real people, but deleting its key on a gateway
// that already converted takes Dial from every agent that should have it. So the
// guide deletes the key only when its check says the conversion is still ahead
// and could widen Dial, then re-runs /add-dial-tool.
// Each case runs the check (several stubbed CLI calls) once or more; give a busy runner room.
describe('OneCLI upgrade guide: Dial installs', { timeout: 20_000 }, () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const CHECK = 'GW="$GW" sh .claude/skills/add-onecli/scripts/dial-key-check.sh';
  const SCRIPT = path.resolve(__dirname, '../.claude/skills/add-onecli/scripts/dial-key-check.sh');
  const GW = 'http://127.0.0.1:10254';
  const DIAL_RULE = {
    name: 'Dial: blocked agents',
    action: 'block',
    isDefault: false,
    source: 'custom',
    rateLimit: null,
    conditions: null,
    identities: [{ type: 'agent', id: 'oc-unchosen' }],
    targets: [{ kind: 'network', hostPattern: 'api.getdial.ai' }],
  };
  const SECRETS = {
    hint: 'h',
    data: [
      { id: 'd1', name: 'Dial API', hostPattern: 'api.getdial.ai' },
      { id: 'x1', name: 'Phone key', hostPattern: 'api.getdial.ai' },
      { id: 'm1', name: 'Anthropic', hostPattern: 'api.anthropic.com' },
    ],
  };
  const health = (version: string) => JSON.stringify({ status: 'ok', version });
  const DRAFT_DEFAULT = { id: 'def-draft', isDefault: true, source: 'default', action: 'allow' };
  const PUB_DEFAULT = { id: 'def-pub', isDefault: true, source: 'default', action: 'allow' };
  const rule = (over: Record<string, unknown>) => ({
    name: 'r',
    action: 'allow',
    isDefault: false,
    source: 'custom',
    rateLimit: null,
    conditions: null,
    identities: [],
    targets: [{ kind: 'app', provider: 'github' }],
    ...over,
  });

  // `curl` answers the health reads in turn (the last one repeats), so a test can
  // move the gateway between the check and a delete.
  function dial(
    opts: {
      version?: string;
      healths?: string[];
      healthExit?: number;
      modes?: string[];
      agentsRaw?: string;
      cliProject?: string;
      secrets?: unknown;
      secretsRaw?: string;
      listExit?: number;
      rules?: unknown[];
      published?: unknown[];
      gatewayEnv?: string[] | null;
      ports?: unknown;
      dockerHost?: string;
      defs?: { draft?: unknown; published?: unknown };
      rulesExit?: number;
      deleteExit?: number;
      gw?: string | null;
      env?: Record<string, string>;
    } = {},
    args: string[] = [],
  ) {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    const healths = opts.healths ?? [health(opts.version ?? '1.42.0')];
    healths.forEach((h, i) => fs.writeFileSync(path.join(home, `health${i}.json`), h));
    fs.writeFileSync(path.join(home, 'secrets.json'), opts.secretsRaw ?? JSON.stringify(opts.secrets ?? SECRETS));
    fs.writeFileSync(path.join(home, 'rules-draft.json'), JSON.stringify(opts.rules ?? [DIAL_RULE]));
    fs.writeFileSync(
      path.join(home, 'rules-published.json'),
      JSON.stringify(opts.published ?? opts.rules ?? [DIAL_RULE]),
    );
    fs.writeFileSync(
      path.join(home, 'gateway-ports.json'),
      JSON.stringify(opts.ports ?? { '10254/tcp': [{ HostIp: '127.0.0.1', HostPort: '10254' }], '5432/tcp': null }),
    );
    fs.writeFileSync(
      path.join(home, 'gateway-env.txt'),
      (opts.gatewayEnv ?? ['PATH=/usr/bin', 'NODE_ENV=production']).join('\n'),
    );
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
echo "docker $*" >> "${home}/calls.log"
[ "$1 $2" = "context inspect" ] && { echo "\${DOCKER_HOST:-${opts.dockerHost ?? 'unix:///var/run/docker.sock'}}"; exit 0; }
[ "$1" = -H ] && { [ "$2" = "\${DOCKER_HOST:-${opts.dockerHost ?? 'unix:///var/run/docker.sock'}}" ] || exit 8; shift 2; }
[ "$1" = inspect ] && [ "${opts.gatewayEnv === null ? 'no' : 'yes'}" = yes ] || exit 1
case "$3" in *Ports*) cat "${home}/gateway-ports.json" ;; *Env*) cat "${home}/gateway-env.txt" ;; *) exit 7 ;; esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(path.join(home, 'default-draft.json'), JSON.stringify(opts.defs?.draft ?? DRAFT_DEFAULT));
    fs.writeFileSync(path.join(home, 'default-published.json'), JSON.stringify(opts.defs?.published ?? PUB_DEFAULT));
    const agents = (opts.modes ?? ['selective']).map((secretMode, i) => ({
      id: `oc-${i}`,
      identifier: `ag-${i}`,
      secretMode,
    }));
    fs.writeFileSync(path.join(home, 'agents.json'), opts.agentsRaw ?? JSON.stringify({ data: agents }));
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh
echo "curl $*" >> "${home}/calls.log"
[ ${opts.healthExit ?? 0} = 0 ] || exit ${opts.healthExit ?? 0}
n=$(grep -c '^curl ' "${home}/calls.log"); i=$((n - 1)); [ "$i" -lt ${healths.length} ] || i=${healths.length - 1}
cat "${home}/health$i.json"
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'onecli'),
      `#!/bin/sh
echo "$ONECLI_API_HOST $*" >> "${home}/calls.log"
case "$1 $2" in
  "secrets list") [ "$3 $4" = "--max 0" ] || exit 7; [ ${opts.listExit ?? 0} = 0 ] || exit ${opts.listExit ?? 0}; cat "${home}/secrets.json" ;;
  "secrets delete") exit ${opts.deleteExit ?? 0} ;;
  "agents list") [ "$3 $4" = "--max 0" ] || exit 7; cat "${home}/agents.json" ;;
  "policy rules") [ "$3 $4" = "list --status" ] || exit 7; [ ${opts.rulesExit ?? 0} = 0 ] || exit ${opts.rulesExit ?? 0}; cat "${home}/rules-$5.json" ;;
  "policy default") [ "$3 $4" = "get --status" ] || exit 7; cat "${home}/default-$5.json" ;;
  "config get") [ "$3" = project ] || exit 7; echo '{"key":"project","value":"${opts.cliProject ?? ''}"}' ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    const gw = opts.gw === undefined ? GW : opts.gw;
    return spawnSync('sh', [SCRIPT, ...args], {
      env: {
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        HOME: home,
        ...(gw === null ? {} : { GW: gw }),
        ...(opts.env ?? {}),
      },
      encoding: 'utf8',
    });
  }
  const calls = () =>
    fs.existsSync(path.join(home, 'calls.log'))
      ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n')
      : [];
  const deletes = () => calls().filter((l) => l.includes('secrets delete'));

  it('checks before the pull, deletes only through the check, then re-runs /add-dial-tool', () => {
    const lines = guide.split('\n');
    expect(lines.filter((l) => l === CHECK)).toHaveLength(1);
    expect(lines.filter((l) => l === `${CHECK} --delete`)).toHaveLength(1);
    const pre = guide.indexOf('GW="$GW" sh .claude/skills/add-onecli/scripts/pre-upgrade-check.sh');
    const at = guide.indexOf(`${CHECK}\n`);
    const del = guide.indexOf(`${CHECK} --delete`);
    expect(pre).toBeLessThan(at);
    expect(at).toBeLessThan(del);
    expect(del).toBeLessThan(guide.indexOf(saveLine(UPGRADE)));
    expect(del).toBeLessThan(guide.indexOf('docker compose pull onecli'));
    const before = guide.slice(0, guide.lastIndexOf('```bash', del)).trimEnd();
    const paragraph = before.slice(before.lastIndexOf('\n\n'));
    expect(paragraph).toMatch(/If it prints `delete`/);
    expect(paragraph).toMatch(/If it prints `keep`, do not delete the Dial key/);
    expect(guide.slice(0, at)).toMatch(/runs once per project \(`ONECLI_PROJECT=<project id>` in front\)/);
    expect(guide.slice(del)).toMatch(/re-run `\/add-dial-tool` after the upgrade/);
    // No Dial delete outside the check, and no unconditional advice left.
    expect(guide.slice(0, guide.indexOf('## 3. Verify'))).not.toMatch(/secrets delete/);
    expect(guide).not.toMatch(/delete any Dial key before you pull/i);
    expect(guide).not.toMatch(/upgraded with the key in place, delete it now/);
  });

  it('a gateway that has not converted, with a Dial key and a rule the conversion deletes: deletes every key for the Dial host', () => {
    const r = dial({}, ['--delete']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(`delete: the gateway at ${GW} (1.42.0) has not converted yet`);
    expect(r.stdout).toContain('rule: block "Dial: blocked agents"');
    expect(deletes()).toEqual([`${GW} secrets delete --id d1`, `${GW} secrets delete --id x1`]);
  });

  it('without --delete it only reports: delete and the keys, exit 1, nothing deleted', () => {
    const r = dial();
    expect(r.status).toBe(1);
    expect(r.stdout).toMatch(/^delete: [^]*\nDial keys in the [^\n]*\nd1 "Dial API"\nx1 "Phone key"\n$/m);
    expect(deletes()).toEqual([]);
  });

  it.each([
    [
      'a gateway already on 1.45, which converted',
      { version: '1.45.0' },
      /keep: .* runs 1\.45\.0 and every agent in the project of the OneCLI API key has converted/,
    ],
    ['a gateway on 1.44, which converted', { version: '1.44.2' }, /has converted/],
    ['a gateway with no Dial key', { secrets: { data: [SECRETS.data[2]] } }, /keep: there is no Dial key/],
    ['a policy the conversion keeps (Dial scoped to all)', { rules: [] }, /keep: nothing the conversion removes/],
    [
      'a policy the conversion keeps, even with a catch-all secret',
      { rules: [], secrets: { data: [{ id: 'c1', name: 'All hosts', hostPattern: '*' }] } },
      /keep: nothing the conversion removes/,
    ],
    [
      'a cloud build version (1.45.0+f6cca6e5)',
      { version: '1.45.0+f6cca6e5' },
      /runs 1\.45\.0\+f6cca6e5 and every agent/,
    ],
  ])('keeps the Dial key on %s, even with --delete', (_name, opts, said) => {
    const r = dial(opts, ['--delete']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(said);
    expect(deletes()).toEqual([]);
    expect(dial(opts).status).toBe(0);
  });

  it('on a converted gateway it reads only the version and the agent modes', () => {
    expect(dial({ version: '1.45.0' }, ['--delete']).status).toBe(0);
    expect(calls().filter((l) => !l.startsWith('docker '))).toEqual([
      `${GW} config get project`,
      `curl -fsS --max-time 10 ${GW}/api/health`,
      `${GW} agents list --max 0`,
    ]);
  });

  it('on 1.44+ the keep points at the guide paragraph for a gateway that converted with the Dial rule', () => {
    const r = dial({ version: '1.45.0' });
    expect(r.stdout).toContain('"If the gateway already converted" in docs/onecli-upgrades.md');
    expect(guide).toContain('If the gateway already converted while `Dial: blocked agents` was in place');
  });

  it.each([
    ['reports unknown (OneCLI 1.24 to 1.38)', { version: 'unknown' }],
    ['reports no version (older than 1.24)', { healths: ['{"status":"ok"}'] }],
    ['runs 1.41.0', { version: '1.41.0' }],
  ])(
    'a gateway that %s and holds a Dial key: delete, since it has no policy to read and moving it can open Dial',
    (_n, opts) => {
      const r = dial(opts);
      expect(r.status).toBe(1);
      expect(r.stdout).toMatch(/older than 1\.42/);
      expect(calls().some((l) => l.includes(' policy '))).toBe(false);
      expect(dial(opts, ['--delete']).status).toBe(0);
      expect(deletes()).toEqual([`${GW} secrets delete --id d1`, `${GW} secrets delete --id x1`]);
    },
  );

  it('a gateway older than 1.42 with no Dial key keeps', () => {
    const r = dial({ version: 'unknown', secrets: { data: [SECRETS.data[2]] } }, ['--delete']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/keep: there is no Dial key/);
  });

  it('the guide tells a gateway older than 1.42, one that reports unknown included, to move to 1.42.0 first', () => {
    const pre = guide.indexOf('GW="$GW" sh .claude/skills/add-onecli/scripts/pre-upgrade-check.sh');
    const after = guide.slice(pre, guide.indexOf(`${CHECK}\n`));
    expect(after).toMatch(/older than 1\.42[^\n]*`unknown`[^\n]*1\.24 to 1\.38[^\n]*Dial check[^\n]*move the gateway to 1\.42\.0/);
  });

  it('deletes on a 1.42 project whose rules were never cut over (published default has no id): the old rules decide', () => {
    const r = dial({ defs: { published: { ...PUB_DEFAULT, id: '' } }, rules: [] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('never moved to the policy API');
  });

  it.each([
    [
      'a network block on another host',
      rule({ name: 'egress', action: 'block', targets: [{ kind: 'network', hostPattern: 'api.example.com' }] }),
    ],
    ['a rate-limited allow on an app', rule({ name: 'limited', rateLimit: 10 })],
    [
      'a behavioral rule on an app',
      rule({ name: 'weekdays', conditions: [{ field: 'time', op: 'in', value: 'weekdays' }] }),
    ],
    [
      'a block on another secret',
      rule({ name: 'no openai', action: 'block', targets: [{ kind: 'secret', secretId: 'm1' }] }),
    ],
    [
      'a plain allow on a Dial key, which the conversion keeps',
      rule({ name: 'dial ok', targets: [{ kind: 'secret', secretId: 'd1' }] }),
    ],
    ['a disabled block on the Dial host', { ...DIAL_RULE, enabled: false }],
    [
      'a plain network allow on the Dial host',
      rule({ name: 'dial open', targets: [{ kind: 'network', hostPattern: 'api.getdial.ai' }] }),
    ],
    [
      'a conditional allow on the Dial host',
      rule({
        name: 'dial weekdays',
        conditions: [{ field: 'time', op: 'in', value: 'weekdays' }],
        targets: [{ kind: 'network', hostPattern: 'api.getdial.ai' }],
      }),
    ],
  ])('keeps the Dial key when the only finding is %s', (_name, finding) => {
    const r = dial({ rules: [finding] }, ['--delete']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/keep: nothing the conversion removes .* touches Dial/);
    expect(deletes()).toEqual([]);
  });

  it('keeps the Dial key when only an unrelated draft change is unpublished', () => {
    const other = rule({ name: 'egress', action: 'block', targets: [{ kind: 'network', hostPattern: 'h.test' }] });
    const r = dial({ rules: [other], published: [] });
    expect(r.status).toBe(0);
  });

  it.each([
    ['a block on the Dial host', DIAL_RULE],
    ['a legacy per-group Dial block', { ...DIAL_RULE, name: 'Dial: blocked for sales' }],
    [
      'a catch-all network block',
      rule({ name: 'no egress', action: 'block', targets: [{ kind: 'network', hostPattern: '*' }] }),
    ],
    [
      'a wildcard block on getdial.ai',
      rule({ name: 'wild', action: 'block', targets: [{ kind: 'network', hostPattern: '*.GetDial.ai' }] }),
    ],
    [
      'a block on a Dial key',
      rule({ name: 'no dial key', action: 'block', targets: [{ kind: 'secret', secretId: 'x1' }] }),
    ],
    [
      'an approval on a Dial key',
      rule({ name: 'ask dial', requireApproval: true, targets: [{ kind: 'secret', secretId: 'd1' }] }),
    ],
    [
      'a block on every secret',
      rule({ name: 'no secrets', action: 'block', targets: [{ kind: 'secret', secretScope: 'project' }] }),
    ],
    [
      'a rate-limited allow on the Dial host',
      rule({ name: 'dial rate', rateLimit: 5, targets: [{ kind: 'network', hostPattern: 'api.getdial.ai' }] }),
    ],
    [
      'a conditional block on the Dial host',
      rule({
        name: 'dial hours',
        action: 'block',
        conditions: [{ field: 'time', op: 'in', value: 'weekdays' }],
        targets: [{ kind: 'network', hostPattern: 'api.getdial.ai' }],
      }),
    ],
    ['a rule with an untargeted secret', rule({ name: 'odd', action: 'block', targets: [{ kind: 'secret' }] })],
  ])('deletes when the conversion removes %s', (_name, finding) => {
    const r = dial({ rules: [finding] });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain(JSON.stringify(finding.name));
  });

  it.each([
    ['a remote gateway', { gw: 'http://gw.example.test:10254' }],
    ['no readable container', { gatewayEnv: null }],
    [
      'a container that does not publish the port',
      { ports: { '9999/tcp': [{ HostIp: '127.0.0.1', HostPort: '9999' }] } },
    ],
    ['a container bound to another address', { ports: { '10254/tcp': [{ HostIp: '10.0.0.5', HostPort: '10254' }] } }],
    ['a container on a remote Docker daemon', { dockerHost: 'ssh://other-host' }],
    ['a container bound only on IPv6', { ports: { '10254/tcp': [{ HostIp: '::', HostPort: '10254' }] } }],
    ['a container with only a UDP binding', { ports: { '10254/udp': [{ HostIp: '127.0.0.1', HostPort: '10254' }] } }],
    ['a container on a remote Docker daemon (DOCKER_HOST)', { env: { DOCKER_HOST: 'tcp://10.0.0.5:2375' } }],
  ])('deletes when the gateway container cannot be shown to be $GW (%s): its old rules may decide', (_n, opts) => {
    const r = dial({ rules: [], ...opts });
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('could not be shown to be the gateway at');
    expect(calls().some((l) => l.includes(' policy '))).toBe(false);
  });

  it('deletes while the gateway runs with POLICY_ENFORCE_V2 off: the old rules decide, and their deny mode is not readable', () => {
    for (const env of ['POLICY_ENFORCE_V2=0', 'POLICY_ENFORCE_V2=', 'POLICY_ENFORCE_V2=off']) {
      const r = dial({ rules: [], gatewayEnv: [env] });
      expect(r.status).toBe(1);
      expect(r.stdout).toContain('POLICY_ENFORCE_V2 is off');
    }
  });

  it.each([[['PATH=/usr/bin']], [['POLICY_ENFORCE_V2=1']], [['POLICY_ENFORCE_V2=true']]])(
    'reads only the policy while its own container enforces it (%j)',
    (gatewayEnv) => {
      const r = dial({ rules: [], gatewayEnv }, ['--delete']);
      expect(r.status).toBe(0);
      expect(deletes()).toEqual([]);
      expect(calls().some((l) => l.includes(' rules list --max 0'))).toBe(false);
    },
  );

  it('resolves a localhost $GW to the address its container binds, and asks only that address', () => {
    expect(dial({ rules: [], gw: 'http://localhost:10254' }).status).toBe(0);
    const reads = calls().filter((l) => !l.startsWith('docker '));
    expect(reads.length).toBeGreaterThan(2);
    expect(
      reads.every((l) => l.startsWith('http://127.0.0.1:10254 ') || l.endsWith(' http://127.0.0.1:10254/api/health')),
    ).toBe(true);
    fs.rmSync(path.join(home, 'calls.log'), { force: true });
    const v6 = dial({
      rules: [],
      gw: 'http://localhost:10254',
      ports: { '10254/tcp': [{ HostIp: '::1', HostPort: '10254' }] },
    });
    expect(v6.status).toBe(0);
    expect(
      calls()
        .filter((l) => !l.startsWith('docker '))
        .every((l) => l.includes('http://[::1]:10254')),
    ).toBe(true);
  });

  it('inspects the container only through the Docker endpoint it checked', () => {
    expect(dial({ rules: [] }).status).toBe(0);
    const inspects = calls().filter((l) => l.startsWith('docker ') && !l.startsWith('docker context '));
    expect(inspects.length).toBe(2);
    expect(inspects.every((l) => l.startsWith('docker -H unix:///var/run/docker.sock inspect -f '))).toBe(true);
  });

  it('trusts a container that publishes the port on every address', () => {
    expect(dial({ rules: [], ports: { '10254/tcp': [{ HostIp: '0.0.0.0', HostPort: '10254' }] } }).status).toBe(0);
  });

  it('stops before deleting anything when a Dial key belongs to the organization (its delete acts on the project)', () => {
    const secrets = {
      data: [SECRETS.data[0], { id: 'o1', name: 'Org Dial', hostPattern: 'api.getdial.ai', scope: 'organization' }],
    };
    const r = dial({ secrets }, ['--delete']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('o1');
    expect(r.stderr).toContain('organization');
    expect(deletes()).toEqual([]);
  });

  it('after a failed delete, names what was deleted and what is left', () => {
    const bin = path.join(home, 'bin');
    dial();
    const stub = fs.readFileSync(path.join(bin, 'onecli'), 'utf8');
    fs.writeFileSync(
      path.join(bin, 'onecli'),
      stub.replace('"secrets delete") exit 0 ;;', '"secrets delete") [ "$4" = d1 ] || exit 1 ;;'),
    );
    fs.rmSync(path.join(home, 'calls.log'), { force: true });
    const r = spawnSync('sh', [SCRIPT, '--delete'], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, GW },
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/deleted already: d1/);
    expect(r.stderr).toMatch(/left: x1/);
  });

  it('a first delete that fails still warns: it may have gone through', () => {
    const r = dial({ deleteExit: 1 }, ['--delete']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('may still have gone through');
    expect(r.stderr).toMatch(/deleted already: none; left: d1 x1/);
  });

  it('deletes on a block default, and on a Dial rule only the published policy holds', () => {
    const block = dial({ rules: [], defs: { published: { ...PUB_DEFAULT, action: 'block' } } });
    expect(block.status).toBe(1);
    expect(block.stdout).toContain('default: block (published)');
    expect(dial({ rules: [], defs: { draft: { ...DRAFT_DEFAULT, action: 'block' } } }).status).toBe(1);
    expect(dial({ rules: [], published: [DIAL_RULE] }).status).toBe(1);
  });

  it.each([
    ['the default is unreadable', { defs: { published: 'nope' } }],
    ['a rule is not an object', { rules: ['x'] }],
    ['a rule has no target list', { rules: [{ ...DIAL_RULE, targets: null }] }],
  ])('stops when %s', (_n, opts) => {
    const r = dial(opts as Parameters<typeof dial>[0], ['--delete']);
    expect(r.status).toBe(2);
    expect(deletes()).toEqual([]);
  });

  it("names the onecli CLI's own project when ONECLI_PROJECT is unset", () => {
    expect(dial({ cliProject: 'proj-c' }).stdout).toContain('Dial keys in the project proj-c');
  });

  it('asks only the gateway being upgraded ($GW), in the project ONECLI_PROJECT names', () => {
    const r = dial({ env: { ONECLI_PROJECT: 'proj-b' } }, ['--delete']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('Dial keys in the project proj-b');
    const onecli = calls().filter((l) => !l.startsWith('curl ') && !l.startsWith('docker '));
    expect(onecli.length).toBeGreaterThan(0);
    expect(onecli.every((l) => l.startsWith(`${GW} `))).toBe(true);
    expect(
      calls()
        .filter((l) => l.startsWith('curl '))
        .every((l) => l.endsWith(` ${GW}/api/health`)),
    ).toBe(true);
  });

  it.each([
    ['GW is unset', { gw: null }],
    ['the gateway does not answer', { healthExit: 7 }],
    ['the health answer is not JSON', { healths: ['Bad Gateway'] }],
    ['the version is a local build (dev)', { version: 'dev' }],
    ['the version is not a plain release', { version: '1.44.garbage' }],
    ['the version is a pre-release', { version: '1.45.0-rc.1' }],
    ['the version spans lines', { version: '1.42.0\n1.45.0' }],
    ['the health answer holds two records', { healths: [`${health('1.42.0')}\n${health('1.45.0')}`] }],
    ['a converted gateway still has agents in all mode', { version: '1.45.0', modes: ['selective', 'all'] }],
    ['a converted gateway lists an agent in another mode', { version: '1.45.0', modes: ['selective', 'legacy'] }],
    [
      'a converted gateway lists an agent with no mode',
      { version: '1.45.0', agentsRaw: '{"data":[{"id":"oc-0","secretMode":"selective"},{"id":"oc-1"}]}' },
    ],
    ['a converted gateway lists a null agent', { version: '1.45.0', agentsRaw: '{"data":[null]}' }],
    ['the agent list is empty output', { version: '1.45.0', agentsRaw: '' }],
    [
      'a secret reaches the Dial host through a wider pattern',
      { secrets: { data: [SECRETS.data[0], { id: 'w9', name: 'Dial API', hostPattern: 'api.*dial.ai' }] } },
    ],
    [
      'a secret reaches the Dial host and its look-alikes (*getdial.ai)',
      { secrets: { data: [SECRETS.data[0], { id: 'w8', name: 'Dial API', hostPattern: '*getdial.ai' }] } },
    ],
    [
      'a secret reaches the Dial host and other domains (api.getdial.a*)',
      { secrets: { data: [SECRETS.data[0], { id: 'w7', name: 'Dial API', hostPattern: 'api.getdial.a*' }] } },
    ],
    [
      'a catch-all secret would be widened',
      { secrets: { data: [SECRETS.data[0], { id: 'c1', name: 'All', hostPattern: '*' }] } },
    ],
    ['the secret list fails', { listExit: 1 }],
    ['the secret list is only whitespace', { secretsRaw: ' \t\n' }],
    ['the secret list is not a list', { secretsRaw: '{"data":null}' }],
    ['the policy cannot be read', { rulesExit: 1 }],
  ])('stops and deletes nothing when %s', (_name, opts) => {
    const r = dial(opts, ['--delete']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('STOP');
    expect(r.stdout).not.toMatch(/^(keep|delete):/m);
    expect(deletes()).toEqual([]);
  });

  it('stops on a failed delete', () => {
    const r = dial({ deleteExit: 1 }, ['--delete']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('could not delete the Dial key d1');
    expect(r.stderr).toContain("acts only in the API key's own project");
    expect(deletes()).toHaveLength(1);
  });

  it('re-reads the version before each delete and keeps the rest once the gateway has converted', () => {
    const r = dial({ healths: [health('1.42.0'), health('1.42.0'), health('1.45.0')] }, ['--delete']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('now runs 1.45.0, so it has converted: keep the Dial keys not deleted');
    expect(r.stderr).toContain('Dial keys deleted so far: d1; not deleted: x1');
    expect(r.stderr).not.toContain('delete the Dial keys left');
    expect(deletes()).toEqual([`${GW} secrets delete --id d1`]);
  });

  it('matches every key for the Dial host whatever its name, and prints names escaped', () => {
    const secrets = {
      data: [
        { id: 'd1', name: 'Dial API', hostPattern: 'api.getdial.ai' },
        { id: 'd2', name: 'old key; $(touch pwned) `id` *\n\u001b[2Jfake: keep', hostPattern: 'api.getdial.ai' },
        { id: 'n1', name: null, hostPattern: 'api.getdial.ai' },
        { id: 'u1', name: 42, hostPattern: 'API.GETDIAL.AI' },
        { id: 'w1', name: 'wildcard', hostPattern: '*.getdial.ai' },
        { id: 'h4', name: 'Dial API', hostPattern: 'getdial.ai' },
        { id: 'h5', name: 'Dial API', hostPattern: '*getdial*' },
        { id: 'h1', name: 'Dial API', hostPattern: 'api.getdial.ai.evil.test' },
        { id: 'h2', name: 'Dial API', hostPattern: 'notgetdial.ai' },
        { id: 'h3', name: 'Dial API', hostPattern: null },
      ],
    };
    const r = dial({ secrets }, ['--delete']);
    expect(r.status).toBe(0);
    expect(deletes()).toEqual(['d1', 'd2', 'n1', 'u1', 'w1'].map((id) => `${GW} secrets delete --id ${id}`));
    expect(r.stdout).toContain('d2 "old key; $(touch pwned) `id` *\\n\\u001b[2Jfake: keep"');
    expect(r.stdout).not.toContain('\u001b');
  });

  it.each(['*', 'd1 d2', '../x', ''])('refuses a Dial key id it cannot pass safely (%j)', (id) => {
    const secrets = {
      data: [
        { id: 'd1', name: 'Dial API', hostPattern: 'api.getdial.ai' },
        { id, name: 'Dial 2', hostPattern: 'api.getdial.ai' },
      ],
    };
    expect(dial({ secrets }, ['--delete']).status).toBe(2);
    expect(deletes()).toEqual([]);
  });

  it('refuses an unknown argument before any call', () => {
    expect(dial({}, ['--yes']).status).toBe(2);
    expect(calls()).toEqual([]);
  });

  it('a secret list larger than a pipe buffer still works', () => {
    const others = Array.from({ length: 6000 }, (_, i) => ({
      id: `x${i}`,
      name: `Other ${i}`,
      hostPattern: `h${i}.example.com`,
    }));
    const r = dial({ secrets: { data: [...others, { id: 'd1', name: 'Dial API', hostPattern: 'api.getdial.ai' }] } }, [
      '--delete',
    ]);
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(deletes()).toEqual([`${GW} secrets delete --id d1`]);
  });

  it.each(['sh', 'bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0))(
    'the guide command hands the Detect step’s unexported GW to the script and deletes each Dial key under %s',
    (shell) => {
      dial();
      fs.rmSync(path.join(home, 'calls.log'), { force: true });
      const cmd = `${CHECK} --delete`.replace('sh .claude', `sh ${path.resolve(__dirname, '..')}/.claude`);
      const r = spawnSync(shell, ['-c', `GW=http://from-detect.test:1; ${cmd}`], {
        env: { PATH: `${path.join(home, 'bin')}:${process.env.PATH ?? ''}`, HOME: home },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(deletes()).toEqual([
        'http://from-detect.test:1 secrets delete --id d1',
        'http://from-detect.test:1 secrets delete --id x1',
      ]);
    },
  );

  it('an install that already converted with the Dial rule in place re-runs /add-dial-tool and detaches the rest, not a delete', () => {
    const after = guide.slice(
      guide.indexOf('If the gateway already converted while `Dial: blocked agents` was in place'),
    );
    const paragraph = after.slice(0, after.indexOf('\n\n'));
    expect(paragraph).toMatch(/Re-run `\/add-dial-tool` now, on every install that shares the gateway/);
    expect(paragraph).toMatch(/OneCLI's default agent included/);
    expect(paragraph).toContain('onecli agents grants detach-secret --id <agent-id> --secret-id <dial-secret-id>');
    expect(paragraph).not.toMatch(/delete/i);
  });
});

describe('OneCLI upgrade guide: skills that wrote standing instructions', () => {
  it('tells /add-tavily-tool installs to re-run its Phase 5 once the NanoClaw service is back', () => {
    const guide = fs.readFileSync(GUIDE, 'utf8');
    const restart = guide.indexOf('systemctl --user restart $(systemd_unit)');
    const rollback = guide.indexOf('## 4. Rollback');
    const line = guide
      .slice(restart, rollback)
      .split('\n')
      .find((l) => l.includes('/add-tavily-tool'));
    expect(restart).toBeGreaterThan(-1);
    expect(line).toMatch(/re-run its Phase 5/);
    expect(guide.slice(0, restart)).not.toContain('/add-tavily-tool');
  });
});

// After the pull the guide must not call the upgrade done on a stale or partial
// conversion result: a forced verify failure reported "0 failed, 1 verify-failed"
// while the gateway denied every request.
describe('OneCLI upgrade guide: post-upgrade check', () => {
  const guide = fs.readFileSync(GUIDE, 'utf8');
  const CHECK = 'GW="$GW" sh .claude/skills/add-onecli/scripts/post-upgrade-check.sh';
  const SCRIPT = path.resolve(__dirname, '../.claude/skills/add-onecli/scripts/post-upgrade-check.sh');
  const OK_LINE =
    '{"msg":"[grant-conversion] projects: 1 converted, 0 skipped, 0 failed, 0 preempted, 0 verify-failed; agents flipped: 3"}';
  const VENDOR_404 = '{"type":"error","error":{"type":"not_found_error","message":"Not found"}}';

  function post(opts: {
    conversion?: string;
    container?: boolean;
    secrets?: Array<Record<string, unknown>>;
    grants?: string[];
    body?: string;
    code?: string;
    curlExit?: number;
    modes?: string[];
    version?: string;
    env?: Record<string, string>;
  }) {
    const bin = path.join(home, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(home, 'boot.log'), opts.conversion ?? OK_LINE);
    fs.writeFileSync(
      path.join(home, 'secrets.json'),
      JSON.stringify({ data: opts.secrets ?? [{ id: 's1', name: 'Anthropic', hostPattern: 'api.anthropic.com' }] }),
    );
    fs.writeFileSync(
      path.join(home, 'grants.json'),
      JSON.stringify({ data: { secrets: (opts.grants ?? ['s1']).map((secretId) => ({ secretId })) } }),
    );
    fs.writeFileSync(path.join(home, 'probe.txt'), `${opts.body ?? VENDOR_404}\n${opts.code ?? '404'}`);
    fs.writeFileSync(
      path.join(bin, 'curl'),
      `#!/bin/sh\necho '{"status":"ok","version":"${opts.version ?? '1.45.0'}"}'\n`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'docker'),
      `#!/bin/sh
printf '%s\\n' "docker $*" >> "${home}/calls.log"
case "$1" in
  inspect) [ "${opts.container === false ? 'no' : 'yes'}" = yes ] || exit 1; echo 2026-10-20T13:41:04.000000000Z ;;
  logs) [ "$2 $3" = "--since 2026-10-20T13:41:04.000000000Z" ] || exit 9; cat "${home}/boot.log" ;;
esac
`,
      { mode: 0o755 },
    );
    fs.writeFileSync(
      path.join(bin, 'onecli'),
      `#!/bin/sh
printf '%s\\n' "onecli $*" >> "${home}/calls.log"
case "$1 $2" in
  "secrets list") cat "${home}/secrets.json" ;;
  "agents list") echo '${JSON.stringify({ data: (opts.modes ?? ['selective']).map((m, i) => ({ id: `oc-${i}`, identifier: `ag-${i}`, secretMode: m })) })}' ;;
  "agents grants") cat "${home}/grants.json" ;;
  "run --agent") cat "${home}/probe.txt"; exit ${opts.curlExit ?? 0} ;;
  *) exit 9 ;;
esac
`,
      { mode: 0o755 },
    );
    fs.rmSync(path.join(home, 'calls.log'), { force: true });
    const r = spawnSync('sh', [SCRIPT], {
      env: { PATH: `${bin}:${process.env.PATH ?? ''}`, HOME: home, GW: 'http://172.17.0.1:10254', ...opts.env },
      encoding: 'utf8',
    });
    const calls = fs.existsSync(path.join(home, 'calls.log'))
      ? fs.readFileSync(path.join(home, 'calls.log'), 'utf8').trim().split('\n')
      : [];
    return { ...r, calls };
  }

  it('runs after the pull, before Verify, and replaces the bare grep of the log', () => {
    expect(guide.split('\n').filter((l) => l === CHECK)).toHaveLength(1);
    expect(guide.indexOf(CHECK)).toBeGreaterThan(guide.indexOf('docker compose pull onecli'));
    expect(guide.indexOf(CHECK)).toBeLessThan(guide.indexOf('## 3. Verify'));
    expect(guide).not.toMatch(/grep grant-conversion`; it must report `0 failed`/);
    expect(guide).toMatch(/0 verify-failed/);
  });

  it('passes on 0 failed and 0 verify-failed from this boot, and leaves the injection check to a real agent reply', () => {
    const r = post({});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('OK:');
    expect(r.calls).toContain('docker logs --since 2026-10-20T13:41:04.000000000Z onecli');
    // A probe request cannot show that injection works (NO_PROXY, path-scoped or header-replacing secrets).
    expect(r.calls.filter((c) => c.startsWith('onecli'))).toEqual(['onecli agents list --max 0']);
  });

  it('ends Verify with a real agent reply after the restart: the injection check', () => {
    const restart = guide.indexOf('Finally, restart the NanoClaw service');
    const chat = guide.indexOf('pnpm run chat', restart);
    expect(restart).toBeGreaterThan(-1);
    expect(chat).toBeGreaterThan(restart);
    expect(chat).toBeLessThan(guide.indexOf('## 4. Rollback'));
    expect(guide.slice(chat, guide.indexOf('## 4. Rollback'))).toMatch(/failure notice/);
  });

  it.each([
    ['1 verify-failed', OK_LINE.replace('0 verify-failed', '1 verify-failed')],
    ['10 failed', OK_LINE.replace(', 0 failed,', ', 10 failed,')],
    ['a missing result in this boot', ''],
    ['a preempted conversion', OK_LINE.replace('0 converted', '0 converted').replace('0 preempted', '1 preempted')],
  ])('is not done with %s', (_name, conversion) => {
    const r = post({ conversion });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('NOT DONE');
    expect(r.calls.some((c) => c.startsWith('onecli'))).toBe(false);
  });

  it('is not done while an agent is still in all mode', () => {
    const r = post({ modes: ['selective', 'all'] });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('all mode');
  });

  it('asks for the reply from an agent whose model needs a key in OneCLI, not a keyless one', () => {
    const verify = guide.slice(guide.indexOf('Finally, restart the NanoClaw service'), guide.indexOf('## 4. Rollback'));
    expect(verify).toMatch(/needs a key held in OneCLI/);
    expect(verify).toMatch(/keyless endpoint proves nothing/);
  });

  it('names a gateway that was never upgraded instead of saying wait', () => {
    const r = post({ version: '1.42.0', conversion: '' });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('1.42.0');
    expect(r.stderr).toContain('has not been upgraded');
    expect(r.stderr).not.toContain('wait a few seconds');
  });

  it('reads the container named in ONECLI_GATEWAY_CONTAINER', () => {
    const r = post({ env: { ONECLI_GATEWAY_CONTAINER: 'gw-1' } });
    expect(r.status).toBe(0);
    expect(r.calls).toContain('docker inspect -f {{.State.StartedAt}} gw-1');
    expect(r.calls).toContain('docker logs --since 2026-10-20T13:41:04.000000000Z gw-1');
  });

  it('says where to run it for a remote gateway, and how to name another container', () => {
    const at = guide.indexOf(CHECK);
    const around = guide.slice(at - 600, at + 900);
    expect(around).toMatch(/remote gateway/i);
    expect(around).toContain('ONECLI_GATEWAY_CONTAINER');
  });

  it('lists every exit of the reply check, including an unreachable host', () => {
    const verify = guide.slice(guide.indexOf('Finally, restart the NanoClaw service'), guide.indexOf('## 4. Rollback'));
    expect(verify).toMatch(/exit 2/);
    expect(verify).toMatch(/exit 3/);
    expect(verify).toMatch(/exit 4/);
  });

  it('says the CLI on a remote gateway host must be signed in to that gateway', () => {
    const at = guide.indexOf(CHECK);
    expect(guide.slice(at - 700, at)).toContain(
      "`onecli auth login >/dev/null 2>&1 && echo signed in || echo 'sign-in failed' >&2`",
    );
  });

  it('names the configured container, not only onecli, where the reply check fails', () => {
    const verify = guide.slice(guide.indexOf('Finally, restart the NanoClaw service'), guide.indexOf('## 4. Rollback'));
    expect(verify.slice(verify.indexOf('No reply (exit 3)'))).toContain('ONECLI_GATEWAY_CONTAINER');
    // Detect, Verify and the newer-gateway note also run docker on the container by name.
    const detect = guide.slice(guide.indexOf('## 1. Detect'), guide.indexOf('## 2. Upgrade'));
    expect(detect).toMatch(/not named `onecli`, export `ONECLI_GATEWAY_CONTAINER=<name>`/);
    // Every command that reads the container by name honours the variable, as the scripts do.
    const byName = guide.match(/docker (inspect|logs)[^\n`]*/g) ?? [];
    expect(byName.length).toBeGreaterThan(3);
    for (const cmd of byName) expect(cmd).toContain('"${ONECLI_GATEWAY_CONTAINER:-onecli}"');
  });

  it('says only an old gateway may report version unknown in Detect, since Verify refuses it', () => {
    const detect = guide.slice(guide.indexOf('## 1. Detect'), guide.indexOf('## 2. Upgrade'));
    expect(detect).toContain('an old gateway may say "unknown"');
    expect(detect).not.toContain('its `version` field may say "unknown"');
  });

  it("names the key in NanoClaw's .env in every sign-in hint, not a bare token", () => {
    const SCRIPTS = path.resolve(__dirname, '../.claude/skills/add-onecli/scripts');
    for (const text of [guide, fs.readFileSync(path.join(SCRIPTS, 'post-upgrade-check.sh'), 'utf8')]) {
      expect(text).toContain('onecli auth login');
      expect(text).toContain("pipe ONECLI_API_KEY from NanoClaw's .env into");
      // On the command line the key shows in `ps` and shell history; pasted, on screen.
      expect(text).not.toContain('--api-key');
      expect(text).not.toContain('<token>');
    }
  });

  it('refuses a gateway that reports version unknown in Verify, as the grants gate does', () => {
    const verify = guide.slice(guide.indexOf('## 3. Verify'), guide.indexOf('Verify the bind interface'));
    expect(verify).not.toMatch(/or "unknown"/);
    expect(verify).toMatch(/including `unknown`/);
    // The gate accepts any 1.45.x, so the guide may only claim it refuses an unreadable version.
    expect(verify).toMatch(
      /before they save a key \(`check-grants-gateway\.sh`\) also refuses a gateway that reports `unknown`/,
    );
    expect(verify).not.toMatch(/does not report the pin/);
  });

  it('says the check reads the current boot only, so a late run restarts the gateway once first', () => {
    const at = guide.indexOf(CHECK);
    const after = guide.slice(at, guide.indexOf('## 3. Verify'));
    expect(after).toMatch(/logs one on every start/);
    expect(after).toContain('docker compose restart onecli');
  });

  it('tells a new group with no recorded key to run its provider login again', () => {
    const verify = guide.slice(guide.indexOf('Finally, restart the NanoClaw service'), guide.indexOf('## 4. Rollback'));
    expect(verify).toContain('pnpm exec tsx setup/index.ts --step gateway-auth claude');
    expect(verify).toMatch(/new group fails while existing ones answer/);
    // Names only: a key under another name is reported, never adopted by its type.
    expect(verify).toMatch(/only by the name setup saves/);
    expect(verify).not.toMatch(/one key of that provider's type/);
  });

  it('stops without a local gateway container, which it must read the boot log from', () => {
    const r = post({ container: false });
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('gateway host');
  });
});
