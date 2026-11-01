// Behavior tests for the Tavily paid-key upgrade the agent walks the user
// through (upgrade-instructions.md, written per group by Phase 5). On OneCLI
// 1.44+ a new secret reaches no agent until it is attached, so the user must
// attach the saved key to their group before the keyless header is dropped.
// The attach block runs under `sh` against a stub `onecli` that logs calls.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const SKILL_DIR = path.resolve(__dirname, '../.claude/skills/add-tavily-tool');
const doc = fs.readFileSync(path.join(SKILL_DIR, 'upgrade-instructions.md'), 'utf8');
const skill = fs.readFileSync(path.join(SKILL_DIR, 'SKILL.md'), 'utf8');
const blocks = [...doc.matchAll(/```bash\n([\s\S]*?)```/g)].map((m) => m[1]);
const ATTACH = blocks.find((b) => b.includes('grants attach-secret')) ?? '';

let root: string;
let calls: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'tavily-upgrade-'));
  calls = path.join(root, 'calls.log');
  fs.writeFileSync(calls, '');
  fs.mkdirSync(path.join(root, 'bin'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(secretName: string, attachExit = 0, extraSecret = '', grantsUnknown = false) {
  fs.writeFileSync(
    path.join(root, 'bin', 'onecli'),
    `#!/usr/bin/env bash
echo "onecli $*" >> "$CALLS"
case "$1 $2" in
  "secrets list") [ "$3 $4" = "--max 0" ] || exit 7; echo '{"hint":"h","data":[{"id":"sec-model","name":"Anthropic","hostPattern":"api.anthropic.com"},{"id":"sec-tavily","name":"${secretName}","hostPattern":"mcp.tavily.com","createdAt":"2026-10-19T18:00:00Z","preview":"tvly-...abcd"}${extraSecret}]}' ;;
  "agents list") [ "$3 $4" = "--max 0" ] || exit 7; echo '{"hint":"h","data":[{"id":"oc-other","identifier":"ag-other"},{"id":"oc-research","identifier":"ag-research"}]}' ;;
  "agents grants") ${grantsUnknown ? 'echo "unexpected argument grants" >&2; exit 80' : `exit ${attachExit}`} ;;
esac
`,
    { mode: 0o755 },
  );
  const r = spawnSync(
    'sh',
    ['-c', `${ATTACH.replaceAll('{{AGENT_GROUP_ID}}', 'ag-research')}\nrc=$?\necho still-here\nexit $rc`],
    {
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, CALLS: calls },
      encoding: 'utf8',
    },
  );
  return {
    status: r.status,
    stdout: r.stdout,
    stderr: r.stderr,
    lines: fs.readFileSync(calls, 'utf8').trim().split('\n'),
  };
}

describe('Tavily paid-key upgrade on OneCLI grants', () => {
  it('attaches the saved key, found by its host, to this group only', () => {
    for (const name of ['Tavily', 'tavily']) {
      fs.writeFileSync(calls, '');
      const { status, lines } = run(name);
      expect(status).toBe(0);
      expect(lines.filter((l) => l.includes('attach-secret'))).toEqual([
        'onecli agents grants attach-secret --id oc-research --secret-id sec-tavily',
      ]);
    }
  });

  it('fails loudly when the attach fails, before the keyless header is dropped', () => {
    expect(run('Tavily', 1).status).not.toBe(0);
  });

  it('stops, naming every candidate, when more than one key sits on the Tavily host', () => {
    const { status, stderr, lines } = run(
      'Tavily',
      0,
      ',{"id":"sec-other-group","name":"Tavily","hostPattern":"mcp.tavily.com"}',
    );
    expect(status).not.toBe(0);
    expect(stderr).toContain('sec-tavily');
    expect(stderr).toContain('sec-other-group');
    expect(lines.some((l) => l.includes('attach-secret'))).toBe(false);
  });

  it('stops on a CLI without the grants commands, and never tells the agent to go on without the attach', () => {
    expect(run('Tavily', 0, '', true).status).not.toBe(0);
    expect(doc).not.toMatch(/already injects the key/);
    expect(doc).toMatch(/docs\/onecli-upgrades\.md/);
  });

  it.each(['bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0))(
    'attaches the single key when pasted into %s',
    (shell) => {
      run('Tavily');
      fs.writeFileSync(calls, '');
      const r = spawnSync(shell, ['-c', ATTACH.replaceAll('{{AGENT_GROUP_ID}}', 'ag-research')], {
        env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, CALLS: calls },
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
      expect(fs.readFileSync(calls, 'utf8')).toContain(
        'onecli agents grants attach-secret --id oc-research --secret-id sec-tavily',
      );
    },
  );

  it('runs in a subshell, so a refusal never closes the user shell', () => {
    expect(ATTACH.trim().startsWith('(')).toBe(true);
    expect(ATTACH.trim().endsWith(')')).toBe(true);
    expect(run('Tavily', 1).stdout).toContain('still-here');
  });

  it('with two keys, lists each with its creation time (never its preview) and names this group agent', () => {
    const { stderr } = run(
      'Tavily',
      0,
      ',{"id":"sec-other-group","name":"Tavily","hostPattern":"mcp.tavily.com","createdAt":"2026-10-01T09:00:00Z","preview":"tvly-...wxyz"}',
    );
    expect(stderr).toContain('2026-10-19T18:00:00Z');
    expect(stderr).toContain('2026-10-01T09:00:00Z');
    expect(stderr).not.toContain('tvly-');
    expect(stderr).toContain('--id oc-research');
    expect(stderr).not.toMatch(/newest/);
  });

  it('reads an agent list answered as a bare array, as the gate accepts', () => {
    fs.writeFileSync(
      path.join(root, 'bin', 'onecli'),
      `#!/usr/bin/env bash\necho "onecli $*" >> "$CALLS"\ncase "$1 $2" in "secrets list") echo '{"data":[{"id":"sec-tavily","name":"Tavily","hostPattern":"mcp.tavily.com"}]}' ;; "agents list") echo '[{"id":"oc-research","identifier":"ag-research"}]' ;; esac\n`,
      { mode: 0o755 },
    );
    const r = spawnSync('sh', ['-c', ATTACH.replaceAll('{{AGENT_GROUP_ID}}', 'ag-research')], {
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, CALLS: calls },
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(fs.readFileSync(calls, 'utf8')).toContain(
      'agents grants attach-secret --id oc-research --secret-id sec-tavily',
    );
  });

  it('with no key yet, says to save it through the link first', () => {
    fs.writeFileSync(
      path.join(root, 'bin', 'onecli'),
      `#!/usr/bin/env bash\ncase "$1 $2" in "secrets list") echo '{"data":[]}' ;; "agents list") echo '{"data":[{"id":"oc-research","identifier":"ag-research"}]}' ;; esac\n`,
      { mode: 0o755 },
    );
    const r = spawnSync('sh', ['-c', ATTACH.replaceAll('{{AGENT_GROUP_ID}}', 'ag-research')], {
      env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}` },
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/save it through the link/);
  });

  it('never says the key is injected before it is attached', () => {
    expect(doc).not.toMatch(/injected at the gateway/);
  });

  it('comes after the key is saved and before the server is re-registered without the keyless header', () => {
    const save = doc.indexOf('paste the key into the prefilled form');
    const attach = doc.indexOf(ATTACH);
    const reregister = doc.indexOf('ncl groups config remove-mcp-server --name tavily');
    expect(save).toBeGreaterThan(-1);
    expect(attach).toBeGreaterThan(save);
    expect(reregister).toBeGreaterThan(attach);
  });

  it('Phase 5 fills in each group id, and the keyless section names the attach', () => {
    expect(skill).toMatch(/Substitute `\{\{ONECLI_DASHBOARD_URL\}\}` and `\{\{AGENT_GROUP_ID\}\}`/);
    expect(skill.slice(skill.indexOf('## Keyless limit'))).toContain('attach');
  });
});
