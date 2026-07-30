import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySkill, removeSkill, planSkill, fullyApplied, firstFailureHint, referenceProse, stepLabel, type ApplyEvent, type InputMeta } from './skill-apply.js';
import { parseDirectives, validate } from './skill-directives.js';

// A synthetic skill exercising the fs handlers for real (no network), plus one
// directive the engine can't handle — to prove it bounces to an agent, not abort.
const SKILL = `# demo skill

## Copy the file
\`\`\`nc:copy
resources/sample.ts -> src/sample.ts
\`\`\`

## Register it
\`\`\`nc:append to:src/barrel.ts
import './sample.js';
\`\`\`

## Capture and store a secret
\`\`\`nc:prompt token secret
Paste the demo token.
\`\`\`
\`\`\`nc:env-set
DEMO_TOKEN={{token}}
\`\`\`

## A step the engine can't do deterministically
Hand-edit the scheduler to register the demo hook.
\`\`\`nc:patch-scheduler
register demo
\`\`\`
`;

let root: string;
let skillDir: string;
// A headless resolveInput fake: answers from a fixed map; a missing var defers.
const headless = (vals: Record<string, string>) => async (name: string): Promise<string | undefined> => vals[name];
const recordingExec = () => {
  const cmds: string[] = [];
  return { cmds, exec: (c: string) => void cmds.push(c) };
};

beforeEach(() => {
  skillDir = mkdtempSync(join(tmpdir(), 'nc-skill-'));
  root = mkdtempSync(join(tmpdir(), 'nc-proj-'));
  mkdirSync(join(skillDir, 'resources'), { recursive: true });
  writeFileSync(join(skillDir, 'SKILL.md'), SKILL);
  writeFileSync(join(skillDir, 'resources/sample.ts'), 'export const sample = true;\n');
  mkdirSync(join(root, 'src'), { recursive: true });
  writeFileSync(join(root, 'src/barrel.ts'), '// channel barrel\n');
  writeFileSync(join(root, '.env'), '');
  writeFileSync(join(root, 'package.json'), '{"name":"scratch"}');
});

describe('apply engine lifecycle', () => {
  it('applies fs directives, captures the secret, and bounces the unknown step to an agent', async () => {
    const { exec } = recordingExec();
    const res = await applySkill(skillDir, root, { resolveInput: headless({ token: 'sekret-123' }), exec });

    // mutations happened
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(true);
    expect(readFileSync(join(root, 'src/barrel.ts'), 'utf8')).toContain("import './sample.js';");
    expect(readFileSync(join(root, '.env'), 'utf8')).toContain('DEMO_TOKEN=sekret-123');

    // the unknown directive went to an agent — with prose — not the human, not an abort
    expect(res.agentTasks).toHaveLength(1);
    expect(res.agentTasks[0].kind).toBe('patch-scheduler');
    expect(res.agentTasks[0].prose).toContain('Hand-edit the scheduler');
    expect(res.deferred).toEqual([]);
    expect(res.journal.length).toBeGreaterThanOrEqual(3); // wrote + appended + set-env
  });

  it('is idempotent — a second apply changes nothing', async () => {
    const p = headless({ token: 'sekret-123' });
    await applySkill(skillDir, root, { resolveInput: p, exec: () => {} });
    const second = await applySkill(skillDir, root, { resolveInput: p, exec: () => {} });
    expect(second.applied).toEqual([]); // everything already applied
    expect(second.journal).toEqual([]); // nothing mutated
    expect(second.skipped.length).toBeGreaterThanOrEqual(3);
  });

  it('removes cleanly from the journal — no hand-written REMOVE.md', async () => {
    const res = await applySkill(skillDir, root, { resolveInput: headless({ token: 'sekret-123' }), exec: () => {} });
    await removeSkill(root, res.journal);
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(false);
    expect(readFileSync(join(root, 'src/barrel.ts'), 'utf8')).not.toContain("import './sample.js';");
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DEMO_TOKEN');
  });

  it('defers a prompt (and its consumer) when resolveInput has no value — headless rebuild', async () => {
    const res = await applySkill(skillDir, root, { resolveInput: headless({}), exec: () => {} });
    expect(res.deferred).toContain('token'); // prompt deferred
    expect(res.deferred.some((d) => /unresolved \{\{token\}\}/.test(d))).toBe(true); // env-set blocked on it
    expect(readFileSync(join(root, '.env'), 'utf8')).not.toContain('DEMO_TOKEN');
  });

  it('plan marks the unknown step ↳agent and the prompt ? needs-input before any write', () => {
    const { steps, agentSteps, needsInput } = planSkill(skillDir, root);
    expect(agentSteps).toBe(1);
    expect(needsInput).toContain('token');
    expect(existsSync(join(root, 'src/sample.ts'))).toBe(false); // planning mutated nothing
  });
});

// from-branch copy: the dest may live only on the registry branch (e.g. a
// container skill trunk no longer ships), so the engine must create the
// parent directory itself — the shell redirect in `git show src > dest` can't.
const FROM_BRANCH_SKILL = `# from-branch demo

## Pull the formatting skill from the channels branch
\`\`\`nc:copy from-branch:channels
container/skills/demo-formatting/SKILL.md
\`\`\`
`;

describe('from-branch copy apply path', () => {
  it('creates the missing dest parent dir before the git-show redirect', async () => {
    const fskill = mkdtempSync(join(tmpdir(), 'nc-skill-fb-'));
    const froot = mkdtempSync(join(tmpdir(), 'nc-proj-fb-'));
    writeFileSync(join(fskill, 'SKILL.md'), FROM_BRANCH_SKILL);
    writeFileSync(join(froot, '.env'), '');
    writeFileSync(join(froot, 'package.json'), '{"name":"scratch"}');
    // container/skills/demo-formatting/ deliberately absent from root

    const { cmds, exec } = recordingExec();
    const res = await applySkill(fskill, froot, { exec, resolveRemote: () => 'origin' });

    // the redirect target's parent now exists, so the exec'd `git show … > dest`
    // (mocked here) would not fail with ENOENT on a real run
    expect(existsSync(join(froot, 'container/skills/demo-formatting'))).toBe(true);
    expect(cmds).toContain('git fetch origin channels');
    expect(cmds.some((c) => /^git show origin\/channels:container\/skills\/demo-formatting\/SKILL\.md > container\/skills\/demo-formatting\/SKILL\.md$/.test(c))).toBe(true);
    expect(res.journal).toContainEqual({ op: 'wrote', path: 'container/skills/demo-formatting/SKILL.md' });

    rmSync(fskill, { recursive: true, force: true });
    rmSync(froot, { recursive: true, force: true });
  });
});

// json-merge: push a body object into an array-of-objects JSON file, keyed.
const JSON_MERGE_SKILL = `# json-merge demo

## Register the CLI tool
\`\`\`nc:json-merge into:container/cli-tools.json key:name
{ "name": "@openai/codex", "version": "0.138.0" }
\`\`\`
`;

describe('json-merge directive', () => {
  let jroot: string;
  let jskill: string;
  beforeEach(() => {
    jskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    jroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(jskill, 'SKILL.md'), JSON_MERGE_SKILL);
    mkdirSync(join(jroot, 'container'), { recursive: true });
    writeFileSync(join(jroot, 'container/cli-tools.json'), '[\n  { "name": "vercel", "version": "52.2.1" }\n]\n');
  });

  it('pushes the object, preserving 2-space indent + trailing newline', async () => {
    const res = await applySkill(jskill, jroot, { resolveInput: headless({}), exec: () => {} });
    const out = readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8');
    expect(out.endsWith('\n')).toBe(true);
    const arr = JSON.parse(out);
    expect(arr).toEqual([
      { name: 'vercel', version: '52.2.1' },
      { name: '@openai/codex', version: '0.138.0' },
    ]);
    expect(out).toBe(JSON.stringify(arr, null, 2) + '\n'); // 2-space indent
    expect(res.journal.some((e) => e.op === 'json-merge')).toBe(true);
  });

  it('is idempotent — re-applying does not duplicate the element', async () => {
    await applySkill(jskill, jroot, { resolveInput: headless({}), exec: () => {} });
    const second = await applySkill(jskill, jroot, { resolveInput: headless({}), exec: () => {} });
    expect(second.applied).toEqual([]);
    expect(second.skipped.length).toBe(1);
    const arr = JSON.parse(readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8'));
    expect(arr.filter((e: { name: string }) => e.name === '@openai/codex')).toHaveLength(1);
  });

  it('removeSkill drops the element whose key matches', async () => {
    const res = await applySkill(jskill, jroot, { resolveInput: headless({}), exec: () => {} });
    await removeSkill(jroot, res.journal);
    const arr = JSON.parse(readFileSync(join(jroot, 'container/cli-tools.json'), 'utf8'));
    expect(arr).toEqual([{ name: 'vercel', version: '52.2.1' }]);
  });

  it('plan marks it →apply when absent, ✓skip when present', () => {
    const before = planSkill(jskill, jroot);
    expect(before.steps[0].status).toBe('apply');
    // simulate already-merged
    writeFileSync(
      join(jroot, 'container/cli-tools.json'),
      JSON.stringify([{ name: '@openai/codex', version: '0.138.0' }], null, 2) + '\n',
    );
    const after = planSkill(jskill, jroot);
    expect(after.steps[0].status).toBe('skip');
  });
});

// append at:<marker>: insert before a dormant region's closing line.
const MARKER_FILE = ['const STEPS = {', "  auth: () => import('./auth.js'),", '  // >>> nanoclaw:setup-steps', '  // <<< nanoclaw:setup-steps', '};', ''].join('\n');
const APPEND_AT_SKILL = `# append-at demo

## Register a setup step
\`\`\`nc:append to:setup/index.ts at:nanoclaw:setup-steps
codex: () => import('./codex.js'),
\`\`\`
`;
const APPEND_EOF_SKILL = `# append-eof demo

## Register at EOF
\`\`\`nc:append to:setup/index.ts
// trailing line
\`\`\`
`;

describe('append at:<marker>', () => {
  let aroot: string;
  let askill: string;
  beforeEach(() => {
    askill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    aroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    mkdirSync(join(aroot, 'setup'), { recursive: true });
    writeFileSync(join(aroot, 'setup/index.ts'), MARKER_FILE);
  });

  it('inserts before the `<<< marker` line, matching its indentation', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    await applySkill(askill, aroot, { resolveInput: headless({}), exec: () => {} });
    const out = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n');
    const closeIdx = out.findIndex((l) => l.includes('<<< nanoclaw:setup-steps'));
    expect(out[closeIdx - 1]).toBe("  codex: () => import('./codex.js'),"); // inserted just above, 2-space indent
    expect(out[closeIdx - 2]).toContain('>>> nanoclaw:setup-steps'); // open marker untouched
  });

  it('is idempotent (whole-file line check) regardless of position', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    await applySkill(askill, aroot, { resolveInput: headless({}), exec: () => {} });
    const second = await applySkill(askill, aroot, { resolveInput: headless({}), exec: () => {} });
    expect(second.applied).toEqual([]);
    const count = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n').filter((l) => l.trim() === "codex: () => import('./codex.js'),").length;
    expect(count).toBe(1);
  });

  it('removeSkill deletes the inserted line (position-agnostic, by trimmed line)', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_AT_SKILL);
    const res = await applySkill(askill, aroot, { resolveInput: headless({}), exec: () => {} });
    await removeSkill(aroot, res.journal);
    expect(readFileSync(join(aroot, 'setup/index.ts'), 'utf8')).not.toContain("codex: () => import('./codex.js'),");
  });

  it('without at: still appends at EOF (unchanged behavior)', async () => {
    writeFileSync(join(askill, 'SKILL.md'), APPEND_EOF_SKILL);
    await applySkill(askill, aroot, { resolveInput: headless({}), exec: () => {} });
    const lines = readFileSync(join(aroot, 'setup/index.ts'), 'utf8').split('\n').filter(Boolean);
    expect(lines[lines.length - 1]).toBe('// trailing line'); // at EOF, not before the marker
  });
});

// nc:run substitutes prompted {{vars}} — this is what lets wiring be "collect
// input + call ncl", with no nc:wire directive.
const RUN_WIRE_SKILL = `# run-substitute demo

## Collect input
\`\`\`nc:prompt owner_email
Your email.
\`\`\`

## Wire via ncl
\`\`\`nc:run effect:wire
ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0
ncl messaging-groups send --channel-type resend --platform-id resend:{{owner_email}} --text "hello"
\`\`\`

## A var-free build run
\`\`\`nc:run effect:build
pnpm run build
\`\`\`
`;

describe('nc:run variable substitution', () => {
  let rroot: string;
  let rskill: string;
  beforeEach(() => {
    rskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    rroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(rskill, 'SKILL.md'), RUN_WIRE_SKILL);
    writeFileSync(join(rroot, 'package.json'), '{"name":"scratch"}');
  });

  it('interpolates a prompted {{var}} into run commands; var-free runs pass through unchanged', async () => {
    const { cmds, exec } = recordingExec();
    await applySkill(rskill, rroot, { resolveInput: headless({ owner_email: 'you@example.com' }), exec });
    expect(cmds).toContain(
      'ncl messaging-groups create --channel-type resend --platform-id resend:you@example.com --is-group 0',
    );
    expect(cmds).toContain(
      'ncl messaging-groups send --channel-type resend --platform-id resend:you@example.com --text "hello"',
    );
    expect(cmds).toContain('pnpm run build');
  });

  it('journals the ORIGINAL command (placeholders intact) — a substituted value never lands in the journal', async () => {
    const res = await applySkill(rskill, rroot, { resolveInput: headless({ owner_email: 'you@example.com' }), exec: () => {} });
    const ran = res.journal.filter((e) => e.op === 'ran').map((e) => 'cmd' in e ? e.cmd : '');
    expect(ran).toContain(
      'ncl messaging-groups create --channel-type resend --platform-id resend:{{owner_email}} --is-group 0',
    );
    expect(JSON.stringify(res.journal)).not.toContain('you@example.com');
  });

  it('defers a wiring run when its {{var}} prompt is unanswered (degrade, not crash)', async () => {
    const { cmds, exec } = recordingExec();
    const res = await applySkill(rskill, rroot, { resolveInput: headless({}), exec });
    expect(res.deferred.some((d) => /unresolved \{\{owner_email\}\}/.test(d))).toBe(true);
    expect(cmds.some((c) => c.startsWith('ncl'))).toBe(false); // no ncl ran with an unresolved value
    expect(cmds).toContain('pnpm run build'); // the var-free run still executes
  });
});

// capture: a run binds its stdout into a {{var}}, the twin of prompt. This is
// what lets a flow resolve a value from an API (Slack conversations.open) and
// feed it downstream — so even slack.ts's bespoke steps are pure directives.
const CAPTURE_SKILL = `# capture demo

## Collect
\`\`\`nc:prompt user_id
Your member id.
\`\`\`

## Resolve an id from a command, then wire with it
\`\`\`nc:run capture:dm_channel effect:fetch
resolve-dm {{user_id}}
\`\`\`
\`\`\`nc:run effect:wire
ncl messaging-groups create --channel-type slack --platform-id slack:{{dm_channel}}
\`\`\`
`;

describe('nc:run capture', () => {
  let croot: string;
  let cskill: string;
  beforeEach(() => {
    cskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    croot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(cskill, 'SKILL.md'), CAPTURE_SKILL);
    writeFileSync(join(croot, 'package.json'), '{"name":"scratch"}');
  });

  it('binds a command stdout (trimmed) into {{var}} and substitutes it downstream', async () => {
    const cmds: string[] = [];
    // exec returns stdout for the resolve command (simulating `… | jq -r .channel.id`).
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('resolve-dm')) return 'D0SLACK123\n';
    };
    await applySkill(cskill, croot, { resolveInput: headless({ user_id: 'U999' }), exec });
    expect(cmds).toContain('resolve-dm U999'); // resolved with the prompted id
    expect(cmds).toContain('ncl messaging-groups create --channel-type slack --platform-id slack:D0SLACK123'); // captured value flowed downstream
  });

  it('lint accepts {{dm_channel}} as defined by the earlier capture', () => {
    expect(validate(parseDirectives(CAPTURE_SKILL))).toEqual([]);
  });
});

// Multi-field JSON capture: a `capture:a=.x,b=.owner.id` on an effect:fetch parses
// the command's stdout as JSON and binds each var to its jq-style dot-path — so ONE
// API call (Discord's /oauth2/applications/@me) resolves several values at once.
// A single `capture:var` (no =) still binds stdout as-is. validate:<re> shape-guards
// a captured value; a mismatch bounces to an agent (a command's output has no human
// to re-prompt). effect:step's terminal-block field capture (distinguished by
// effect) is untouched — see the effect:step describe above.
const MULTI_CAPTURE_SKILL = `# multi-field capture demo

## Derive three values from one call
\`\`\`nc:run capture:application_id=.id,public_key=.verify_key,owner_handle=.owner.id effect:fetch
curl -sf https://example/app
\`\`\`

## Store the derived values
\`\`\`nc:env-set
APP_ID={{application_id}}
PUB_KEY={{public_key}}
\`\`\`
`;

const CAPTURE_VALIDATE_SKILL = `# capture validate demo

## Resolve an id that must be numeric
\`\`\`nc:run capture:app_id=.id effect:fetch validate:^\\d+$
curl -sf https://example/app
\`\`\`

## Use it
\`\`\`nc:env-set
APP_ID={{app_id}}
\`\`\`
`;

describe('nc:run multi-field JSON capture + validate', () => {
  let mroot: string;
  let mskill: string;
  beforeEach(() => {
    mskill = mkdtempSync(join(tmpdir(), 'nc-multi-skill-'));
    mroot = mkdtempSync(join(tmpdir(), 'nc-multi-proj-'));
    writeFileSync(join(mroot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(mroot, '.env'), '');
  });

  it('binds three vars from one JSON stdout via dot-paths (incl. a nested .owner.id) and feeds them downstream', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), MULTI_CAPTURE_SKILL);
    const json = JSON.stringify({ id: '111111111111111111', verify_key: 'abc123', owner: { id: '999999999999999999' } });
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => json + '\n' });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.application_id).toBe('111111111111111111');
    expect(res.vars.public_key).toBe('abc123');
    expect(res.vars.owner_handle).toBe('999999999999999999'); // nested dot-path resolved
    const env = readFileSync(join(mroot, '.env'), 'utf8');
    expect(env).toContain('APP_ID=111111111111111111'); // flowed into env-set
    expect(env).toContain('PUB_KEY=abc123');
  });

  it('lint registers each capture:<var>=<dot-path> var as defined for the downstream env-set', () => {
    expect(validate(parseDirectives(MULTI_CAPTURE_SKILL))).toEqual([]);
  });

  it('single capture:<var> (no =) still binds stdout as-is — unchanged', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), '# single\n\n```nc:run capture:dm effect:fetch\nresolve\n```\n```nc:env-set\nDM={{dm}}\n```\n');
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => 'D123\n' });
    expect(res.vars.dm).toBe('D123');
    expect(readFileSync(join(mroot, '.env'), 'utf8')).toContain('DM=D123');
  });

  it('a validate mismatch on a captured value bounces to an agent — never binds the var', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), CAPTURE_VALIDATE_SKILL);
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => JSON.stringify({ id: 'not-a-number' }) });
    expect(res.agentTasks).toHaveLength(1); // bounce, not re-ask
    expect(res.agentTasks[0].kind).toBe('run');
    expect(res.vars.app_id).toBeUndefined(); // validate failed before binding
    // the downstream env-set then defers on the unresolved {{app_id}}
    expect(res.deferred.some((d) => /unresolved \{\{app_id\}\}/.test(d))).toBe(true);
    expect(readFileSync(join(mroot, '.env'), 'utf8')).not.toContain('APP_ID=');
  });

  it('a validate match binds the captured value and applies clean', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), CAPTURE_VALIDATE_SKILL);
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => JSON.stringify({ id: '42' }) });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.app_id).toBe('42');
  });

  it('unparseable JSON stdout for a multi-field capture bounces (degrade, not crash)', async () => {
    writeFileSync(join(mskill, 'SKILL.md'), MULTI_CAPTURE_SKILL);
    const res = await applySkill(mskill, mroot, { inputs: {}, exec: () => 'not json at all' });
    expect(res.agentTasks).toHaveLength(1);
    expect(res.vars.application_id).toBeUndefined();
  });
});

// operator: the parts addressed to the human (UI steps), delineated so the agent
// relays them and the engine renders them — the output twin of prompt.
describe('nc:operator', () => {
  let oroot: string;
  let oskill: string;
  beforeEach(() => {
    oskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    oroot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(oroot, 'package.json'), '{"name":"scratch"}');
  });

  it('is a no-op when no operator sink is present (headless rebuild) — not a crash, not an agent bounce', async () => {
    writeFileSync(join(oskill, 'SKILL.md'), '# op demo\n\nTell the user:\n```nc:operator\nDo a manual thing.\n```\n');
    const res = await applySkill(oskill, oroot, { resolveInput: headless({}), exec: () => {} });
    expect(res.agentTasks).toEqual([]); // operator with no sink is fine, not bounced
  });

  it('an unresolved {{var}} in the operator body defers the whole block — nothing collected, no event fired', async () => {
    // the body references {{bot}} but no prompt/capture defines it
    writeFileSync(join(oskill, 'SKILL.md'), '# o\n\nTell the user:\n```nc:operator\nOpen @{{bot}} in Telegram and keep it on screen.\n```\n');
    const events: ApplyEvent[] = [];
    const res = await applySkill(oskill, oroot, { inputs: {}, exec: () => {}, onEvent: (e) => void events.push(e) });
    expect(events).toEqual([]); // never emitted — deferred before any event
    expect(res.operatorMessages).toEqual([]); // and never collected half-rendered
    expect(res.deferred.some((d) => /unresolved \{\{bot\}\}/.test(d))).toBe(true);
    expect(res.agentTasks).toEqual([]); // deferred, not bounced
  });
});

// Programmatic apply: pass every prompt answer via `inputs` and the whole skill
// runs through with no resolver and no human interaction.
const PROGRAMMATIC_SKILL = `# programmatic demo

## Collect
\`\`\`nc:prompt owner
Your name.
\`\`\`

## A human step (collected, not blocking)
Tell the user:
\`\`\`nc:operator
Go create the thing, {{owner}}.
\`\`\`

## Resolve from a command, then wire
\`\`\`nc:run capture:thing_id effect:fetch
resolve-thing {{owner}}
\`\`\`
\`\`\`nc:run effect:wire
ncl wire --owner {{owner}} --thing {{thing_id}}
\`\`\`
`;

describe('programmatic apply via inputs', () => {
  let proot: string;
  let pskill: string;
  beforeEach(() => {
    pskill = mkdtempSync(join(tmpdir(), 'nc-skill-'));
    proot = mkdtempSync(join(tmpdir(), 'nc-proj-'));
    writeFileSync(join(proot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(proot, '.env'), '');
  });

  it('runs the whole skill from inputs alone — no resolver, nothing deferred or bounced', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), PROGRAMMATIC_SKILL);
    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('resolve-thing')) return 'T-42\n';
    };
    const res = await applySkill(pskill, proot, { inputs: { owner: 'ada' }, exec });
    expect(fullyApplied(res)).toBe(true);
    expect(res.deferred).toEqual([]);
    expect(res.agentTasks).toEqual([]);
    expect(cmds).toContain('resolve-thing ada'); // prompt input flowed through
    expect(cmds).toContain('ncl wire --owner ada --thing T-42'); // captured value flowed through
    expect(res.operatorMessages).toEqual(['Go create the thing, ada.']); // human step collected for relay
  });

  it('reports a missing input as deferred — fullyApplied is false, not a crash', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), PROGRAMMATIC_SKILL);
    const res = await applySkill(pskill, proot, { inputs: {}, exec: () => {} });
    expect(fullyApplied(res)).toBe(false);
    expect(res.deferred).toContain('owner');
  });

  it('inputs win over resolveInput; resolveInput only fills the gaps', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), '# two prompts\n\n```nc:prompt a\nA?\n```\n```nc:prompt b\nB?\n```\n```nc:env-set\nA={{a}}\nB={{b}}\n```\n');
    const asked: string[] = [];
    const resolveInput = async (n: string): Promise<string> => { asked.push(n); return 'fromResolveInput'; };
    await applySkill(pskill, proot, { inputs: { a: 'fromInputs' }, resolveInput, exec: () => {} });
    const env = readFileSync(join(proot, '.env'), 'utf8');
    expect(env).toContain('A=fromInputs'); // input wins
    expect(env).toContain('B=fromResolveInput'); // resolveInput filled the gap
    expect(asked).toEqual(['b']); // 'a' was never asked — it came from inputs
  });

  it('skipEffects skips a run the caller owns (effect:restart) but runs the rest', async () => {
    writeFileSync(
      join(pskill, 'SKILL.md'),
      '# restart demo\n\n```nc:run effect:build\npnpm run build\n```\n```nc:run effect:restart\nbash setup/lib/restart.sh\n```\n```nc:run effect:wire\nncl wire\n```\n',
    );
    const cmds: string[] = [];
    const res = await applySkill(pskill, proot, { inputs: {}, skipEffects: ['restart'], exec: (c) => void cmds.push(c) });
    expect(cmds).toContain('pnpm run build');
    expect(cmds).toContain('ncl wire');
    expect(cmds).not.toContain('bash setup/lib/restart.sh'); // restart owned by the caller → skipped
    expect(res.skipped.some((s) => /run restart: owned by the caller/.test(s))).toBe(true);
  });

  it('declares the prompt validate:<re> to resolveInput via InputMeta', async () => {
    writeFileSync(join(pskill, 'SKILL.md'), '# v\n\n```nc:prompt token secret validate:^xoxb-\nPaste.\n```\n');
    let seenValidate: string | undefined;
    await applySkill(pskill, proot, {
      exec: () => {},
      resolveInput: async (_name, meta) => {
        seenValidate = meta.validate;
        return 'xoxb-ok';
      },
    });
    expect(seenValidate).toBe('^xoxb-');
  });

  it('exposes resolved non-secret vars (prompt answers + captures) but never secrets', async () => {
    writeFileSync(
      join(pskill, 'SKILL.md'),
      '# vars demo\n\n```nc:prompt token secret\nT?\n```\n```nc:prompt handle\nH?\n```\n```nc:run capture:addr\nresolve {{handle}}\n```\n',
    );
    const res = await applySkill(pskill, proot, { inputs: { token: 'SEKRET', handle: 'U9' }, exec: () => 'x:U9\n' });
    expect(res.vars.handle).toBe('U9'); // plain prompt answer exposed
    expect(res.vars.addr).toBe('x:U9'); // capture output exposed (a caller reads this)
    expect(res.vars.token).toBeUndefined(); // secret prompt NOT exposed
  });
});

// when: guards let one skill carry mutually-exclusive branches (a local vs
// remote install mode) in document order — the unmet branch is skipped, and a
// guarded prompt is skipped (not deferred) so the programmatic run still completes.
const MODE_SKILL = `# mode demo

## Pick a mode
\`\`\`nc:prompt mode
Pick local or remote.
\`\`\`

## Remote needs a server
\`\`\`nc:prompt server_url when:mode=remote
Photon server URL.
\`\`\`
\`\`\`nc:env-set when:mode=remote
IMESSAGE_SERVER_URL={{server_url}}
\`\`\`

## Local needs nothing extra
\`\`\`nc:env-set when:mode=local
IMESSAGE_LOCAL=true
\`\`\`
`;

function modeScratch(): { sdir: string; rdir: string } {
  const sdir = mkdtempSync(join(tmpdir(), 'nc-when-skill-'));
  const rdir = mkdtempSync(join(tmpdir(), 'nc-when-proj-'));
  writeFileSync(join(sdir, 'SKILL.md'), MODE_SKILL);
  writeFileSync(join(rdir, '.env'), '');
  writeFileSync(join(rdir, 'package.json'), '{"name":"scratch"}');
  return { sdir, rdir };
}

describe('when: guard', () => {
  it('local mode: the remote-guarded prompt + env-set are skipped, not deferred — fully programmatic', async () => {
    const { sdir, rdir } = modeScratch();
    const res = await applySkill(sdir, rdir, { inputs: { mode: 'local' }, exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
    expect(res.deferred).toEqual([]); // server_url was skipped by the guard, NOT deferred
    const env = readFileSync(join(rdir, '.env'), 'utf8');
    expect(env).toContain('IMESSAGE_LOCAL=true');
    expect(env).not.toContain('IMESSAGE_SERVER_URL');
    expect(res.skipped.some((s) => /when mode=remote/.test(s))).toBe(true);
  });

  it('remote mode: the remote branch applies, the local-only env-set is skipped', async () => {
    const { sdir, rdir } = modeScratch();
    const res = await applySkill(sdir, rdir, { inputs: { mode: 'remote', server_url: 'https://photon.example' }, exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
    const env = readFileSync(join(rdir, '.env'), 'utf8');
    expect(env).toContain('IMESSAGE_SERVER_URL=https://photon.example');
    expect(env).not.toContain('IMESSAGE_LOCAL');
  });

  it('a guarded prompt with no input does not defer when its guard is unmet (the programmatic-run contract)', async () => {
    const { sdir, rdir } = modeScratch();
    // local mode, server_url neither supplied nor answerable — must still complete.
    const res = await applySkill(sdir, rdir, { inputs: { mode: 'local' }, resolveInput: headless({}), exec: () => {} });
    expect(res.deferred).toEqual([]);
    expect(fullyApplied(res)).toBe(true);
  });
});

// effect:step runs a long-running, operator-interactive step (a pairing code, a
// QR device-link) through the injected streaming exec and binds the terminal
// block's named fields via capture:<var>=<FIELD>,… — the structured twin of
// stdout capture. With no streaming exec it degrades to an agent.
const STEP_SKILL = `# step demo

## Link the device
\`\`\`nc:run effect:step capture:platform_id=PLATFORM_ID,owner_handle=ADMIN_ID
pnpm exec tsx setup/index.ts --step pair-demo
\`\`\`

## Use what the step resolved
\`\`\`nc:env-set
DEMO_PLATFORM={{platform_id}}
\`\`\`
`;

function stepScratch(): { sdir: string; rdir: string } {
  const sdir = mkdtempSync(join(tmpdir(), 'nc-step-skill-'));
  const rdir = mkdtempSync(join(tmpdir(), 'nc-step-proj-'));
  writeFileSync(join(sdir, 'SKILL.md'), STEP_SKILL);
  writeFileSync(join(rdir, '.env'), '');
  writeFileSync(join(rdir, 'package.json'), '{"name":"scratch"}');
  return { sdir, rdir };
}

describe('nc:run effect:step (streaming, multi-field capture)', () => {
  it('binds the terminal block fields into vars and substitutes them downstream', async () => {
    const { sdir, rdir } = stepScratch();
    const seen: string[] = [];
    const execStream = async (cmd: string) => {
      seen.push(cmd);
      return { ok: true, fields: { STATUS: 'success', PLATFORM_ID: 'telegram:12345', ADMIN_ID: '67890' } };
    };
    const res = await applySkill(sdir, rdir, { exec: () => {}, execStream });
    expect(fullyApplied(res)).toBe(true);
    expect(seen).toEqual(['pnpm exec tsx setup/index.ts --step pair-demo']);
    expect(res.vars.platform_id).toBe('telegram:12345'); // both fields captured…
    expect(res.vars.owner_handle).toBe('67890');
    expect(readFileSync(join(rdir, '.env'), 'utf8')).toContain('DEMO_PLATFORM=telegram:12345'); // …and consumed downstream
  });

  it('degrades to an agent when no streaming exec is wired (not a crash)', async () => {
    const { sdir, rdir } = stepScratch();
    const res = await applySkill(sdir, rdir, { exec: () => {} }); // no execStream
    expect(res.agentTasks).toHaveLength(1);
    expect(res.agentTasks[0].kind).toBe('run');
    expect(res.deferred.some((d) => /platform_id/.test(d))).toBe(true); // downstream env-set then defers
  });

  it('a failed step bounces to an agent rather than capturing empty values', async () => {
    const { sdir, rdir } = stepScratch();
    const res = await applySkill(sdir, rdir, { exec: () => {}, execStream: async () => ({ ok: false, fields: {} }) });
    expect(res.agentTasks).toHaveLength(1);
    expect(res.vars.platform_id).toBeUndefined();
  });
});

// Run-health gate: once any directive bounces (a real failure, not a deferred
// prompt), the dangerous side effects — a live restart, an interactive
// pairing/QR step, a wire — must not fire on their own. They bounce too, so the
// agent finishes them from the prose after fixing the upstream failure. This is
// what stops a doomed QR / a pointless restart after a bad credential.
const GATE_SKILL = `# gate demo

## Validate the credential first
\`\`\`nc:run capture:who effect:fetch
verify-cred
\`\`\`

## Restart the service
\`\`\`nc:run effect:restart
bash restart.sh
\`\`\`

## Link the device (interactive)
\`\`\`nc:run effect:step capture:platform_id=PLATFORM_ID
pnpm exec tsx setup/index.ts --step pair
\`\`\`
`;

// A deferred prompt is NOT a failure: the headless rebuild leaves it (and its
// {{var}} consumer) unresolved, but a later restart must still be runnable.
const DEFER_THEN_RESTART_SKILL = `# defer then restart demo

## Collect a token
\`\`\`nc:prompt token secret
Paste it.
\`\`\`
\`\`\`nc:env-set
TOK={{token}}
\`\`\`

## Restart the service
\`\`\`nc:run effect:restart
bash restart.sh
\`\`\`
`;

describe('run-health gate (a bounce blocks later side effects)', () => {
  let groot: string;
  let gskill: string;
  beforeEach(() => {
    gskill = mkdtempSync(join(tmpdir(), 'nc-gate-skill-'));
    groot = mkdtempSync(join(tmpdir(), 'nc-gate-proj-'));
    writeFileSync(join(groot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(groot, '.env'), '');
  });

  it('a failed effect:fetch blocks the later restart and step — they bounce, never execute', async () => {
    writeFileSync(join(gskill, 'SKILL.md'), GATE_SKILL);
    const cmds: string[] = [];
    const streamed: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c === 'verify-cred') throw new Error('401 bad credential'); // bad cred → bounce
    };
    const execStream = async (c: string) => {
      streamed.push(c);
      return { ok: true, fields: { PLATFORM_ID: 'x' } };
    };
    const res = await applySkill(gskill, groot, { inputs: {}, exec, execStream });

    // the fetch actually ran and threw — that's the first bounce
    expect(cmds).toContain('verify-cred');
    // the restart never executed (no live restart on a bad credential)…
    expect(cmds).not.toContain('bash restart.sh');
    // …and the interactive step never spawned (no doomed QR/pairing)
    expect(streamed).toEqual([]);

    // three agent tasks: the failed fetch + the two gated side effects
    expect(res.agentTasks).toHaveLength(3);
    const gated = res.agentTasks.filter((t) => /an earlier step did not complete/.test(t.reason));
    expect(gated).toHaveLength(2); // restart + step, both bounced by the gate
  });

  // Once blocked, an operator block must not walk the human through steps the
  // run has already gated ("a pairing code is about to appear" → nothing
  // appears). No event ⇒ a consumer's URL offer / readiness confirm never
  // fires; no operatorMessages entry ⇒ a failed run's manual-steps report
  // omits steps predicated on the failure. A block BEFORE the failure still
  // renders normally.
  it('a bounce also silences later operator blocks — no event, no collected message', async () => {
    writeFileSync(
      join(gskill, 'SKILL.md'),
      [
        '# doomed walkthrough demo',
        '',
        '## Create the bot',
        '```nc:operator',
        'Make the bot first.',
        '```',
        '',
        '## Validate the credential',
        '```nc:run capture:who effect:fetch',
        'verify-cred',
        '```',
        '',
        '## Get ready to pair',
        '```nc:operator',
        'Open the bot — a pairing code is about to appear.',
        '```',
        '',
        '## Pair',
        '```nc:run effect:step capture:platform_id=PLATFORM_ID',
        'run-pair-step',
        '```',
        '',
      ].join('\n'),
    );
    const events: string[] = [];
    const res = await applySkill(gskill, groot, {
      inputs: {},
      exec: (c) => {
        if (c === 'verify-cred') throw new Error('401 bad credential');
      },
      execStream: async () => ({ ok: true, fields: { PLATFORM_ID: 'x' } }),
      onEvent: (e) => {
        if (e.type === 'operator') events.push(e.text);
      },
    });

    expect(events).toEqual(['Make the bot first.']); // pre-failure block rendered…
    expect(res.operatorMessages).toEqual(['Make the bot first.']); // …and collected
    expect(res.operatorMessages.join()).not.toContain('about to appear'); // doomed block silenced
    expect(res.skipped).toContain('operator: skipped after an earlier failure');
    expect(res.agentTasks.some((t) => /an earlier step did not complete/.test(t.reason))).toBe(true); // step still gated
  });

  it('a deferred prompt does NOT block a later restart (headless rebuild stays runnable)', async () => {
    writeFileSync(join(gskill, 'SKILL.md'), DEFER_THEN_RESTART_SKILL);
    const cmds: string[] = [];
    const res = await applySkill(gskill, groot, { resolveInput: headless({}), exec: (c) => void cmds.push(c) });

    // the prompt and its consumer deferred (no answer headless) — not a failure
    expect(res.deferred).toContain('token');
    expect(res.deferred.some((d) => /unresolved \{\{token\}\}/.test(d))).toBe(true);
    expect(readFileSync(join(groot, '.env'), 'utf8')).not.toContain('TOK=');

    // the restart still runs, and nothing bounced
    expect(cmds).toContain('bash restart.sh');
    expect(res.agentTasks).toEqual([]);
  });
});

// effect:check runs the body as a shell PREDICATE — a precondition gate that
// mutates NOTHING (no journal, no capture). A non-zero exit bounces to an agent
// AND latches `blocked`, so a following dangerous side effect (a restart) is
// gated. An unresolved {{var}} defers (a headless rebuild before the value is
// collected). A zero exit is a silent pass.
const CHECK_GATE_SKILL = `# check gate demo

## Require macOS for local mode
\`\`\`nc:run effect:check
[ "$(uname)" = Darwin ]
\`\`\`

## Restart the service
\`\`\`nc:run effect:restart
bash restart.sh
\`\`\`
`;

const CHECK_VAR_SKILL = `# check var demo

## Collect the linked number
\`\`\`nc:prompt bot_phone
The linked number.
\`\`\`

## Guard the captured value before using it
\`\`\`nc:run effect:check
[ -n "{{bot_phone}}" ]
\`\`\`
`;

const CHECK_PASS_SKILL = `# check pass demo

## A precondition that passes
\`\`\`nc:run effect:check
true
\`\`\`
`;

describe('nc:run effect:check (precondition gate)', () => {
  let chkSkill: string;
  let chkRoot: string;
  beforeEach(() => {
    chkSkill = mkdtempSync(join(tmpdir(), 'nc-check-skill-'));
    chkRoot = mkdtempSync(join(tmpdir(), 'nc-check-proj-'));
    writeFileSync(join(chkRoot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(chkRoot, '.env'), '');
  });

  it('a non-zero check bounces to an agent and gates a following effect:restart', async () => {
    writeFileSync(join(chkSkill, 'SKILL.md'), CHECK_GATE_SKILL);
    const cmds: string[] = [];
    const exec = (c: string): string | void => {
      cmds.push(c);
      if (c.startsWith('[')) throw new Error('exit 1'); // predicate failed (non-zero)
    };
    const res = await applySkill(chkSkill, chkRoot, { inputs: {}, exec });

    expect(cmds).toContain('[ "$(uname)" = Darwin ]'); // the predicate actually ran
    expect(cmds).not.toContain('bash restart.sh'); // restart never executed — gated by the failed check
    // two agent tasks: the failed check itself + the gated restart
    expect(res.agentTasks).toHaveLength(2);
    expect(res.agentTasks[0].kind).toBe('run');
    expect(res.agentTasks.some((t) => /an earlier step did not complete/.test(t.reason))).toBe(true);
    expect(res.journal).toEqual([]); // a check mutates nothing
  });

  it('an unresolved {{var}} in a check defers (headless rebuild) — not a bounce', async () => {
    writeFileSync(join(chkSkill, 'SKILL.md'), CHECK_VAR_SKILL);
    const cmds: string[] = [];
    const res = await applySkill(chkSkill, chkRoot, { resolveInput: headless({}), exec: (c) => void cmds.push(c) });

    expect(res.deferred).toContain('bot_phone'); // the prompt deferred (no headless answer)
    expect(res.deferred.some((d) => /unresolved \{\{bot_phone\}\}/.test(d))).toBe(true); // the check deferred on it
    expect(res.agentTasks).toEqual([]); // a deferred check is NOT a failure — no bounce
    expect(cmds.some((c) => c.startsWith('['))).toBe(false); // the predicate never ran (var unresolved)
  });

  it('a zero-exit check is a no-op — no journal entry, no bounce, no defer', async () => {
    writeFileSync(join(chkSkill, 'SKILL.md'), CHECK_PASS_SKILL);
    const cmds: string[] = [];
    const res = await applySkill(chkSkill, chkRoot, { inputs: {}, exec: (c) => void cmds.push(c) });

    expect(cmds).toContain('true'); // the predicate ran
    expect(res.journal).toEqual([]); // mutated nothing — no 'ran' entry
    expect(res.agentTasks).toEqual([]);
    expect(res.deferred).toEqual([]);
  });

  it('lint accepts a check that guards an earlier-defined var', () => {
    expect(validate(parseDirectives(CHECK_VAR_SKILL))).toEqual([]);
  });
});

// A two-step skill for the event suite below: one effectful run (heading label)
// and one instant env-set (null label).
const EVENT_SKILL = `# event demo

## Verify the credential
\`\`\`nc:run effect:fetch
verify-cred
\`\`\`

## Store it
\`\`\`nc:env-set
DEMO=ok
\`\`\`
`;

// The core event seam: every engine emission flows through `onEvent`. Step
// events bracket each real mutation (applyOne) — an effectful step (a run, a
// dep, a branch-fetch copy) carries a heading-derived label, an instant step
// null; operator events carry the rendered ({{var}}-substituted) block body +
// the directive's opening-fence line. Every call is AWAITED before the engine
// proceeds — the ordering guarantee a consumer's gating is built on — and a
// handler throw is treated like any other throw at that directive: bounce,
// never crash, never a silent drop.
describe('onEvent (core event seam)', () => {
  let eroot: string;
  let eskill: string;
  beforeEach(() => {
    eskill = mkdtempSync(join(tmpdir(), 'nc-ev-skill-'));
    eroot = mkdtempSync(join(tmpdir(), 'nc-ev-proj-'));
    writeFileSync(join(eroot, '.env'), '');
    writeFileSync(join(eroot, 'package.json'), '{"name":"scratch"}');
  });

  it('fires step-start/step-end brackets in document order; effectful label, instant null', async () => {
    writeFileSync(join(eskill, 'SKILL.md'), EVENT_SKILL);
    const events: ApplyEvent[] = [];
    await applySkill(eskill, eroot, { exec: () => {}, onEvent: (e) => void events.push(e) });

    expect(events.map((e) => `${e.type}:${'kind' in e ? e.kind : ''}`)).toEqual([
      'step-start:run', 'step-end:run', 'step-start:env-set', 'step-end:env-set',
    ]);
    const start = events[0] as Extract<ApplyEvent, { type: 'step-start' }>;
    expect(start.label).toBe('Verify the credential'); // heading-derived
    expect(typeof start.line).toBe('number');
    const end = events[1] as Extract<ApplyEvent, { type: 'step-end' }>;
    expect(end.ok).toBe(true);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
    expect((events[2] as Extract<ApplyEvent, { type: 'step-start' }>).label).toBe(null); // instant env-set
  });

  it('closes a failed step with step-end ok=false + error — start/end always balanced', async () => {
    writeFileSync(join(eskill, 'SKILL.md'), EVENT_SKILL);
    const events: ApplyEvent[] = [];
    const exec = (c: string): void => {
      if (c === 'verify-cred') throw new Error('401 bad credential');
    };
    const res = await applySkill(eskill, eroot, { exec, onEvent: (e) => void events.push(e) });

    const end = events.find((e): e is Extract<ApplyEvent, { type: 'step-end' }> => e.type === 'step-end' && e.kind === 'run')!;
    expect(end.ok).toBe(false);
    expect(end.error).toMatch(/401 bad credential/);
    expect(events.filter((e) => e.type === 'step-start')).toHaveLength(events.filter((e) => e.type === 'step-end').length);
    expect(res.agentTasks).toHaveLength(1); // degraded to an agent, not a crash
  });

  it('emits an operator event with the rendered text + fence line, after collecting operatorMessages', async () => {
    const md = '# op\n\n```nc:prompt who\nName?\n```\nTell the user:\n```nc:operator\nHello {{who}} — go click the button.\n```\n';
    writeFileSync(join(eskill, 'SKILL.md'), md);
    const opLine = parseDirectives(md).find((d) => d.kind === 'operator')!.line;
    const events: ApplyEvent[] = [];
    const res = await applySkill(eskill, eroot, { inputs: { who: 'world' }, exec: () => {}, onEvent: (e) => void events.push(e) });

    const op = events.find((e): e is Extract<ApplyEvent, { type: 'operator' }> => e.type === 'operator')!;
    expect(op.text).toBe('Hello world — go click the button.'); // {{var}} substituted
    expect(op.line).toBe(opLine); // keyed on the opening-fence line (driver policy maps)
    expect(res.operatorMessages).toEqual(['Hello world — go click the button.']); // still collected in the result
  });

  it('awaits each onEvent before evaluating the next directive (async handler ordering)', async () => {
    writeFileSync(
      join(eskill, 'SKILL.md'),
      '# order\n\nTell the user:\n```nc:operator\nDo the manual thing first.\n```\n\n## Build\n```nc:run effect:build\npnpm run build\n```\n',
    );
    const seq: string[] = [];
    const onEvent = async (e: ApplyEvent): Promise<void> => {
      await new Promise((r) => setTimeout(r, 5)); // if the engine did not await, exec would land first
      seq.push(`event:${e.type}`);
    };
    await applySkill(eskill, eroot, { inputs: {}, exec: (c) => void seq.push(`exec:${c}`), onEvent });
    expect(seq).toEqual(['event:operator', 'event:step-start', 'exec:pnpm run build', 'event:step-end']);
  });

  it('a handler throw on a step event bounces that directive (degrade, not crash)', async () => {
    writeFileSync(join(eskill, 'SKILL.md'), EVENT_SKILL);
    const res = await applySkill(eskill, eroot, {
      exec: () => {},
      onEvent: (e) => {
        if (e.type === 'step-start' && e.kind === 'run') throw new Error('consumer exploded');
      },
    });
    expect(res.agentTasks.some((t) => t.kind === 'run' && /consumer exploded/.test(t.reason))).toBe(true);
  });

  it('a handler throw on an OPERATOR event bounces too — and the blocked latch gates a later side effect', async () => {
    writeFileSync(
      join(eskill, 'SKILL.md'),
      '# op throw\n\nTell the user:\n```nc:operator\nDo the thing.\n```\n\n## Restart\n```nc:run effect:restart\nbash restart.sh\n```\n',
    );
    const cmds: string[] = [];
    const res = await applySkill(eskill, eroot, {
      inputs: {},
      exec: (c) => void cmds.push(c),
      onEvent: (e) => {
        if (e.type === 'operator') throw new Error('relay failed');
      },
    });
    expect(res.operatorMessages).toEqual(['Do the thing.']); // collected before the emit (unchanged)
    expect(res.agentTasks.some((t) => t.kind === 'operator' && /relay failed/.test(t.reason))).toBe(true);
    expect(cmds).not.toContain('bash restart.sh'); // the consumer accepted the bounce consequence…
    expect(res.agentTasks.some((t) => /an earlier step did not complete/.test(t.reason))).toBe(true); // …incl. the cascade
  });

  it('no onEvent ⇒ silent — the headless/programmatic apply still completes', async () => {
    writeFileSync(join(eskill, 'SKILL.md'), EVENT_SKILL);
    const res = await applySkill(eskill, eroot, { exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
  });
});

describe('stepLabel', () => {
  it('labels effectful kinds from the nearest heading, instant kinds null; step is silent', () => {
    const md = [
      '# s', '',
      '## Install deps', '```nc:dep', 'pkg@1.0.0', '```', '',
      '## Copy a file', '```nc:copy', 'a -> b', '```', '',
      '## Pull from the branch', '```nc:copy from-branch:channels', 'x -> y', '```', '',
      '## Link the device', '```nc:run effect:step capture:platform_id=PLATFORM_ID', 'pair', '```', '',
      '## Wire it', '```nc:run effect:wire', 'ncl wire', '```',
    ].join('\n');
    const ds = parseDirectives(md);
    const nth = (k: string, i = 0) => ds.filter((d) => d.kind === k)[i];
    expect(stepLabel(nth('dep'), md)).toBe('Install deps');               // heading-derived
    expect(stepLabel(nth('copy', 0), md)).toBe(null);                     // local copy = instant
    expect(stepLabel(nth('copy', 1), md)).toBe('Pull from the branch');   // from-branch fetch spins
    expect(stepLabel(nth('run', 0), md)).toBe(null);                      // effect:step renders its own live output
    expect(stepLabel(nth('run', 1), md)).toBe('Wire it');                 // heading-derived only — no attr override
  });

  it('falls back to a kind/effect default when there is no heading above the fence', () => {
    const ds = parseDirectives('```nc:run effect:build\npnpm run build\n```\n');
    expect(stepLabel(ds[0], '```nc:run effect:build\npnpm run build\n```\n')).toBe('Building');
  });
});

// firstFailureHint surfaces the prose beside the FIRST bounced directive as the
// operator's failure hint (the setup driver threads it into fail() + the Claude
// handoff). The hint IS the surrounding prose — the same text an agent reads to
// apply the step (prose-primary: a stripped fence leaves the same diagnosis).
const FAIL_HINT_SKILL = `# connect demo

## Verify the credential
The bot token must be valid. If auth.test fails, the token is wrong or the app isn't installed in the workspace.
\`\`\`nc:hand-verify
check the token
\`\`\`
`;

const NO_BOUNCE_SKILL = `# prompt only

## Collect a token
\`\`\`nc:prompt token secret
Paste it.
\`\`\`
`;

describe('firstFailureHint', () => {
  let froot: string;
  let fskill: string;
  beforeEach(() => {
    fskill = mkdtempSync(join(tmpdir(), 'nc-fh-skill-'));
    froot = mkdtempSync(join(tmpdir(), 'nc-fh-proj-'));
    writeFileSync(join(froot, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(froot, '.env'), '');
  });

  it('returns the heading as a headline and the bounced step prose as the hint', async () => {
    writeFileSync(join(fskill, 'SKILL.md'), FAIL_HINT_SKILL);
    const res = await applySkill(fskill, froot, { inputs: {}, exec: () => {} });
    expect(res.agentTasks).toHaveLength(1); // the unknown directive bounced
    const diag = firstFailureHint(res);
    expect(diag?.headline).toBe('Verify the credential'); // the section heading, # stripped
    expect(diag?.hint).toContain('the token is wrong'); // the prose beside the step
    // hint ≡ prose: the diagnosis IS the bounced task's own trimmed prose
    expect(diag?.hint).toBe(res.agentTasks[0].prose.trim());
  });

  it('returns undefined when nothing bounced (a deferred prompt is not a failure)', async () => {
    writeFileSync(join(fskill, 'SKILL.md'), NO_BOUNCE_SKILL);
    const res = await applySkill(fskill, froot, { resolveInput: headless({}), exec: () => {} });
    expect(res.deferred).toContain('token'); // deferred, not bounced
    expect(res.agentTasks).toEqual([]);
    expect(firstFailureHint(res)).toBeUndefined();
  });
});

// `nc:prompt normalize:<how>` is applied DETERMINISTICALLY at engine bind — to
// BOTH an `inputs` value and a resolveInput answer — so they land identically.
// validate/flags/normalize are DECLARED to the consumer via InputMeta (their
// interactive enforcement is asserted in skill-driver.test.ts against
// promptValidator).
const NORMALIZE_SKILL = `# normalize demo

## Collect a base URL
\`\`\`nc:prompt public_url normalize:rstrip-slash
Paste your base URL.
\`\`\`
\`\`\`nc:env-set
PUBLIC_URL={{public_url}}
\`\`\`
`;

describe('nc:prompt normalize at bind + InputMeta declaration', () => {
  let nroot: string;
  let nskill: string;
  beforeEach(() => {
    nskill = mkdtempSync(join(tmpdir(), 'nc-opts-skill-'));
    nroot = mkdtempSync(join(tmpdir(), 'nc-opts-proj-'));
    writeFileSync(join(nskill, 'SKILL.md'), NORMALIZE_SKILL);
    writeFileSync(join(nroot, '.env'), '');
    writeFileSync(join(nroot, 'package.json'), '{"name":"scratch"}');
  });

  it('normalize:rstrip-slash strips a trailing slash on an inputs value (bound + consumed downstream)', async () => {
    const res = await applySkill(nskill, nroot, { inputs: { public_url: 'https://x.ngrok.io/' }, exec: () => {} });
    expect(res.vars.public_url).toBe('https://x.ngrok.io'); // slash stripped at bind
    expect(readFileSync(join(nroot, '.env'), 'utf8')).toContain('PUBLIC_URL=https://x.ngrok.io');
  });

  it('normalize:rstrip-slash strips a trailing slash on an interactive answer too (same bind path)', async () => {
    const res = await applySkill(nskill, nroot, { resolveInput: headless({ public_url: 'https://x.ngrok.io/' }), exec: () => {} });
    expect(res.vars.public_url).toBe('https://x.ngrok.io'); // identical to the inputs path
    expect(readFileSync(join(nroot, '.env'), 'utf8')).toContain('PUBLIC_URL=https://x.ngrok.io');
  });

  it('declares validate/flags/normalize to resolveInput via InputMeta, then normalizes the answer at bind', async () => {
    writeFileSync(
      join(nskill, 'SKILL.md'),
      '# o\n\n```nc:prompt url validate:^https?:// flags:i normalize:rstrip-slash\nURL?\n```\n',
    );
    let seen: InputMeta | undefined;
    const res = await applySkill(nskill, nroot, {
      exec: () => {},
      resolveInput: async (_n, meta) => {
        seen = meta;
        return 'HTTPS://x.io/'; // the consumer returns the raw answer; the engine normalizes
      },
    });
    expect(seen).toMatchObject({ validate: '^https?://', flags: 'i', normalize: 'rstrip-slash' });
    // normalize applied at bind (trailing slash gone); case preserved (lower not set)
    expect(res.vars.url).toBe('HTTPS://x.io');
  });

  it('normalize:lower and trim also bind deterministically', async () => {
    writeFileSync(
      join(nskill, 'SKILL.md'),
      '# n\n\n```nc:prompt a normalize:lower\nA?\n```\n```nc:prompt b normalize:trim\nB?\n```\n',
    );
    const res = await applySkill(nskill, nroot, { inputs: { a: 'MixedCASE', b: '  spaced  ' }, exec: () => {} });
    expect(res.vars.a).toBe('mixedcase');
    expect(res.vars.b).toBe('spaced');
  });
});

// The core input seam: the engine hands `resolveInput` the prompt's DECLARED
// semantics (InputMeta) so a consumer can run its own re-ask loop (clack
// validate, a chat exchange); returning undefined defers. `inputs` win over it.
describe('resolveInput (core input seam)', () => {
  let iroot: string;
  let iskill: string;
  beforeEach(() => {
    iskill = mkdtempSync(join(tmpdir(), 'nc-ri-skill-'));
    iroot = mkdtempSync(join(tmpdir(), 'nc-ri-proj-'));
    writeFileSync(join(iroot, '.env'), '');
    writeFileSync(join(iroot, 'package.json'), '{"name":"scratch"}');
  });

  it('receives the declared InputMeta — question verbatim, secret, validate, flags, normalize', async () => {
    writeFileSync(
      join(iskill, 'SKILL.md'),
      '# m\n\n```nc:prompt url secret validate:^https?:// flags:i normalize:rstrip-slash\nPaste the URL.\nIt must be the public base.\n```\n',
    );
    let seenName: string | undefined;
    let seen: InputMeta | undefined;
    const res = await applySkill(iskill, iroot, {
      exec: () => {},
      resolveInput: async (name, meta) => {
        seenName = name;
        seen = meta;
        return 'HTTPS://x.io/';
      },
    });
    expect(seenName).toBe('url');
    expect(seen).toEqual({
      question: 'Paste the URL.\nIt must be the public base.', // the body verbatim (multi-line intact)
      secret: true,
      validate: '^https?://',
      flags: 'i',
      normalize: 'rstrip-slash',
    });
    expect(res.deferred).toEqual([]); // the answer passed validate (flags honored) after normalize
    expect(res.vars.url).toBeUndefined(); // secret — never exposed
  });

  it('binds the answer through normalize at the same bind point as inputs', async () => {
    writeFileSync(join(iskill, 'SKILL.md'), '# n\n\n```nc:prompt base normalize:rstrip-slash\nBase URL?\n```\n');
    const res = await applySkill(iskill, iroot, { exec: () => {}, resolveInput: async () => 'https://x.io/' });
    expect(res.vars.base).toBe('https://x.io');
  });

  it('undefined ⇒ defer, recorded as the bare var name (unchanged semantics)', async () => {
    writeFileSync(join(iskill, 'SKILL.md'), '# d\n\n```nc:prompt token secret\nPaste it.\n```\n');
    const res = await applySkill(iskill, iroot, { exec: () => {}, resolveInput: async () => undefined });
    expect(res.deferred).toEqual(['token']);
  });

  it('is consulted only for vars `inputs` did not pre-supply — inputs win', async () => {
    writeFileSync(join(iskill, 'SKILL.md'), '# p\n\n```nc:prompt a\nA?\n```\n```nc:prompt b\nB?\n```\n');
    const resolved: string[] = [];
    const res = await applySkill(iskill, iroot, {
      inputs: { a: 'fromInputs' },
      exec: () => {},
      resolveInput: async (n) => {
        resolved.push(n);
        return 'fromResolveInput';
      },
    });
    expect(res.vars.a).toBe('fromInputs'); // inputs win
    expect(res.vars.b).toBe('fromResolveInput'); // resolveInput fills the gap
    expect(resolved).toEqual(['b']); // 'a' was never asked
  });
});

// Validate-at-bind: `validate:` (+ `flags:`) is DATA validation the ENGINE
// enforces on the NORMALIZED value at the single bind point — for `inputs` and
// resolveInput answers alike. A mismatch leaves the var UNBOUND and records
// `<var>: invalid value (does not match validate:<re>)` in `deferred` — not an
// agentTask, not a throw — so downstream consumers defer exactly as if the
// value were never supplied, and a pipeline passing a malformed env value fails
// loudly via fullyApplied=false. The value itself never lands in the entry (a
// secret can't leak). run-capture validate is unchanged (it throws → bounces).
const VALIDATE_BIND_SKILL = `# vb demo

## Collect the member id
\`\`\`nc:prompt owner_handle validate:^U[A-Z0-9]{8,}$
Your member id (starts with U).
\`\`\`
\`\`\`nc:env-set
OWNER={{owner_handle}}
\`\`\`
`;

describe('validate-at-bind (inputs + resolveInput answers)', () => {
  let vroot: string;
  let vskill: string;
  beforeEach(() => {
    vskill = mkdtempSync(join(tmpdir(), 'nc-vb-skill-'));
    vroot = mkdtempSync(join(tmpdir(), 'nc-vb-proj-'));
    writeFileSync(join(vskill, 'SKILL.md'), VALIDATE_BIND_SKILL);
    writeFileSync(join(vroot, '.env'), '');
    writeFileSync(join(vroot, 'package.json'), '{"name":"scratch"}');
  });

  it('rejects an invalid inputs value: var unbound, exact deferred entry, downstream defers, fullyApplied false', async () => {
    const res = await applySkill(vskill, vroot, { inputs: { owner_handle: 'U1' }, exec: () => {} });
    expect(res.deferred).toContain('owner_handle: invalid value (does not match validate:^U[A-Z0-9]{8,}$)');
    expect(res.vars.owner_handle).toBeUndefined(); // the var stayed unbound
    expect(res.deferred.some((d) => /unresolved \{\{owner_handle\}\}/.test(d))).toBe(true); // env-set deferred on it
    expect(res.agentTasks).toEqual([]); // deferred, never bounced (a re-run with a fixed value completes)
    expect(fullyApplied(res)).toBe(false); // the loud pipeline failure
    expect(readFileSync(join(vroot, '.env'), 'utf8')).not.toContain('OWNER=');
  });

  it('a valid inputs value binds exactly as before', async () => {
    const res = await applySkill(vskill, vroot, { inputs: { owner_handle: 'U12345678' }, exec: () => {} });
    expect(fullyApplied(res)).toBe(true);
    expect(res.vars.owner_handle).toBe('U12345678');
    expect(readFileSync(join(vroot, '.env'), 'utf8')).toContain('OWNER=U12345678');
  });

  it('rejects an invalid resolveInput answer the same way (the programmatic backstop)', async () => {
    const res = await applySkill(vskill, vroot, { exec: () => {}, resolveInput: async () => 'not-a-handle' });
    expect(res.deferred).toContain('owner_handle: invalid value (does not match validate:^U[A-Z0-9]{8,}$)');
    expect(res.vars.owner_handle).toBeUndefined();
    expect(fullyApplied(res)).toBe(false);
  });

  it('validates the NORMALIZED value — normalize-then-validate is the order (teams public_url authoring)', async () => {
    writeFileSync(
      join(vskill, 'SKILL.md'),
      '# nv\n\n```nc:prompt base_url validate:^https://[a-z.]+$ normalize:rstrip-slash\nBase URL?\n```\n',
    );
    // the RAW value ends with a slash and would fail the anchored regex; the
    // normalized one passes — proving normalize runs first.
    const res = await applySkill(vskill, vroot, { inputs: { base_url: 'https://x.io/' }, exec: () => {} });
    expect(res.deferred).toEqual([]);
    expect(res.vars.base_url).toBe('https://x.io');
  });

  it('an invalid inputs value does NOT fall through to resolveInput — inputs win outright, loudly', async () => {
    const resolved: string[] = [];
    const res = await applySkill(vskill, vroot, {
      inputs: { owner_handle: 'bad' },
      exec: () => {},
      resolveInput: async (n) => {
        resolved.push(n);
        return 'U12345678';
      },
    });
    expect(resolved).toEqual([]); // never a surprise second acquisition path
    expect(res.deferred).toContain('owner_handle: invalid value (does not match validate:^U[A-Z0-9]{8,}$)');
    expect(res.vars.owner_handle).toBeUndefined();
  });

  it('a secret value never appears in the deferred entry — only the var name + regex source', async () => {
    writeFileSync(join(vskill, 'SKILL.md'), '# s\n\n```nc:prompt token secret validate:^xoxb-\nPaste the bot token.\n```\n');
    const res = await applySkill(vskill, vroot, { inputs: { token: 'SUPER-SECRET-VALUE' }, exec: () => {} });
    expect(res.deferred).toContain('token: invalid value (does not match validate:^xoxb-)');
    expect(JSON.stringify(res)).not.toContain('SUPER-SECRET-VALUE');
  });

  it('honors flags: at bind (case-insensitive match passes)', async () => {
    writeFileSync(join(vskill, 'SKILL.md'), '# f\n\n```nc:prompt h validate:^u[a-z0-9]{8,}$ flags:i\nHandle?\n```\n');
    const res = await applySkill(vskill, vroot, { inputs: { h: 'U12345678' }, exec: () => {} });
    expect(res.deferred).toEqual([]);
    expect(res.vars.h).toBe('U12345678');
  });

});

// referenceProse slices the author-written reference FLOOR — the engine-ignored
// `## Alternatives`, `## Optional configuration`, `## Troubleshooting` sections —
// out of the raw markdown, keeping their ### subsections and plain bash/json
// fences but dropping any stray nc: directive fence. Keyed on the author headings
// (never the resolved {{var}} map), so a {{secret}} placeholder can never leak in.
const REFERENCE_SKILL = `# demo

Intro prose that is NOT reference floor.

## Apply

### 1. Build it
\`\`\`nc:run effect:build
pnpm run build
\`\`\`

## Alternatives

### Use a dedicated number
Register a number instead of linking.
\`\`\`bash
signal-cli -a +1 register
\`\`\`

## Optional configuration
Tune the daemon.
\`\`\`bash
SIGNAL_TCP_HOST=127.0.0.1
\`\`\`

## Channel Info
- type: demo

## Troubleshooting

### Bot not responding
Check the logs.
\`\`\`bash
grep demo logs/nanoclaw.log
\`\`\`
`;

describe('referenceProse (reference-floor slice)', () => {
  it('slices the three reference headings (with ### subsections + plain fences) in document order', () => {
    const ref = referenceProse(REFERENCE_SKILL);
    expect(ref).toContain('## Alternatives');
    expect(ref).toContain('Register a number instead of linking.');
    expect(ref).toContain('signal-cli -a +1 register'); // a plain bash fence is kept
    expect(ref).toContain('## Optional configuration');
    expect(ref).toContain('SIGNAL_TCP_HOST=127.0.0.1');
    expect(ref).toContain('## Troubleshooting');
    expect(ref).toContain('### Bot not responding'); // a ### subsection is kept
    expect(ref).toContain('grep demo logs/nanoclaw.log');
    // non-reference sections are never included
    expect(ref).not.toContain('## Apply');
    expect(ref).not.toContain('## Channel Info');
    expect(ref).not.toContain('Intro prose');
    // document order: Alternatives, then Optional configuration, then Troubleshooting
    expect(ref.indexOf('## Alternatives')).toBeLessThan(ref.indexOf('## Optional configuration'));
    expect(ref.indexOf('## Optional configuration')).toBeLessThan(ref.indexOf('## Troubleshooting'));
  });

  it('drops nc: directive fences and never resolves a {{secret}} placeholder (no leak)', () => {
    // A Troubleshooting section that (pathologically) carries an nc: fence and a
    // {{token}} placeholder: the nc: block is dropped wholesale, while the literal
    // placeholder stays literal — referenceProse keys on raw author text, not vars.
    const md = [
      '# s', '',
      '## Apply', '```nc:prompt token secret', 'Paste it.', '```', '',
      '## Troubleshooting', 'If it fails, confirm {{token}} was written.',
      '```nc:run effect:restart', 'bash restart.sh', '```',
      '```bash', 'grep TOK .env', '```', '',
    ].join('\n');
    const ref = referenceProse(md);
    expect(ref).toContain('## Troubleshooting');
    expect(ref).toContain('grep TOK .env'); // the plain fence survives
    expect(ref).not.toContain('bash restart.sh'); // the nc: fence body is dropped…
    expect(ref).not.toContain('nc:run'); // …along with its opening fence line
    expect(ref).toContain('{{token}}'); // the placeholder is never resolved to a secret value
  });

  it('returns empty for a skill with no reference sections', () => {
    expect(referenceProse('# only apply\n\n## Apply\n```nc:run effect:build\npnpm run build\n```\n')).toBe('');
  });

  it('is carried on ApplyResult.referenceProse through a real apply', async () => {
    const sdir = mkdtempSync(join(tmpdir(), 'nc-ref-skill-'));
    const rdir = mkdtempSync(join(tmpdir(), 'nc-ref-proj-'));
    writeFileSync(join(rdir, 'package.json'), '{"name":"scratch"}');
    writeFileSync(join(rdir, '.env'), '');
    writeFileSync(join(sdir, 'SKILL.md'), REFERENCE_SKILL);
    const res = await applySkill(sdir, rdir, { inputs: {}, exec: () => {} });
    expect(res.referenceProse).toContain('## Troubleshooting');
    expect(res.referenceProse).toContain('## Alternatives');
    expect(res.referenceProse).not.toContain('## Apply');
  });
});
