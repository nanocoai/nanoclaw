// Behavior tests for the /add-dial-tool skill's OneCLI steps.
//
// The skill carries its install as `nc:` directive fences (see
// scripts/skill-directives.ts); the conformance suite proves those fences apply
// against a stubbed exec, but says nothing about what the shell inside them
// does. These tests take the real one-liners OUT of the SKILL.md — the gateway
// version guard, the checked selection, the credential upsert, and the three
// scoping steps — and run them under POSIX `sh` (the engine's default exec is
// /bin/sh; the wizard's is bash) against stateful stub `onecli` / `ncl` / `pnpm`
// binaries in a throwaway project root, then assert the exact commands issued.
// The stubs log every invocation so a test reads the calls. The policy itself
// (what the script writes to the OneCLI policy API) is tested where the script
// lives: .claude/skills/add-dial-tool/scripts/dial-policy.test.ts.
//
// The scoping contract under test (the skill's prose says the same):
//   - the gateway must be 1.42 (the pin): older gateways do not enforce the
//     policy API, 1.43+ removes set-secrets; the guard runs before any write;
//   - the checked selection is a capture every install/sign-in/credential step
//     depends on, so a bad answer stops them all;
//   - a group with no OneCLI agent yet gets one created (mode `all`) so the
//     policy can name it;
//   - the policy step hands the checked selection to the policy script;
//   - secret lists are never edited with set-secrets on an `all`-mode agent (it
//     would switch the agent to selective); a CHOSEN `selective` agent has the
//     Dial secret merged into its list; a blocked one is left alone;
//   - unknown ids, `all`/`none` mixing, and listing failures fail loudly instead
//     of silently opening or closing anything.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applySkill } from './skill-apply.js';
import { parseDirectives, type Directive } from './skill-directives.js';

const SKILL_MD = path.resolve(__dirname, '../.claude/skills/add-dial-tool/SKILL.md');
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
  credential: one(isRun('external', 'onecli secrets')),
  ensureAgents: one(isRun('wire', 'onecli agents create')),
  policy: one((d) => d.kind === 'run' && d.attrs.capture === 'dial_policy'),
  selectiveMerge: one(isRun('wire', 'set-secrets')),
};

let root: string;
let bin: string;
let state: string;
let calls: string;

type OcAgent = { id: string; identifier: string; name: string; secretMode: 'all' | 'selective' };

const GROUPS = [
  { id: 'ag-sales', name: 'Sales' },
  { id: 'ag-support', name: 'Support' },
];
// OneCLI knows Sales already (selective mode, Anthropic assigned); Support has
// no OneCLI agent yet (never spawned). Tests override per case.
const DEFAULT_AGENTS: OcAgent[] = [
  { id: 'oc-default', identifier: 'default', name: 'Default Agent', secretMode: 'all' },
  { id: 'oc-sales', identifier: 'ag-sales', name: 'Sales', secretMode: 'selective' },
];

function writeStub(name: string, body: string): void {
  fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\necho "${name} $*" >> "$CALLS"\n${body}\n`, {
    mode: 0o755,
  });
}

function setup(
  opts: {
    agents?: OcAgent[];
    /** Secret ids `agents secrets` reports for every agent. */
    assigned?: string[];
    /** Secrets in the vault. */
    secrets?: Array<{ id: string; name: string }>;
    /** Make `onecli agents list` fail. */
    agentsListFails?: boolean;
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
  fs.writeFileSync(calls, '');
  const xdg = path.join(root, 'xdg');
  fs.mkdirSync(path.join(xdg, 'dial'), { recursive: true });
  if (opts.authKey !== null) {
    fs.writeFileSync(path.join(xdg, 'dial', 'auth.v1.json'), JSON.stringify({ apiKey: opts.authKey ?? 'sk_test' }));
  }
  process.env.TEST_XDG = xdg;

  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ data: opts.agents ?? DEFAULT_AGENTS }));
  fs.writeFileSync(path.join(state, 'assigned.json'), JSON.stringify({ data: opts.assigned ?? ['sec-anthropic'] }));
  fs.writeFileSync(
    path.join(state, 'secrets.json'),
    JSON.stringify({ data: opts.secrets ?? [{ id: 'sec-dial', name: 'Dial API' }] }),
  );

  writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '${JSON.stringify({ ok: true, data: GROUPS })}'; fi`);
  // The policy script is exercised by its own test; here only the hand-off counts.
  writeStub('pnpm', 'echo published');
  // A stateful OneCLI: creates/updates/deletes land in the JSON files the list
  // commands read, so a later step in the same run sees what an earlier one did
  // (the real vault does). Flags are parsed positionally: --key value.
  writeStub(
    'onecli',
    `
S="$STATE"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "config get") if [ -f "$S/api-host" ]; then cat "$S/api-host"; else echo '{"key":"api-host","value":"http://gw.test:10254"}'; fi ;;
  "secrets list") cat "$S/secrets.json" ;;
  "secrets delete") i=$(arg --id "$@"); jq --arg i "$i" '.data |= map(select(.id != $i))' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{"status":"deleted"}' ;;
  "secrets create") f=$(arg --file "$@"); [ -n "$f" ] && cat "$f" > "$S/key-seen"; jq '.data += [{"id":"sec-new","name":"Dial API"}]' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{"id":"sec-new"}' ;;
  "agents list") ${opts.agentsListFails ? 'echo "boom" >&2; exit 1' : 'cat "$S/agents.json"'} ;;
  "agents secrets") cat "$S/assigned.json" ;;
  "agents set-secrets") echo '{"status":"updated"}' ;;
  "agents create") n=$(arg --name "$@"); i=$(arg --identifier "$@"); jq --arg n "$n" --arg i "$i" '.data += [{"id":("oc-"+$i),"identifier":$i,"name":$n,"secretMode":"all"}]' "$S/agents.json" > "$S/t" && mv "$S/t" "$S/agents.json"; echo "{\\"id\\":\\"oc-$i\\"}" ;;
  "rules "*) echo '{"error":{"message":"Custom policy rules are now managed through the policy API (/v1/policy).","type":"invalid_request_error"}}' >&2; exit 1 ;;
  *) echo '{}' ;;
esac`,
  );
}

/** Run one document command under POSIX sh with the selection vars substituted. */
function sh(
  cmd: string,
  agents = '',
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const substituted = cmd
    .replaceAll('{{dial_agents}}', agents)
    .replaceAll('{{dial_scope}}', agents.replaceAll(' ', ''))
    .replaceAll('{{onecli_gateway}}', '1.42.0')
    .replaceAll('{{dial_policy}}', 'published')
    .replaceAll('{{dial_ua}}', 'nanoclaw/test')
    .replaceAll('{{owner_email}}', 'operator@example.com')
    .replaceAll('{{otp}}', '123456');
  try {
    const stdout = execFileSync('sh', ['-c', substituted], {
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

/** The whole scoping sequence as the document orders it: the checked selection feeds the later steps. */
function scope(agents: string): { stdout: string; status: number } {
  const guard = sh(CMD.scopeGuard, agents);
  if (guard.status !== 0) return guard;
  const checked = guard.stdout.trim();
  let out = '';
  for (const cmd of [CMD.ensureAgents, CMD.policy, CMD.selectiveMerge]) {
    const r = sh(cmd, checked);
    out += r.stdout;
    if (r.status !== 0) return { stdout: out, status: r.status };
  }
  return { stdout: out, status: 0 };
}

const callLines = () => fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
const policyCall = () => callLines().find((l) => l.startsWith('pnpm exec tsx'));

beforeEach(() => setup());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('add-dial-tool: the document carries the steps under test', () => {
  it('has exactly the expected single-command directives', () => {
    for (const [k, v] of Object.entries(CMD)) expect(v, k).toMatch(/\S/);
  });
});

describe('add-dial-tool: scoping Dial to the chosen agents', () => {
  it('creates the missing OneCLI agent, hands the selection to the policy script, merges the selective agent', () => {
    const { status } = scope('ag-sales');
    expect(status).toBe(0);
    const lines = callLines();
    // Support had no OneCLI agent: created (all mode), secrets NOT touched.
    expect(lines).toContain('onecli agents create --name Support --identifier ag-support');
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets --id oc-ag-support'))).toBe(false);
    expect(policyCall()).toBe(
      'pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents ag-sales',
    );
    // Sales is selective: keeps its secrets and gains Dial.
    expect(lines).toContain('onecli agents set-secrets --id oc-sales --secret-ids sec-anthropic,sec-dial');
    // The OneCLI default agent is not a NanoClaw group: untouched.
    expect(lines.some((l) => l.includes('oc-default'))).toBe(false);
    // Legacy rule commands are gone: the gateway rejects them anyway.
    expect(lines.some((l) => l.startsWith('onecli rules'))).toBe(false);
  });

  it.each(['all', 'none'])('passes `%s` through unchanged', (word) => {
    const { status } = scope(word);
    expect(status).toBe(0);
    expect(policyCall()).toBe(
      `pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents ${word}`,
    );
  });

  it('refuses an unknown agent id instead of guessing', () => {
    const { status } = scope('ag-typo');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli') || l.startsWith('pnpm'))).toBe(false);
  });

  it('refuses the selection when the groups cannot be listed', () => {
    writeStub('ncl', 'echo "no socket" >&2; exit 1');
    const r = sh(CMD.scopeGuard, 'ag-sales');
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('could not list agent groups');
  });

  it('`none` merges no secret anywhere', () => {
    const { stdout, status } = scope('none');
    expect(status).toBe(0);
    expect(stdout).not.toContain('Dial secret added');
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
  });

  it('never calls set-secrets on an all-mode agent (that would switch it to selective and cut other credentials)', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [
        { id: 'oc-default', identifier: 'default', name: 'Default Agent', secretMode: 'all' },
        { id: 'oc-sales', identifier: 'ag-sales', name: 'Sales', secretMode: 'all' },
        { id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'all' },
      ],
    });
    const { status } = scope('ag-sales');
    expect(status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
  });

  it('leaves a selective agent that was not chosen alone', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [{ id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' }],
      assigned: ['sec-dial'],
    });
    const { status } = scope('ag-sales');
    expect(status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets --id oc-support'))).toBe(false);
  });

  it('fails instead of reporting success when OneCLI agents cannot be listed', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ agentsListFails: true });
    const { status } = scope('ag-sales');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli agents create'))).toBe(false);
    expect(policyCall()).toBeUndefined();
  });

  it('tolerates spaces in the answer and hands over exactly what was named', () => {
    const { status } = scope('ag-sales, ag-support ,ag-sales');
    expect(status).toBe(0);
    expect(policyCall()).toBe(
      'pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents ag-sales,ag-support,ag-sales',
    );
  });

  it('refuses to add the Dial secret to a chosen selective agent when the vault has no Dial secret', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ secrets: [] });
    const { status } = scope('ag-sales');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
  });

  it('every install, sign-in and credential step depends on the checked selection and the gateway version', () => {
    for (const cmd of [CMD.installCli, CMD.login, CMD.verifyOtp, CMD.credential]) {
      expect(cmd).toContain('{{dial_scope}}');
      expect(cmd).toContain('{{onecli_gateway}}');
    }
    // The block is published before any Dial sign-in, and the key write
    // depends on its capture: no key without the block.
    expect(CMD.credential).toContain('{{dial_policy}}');
    const order = directives.filter((d) => d.kind === 'run').map((d) => d.body.join('\n'));
    const at = (cmd: string) => order.indexOf(cmd);
    expect(at(CMD.scopeGuard)).toBeLessThan(at(CMD.ensureAgents));
    expect(at(CMD.ensureAgents)).toBeLessThan(at(CMD.policy));
    expect(at(CMD.policy)).toBeLessThan(at(CMD.installCli));
    expect(at(CMD.installCli)).toBeLessThan(at(CMD.credential));
    expect(at(CMD.credential)).toBeLessThan(at(CMD.selectiveMerge));
  });
});

describe('add-dial-tool: registering the host credential with OneCLI', () => {
  it('replaces the existing Dial secret (delete, then create from the temp file) — `secrets update` takes the value only on argv', () => {
    const { status, stdout } = sh(CMD.credential);
    expect(status).toBe(0);
    const lines = callLines();
    expect(lines).toContain('onecli secrets delete --id sec-dial');
    const create = lines.find((l) => l.startsWith('onecli secrets create'));
    expect(create).toMatch(
      /^onecli secrets create --name Dial API --type generic --file \S+ --host-pattern api\.getdial\.ai --header-name Authorization --value-format Bearer \{value\}$/,
    );
    expect(lines.indexOf('onecli secrets delete --id sec-dial')).toBeLessThan(lines.indexOf(create!));
    expect(lines.some((l) => l.startsWith('onecli secrets update'))).toBe(false);
    expect(lines.some((l) => /--value(\s|=)/.test(l))).toBe(false);
    // The key reaches OneCLI through the temp file, never argv or stdout, and the file is gone after.
    expect(fs.readFileSync(path.join(state, 'key-seen'), 'utf8')).toBe('sk_test\n');
    expect(create).not.toContain('sk_test');
    expect(stdout).not.toContain('sk_test');
    const tmp = (create ?? '').match(/--file (\S+)/)?.[1] ?? '';
    expect(fs.existsSync(tmp)).toBe(false);
  });

  it('creates the secret with header injection when the vault has none', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ secrets: [] });
    const { status } = sh(CMD.credential);
    expect(status).toBe(0);
    const create = callLines().find((l) => l.startsWith('onecli secrets create'));
    expect(create).toMatch(
      /^onecli secrets create --name Dial API --type generic --file \S+ --host-pattern api\.getdial\.ai --header-name Authorization --value-format Bearer \{value\}$/,
    );
    expect(fs.readFileSync(path.join(state, 'key-seen'), 'utf8')).toBe('sk_test\n');
  });

  it('fails loudly when the host has no Dial key, touching nothing', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ authKey: null });
    const { status } = sh(CMD.credential);
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli secrets'))).toBe(false);
  });
});

describe('add-dial-tool: OneCLI gateway version guard', () => {
  // Only 1.42 (the pin) is supported: older gateways do not enforce the policy
  // API, 1.43+ removes set-secrets. The guard must stop before the credential
  // step writes the key, or all-mode agents get Dial.
  function guard(health: string | null, opts: { apiHost?: string; curlExit?: number } = {}) {
    if (opts.apiHost !== undefined) fs.writeFileSync(path.join(state, 'api-host'), opts.apiHost);
    const out = health === null ? 'echo "connection refused" >&2' : `echo '${health}'`;
    writeStub('curl', `${out}\nexit ${opts.curlExit ?? (health === null ? 7 : 0)}`);
    return sh(CMD.versionGuard);
  }
  const health = (version?: string) => JSON.stringify({ status: 'ok', ...(version ? { version } : {}) });

  it.each(['1.42.0', '1.42.3', '1.42.10'])('passes on gateway %s and captures the version', (v) => {
    const r = guard(health(v));
    expect(r.status).toBe(0);
    expect(r.stdout.trim()).toBe(v);
    expect(callLines()).toContain('curl -fsS --max-time 10 http://gw.test:10254/api/health');
  });

  it.each(['1.41.0', '1.36.0', '1.9.2', '0.8.0'])('stops on the older gateway %s, naming the pin', (v) => {
    const r = guard(health(v));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain(`'${v}'`);
    expect(r.stderr).toContain('older than 1.42');
    expect(r.stderr).toContain('1.42.0');
    expect(r.stderr).toContain('Nothing was written');
  });

  it.each(['1.43.0', '1.43.3', '1.45.0', '1.100.0', '2.7.0'])('stops on the newer gateway %s, naming the pin', (v) => {
    const r = guard(health(v));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
    expect(r.stderr).toContain('newer than 1.42');
    expect(r.stderr).toContain('set-secrets');
    expect(r.stderr).toContain('1.42.0');
  });

  it.each(['unknown', 'dev', '1.42', '1.42.0-x', '1.420.0'])('stops on an unreadable version %s', (v) => {
    const r = guard(health(v));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe('');
  });

  it('stops on a missing version, invalid JSON, a failed transfer, or an unreachable gateway', () => {
    expect(guard(health()).status).not.toBe(0);
    expect(guard(`${health('1.42.0')}garbage`).status).not.toBe(0);
    expect(guard(health('1.42.0'), { curlExit: 18 }).status).not.toBe(0);
    expect(guard(null).status).not.toBe(0);
  });

  it('checks the host the onecli CLI writes to, and stops without one', () => {
    expect(guard(health('1.42.0'), { apiHost: '{"key":"api-host","value":"http://other:1"}' }).status).toBe(0);
    expect(callLines()).toContain('curl -fsS --max-time 10 http://other:1/api/health');
    expect(guard(health('1.42.0'), { apiHost: '{"key":"api-host","value":""}' }).status).not.toBe(0);
    expect(callLines().filter((l) => l.startsWith('curl'))).toHaveLength(1);
  });

  it('runs before anything is written, and the credential step depends on its capture', () => {
    const order = directives.filter((d) => d.kind === 'run').map((d) => d.body.join('\n'));
    const at = order.indexOf(CMD.versionGuard);
    expect(at).toBeGreaterThanOrEqual(0);
    expect(at).toBeLessThan(order.indexOf(CMD.credential));
    expect(at).toBeLessThan(order.indexOf(CMD.ensureAgents));
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
          return exec(c);
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
        c.includes('onecli secrets create') ||
        c.includes('dial-policy.ts') ||
        c.includes('onecli agents set-secrets --id') ||
        c.includes('dial auth') ||
        c.includes('npm install'),
    );

  it('never writes the Dial key or the policy when the gateway version guard fails', async () => {
    const { ran, res } = await apply((c) => {
      if (c.includes('/api/health')) throw new Error('gateway 1.43.3 is newer than 1.42');
      if (c.includes('unknown agent group')) return 'all';
      if (c.includes('dial-policy.ts')) return 'published';
      return undefined;
    });
    expect(ran.some((c) => c.includes('/api/health'))).toBe(true);
    expect(writes(ran)).toEqual([]);
    expect(res.agentTasks.length).toBeGreaterThan(0);
  });

  it('never installs, signs in, or writes when the selection check fails', async () => {
    const { ran, res } = await apply((c) => {
      if (c.includes('/api/health')) return '1.42.0';
      if (c.includes('unknown agent group')) throw new Error("unknown agent group 'ag-typo'");
      if (c.includes('dial-policy.ts')) return 'published';
      return undefined;
    });
    expect(ran.some((c) => c.includes('unknown agent group'))).toBe(true);
    expect(writes(ran)).toEqual([]);
    expect(res.agentTasks.length).toBeGreaterThan(0);
  });

  it('never writes the Dial key when the policy step fails, even though the engine does not gate externals', async () => {
    const { ran, res } = await apply((c) => {
      if (c.includes('/api/health')) return '1.42.0';
      if (c.includes('unknown agent group')) return 'all';
      if (c.includes('dial-policy.ts')) throw new Error('POST /v1/policy/rules failed with 503');
      return undefined;
    });
    expect(ran.some((c) => c.includes('dial-policy.ts'))).toBe(true);
    expect(ran.some((c) => c.includes('onecli secrets create'))).toBe(false);
    expect(ran.some((c) => c.includes('onecli agents set-secrets --id'))).toBe(false);
    expect(res.agentTasks.length).toBeGreaterThan(0);
  });

  it('runs every step, in order, when the guards pass: the block is published before the key is written', async () => {
    const { ran } = await apply((c) => {
      if (c.includes('/api/health')) return '1.42.0';
      if (c.includes('unknown agent group')) return 'all';
      if (c.includes('dial-policy.ts')) return 'allowed:ag-1\npublished';
      return undefined;
    });
    const seen = writes(ran);
    const policy = 'pnpm exec tsx .claude/skills/add-dial-tool/scripts/dial-policy.ts scope --agents all';
    expect(seen).toContain(policy);
    expect(seen.some((c) => c.includes('npm install'))).toBe(true);
    expect(seen.some((c) => c.includes('dial auth login operator@example.com'))).toBe(true);
    expect(seen.some((c) => c.includes('onecli secrets create'))).toBe(true);
    expect(seen.indexOf(policy)).toBeLessThan(seen.findIndex((c) => c.includes('npm install')));
    expect(seen.indexOf(policy)).toBeLessThan(seen.findIndex((c) => c.includes('onecli secrets create')));
  });
});
