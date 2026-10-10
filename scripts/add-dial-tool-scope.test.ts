// Behavior tests for the /add-dial-tool skill's OneCLI steps.
//
// The skill carries its install as `nc:` directive fences (see
// scripts/skill-directives.ts); the conformance suite proves those fences apply
// against a stubbed exec, but says nothing about what the shell inside them
// does. These tests take the real one-liners OUT of the SKILL.md — the credential
// upsert, the typo guard, and the three per-agent scoping steps — and run them
// under POSIX `sh` (the engine's default exec is /bin/sh; the wizard's is bash)
// against stateful stub `onecli` / `ncl` binaries in a throwaway project root,
// then assert which agents end up allowed or blocked and the exact OneCLI
// commands issued. The stubs log every invocation so a test reads the calls.
//
// The scoping contract under test (the skill's prose says the same):
//   - a chosen group has this skill's block rule removed; every other group has
//     one present and enabled (named "Dial: blocked for <group>");
//   - a group with no OneCLI agent yet gets one created (mode `all`) so its rule
//     has something to attach to;
//   - secret lists are never edited with set-secrets on an `all`-mode agent (it
//     would switch the agent to selective); a CHOSEN `selective` agent has the
//     Dial secret merged into its list; a blocked one is left alone;
//   - an operator's own rules on api.getdial.ai (path/method-scoped or not
//     name-prefixed) are never read as ours;
//   - unknown ids, `all`/`none` mixing, and listing failures fail loudly instead
//     of silently opening or closing anything.

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

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
  typoGuard: one(isRun('check', 'unknown agent group')),
  credential: one(isRun('external', 'onecli secrets')),
  ensureAgents: one(isRun('wire', 'onecli agents create')),
  allowBlock: one(isRun('wire', 'onecli rules create')),
  selectiveMerge: one(isRun('wire', 'set-secrets')),
};

let root: string;
let bin: string;
let state: string;
let calls: string;

type OcAgent = { id: string; identifier: string; name: string; secretMode: 'all' | 'selective' };
type Rule = { id: string; agentId: string; name: string; enabled?: boolean; pathPattern?: string | null };

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
    existingRules?: Rule[];
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

  const rules = (opts.existingRules ?? []).map((r) => ({
    enabled: true,
    pathPattern: null,
    method: null,
    ...r,
    hostPattern: 'api.getdial.ai',
    action: 'block',
  }));
  fs.writeFileSync(path.join(state, 'agents.json'), JSON.stringify({ data: opts.agents ?? DEFAULT_AGENTS }));
  fs.writeFileSync(path.join(state, 'rules.json'), JSON.stringify({ data: rules }));
  fs.writeFileSync(path.join(state, 'assigned.json'), JSON.stringify({ data: opts.assigned ?? ['sec-anthropic'] }));
  fs.writeFileSync(
    path.join(state, 'secrets.json'),
    JSON.stringify({ data: opts.secrets ?? [{ id: 'sec-dial', name: 'Dial API' }] }),
  );

  writeStub('ncl', `if [ "$1 $2" = "groups list" ]; then echo '${JSON.stringify({ ok: true, data: GROUPS })}'; fi`);
  // A stateful OneCLI: creates/updates/deletes land in the JSON files the list
  // commands read, so a later step in the same run sees what an earlier one did
  // (the real vault does). Flags are parsed positionally: --key value.
  writeStub(
    'onecli',
    `
S="$STATE"
arg() { local k="$1"; shift; while [ $# -gt 0 ]; do if [ "$1" = "$k" ]; then echo "$2"; return; fi; shift; done; }
case "$1 $2" in
  "secrets list") cat "$S/secrets.json" ;;
  "secrets delete") i=$(arg --id "$@"); jq --arg i "$i" '.data |= map(select(.id != $i))' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{"status":"deleted"}' ;;
  "secrets create") f=$(arg --file "$@"); [ -n "$f" ] && cat "$f" > "$S/key-seen"; jq '.data += [{"id":"sec-new","name":"Dial API"}]' "$S/secrets.json" > "$S/t" && mv "$S/t" "$S/secrets.json"; echo '{"id":"sec-new"}' ;;
  "agents list") ${opts.agentsListFails ? 'echo "boom" >&2; exit 1' : 'cat "$S/agents.json"'} ;;
  "agents secrets") cat "$S/assigned.json" ;;
  "agents set-secrets") echo '{"status":"updated"}' ;;
  "agents create") n=$(arg --name "$@"); i=$(arg --identifier "$@"); jq --arg n "$n" --arg i "$i" '.data += [{"id":("oc-"+$i),"identifier":$i,"name":$n,"secretMode":"all"}]' "$S/agents.json" > "$S/t" && mv "$S/t" "$S/agents.json"; echo "{\\"id\\":\\"oc-$i\\"}" ;;
  "rules list") cat "$S/rules.json" ;;
  "rules create") n=$(arg --name "$@"); a=$(arg --agent-id "$@"); c=$(jq '.data|length' "$S/rules.json"); jq --arg n "$n" --arg a "$a" --arg id "rule-new-$c" '.data += [{"id":$id,"name":$n,"agentId":$a,"hostPattern":"api.getdial.ai","action":"block","enabled":true,"pathPattern":null,"method":null}]' "$S/rules.json" > "$S/t" && mv "$S/t" "$S/rules.json"; echo "{\\"id\\":\\"rule-new-$c\\"}" ;;
  "rules update") i=$(arg --id "$@"); e=$(arg --enabled "$@"); jq --arg i "$i" --argjson e "$e" '(.data[] | select(.id==$i) | .enabled) = $e' "$S/rules.json" > "$S/t" && mv "$S/t" "$S/rules.json"; echo '{"status":"updated"}' ;;
  "rules delete") i=$(arg --id "$@"); jq --arg i "$i" '.data |= map(select(.id != $i))' "$S/rules.json" > "$S/t" && mv "$S/t" "$S/rules.json"; echo '{"status":"deleted"}' ;;
  *) echo '{}' ;;
esac`,
  );
}

/** Run one document command under POSIX sh with {{dial_agents}} substituted. */
function sh(cmd: string, agents = ''): { stdout: string; status: number } {
  const substituted = cmd.replaceAll('{{dial_agents}}', agents);
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
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, status: 0 };
  } catch (e) {
    const err = e as { stdout?: string; status?: number };
    return { stdout: err.stdout ?? '', status: err.status ?? 1 };
  }
}

/** The whole scoping sequence as the document orders it. */
function scope(agents: string): { stdout: string; status: number } {
  const guard = sh(CMD.typoGuard, agents);
  if (guard.status !== 0) return guard;
  let out = '';
  for (const cmd of [CMD.ensureAgents, CMD.allowBlock, CMD.selectiveMerge]) {
    const r = sh(cmd, agents);
    out += r.stdout;
    if (r.status !== 0) return { stdout: out, status: r.status };
  }
  return { stdout: out, status: 0 };
}

const callLines = () => fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean);
const rulesNow = (): Rule[] =>
  (JSON.parse(fs.readFileSync(path.join(state, 'rules.json'), 'utf8')) as { data: Rule[] }).data;
const blockedAgentIds = () =>
  rulesNow()
    .filter((r) => r.enabled)
    .map((r) => r.agentId)
    .sort();

beforeEach(() => setup());
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

describe('add-dial-tool: the document carries the steps under test', () => {
  it('has exactly the expected single-command directives', () => {
    for (const [k, v] of Object.entries(CMD)) expect(v, k).toMatch(/\S/);
  });
});

describe('add-dial-tool: scoping Dial to the chosen agents', () => {
  it('allows the chosen agent and blocks the rest with an OneCLI rule', () => {
    const { stdout, status } = scope('ag-sales');
    expect(status).toBe(0);
    expect(stdout).toContain('allowed: Sales (ag-sales)');
    expect(stdout).toContain('blocked: Support (ag-support)');

    const lines = callLines();
    // Support had no OneCLI agent: created (all mode), secrets NOT touched, blocked by rule.
    expect(lines).toContain('onecli agents create --name Support --identifier ag-support');
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets --id oc-ag-support'))).toBe(false);
    expect(lines).toContain(
      'onecli rules create --name Dial: blocked for Support --host-pattern api.getdial.ai --action block --agent-id oc-ag-support --enabled',
    );
    // Sales is selective: keeps its secrets and gains Dial.
    expect(lines).toContain('onecli agents set-secrets --id oc-sales --secret-ids sec-anthropic,sec-dial');
    // The OneCLI default agent is not a NanoClaw group: untouched.
    expect(lines.some((l) => l.includes('oc-default'))).toBe(false);
    expect(blockedAgentIds()).toEqual(['oc-ag-support']);
  });

  it('`all` opens every group and removes stale block rules', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ existingRules: [{ id: 'rule-old', agentId: 'oc-sales', name: 'Dial: blocked for Sales' }] });
    const { stdout, status } = scope('all');
    expect(status).toBe(0);
    expect(stdout).toContain('allowed: Sales (ag-sales)');
    expect(stdout).toContain('allowed: Support (ag-support)');
    const lines = callLines();
    expect(lines).toContain('onecli rules delete --id rule-old');
    expect(lines.some((l) => l.startsWith('onecli rules create'))).toBe(false);
    expect(blockedAgentIds()).toEqual([]);
  });

  it('is idempotent: an already-blocked agent gets no second rule', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ existingRules: [{ id: 'rule-old', agentId: 'oc-sales', name: 'Dial: blocked for Sales' }] });
    const { status } = scope('ag-support');
    expect(status).toBe(0);
    expect(callLines().filter((l) => l.startsWith('onecli rules create'))).toHaveLength(0);
    expect(blockedAgentIds()).toEqual(['oc-sales']);
  });

  it('refuses an unknown agent id instead of guessing', () => {
    const { status } = scope('ag-typo');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli'))).toBe(false);
  });

  it('`none` blocks every group', () => {
    const { stdout, status } = scope('none');
    expect(status).toBe(0);
    expect(stdout).not.toContain('allowed:');
    expect(blockedAgentIds()).toEqual(['oc-ag-support', 'oc-sales']);
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
    const lines = callLines();
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
    // The block rule alone does the scoping for the excluded agent.
    expect(lines.some((l) => l.startsWith('onecli rules create') && l.includes('--agent-id oc-support'))).toBe(true);
  });

  it('blocks a selective agent by rule only, without editing its secret list', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      agents: [{ id: 'oc-support', identifier: 'ag-support', name: 'Support', secretMode: 'selective' }],
      assigned: ['sec-dial'],
    });
    const { status, stdout } = scope('ag-sales');
    expect(status).toBe(0);
    expect(stdout).toContain('blocked: Support (ag-support)');
    const lines = callLines();
    expect(lines.some((l) => l.startsWith('onecli agents set-secrets --id oc-support'))).toBe(false);
    expect(lines.some((l) => l.startsWith('onecli rules create') && l.includes('--agent-id oc-support'))).toBe(true);
  });

  it('a disabled block rule does not count as blocking: it is re-enabled', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({
      existingRules: [{ id: 'rule-off', agentId: 'oc-sales', name: 'Dial: blocked for Sales', enabled: false }],
    });
    const { status } = scope('ag-support');
    expect(status).toBe(0);
    expect(callLines()).toContain('onecli rules update --id rule-off --enabled true');
    expect(blockedAgentIds()).toEqual(['oc-sales']);
  });

  it("leaves the operator's own path-scoped rule alone when unblocking", () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ existingRules: [{ id: 'rule-op', agentId: 'oc-sales', name: 'ops: no calls', pathPattern: '/v1/calls' }] });
    const { status } = scope('all');
    expect(status).toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli rules delete'))).toBe(false);
    expect(rulesNow().map((r) => r.id)).toEqual(['rule-op']);
  });

  it('fails instead of reporting success when OneCLI agents cannot be listed', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ agentsListFails: true });
    const { status } = scope('ag-sales');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli rules create'))).toBe(false);
    expect(callLines().some((l) => l.startsWith('onecli agents create'))).toBe(false);
  });

  it('tolerates spaces and duplicates in the answer and allows exactly what was named', () => {
    const { stdout, status } = scope('ag-sales, ag-support ,ag-sales');
    expect(status).toBe(0);
    expect(stdout).toContain('allowed: Sales (ag-sales)');
    expect(stdout).toContain('allowed: Support (ag-support)');
    expect(blockedAgentIds()).toEqual([]);
  });

  it('refuses to add the Dial secret to a chosen selective agent when the vault has no Dial secret', () => {
    fs.rmSync(root, { recursive: true, force: true });
    setup({ secrets: [] });
    const { status } = scope('ag-sales');
    expect(status).not.toBe(0);
    expect(callLines().some((l) => l.startsWith('onecli agents set-secrets'))).toBe(false);
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
