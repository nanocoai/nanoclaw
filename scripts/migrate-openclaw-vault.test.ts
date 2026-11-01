// /migrate-from-openclaw's vault step: the SKILL.md block runs under each
// shell against a stub `onecli`, so the assertions see exactly what it passes
// and prints. The key must reach OneCLI only through a private file.

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, expect, it } from 'vitest';

const DOC = fs.readFileSync(path.resolve(__dirname, '../.claude/skills/migrate-from-openclaw/SKILL.md'), 'utf8');
const BLOCK = DOC.slice(DOC.indexOf('These are container-facing')).match(/```bash\n([\s\S]*?)```/)![1];
const KEY = 'sk-ant-api03-TESTKEY-not-a-real-key-0123456789';
const shells = ['sh', 'bash', 'zsh'].filter((sh) => spawnSync(sh, ['-c', 'true']).status === 0);

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'migrate-openclaw-vault-'));
  fs.mkdirSync(path.join(root, 'bin'));
  fs.writeFileSync(
    path.join(root, 'auth-profiles.json'),
    JSON.stringify({ profiles: { 'anthropic:default': { key: KEY } } }),
  );
  fs.writeFileSync(
    path.join(root, 'bin', 'onecli'),
    `#!/usr/bin/env bash
echo "$*" > "$ROOT/argv"
p=""; f=""; for a in "$@"; do [ "$p" = --file ] && f="$a"; p="$a"; done
cat "$f" > "$ROOT/key-seen"; dirname "$f" > "$ROOT/key-dir"
[ -z "$FAIL_CREATE" ] || { echo "{\\"error\\":\\"rejected $(cat "$f")\\"}" >&2; exit 1; }
echo '{"id":"sec-new"}'
`,
    { mode: 0o755 },
  );
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function run(shell: string, prefix = '') {
  const script = BLOCK.replace(
    `'<path to the key>' <source file>`,
    `'.profiles["anthropic:default"].key' "$ROOT/auth-profiles.json"`,
  );
  const r = spawnSync(shell, ['-c', prefix + script], {
    env: { ...process.env, PATH: `${path.join(root, 'bin')}:${process.env.PATH}`, ROOT: root },
    encoding: 'utf8',
  });
  const read = (name: string) => fs.readFileSync(path.join(root, name), 'utf8').trim();
  return { ...r, read };
}

it.each(shells)('saves the key from a private temp file and removes it (%s)', (shell) => {
  const { status, read } = run(shell);
  expect(status).toBe(0);
  expect(read('argv')).toBe(
    `secrets create --name Anthropic --type anthropic --file ${read('key-dir')}/key --host-pattern api.anthropic.com`,
  );
  expect(read('key-seen')).toBe(KEY);
  expect(fs.existsSync(read('key-dir'))).toBe(false);
});

it.each(shells)('a failed save prints no key and removes it, even under set -e (%s)', (shell) => {
  const { status, stdout, stderr, read } = run(shell, 'set -e; FAIL_CREATE=1; export FAIL_CREATE\n');
  expect(status).not.toBe(0);
  expect(stdout + stderr).not.toContain(KEY);
  expect(stderr).toContain('OneCLI did not save the key');
  expect(fs.existsSync(read('key-dir'))).toBe(false);
});
