// Behavior tests for the /add-dial-tool skill's OneCLI steps.
//
// The skill carries its install as `nc:` directive fences (see
// scripts/skill-directives.ts); the conformance suite proves those fences apply
// against a stubbed exec, but says nothing about what the shell inside them
// does. These tests take the real one-liners OUT of the SKILL.md — the gateway
// guard, the checked selection, the credential upsert, and the attach step —
// and run them under POSIX `sh` (the engine's default exec is /bin/sh; the
// wizard's is bash) against stateful stub `onecli` / `ncl` binaries in a
// throwaway project root, then assert the exact commands issued and the grants
// each agent ends up holding.
//
// The scoping contract under test (the skill's prose says the same):
//   - the gateway must be the pinned 1.45 and no agent may still be in `all`
//     mode (an unfinished conversion would inject a new key into it); the guard
//     runs before any write;
//   - the checked selection is a capture every install/sign-in/credential step
//     depends on, so a bad answer stops them all;
//   - the key is written as a fresh secret (attached to nobody), then attached
//     to each chosen group and detached from every other group of this install,
//     which re-narrows an upgraded install where the conversion gave Dial to all;
//   - a chosen group that never spawned gets its OneCLI agent created holding
//     the key; an unchosen one gets no agent; agents that are not this install's
//     groups are never touched;
//   - unknown ids, `all`/`none` mixing, and listing failures fail loudly instead
//     of silently opening or closing anything.

import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySkill } from './skill-apply.js';
import { parseDirectives, type Directive } from './skill-directives.js';

const SKILL_MD = path.resolve(__dirname, '../.claude/skills/add-dial-tool/SKILL.md');
const GATE = '.claude/skills/add-onecli/scripts/check-grants-gateway.sh';
const directives = parseDirectives(fs.readFileSync(SKILL_MD, 'utf8'));
const one = (pred: (d: Directive) => boolean): string => {
  const hits = directives.filter(pred);
  if (hits.length !== 1) throw new Error(`expected exactly one matching directive, found ${hits.length}`);
  if (hits[0].body.length !== 1) throw new Error(`directive at line ${hits[0].line} must be a single command`);
  return hits[0].body[0];
};
const isRun = (effect: string, needle: string) => (d: Directive) =>
  d.kind === 'run' && d.attrs.effect === effect && d.body.join('\n').includes(needle);

// The commands under test, as written in the document.
const CMD = {
  versionGuard: one((d) => d.kind === 'run' && d.attrs.capture === 'onecli_gateway'),
  scopeGuard: one((d) => d.kind === 'run' && d.attrs.capture === 'dial_scope'),
  installCli: one(isRun('external', 'npm install -g @getdial/cli')),
  login: one(isRun('external', 'dial auth login {{owner_email}}')),
  verifyOtp: one(isRun('external', 'dial auth verify-otp --code')),
  credential: one(isRun('external', 'dial-secret.ts')),
  attach: one(isRun('external', 'grants attach-secret')),
};

let root: string;
let bin: string;
let state: string;
let calls: string;

type OcAgent = { id: string; identifier: string; name: string; secretMode: 'all' | 'selective'; isDefault?: boolean };

const GROUPS = [
  { id: 'ag-sales', name: 'Sales' },
  { id: 'ag-support', name: 'Support' },
];
// OneCLI knows Sales already (holding its model key); Support has no OneCLI
// agent yet (never spawned). Tests override per case.
const DEFAULT_AGENTS: OcAgent[] = [
  { id: 'oc-default', identifier: 'default', name: 'Default Agent', secretMode: 'selective', isDefault: true },
  { id: 'oc-sales', identifier: 'ag-sales', name: 'Sales', secretMode: 'selective' },
];
const DIAL = { id: 'sec-dial', name: 'Dial API', hostPattern: 'api.getdial.ai' };

function writeStub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`, {
    mode: 0o755,
  });
}

function setup(
  opts: {
    agents?: OcAgent[];
    /** Secret ids each OneCLI agent holds, by agent id. */
    grants?: Record<string, string[]>;
    /** Secrets in the vault. */
    secrets?: Array<{ id: string; name: string; hostPattern: string }>;
    /** Make `onecli agents list` fail. */
    agentsListFails?: boolean;
    /** Answer `onecli agents list` with a bare array, which the gate also accepts. */
    bareAgentList?: boolean;
    /** Write a host auth file with this key (default: one with a key). */
    authKey?: string | null;
  } = {},
): void {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-dial-tool-'));
  bin = path.join(root, 'bin');
  state = path.join(root, 'state');
  calls = path.join(root, 'calls.log');
  fs.mkdirSync(bin);
  fs.mkdirSync(state);
  // The gateway guard runs the shared grants gate from the project root.
  fs.mkdirSync(path.join(root, path.dirname(GATE)), { recursive: true });
  fs.copyFileSync(path.resolve(__dirname, '..', GATE), path.join(root, GATE));
  fs.writeFileSync(calls, '');
  const xdg = path.join(root, 'xdg');
  fs.mkdirSync(path.join(xdg, 'dial'), { recursive: true });
  if (opts.authKey !== null) {
    fs.writeFileSync(path.join(xdg, 'dial', 'auth.v1.json'), JSON.stringify({ apiKey: opts.authKey ?? 'sk_test' }));
  }
  process.env.TEST_XDG = xdg;

  const agentList = opts.agents ?? DEFAULT_AGENTS;
  fs.writeFileSync(
    path.join(state, 'agents.json'),
    JSON.stringify(opts.bareAgentList ? agentList : { hint: 'h', data: agentList }),
  );
  fs.writeFileSync(
    path.join(state, 'grants.json'),
    JSON.stringify(opts.grants ?? { 'oc-sales': ['sec-anthropic'], 'oc-default': [] }),
  );
  fs.writeFileSync(path.join(state, 'secrets.json'), JSON.stringify({ hint: 'h', data: opts.secrets ?? [DIAL] }));

  writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '${JSON.stringify({ ok: true, data: GROUPS })}'; fi`);
  // A stateful OneCLI: creates, deletes and grant changes land in the JSON files
  // the list commands read, so a later step sees what an earlier one did (the
  // real vault does). Deleting a secret drops its grants, as OneCLI does. List
  // commands refuse to run without --max 0 (the CLI truncates at 20 rows).
  writeStub(
    'onecli',
    `
S="$STATE"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "config get") if [ -f "$S/api-host" ]; then cat "$S/api-host"; else echo '{"key":"api-host","value":"http://gw.test:10254"}'; fi ;;
  "secrets list") [ "$3 $4" = "--max 0" ] || { echo "truncated list" >&2; exit 7; }; cat "$S/secrets.json" ;;
  "secrets delete") i=$(arg --id "$@"); jq --arg i "$i" '.data |= map(select(.id != $i))' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; jq --arg i "$i" 'map_values(map(select(. != $i)))' "$S/grants.json" > "$S/t" && mv "$S/t" "$S/grants.json"; echo '{"status":"deleted"}' ;;
  "secrets create") f=$(arg --file "$@"); h=$(arg --host-pattern "$@"); [ -n "$f" ] && cat "$f" > "$S/key-seen"; jq --arg h "$h" '.data += [{"id":"sec-new","name":"Dial API","hostPattern":$h}]' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{"id":"sec-new"}' ;;
  "agents list") ${opts.agentsListFails ? 'echo "boom" >&2; exit 1' : '[ "$3 $4" = "--max 0" ] || { echo "truncated list" >&2; exit 7; }; cat "$S/agents.json"'} ;;
  "agents create") n=$(arg --name "$@"); i=$(arg --identifier "$@"); jq --arg n "$n" --arg i "$i" '.data += [{"id":("oc-"+$i),"identifier":$i,"name":$n,"secretMode":"selective"}]' "$S/agents.json" > "$S/t" && mv "$S/t" "$S/agents.json"; echo "{\\"hint\\":\\"h\\",\\"id\\":\\"oc-$i\\"}" ;;
  "agents grants")
    a=$(arg --id "$@"); s=$(arg --secret-id "$@")
    case "$3" in
      attach-secret) jq --arg a "$a" --arg s "$s" '.[$a] = ((.[$a] // []) + [$s] | unique)' "$S/grants.json" > "$S/t" && mv "$S/t" "$S/grants.json" ;;
      detach-secret) jq --arg a "$a" --arg s "$s" '.[$a] = ((.[$a] // []) | map(select(. != $s)))' "$S/grants.json" > "$S/t" && mv "$S/t" "$S/grants.json" ;;
    esac
    echo '{}' ;;
  "agents secrets"|"agents set-secrets"|"agents set-secret-mode") echo '{"error":"removed","code":"GONE"}' >&2; exit 1 ;;
  "rules "*|"policy "*) echo '{"error":{"message":"retired","type":"invalid_request_error"}}' >&2; exit 1 ;;
  *) echo '{}' ;;
esac`,
  );
}

/** Run one document command under POSIX sh with the selection vars substituted. */
function sh(
  cmd: string,
  agents = '',
  extraEnv: Record<string, string> = {},
  shell = 'sh',
): { stdout: string; stderr: string; status: number } {
  const substituted = cmd
    .replaceAll('{{dial_agents}}', agents)
    .replaceAll('{{dial_scope}}', agents.replaceAll(' ', ''))
    .replaceAll('{{onecli_gateway}}', '1.45.0')
    .replaceAll('{{dial_secret}}', 'sec-dial')
    .replaceAll('{{dial_ua}}', 'nanoclaw/test')
    .replaceAll('{{owner_email}}', 'operator@example.com')
    .replaceAll('{{otp}}', '123456');
  try {
    const stdout = execFileSync(shell, ['-c', substituted], {
      cwd: root,
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        CALLS: calls,
        STATE: state,
        XDG_DATA_HOME: process.env.TEST_XDG,
        HOME: root,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, stderr: '', status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { stdout: err.stdout ?? '', stderr: err.stderr ?? '', status: err.status ?? 1 };
  }
}

/** The checked selection, then the credential and attach steps, as the document orders them. */
function scope(agents: string, steps = [CMD.attach]): { stdout: string; stderr: string; status: number } {
  const guard = sh(CMD.scopeGuard, agents);
  if (guard.status !== 0) return guard;
  const checked = guard.stdout.trim();
  let out = '';
  for (const cmd of steps) {
    const r = sh(cmd, checked);
    out += r.stdout;
    if (r.status !== 0) return { stdout: out, stderr: r.stderr, status: r.status };
  }
  return { stdout: out, stderr: '', status: 0 };
}

const callLines = () => fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
const held = (): Record<string, string[]> => JSON.parse(fs.readFileSync(path.join(state, 'grants.json'), 'utf8'));
const agentIds = (): string[] =>
  (JSON.parse(fs.readFileSync(path.join(state, 'agents.json'), 'utf8')).data as OcAgent[]).map((a) => a.id);

beforeEach(() => setup());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('add-dial-tool: the document carries the steps under test', () => {
  it('has exactly the expected single-command directives, and no policy or secret-list commands', () => {
    for (const [k, v] of Object.entries(CMD)) expect(v, k).toMatch(/\S/);
    const all = directives.flatMap((d) => d.body).join('\n');
    expect(all).not.toMatch(/dial-policy|set-secrets|agents secrets|onecli rules|policy rules/);
  });
});

describe('add-dial-tool: attaching Dial to the chosen agents', () => {
  it('attaches the new key to the chosen group and creates no agent for an unchosen one that never ran', () => {
    const { stdout, status } = scope('ag-sales');
    expect(status).toBe(0);
    expect(stdout).toContain('allowed:ag-sales');
    expect(stdout).toContain('withheld:ag-support');
    expect(held()['oc-sales']).toEqual(['sec-anthropic', 'sec-dial']);
    expect(agentIds()).not.toContain('oc-ag-support');
    expect(callLines().some((l) => l.includes('oc-default'))).toBe(false);
  });

  it('creates the OneCLI agent for a chosen group that never ran, holding the key (not empty)', () => {
    const { status } = scope('ag-support');
    expect(status).toBe(0);
    expect(callLines()).toContain('onecli agents create --name Support --identifier ag-support');
    expect(held()['oc-ag-support']).toEqual(['sec-dial']);
    expect(held()['oc-sales']).toEqual(['sec-anthropic']);
  });

  it('`all` gives every current group the key; `none` gives it to nobody and creates nothing', () => {
    expect(scope('all').status).toBe(0);
    expect(held()['oc-sales']).toContain('sec-dial');
    expect(held()['oc-ag-support']).toEqual(['sec-dial']);
    fs.rmSync(root, { recursive: true, force: true });
    setup();
    const { stdout, status } = scope('none');
    expect(status).toBe(0);
    expect(stdout).not.toContain('allowed:');
    expect(Object.values(held()).flat()).not.toContain('sec-dial');
    expect(callLines().some((l) => l.startsWith('onecli agents create'))).toBe(false);
  });

  it('re-narrows an upgraded install where the conversion gave the old key to every agent', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [
        ...DEFAULT_AGENTS,
        { id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' },
      ],
      grants: {
        'oc-default': ['sec-dial'],
        'oc-sales': ['sec-anthropic', 'sec-dial'],
        'oc-support': ['sec-anthropic', 'sec-dial'],
      },
    });
    const { status } = scope('ag-sales');
    expect(status).toBe(0);
    expect(held()).toEqual({
      'oc-default': ['sec-dial'],
      'oc-sales': ['sec-anthropic', 'sec-dial'],
      'oc-support': ['sec-anthropic'],
    });
  });

  it('detaches the key from unchosen groups, never from OneCLI’s default agent or another install’s agents', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [
        ...DEFAULT_AGENTS,
        { id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' },
        {
          id: 'oc-foreign',
          identifier: 'ag-other-install',
          name: 'Elsewhere',
          secretMode: 'selective',
          isDefault: true,
        },
      ],
      grants: {
        'oc-default': ['sec-dial'],
        'oc-sales': ['sec-dial'],
        'oc-support': ['sec-dial'],
        'oc-foreign': ['sec-dial'],
      },
    });
    const { status } = scope('ag-sales');
    expect(status).toBe(0);
    expect(held()).toMatchObject({
      'oc-default': ['sec-dial'],
      'oc-sales': ['sec-dial'],
      'oc-support': [],
      'oc-foreign': ['sec-dial'],
    });
    expect(callLines().some((l) => l.includes('oc-foreign') || l.includes('oc-default'))).toBe(false);
  });

  it('withholds from unchosen groups before attaching, so a failed attach leaves no unchosen group with the key', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [
        ...DEFAULT_AGENTS,
        { id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' },
      ],
      grants: { 'oc-sales': ['sec-dial'], 'oc-support': ['sec-dial'] },
    });
    const real = fs.readFileSync(path.join(bin, 'onecli'), 'utf8').split('\n').slice(2).join('\n');
    writeStub(
      'onecli',
      `if [ "$1 $2 $3" = "agents grants attach-secret" ]; then echo "agent limit reached" >&2; exit 1; fi\n${real}`,
    );
    const { status } = scope('ag-sales');
    expect(status).not.toBe(0);
    expect(held()['oc-support']).toEqual([]);
  });

  it('reads back the agent of a chosen group that spawned meanwhile (create answers 409) and carries on', () => {
    const real = fs.readFileSync(path.join(bin, 'onecli'), 'utf8').split('\n').slice(2).join('\n');
    // The host creates the agent first; the skill's create then fails as a duplicate.
    writeStub(
      'onecli',
      `if [ "$1 $2" = "agents create" ]; then jq '.data += [{"id":"oc-host-made","identifier":"ag-support","name":"Support","secretMode":"selective"}]' "$STATE/agents.json" > "$STATE/t" && mv "$STATE/t" "$STATE/agents.json"; echo '{"error":"An agent with this identifier already exists"}' >&2; exit 1; fi\n${real}`,
    );
    const { status, stdout } = scope('ag-sales,ag-support');
    expect(status).toBe(0);
    expect(stdout).toContain('allowed:ag-support');
    expect(held()['oc-host-made']).toEqual(['sec-dial']);
  });

  it('expands `all` to the groups that exist at selection, and to `none` when there are none', () => {
    expect(sh(CMD.scopeGuard, 'all').stdout.trim()).toBe('ag-sales,ag-support');
    writeStub('ncl', `echo '{"ok":true,"data":[]}'`);
    expect(sh(CMD.scopeGuard, 'all').stdout.trim()).toBe('none');
  });

  it('refuses an unknown agent id instead of guessing', () => {
    const { status } = scope('ag-typo');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli'))).toBe(false);
  });

  it('refuses the selection when the groups cannot be listed', () => {
    writeStub('ncl', 'echo "no socket" >&2; exit 1');
    const r = sh(CMD.scopeGuard, 'ag-sales');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('could not list agent groups');
  });

  it('fails instead of reporting success when OneCLI agents cannot be listed', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ agentsListFails: true });
    const { status, stdout } = scope('ag-sales', [CMD.attach]);
    expect(status).not.toBe(0);
    expect(stdout).not.toContain('allowed:');
    expect(callLines().some((l) => l.startsWith('onecli agents create') || l.includes('attach-secret'))).toBe(false);
  });

  it('withholds Dial from an unchosen group when OneCLI lists agents as a bare array', () => {
    // A misread list would skip the detach yet still print withheld:.
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      bareAgentList: true,
      agents: [
        ...DEFAULT_AGENTS,
        { id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' },
      ],
      grants: { 'oc-sales': [], 'oc-support': ['sec-dial'], 'oc-default': [] },
    });
    const { status, stdout } = scope('ag-sales', [CMD.attach]);
    expect(status).toBe(0);
    expect(stdout).toContain('withheld:ag-support');
    expect(held()['oc-support']).toEqual([]);
    expect(held()['oc-sales']).toEqual(['sec-dial']);
  });

  it('fails instead of withholding nothing when the OneCLI agent list cannot be read', () => {
    writeStub('onecli', 'if [ "$1 $2" = "agents list" ]; then echo "not json"; fi');
    const { status, stdout } = scope('ag-sales', [CMD.attach]);
    expect(status).not.toBe(0);
    expect(stdout).not.toMatch(/withheld:|allowed:/);
  });

  it('fails instead of reporting withheld when an agent list entry cannot be read', () => {
    writeStub(
      'onecli',
      `echo "onecli $*" >> "$CALLS"\nif [ "$1 $2" = "agents list" ]; then echo '["bad",{"id":"oc-sales","identifier":"ag-sales"}]'; fi`,
    );
    const { status, stdout } = scope('none', [CMD.attach]);
    expect(status).not.toBe(0);
    expect(stdout).not.toMatch(/withheld:|allowed:/);
  });

  it.each([
    ['an empty id', '[{"id":"","identifier":"ag-sales"}]'],
    ['no identifier', '[{"id":"oc-sales"}]'],
  ])('fails instead of reporting withheld for an agent entry with %s', (_name, list) => {
    writeStub('onecli', `echo "onecli $*" >> "$CALLS"\nif [ "$1 $2" = "agents list" ]; then echo '${list}'; fi`);
    const { status, stdout } = scope('none', [CMD.attach]);
    expect(status).not.toBe(0);
    expect(stdout).not.toMatch(/withheld:|allowed:/);
  });

  it('fails when the agent group list command prints nothing', () => {
    writeStub('ncl', 'exit 0');
    expect(scope('none', [CMD.attach]).status).not.toBe(0);
  });

  it('fails instead of doing nothing when the agent group list cannot be read', () => {
    writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '{"ok":true}'; fi`);
    const { status } = scope('none', [CMD.attach]);
    expect(status).not.toBe(0);
  });

  it.each([
    ['an embedded newline', { id: 'ag-sales\nag-foreign', name: 'Sales' }],
    ['a trailing newline', { id: 'ag-sales\n', name: 'ag-foreign' }],
  ])('fails on a group id with %s, before any grant changes', (_n, group) => {
    const groups = { ok: true, data: [group] };
    writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '${JSON.stringify(groups)}'; fi`);
    const { status, stdout } = scope('none', [CMD.attach]);
    expect(status).not.toBe(0);
    expect(stdout).not.toMatch(/withheld:|allowed:/);
    expect(callLines().some((l) => l.includes('detach-secret') || l.includes('attach-secret'))).toBe(false);
  });

  it('a group name with a newline or tab never reads as another group id', () => {
    // Another install's agent on the same gateway holds the key and must keep it.
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [
        ...DEFAULT_AGENTS,
        { id: 'oc-foreign', identifier: 'ag-foreign', name: 'Foreign', secretMode: 'selective' },
      ],
      grants: { 'oc-sales': ['sec-dial'], 'oc-foreign': ['sec-dial'], 'oc-default': [] },
    });
    const groups = { ok: true, data: [{ id: 'ag-sales', name: 'Sales\nag-foreign\tForeign' }] };
    writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '${JSON.stringify(groups)}'; fi`);
    const { status, stdout } = scope('none', [CMD.attach]);
    expect(status).toBe(0);
    expect(stdout).not.toContain('withheld:ag-foreign');
    expect(held()['oc-foreign']).toEqual(['sec-dial']);
    expect(held()['oc-sales']).toEqual([]);
  });

  it('tolerates spaces in the answer', () => {
    const { status } = scope('ag-sales, ag-support ,ag-sales');
    expect(status).toBe(0);
    expect(held()['oc-sales']).toContain('sec-dial');
    expect(held()['oc-ag-support']).toEqual(['sec-dial']);
  });

  it('every install, sign-in and credential step depends on the checked selection and the gateway guard', () => {
    for (const cmd of [CMD.installCli, CMD.login, CMD.verifyOtp, CMD.credential]) {
      expect(cmd).toContain('{{dial_scope}}');
      expect(cmd).toContain('{{onecli_gateway}}');
    }
    const order = directives.filter((d) => d.kind === 'run').map((d) => d.body.join('\n'));
    const at = (cmd: string) => order.indexOf(cmd);
    expect(at(CMD.versionGuard)).toBeLessThan(at(CMD.scopeGuard));
    expect(at(CMD.scopeGuard)).toBeLessThan(at(CMD.installCli));
    expect(at(CMD.installCli)).toBeLessThan(at(CMD.credential));
    expect(at(CMD.credential)).toBeLessThan(at(CMD.attach));
    // The attach step uses only the id the credential step captured, so it waits on that step.
    expect(CMD.attach).toContain("S='{{dial_secret}}'");
    expect(CMD.attach).not.toMatch(/secrets (list|delete|create)/);
  });
});

describe('add-dial-tool: registering the host credential with OneCLI', () => {
  // What the script writes is tested where it lives: .claude/skills/add-dial-tool/scripts/dial-secret.test.ts.
  it('stores the key through the script and captures only its secret id', () => {
    const d = directives.find((x) => x.kind === 'run' && x.body.join('\n') === CMD.credential)!;
    expect(d.attrs.capture).toBe('dial_secret');
    expect(new RegExp(String(d.attrs.validate)).test('sec-1')).toBe(true);
    expect(new RegExp(String(d.attrs.validate)).test('sk_live key')).toBe(false);
    expect(CMD.credential).toContain('pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-secret.ts');
    expect(CMD.credential).not.toMatch(/--value|apiKey|auth\.v1\.json/);
  });
});

describe('add-dial-tool: OneCLI gateway guard', () => {
  // Only the pinned 1.45 is supported: older gateways lack agent grants, and an
  // agent still in `all` mode would receive a new key. The guard must stop
  // before the credential step writes the key.
  function guard(health: string | null, opts: { apiHost?: string; curlExit?: number } = {}) {
    if (opts.apiHost !== undefined) fs.writeFileSync(path.join(state, 'api-host'), opts.apiHost);
    const out = health === null ? 'echo "connection refused" >&2' : `echo '${health}'`;
    writeStub('curl', `${out}\nexit ${opts.curlExit ?? (health === null ? 7 : 0)}`);
    return sh(CMD.versionGuard);
  }
  const health = (version?: string) => JSON.stringify({ status: 'ok', ...(version ? { version } : {}) });

  it('runs the shared grants gate, as /add-vercel and /add-tavily-tool do', () => {
    expect(CMD.versionGuard).toBe(`sh ${GATE} /add-dial-tool`);
  });

  it.each(['1.45.0', '1.45.3', '1.45.10'])('passes on gateway %s and captures the version', (v) => {
    const r = guard(health(v));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(v);
    expect(callLines()).toContain('curl -fsS --max-time 10 http://gw.test:10254/api/health');
  });

  it.each(['1.44.0', '1.43.3', '1.42.0', '1.41.0', '1.9.2', '0.8.0'])(
    'stops on the older gateway %s, naming the pin',
    (v) => {
      const r = guard(health(v));
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toContain(`is ${v}`);
      expect(r.stderr).toContain(v === '1.44.0' ? 'is not the pinned 1.45' : 'older than 1.44 and has no agent grants');
      expect(r.stderr).toContain('/add-dial-tool needs the pinned OneCLI gateway, 1.45');
      expect(r.stderr).toContain('Nothing was written');
    },
  );

  it.each(['1.46.0', '1.100.0', '2.7.0'])('stops on the newer gateway %s, naming the pin', (v) => {
    const r = guard(health(v));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('newer than the pinned 1.45');
    expect(r.stderr).toContain('/add-dial-tool needs the pinned OneCLI gateway, 1.45');
  });

  it.each(['unknown', 'dev', '1.45', '1.45.0-x', '1.45.10-rc1', '1.450.0'])(
    'stops on an unreadable version %s',
    (v) => {
      const r = guard(health(v));
      expect(r.status).not.toBe(0);
      expect(r.stdout).toBe('');
    },
  );

  it('stops while any agent is still in all mode (unfinished conversion), or when agents cannot be listed', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ agents: [...DEFAULT_AGENTS, { id: 'oc-x', identifier: 'ag-x', name: 'X', secretMode: 'all' }] });
    const r = guard(health('1.45.0'));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('still in all mode');
    fs.rmSync(root, { recursive: true, force: true });
    setup({ agentsListFails: true });
    expect(guard(health('1.45.0')).status).not.toBe(0);
  });

  it('stops when the onecli CLI has no grants commands (CLI older than 2.9), before anything is written', () => {
    const real = fs.readFileSync(path.join(bin, 'onecli'), 'utf8');
    writeStub(
      'onecli',
      'if [ "$1 $2" = "agents grants" ]; then echo "unexpected argument grants" >&2; exit 80; fi\n' +
        real.split('\n').slice(2).join('\n'),
    );
    const r = guard(health('1.45.0'));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain("no 'agents grants'");
  });

  it('stops on a missing version, invalid JSON, a failed transfer, or an unreachable gateway', () => {
    expect(guard(health()).status).not.toBe(0);
    expect(guard(`${health('1.45.0')}garbage`).status).not.toBe(0);
    expect(guard(health('1.45.0'), { curlExit: 18 }).status).not.toBe(0);
    expect(guard(null).status).not.toBe(0);
  });

  it('checks the host the onecli CLI writes to, and stops without one', () => {
    expect(guard(health('1.45.0'), { apiHost: '{"key":"api-host","value":"http://other:1"}' }).status).toBe(0);
    expect(callLines()).toContain('curl -fsS --max-time 10 http://other:1/api/health');
    expect(guard(health('1.45.0'), { apiHost: '{"key":"api-host","value":""}' }).status).not.toBe(0);
    expect(callLines().filter((l) => l.startsWith('curl'))).toHaveLength(1);
  });

  it('runs before anything is written, and the credential step depends on its capture', () => {
    const order = directives.filter((d) => d.kind === 'run').map((d) => d.body.join('\n'));
    const at = order.indexOf(CMD.versionGuard);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(order.indexOf(CMD.credential));
    expect(at).toBeLessThan(order.indexOf(CMD.attach));
    // An unresolved {{var}} defers the directive, so a failed guard blocks the key write.
    expect(CMD.credential).toContain('{{onecli_gateway}}');
  });
});

// The engine's run-health gate skips wires after a failed step, but not
// effect:external steps — those are gated by depending on a capture that a
// failed guard leaves unbound. Prove it end to end through the engine.
describe('add-dial-tool: the skill engine gates every write on the guards', () => {
  async function apply(exec: (c: string) => string | undefined) {
    const r = fs.mkdtempSync(path.join(os.tmpdir(), 'add-dial-tool-apply-'));
    try {
      fs.mkdirSync(path.join(r, 'container'));
      fs.writeFileSync(path.join(r, 'container/cli-tools.json'), '[]\n');
      fs.writeFileSync(path.join(r, 'package.json'), '{"name":"scratch"}\n');
      fs.writeFileSync(path.join(r, '.env'), '');
      const ran: string[] = [];
      const res = await applySkill(path.dirname(SKILL_MD), r, {
        inputs: { dial_agents: 'all', owner_email: 'operator@example.com', otp: '123456' },
        resolveRemote: () => 'origin',
        exec: (c) => {
          ran.push(c);
          if (c.includes('dial doctor')) return '{"auth":{"signedIn":false}}';
          if (c.includes('(.data|length)==0')) return 'ag-1 (Sales)';
          if (c.includes('package.json')) return 'nanoclaw/2.2.0';
          const out = exec(c);
          if (out === undefined && c.includes('dial-secret.ts')) return 'sec-1';
          return out;
        },
        execStream: async () => ({ ok: true, fields: {} }),
      });
      return { ran, res };
    } finally {
      fs.rmSync(r, { recursive: true, force: true });
    }
  }
  const writes = (ran: string[]) =>
    ran.filter(
      (c) =>
        c.includes('dial-secret.ts') ||
        c.includes('grants attach-secret') ||
        c.includes('dial auth') ||
        c.includes('npm install'),
    );

  it('never writes the Dial key or attaches it when the gateway guard fails', async () => {
    const { ran, res } = await apply((c) => {
      if (c.includes('check-grants-gateway.sh')) throw new Error('the OneCLI gateway is 1.42.0, older than 1.44');
      if (c.includes('unknown agent group')) return 'all';
      return undefined;
    });
    expect(ran.some((c) => c.includes('check-grants-gateway.sh'))).toBe(true);
    expect(writes(ran)).toEqual([]);
    expect(res.agentTasks.length).toBeGreaterThan(0);
  });

  it('never installs, signs in, or writes when the selection check fails', async () => {
    const { ran, res } = await apply((c) => {
      if (c.includes('check-grants-gateway.sh')) return '1.45.0';
      if (c.includes('unknown agent group')) throw new Error("unknown agent group 'ag-typo'");
      return undefined;
    });
    expect(ran.some((c) => c.includes('unknown agent group'))).toBe(true);
    expect(writes(ran)).toEqual([]);
    expect(res.agentTasks.length).toBeGreaterThan(0);
  });

  it('attaches the new key even when the image build failed, so a replaced key is never left on nobody', async () => {
    const { ran } = await apply((c) => {
      if (c.includes('check-grants-gateway.sh')) return '1.45.0';
      if (c.includes('unknown agent group')) return 'all';
      if (c.includes('container/build.sh')) throw new Error('docker build failed');
      return undefined;
    });
    const key = ran.findIndex((c) => c.includes('dial-secret.ts'));
    const attach = ran.findIndex((c) => c.includes('grants attach-secret'));
    expect(key).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(key);
    expect(ran[attach]).toContain("S='sec-1'");
  });

  it('never attaches when storing the key fails, so no other key is attached', async () => {
    const { ran, res } = await apply((c) => {
      if (c.includes('check-grants-gateway.sh')) return '1.45.0';
      if (c.includes('unknown agent group')) return 'all';
      if (c.includes('dial-secret.ts')) throw new Error('Multiple Dial API credentials exist');
      return undefined;
    });
    expect(ran.some((c) => c.includes('dial-secret.ts'))).toBe(true);
    expect(ran.some((c) => c.includes('grants attach-secret'))).toBe(false);
    expect(res.agentTasks.length).toBeGreaterThan(0);
  });

  it('runs every step, in order, when the guards pass: the key is written before it is attached', async () => {
    const { ran } = await apply((c) => {
      if (c.includes('check-grants-gateway.sh')) return '1.45.0';
      if (c.includes('unknown agent group')) return 'all';
      return undefined;
    });
    const seen = writes(ran);
    expect(seen.some((c) => c.includes('npm install'))).toBe(true);
    expect(seen.some((c) => c.includes('dial auth login operator@example.com'))).toBe(true);
    const key = seen.findIndex((c) => c.includes('dial-secret.ts'));
    const attach = seen.findIndex((c) => c.includes('grants attach-secret'));
    expect(key).toBeGreaterThan(-1);
    expect(key).toBeLessThan(attach);
    expect(seen.findIndex((c) => c.includes('npm install'))).toBeLessThan(key);
  });
});

describe('add-dial-tool: removal', () => {
  const REMOVE = (() => {
    const doc = fs.readFileSync(path.resolve(__dirname, '../.claude/skills/add-dial-tool/REMOVE.md'), 'utf8');
    const at = doc.indexOf('## 3. Remove the OneCLI credential');
    return /```bash\n([\s\S]*?)```/.exec(doc.slice(at))![1];
  })();

  it('stops when the secret list is only whitespace', () => {
    writeStub('onecli', "printf ' \\n'");
    expect(sh(REMOVE).status).not.toBe(0);
  });

  it('stops when the secret list command fails with no output', () => {
    writeStub('onecli', 'echo unauthorized >&2; exit 1');
    expect(sh(REMOVE).status).not.toBe(0);
  });

  it('stops instead of reporting success when the secret list cannot be read', () => {
    writeStub('onecli', `echo '{"data":null}'`);
    expect(sh(REMOVE).status).not.toBe(0);
  });

  const failures: Array<[string, string]> = [
    ['a failed secret list', 'echo unauthorized >&2; exit 1'],
    ['an empty secret list', "printf ' \\n'"],
    [
      'a failed delete',
      `case "$1 $2" in "secrets list") echo '{"data":[{"id":"sec-dial","name":"Dial API","hostPattern":"api.getdial.ai"}]}' ;; "secrets delete") exit 1 ;; esac`,
    ],
  ];
  const shells = ['sh', 'zsh'].filter((shell) => spawnSync(shell, ['-c', 'true']).status === 0);
  it.each(shells.flatMap((shell) => failures.map(([name, body]) => [shell, name, body])))(
    'under %s, %s stops the removal without closing the calling shell',
    (shell, _name, body) => {
      writeStub('onecli', body);
      const r = sh(`${REMOVE}\necho shell-still-open`, '', {}, shell);
      expect(r.status).toBe(0);
      expect(r.stdout).toContain('shell-still-open');
    },
  );

  it('a failed delete stops the removal before the next Dial key, and the block fails', () => {
    writeStub(
      'onecli',
      `case "$1 $2" in "secrets list") echo '{"data":[{"id":"sec-dial","name":"Dial API","hostPattern":"api.getdial.ai"},{"id":"sec-dial-old","name":"Old Dial","hostPattern":"api.getdial.ai"}]}' ;; "secrets delete") exit 1 ;; esac`,
    );
    expect(sh(REMOVE).status).not.toBe(0);
    expect(callLines().filter((l) => l.includes('secrets delete'))).toEqual(['onecli secrets delete --id sec-dial']);
  });

  it('a secret list larger than a pipe buffer still works under pipefail', () => {
    fs.rmSync(root, { recursive: true, force: true });
    const others = Array.from({ length: 6000 }, (_, i) => ({
      id: `sec-${i}`,
      name: `Other ${i}`,
      hostPattern: `h${i}.example.com`,
    }));
    setup({ secrets: [...others, DIAL] });
    // GNU grep -q stops reading at its first match, closing the pipe on the writer.
    writeStub('grep', 'head -c 1 >/dev/null');
    // bash: Ubuntu's sh (dash) may not know pipefail.
    expect(sh(`set -o pipefail\n${REMOVE}`, '', {}, 'bash').status).toBe(0);
    expect(callLines()).toContain('onecli secrets delete --id sec-dial');
  });

  it('deletes every api.getdial.ai secret, which takes its grants with it, and nothing else', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      secrets: [
        DIAL,
        { id: 'sec-dial-old', name: 'Old Dial', hostPattern: 'api.getdial.ai' },
        { id: 'sec-notes', name: 'Dialogue notes', hostPattern: 'notes.example.com' },
      ],
      grants: { 'oc-sales': ['sec-anthropic', 'sec-dial'], 'oc-default': ['sec-dial-old'] },
    });
    expect(sh(REMOVE).status).toBe(0);
    const lines = callLines();
    expect(lines).toContain('onecli secrets delete --id sec-dial');
    expect(lines).toContain('onecli secrets delete --id sec-dial-old');
    expect(lines).not.toContain('onecli secrets delete --id sec-notes');
    expect(held()).toEqual({ 'oc-sales': ['sec-anthropic'], 'oc-default': [] });
    expect(lines.some((l) => /policy|rules|dial-policy/.test(l))).toBe(false);
  });
});

describe('add-dial-tool: shared-gateway and first-run wording', () => {
  const read = (rel: string) => fs.readFileSync(path.resolve(__dirname, '..', rel), 'utf8');

  it('warns that another Dial account switches every agent holding the key, other installs included', () => {
    const doc = read('.claude/skills/add-dial-tool/SKILL.md');
    const op = doc.slice(doc.indexOf('This host is signed in to Dial as {{connected_email}}'));
    expect(op.slice(0, op.indexOf('```'))).toMatch(
      /different Dial account switches every agent that holds the Dial key/,
    );
    // A host that starts signed out can also sign in to a different account than another install's.
    const out = doc.slice(doc.indexOf('```nc:operator when:signed_in=false'));
    expect(out.slice(0, out.indexOf('```', 5))).toMatch(/switches every agent that holds the Dial key/);
  });

  it('tells a first-time /add-dial user that the tool reaches no agent until /add-dial-tool runs', () => {
    const doc = read('.claude/skills/add-dial/SKILL.md');
    const next = doc.slice(doc.indexOf('## Next Steps'), doc.indexOf('## Channel Info'));
    expect(next).toMatch(/before any agent existed, it reaches no agent until/);
    expect(next).toContain('/add-dial-tool');
  });

  it('says the upgrade guide’s Dial delete reaches a shared gateway’s other install, as REMOVE.md does', () => {
    const guide = read('.claude/skills/add-onecli/payload/docs/onecli-upgrades.md');
    const dial = guide.slice(guide.indexOf('Then, on every upgrade, delete any Dial key'));
    expect(dial.slice(0, dial.indexOf('```'))).toMatch(/shared with another install, that install loses Dial too/);
  });
});
