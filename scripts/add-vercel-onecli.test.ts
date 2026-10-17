// Behavior tests for /add-vercel's OneCLI steps: the shell blocks that attach the
// Vercel secret to the groups the user chose (SKILL.md) and take it away again
// (REMOVE.md).
//
// The blocks are taken out of the documents and run under `sh` against stub
// `onecli` and `ncl` binaries that log every call, so the assertions read the
// exact commands the skill issues. New groups get only their model credential,
// so Vercel is opt-in per group; OneCLI 1.44+ answers `410 Gone` on the old
// per-agent list API, and its CLI lists 20 rows unless asked for all.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SKILL_DIR = path.resolve(__dirname, '../.claude/skills/add-vercel');

/** The first ```bash block after `heading` in `file`, skipping `skip` blocks. */
function block(file: string, heading: string, skip = 0): string {
  const doc = fs.readFileSync(path.join(SKILL_DIR, file), 'utf8');
  const start = doc.indexOf(heading);
  if (start < 0) throw new Error(`${file}: heading not found: ${heading}`);
  const blocks = [...doc.slice(start).matchAll(/```bash\n([\s\S]*?)```/g)];
  if (!blocks[skip]) throw new Error(`${file}: no bash block ${skip} after ${heading}`);
  return blocks[skip][1];
}

const ATTACH = block('SKILL.md', '### Attach the secret to the groups that use Vercel', 1);
const DETACH = block('REMOVE.md', '## 3. Remove the OneCLI credential');
const chosen = (groups: string) => ATTACH.replace(/^VERCEL_GROUPS=.*$/m, `VERCEL_GROUPS="${groups}"`);

let root: string;
let calls: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-vercel-onecli-'));
  calls = path.join(root, 'calls.log');
  fs.writeFileSync(calls, '');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'onecli'),
    `#!/usr/bin/env bash
echo "onecli $*" >> "$CALLS"
case "$1 $2" in
  "secrets list") [ "$3 $4" = "--max 0" ] || exit 7; echo '{"hint":"h","data":[{"id":"sec-model","name":"Anthropic"},{"id":"sec-vercel","name":"Vercel API Token"}]}' ;;
  "agents list") [ "$3 $4" = "--max 0" ] || exit 7; echo '{"hint":"h","data":[{"id":"oc-default","identifier":"default","isDefault":true},{"id":"oc-sales","identifier":"ag-sales"},{"id":"oc-ops","identifier":"ag-ops"}]}' ;;
  "agents create") echo '{"hint":"h","id":"oc-new"}' ;;
  "agents secrets"|"agents set-secrets") echo '{"error":"removed","code":"GONE"}'; exit 1 ;;
  *) echo '{}' ;;
esac
`,
    { mode: 0o755 },
  );
  fs.writeFileSync(
    path.join(bin, 'ncl'),
    `#!/usr/bin/env bash
echo "ncl $*" >> "$CALLS"
echo '{"data":[{"id":"ag-sales","name":"Sales"},{"id":"ag-ops","name":"Ops"},{"id":"ag-new","name":"New Group"}]}'
`,
    { mode: 0o755 },
  );
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(script: string) {
  const r = spawnSync('sh', ['-c', script], {
    cwd: root,
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, CALLS: calls },
    encoding: 'utf8',
  });
  return { status: r.status, stderr: r.stderr, lines: fs.readFileSync(calls, 'utf8').trim().split('\n') };
}

describe('/add-vercel OneCLI steps', () => {
  it('attaches the Vercel secret only to the chosen groups', () => {
    const { status, lines } = run(chosen('ag-sales'));
    expect(status).toBe(0);
    expect(lines.filter((l) => l.includes('grants attach-secret'))).toEqual([
      'onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel',
    ]);
  });

  it('creates the OneCLI agent for a chosen group that has not run yet, then attaches', () => {
    const { status, lines } = run(chosen('ag-ops,ag-new'));
    expect(status).toBe(0);
    expect(lines).toContain('onecli agents create --name New Group --identifier ag-new');
    expect(lines).toContain('onecli agents grants attach-secret --id oc-new --secret-id sec-vercel');
    expect(lines).toContain('onecli agents grants attach-secret --id oc-ops --secret-id sec-vercel');
    expect(lines.filter((l) => l.startsWith('onecli agents create'))).toHaveLength(1);
  });

  it('refuses an unknown group id before attaching anything', () => {
    const { status, stderr, lines } = run(chosen('ag-nope'));
    expect(status).not.toBe(0);
    expect(stderr).toContain("unknown agent group 'ag-nope'");
    expect(lines.some((l) => l.includes('attach-secret'))).toBe(false);
  });

  it('a re-run with the secret already stored still goes through group selection', () => {
    const doc = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
    const skip = doc.split('\n').find((l) => l.startsWith('If a Vercel credential already exists'));
    expect(skip).toContain('#attach-the-secret-to-the-groups-that-use-vercel');
    expect(skip).not.toMatch(/Phase 4/);
  });

  it('removal detaches the Vercel secret from every agent, then deletes it', () => {
    const { lines } = run(DETACH);
    for (const id of ['oc-default', 'oc-sales', 'oc-ops'])
      expect(lines).toContain(`onecli agents grants detach-secret --id ${id} --secret-id sec-vercel`);
    expect(lines.at(-1)).toBe('onecli secrets delete --id sec-vercel');
  });

  it.each([
    ['apply', chosen('ag-sales')],
    ['removal', DETACH],
  ])('%s lists every row and never uses the per-agent list API that OneCLI 1.44+ removed', (_name, script) => {
    const { status, lines } = run(script);
    expect(status).toBe(0);
    expect(lines.some((l) => /onecli agents (set-secrets|secrets)\b/.test(l))).toBe(false);
    expect(lines.filter((l) => / list\b/.test(l) && l.startsWith('onecli')).every((l) => l.endsWith('--max 0'))).toBe(
      true,
    );
  });
});
