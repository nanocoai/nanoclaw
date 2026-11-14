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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const MODEL = { id: 'sec-model', name: 'Anthropic', hostPattern: 'api.anthropic.com', preview: 'sk-a...PREVIEW' };
const VERCEL = {
  id: 'sec-vercel',
  name: 'Vercel API Token',
  hostPattern: 'api.vercel.com',
  createdAt: '2026-10-01T10:00:00Z',
  preview: 'vcp_...PREVIEW',
};
const VERCEL_2 = { ...VERCEL, id: 'sec-vercel-2', name: 'Vercel work', createdAt: '2026-10-18T09:00:00Z' };

let root: string;
let calls: string;
/** What `onecli secrets list` prints. */
const vault = (secrets: object[] | string) =>
  fs.writeFileSync(
    path.join(root, 'secrets.json'),
    typeof secrets === 'string' ? secrets : JSON.stringify({ hint: 'h', data: secrets }),
  );

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'add-vercel-onecli-'));
  calls = path.join(root, 'calls.log');
  fs.writeFileSync(calls, '');
  vault([MODEL, VERCEL]);
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(
    path.join(bin, 'onecli'),
    `#!/usr/bin/env bash
echo "onecli $*" >> "$CALLS"
case "$1 $2" in
  "secrets list") [ "$3 $4" = "--max 0" ] || exit 7; cat "$ROOT/secrets.json" ;;
  "agents list") [ "$3 $4" = "--max 0" ] || exit 7; A='[{"id":"oc-default","identifier":"default","isDefault":true},{"id":"oc-sales","identifier":"ag-sales"},{"id":"oc-ops","identifier":"ag-ops"}]'; if [ -n "$BARE_AGENTS" ]; then printf '%s\\n' "$A"; else printf '{"hint":"h","data":%s}\\n' "$A"; fi ;;
  "agents create") echo '{"hint":"h","id":"oc-new"}' ;;
  "secrets create") p=""; f=""; for a in "$@"; do [ "$p" = --file ] && f="$a"; p="$a"; done
    cat "$f" > "$ROOT/key-seen"; ls -ld "$(dirname "$f")" | cut -c1-10 > "$ROOT/key-dir-mode"
    # A failing gateway that quotes the value back, as a worst case.
    [ -z "$FAIL_CREATE" ] || { echo "{\"error\":\"rejected $(cat "$f")\"}" >&2; exit 1; }
    echo '{"id":"sec-new"}' ;;
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

function run(script: string, shell = 'sh', tmp = root) {
  const r = spawnSync(shell, ['-c', script], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${path.join(root, 'bin')}:${process.env.PATH}`,
      CALLS: calls,
      ROOT: root,
      TMPDIR: tmp,
    },
    encoding: 'utf8',
  });
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lines: fs.readFileSync(calls, 'utf8').trim().split('\n'),
  };
}
const attached = (lines: string[]) => lines.filter((l) => l.includes('grants attach-secret'));
const shells = ['sh', 'bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

describe('/add-vercel OneCLI steps', () => {
  const TOKEN = 'vcp_TESTKEY-not-a-real-token-0123456789';
  /** The save as the agent runs it: `mktemp -d`, its file tool writes the token, then the save block. */
  function saveToken(shell: string, prefix = '', tmp = root) {
    const made = spawnSync(shell, ['-c', block('SKILL.md', '### Set up Vercel API credential')], {
      encoding: 'utf8',
      env: { ...process.env, TMPDIR: tmp },
    });
    const dir = made.stdout.trim();
    fs.writeFileSync(path.join(dir, 'token'), TOKEN);
    const save = block('SKILL.md', '### Set up Vercel API credential', 1).replace(/^D=.*$/m, `D="${dir}"`);
    return { dir, ...run(prefix + save, shell, tmp) };
  }

  it.each(shells)('saves the token from a file in a private temp dir, never in a command (%s)', (shell) => {
    const { dir, status, lines } = saveToken(shell);
    expect(status).toBe(0);
    expect(lines).toEqual([
      expect.stringMatching(
        /^onecli secrets create --name Vercel API Token --type generic --file \S+\/token --host-pattern api\.vercel\.com --header-name Authorization --value-format Bearer \{value\}$/,
      ),
    ]);
    expect(fs.readFileSync(path.join(root, 'key-seen'), 'utf8')).toBe(TOKEN);
    expect(fs.readFileSync(path.join(root, 'key-dir-mode'), 'utf8').trim()).toBe('drwx------');
    expect(fs.existsSync(dir)).toBe(false);
    // No step has a token placeholder for the agent to fill into a command.
    expect(fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8')).not.toMatch(/<TOKEN>|--value "/);
  });

  // macOS's /tmp is a symlink, which find does not enter unless told to.
  it.each(
    shells.flatMap((sh) => [
      [sh, 'a directory'],
      [sh, 'a symlink'],
    ]),
  )('a save clears a token dir an earlier run left, not one still in use (%s, TMPDIR is %s)', (shell, kind) => {
    const tmp = kind === 'a symlink' ? path.join(root, 'tmp-link') : root;
    if (tmp !== root) fs.symlinkSync(root, tmp);
    const left = (name: string, ageMinutes: number) => {
      const d = path.join(root, name);
      fs.mkdirSync(d, { mode: 0o700 });
      fs.writeFileSync(path.join(d, 'token'), TOKEN);
      const t = new Date(Date.now() - ageMinutes * 60_000);
      fs.utimesSync(d, t, t);
      return d;
    };
    const stale = left('nanoclaw-vercel-token.OLD', 60);
    const active = left('nanoclaw-vercel-token.NOW', 1);
    const { dir, status } = saveToken(shell, '', tmp);
    expect(status).toBe(0);
    expect(fs.realpathSync(path.dirname(dir))).toBe(fs.realpathSync(root));
    expect(path.basename(dir)).toMatch(/^nanoclaw-vercel-token\./);
    expect(fs.existsSync(stale)).toBe(false);
    expect(fs.existsSync(active)).toBe(true);
  });

  it.each(shells)('a failed save prints no token and removes it, even under set -e (%s)', (shell) => {
    const { dir, status, stdout, stderr } = saveToken(shell, 'set -e; FAIL_CREATE=1; export FAIL_CREATE\n');
    expect(status).not.toBe(0);
    expect(stdout + stderr).not.toContain(TOKEN);
    expect(stderr).toContain('OneCLI did not save the token');
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('attaches the Vercel secret only to the chosen groups', () => {
    const { status, lines } = run(chosen('ag-sales'));
    expect(status).toBe(0);
    expect(lines.filter((l) => l.includes('grants attach-secret'))).toEqual([
      'onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel',
    ]);
  });

  it('reads an agent list answered as a bare array, as the gate accepts, without creating a duplicate agent', () => {
    vi.stubEnv('BARE_AGENTS', '1');
    const { status, lines } = run(chosen('ag-sales'));
    vi.unstubAllEnvs();
    expect(status).toBe(0);
    expect(lines.some((l) => l.startsWith('onecli agents create'))).toBe(false);
    expect(attached(lines)).toEqual(['onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel']);
  });

  it('creates the OneCLI agent for a chosen group that has not run yet, then attaches', () => {
    const { status, lines } = run(chosen('ag-ops,ag-new'));
    expect(status).toBe(0);
    expect(lines).toContain('onecli agents create --name New Group --identifier ag-new');
    expect(lines).toContain('onecli agents grants attach-secret --id oc-new --secret-id sec-vercel');
    expect(lines).toContain('onecli agents grants attach-secret --id oc-ops --secret-id sec-vercel');
    expect(lines.filter((l) => l.startsWith('onecli agents create'))).toHaveLength(1);
  });

  it('finds the token by its host, not by a name that mentions Vercel', () => {
    vault([MODEL, { id: 'sec-notes', name: 'vercel notes', hostPattern: 'notes.example.com' }, VERCEL]);
    const { status, lines } = run(chosen('ag-sales'));
    expect(status).toBe(0);
    expect(attached(lines)).toEqual(['onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel']);
  });

  it('with two Vercel tokens, lists them without previews and attaches nothing', () => {
    vault([MODEL, VERCEL, VERCEL_2]);
    const { status, stdout, stderr, lines } = run(chosen('ag-sales'));
    expect(status).not.toBe(0);
    expect(attached(lines)).toEqual([]);
    expect(stderr).toContain('sec-vercel  Vercel API Token  created 2026-10-01T10:00:00Z');
    expect(stderr).toContain('sec-vercel-2  Vercel work  created 2026-10-18T09:00:00Z');
    expect(stderr).toContain('VERCEL_SECRET');
    expect(stdout + stderr).not.toContain('PREVIEW');
  });

  it('VERCEL_SECRET picks the token to attach when there are several', () => {
    vault([MODEL, VERCEL, VERCEL_2]);
    const { status, lines } = run(chosen('ag-sales').replace(/^VERCEL_SECRET=.*$/m, 'VERCEL_SECRET="sec-vercel-2"'));
    expect(status).toBe(0);
    expect(attached(lines)).toEqual(['onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel-2']);
  });

  it('refuses a VERCEL_SECRET that is not a Vercel token', () => {
    const { status, stderr, lines } = run(
      chosen('ag-sales').replace(/^VERCEL_SECRET=.*$/m, 'VERCEL_SECRET="sec-model"'),
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain("'sec-model' is not a Vercel token");
    expect(attached(lines)).toEqual([]);
  });

  it.each([
    ['no Vercel token', () => vault([MODEL]), 'no Vercel token in OneCLI'],
    ['a blank list', () => vault(''), 'could not list OneCLI secrets'],
  ])('refuses with %s and attaches nothing', (_name, setup, message) => {
    setup();
    const { status, stderr, lines } = run(chosen('ag-sales'));
    expect(status).not.toBe(0);
    expect(stderr).toContain(message);
    expect(attached(lines)).toEqual([]);
  });

  it.each(shells)('a refusal under %s leaves the calling shell open', (shell) => {
    vault([MODEL]);
    const { status, stdout } = run(`${chosen('ag-sales')}\necho shell-still-open`, shell);
    expect(status).toBe(0);
    expect(stdout).toContain('shell-still-open');
  });

  it.each(shells)('attaches under %s', (shell) => {
    const { status, lines } = run(chosen('ag-sales,ag-ops'), shell);
    expect(status).toBe(0);
    expect(attached(lines)).toHaveLength(2);
  });

  it.each(shells.filter((sh) => sh !== 'sh'))(
    'a vault list larger than a pipe buffer works under %s with pipefail',
    (shell) => {
      const many = Array.from({ length: 6000 }, (_, i) => ({
        id: `sec-${i}`,
        name: `Other secret ${i}`,
        hostPattern: `h${i}.example.com`,
      }));
      vault([...many, VERCEL]);
      // GNU grep -q stops reading at its first match, closing the pipe on the writer.
      fs.writeFileSync(path.join(root, 'bin', 'grep'), '#!/usr/bin/env bash\nhead -c 1 >/dev/null\n', { mode: 0o755 });
      const pipefail = shell === 'zsh' ? 'setopt pipefail' : 'set -o pipefail';
      const attach = run(`${pipefail}\n${chosen('ag-sales')}`, shell);
      expect(attach.stderr).toBe('');
      expect(attached(attach.lines)).toEqual([
        'onecli agents grants attach-secret --id oc-sales --secret-id sec-vercel',
      ]);
      const removal = run(`${pipefail}\n${DETACH}`, shell);
      expect(removal.lines.at(-1)).toBe('onecli secrets delete --id sec-vercel');
    },
  );

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
    vault([MODEL, { id: 'sec-notes', name: 'vercel notes', hostPattern: 'notes.example.com' }, VERCEL]);
    const { lines } = run(DETACH);
    for (const id of ['oc-default', 'oc-sales', 'oc-ops'])
      expect(lines).toContain(`onecli agents grants detach-secret --id ${id} --secret-id sec-vercel`);
    expect(lines.at(-1)).toBe('onecli secrets delete --id sec-vercel');
    expect(lines.some((l) => l.includes('sec-notes'))).toBe(false);
  });

  it('removal with two Vercel tokens lists them, deletes nothing, and leaves the shell open', () => {
    vault([MODEL, VERCEL, VERCEL_2]);
    const { status, stdout, stderr, lines } = run(`${DETACH}\necho shell-still-open`);
    expect(status).toBe(0);
    expect(stdout).toContain('shell-still-open');
    expect(lines.some((l) => /detach-secret|secrets delete/.test(l))).toBe(false);
    expect(stderr).toContain('sec-vercel-2  Vercel work  created 2026-10-18T09:00:00Z');
    expect(stdout + stderr).not.toContain('PREVIEW');
  });

  it('removal with VERCEL_SECRET removes only that token', () => {
    vault([MODEL, VERCEL, VERCEL_2]);
    const { lines } = run(DETACH.replace(/^VERCEL_SECRET=.*$/m, 'VERCEL_SECRET="sec-vercel-2"'));
    expect(lines.at(-1)).toBe('onecli secrets delete --id sec-vercel-2');
    expect(lines.some((l) => l.endsWith('--secret-id sec-vercel'))).toBe(false);
  });

  it.each([
    ['the existing-credential check', '### Check if Vercel credential already exists', 0],
    ['the check after saving', 'Once the user provides the token', 2],
  ])('%s shows Vercel tokens by host without previews', (_name, heading, skip) => {
    vault([MODEL, { id: 'sec-notes', name: 'vercel notes', hostPattern: 'notes.example.com' }, VERCEL]);
    const { stdout } = run(block('SKILL.md', heading, skip));
    expect(stdout.trim()).toBe('sec-vercel  Vercel API Token  created 2026-10-01T10:00:00Z');
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
