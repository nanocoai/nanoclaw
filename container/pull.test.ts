/**
 * An update or a skill pulls through `container/pull.sh` without going through
 * setup. These run the real script, the real installer and the real helper
 * source; docker and pnpm are stand-ins.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { HELPER_BINARY_NAME, renderHelper } from '../setup/install-cred-helper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const SOURCE = fs.readFileSync(path.join(REPO, 'setup', 'registry', 'credential-helper.mjs'), 'utf-8');
const REF = `reg.example.com/nanoclaw/agent@sha256:${'a'.repeat(64)}`;
const GONE_NODE = '/nonexistent/node/1.0.0/bin/node';

// Answers what pull.sh asks, and on `pull` starts the helper as the real CLI
// does for a registry wired to it: found on PATH, then executed.
const DOCKER_STUB = `#!/bin/bash
case "$1 $2" in
  "version --format") echo arm64 ;;
  "image inspect")
    if [ "$3" != "--format" ]; then [ -f "$STUB_STATE/pulled" ]; exit; fi
    case "$4" in
      *Architecture*) echo arm64 ;;
      *Labels*) echo "<no value>" ;;
    esac ;;
  "pull "*)
    helper="$(command -v ${HELPER_BINARY_NAME})" || exit 1
    "$helper" version 2>/dev/null | grep -q nanoclaw-docker-credential-helper || { echo "error getting credentials - err: fork/exec $helper: no such file or directory" >&2; exit 1; }
    touch "$STUB_STATE/pulled" ;;
esac
`;

// Records the call, then runs the checkout's own tsx: a real pnpm must never
// run from a test, where it can reinstall the dependencies it finds.
const PNPM_STUB = `#!/bin/bash
echo "$*" >> "$STUB_STATE/pnpm-calls"
[ "$1 $2" = "exec tsx" ] || exit 1
shift 2
exec "$REPO/node_modules/.bin/tsx" "$@"
`;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function install(contents: string): { root: string; helper: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-helper-'));
  scratch.push(root);
  for (const dir of ['stub', 'bin', 'node', 'home', 'state', 'docker']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'stub', 'docker'), DOCKER_STUB, { mode: 0o755 });
  fs.writeFileSync(path.join(root, 'stub', 'pnpm'), PNPM_STUB, { mode: 0o755 });
  // A directory holding node and nothing else: whatever sits beside the real
  // node, a helper installed on this machine included, stays off PATH.
  fs.symlinkSync(process.execPath, path.join(root, 'node', 'node'));
  fs.writeFileSync(
    path.join(root, 'docker', 'config.json'),
    `${JSON.stringify({ credHelpers: { 'reg.example.com': 'nanoclaw' } }, null, '\t')}\n`,
  );
  const helper = path.join(root, 'bin', HELPER_BINARY_NAME);
  fs.writeFileSync(helper, contents, { mode: 0o755 });
  return { root, helper };
}

/** The scratch helper comes first on PATH, so no other one is ever reached. */
function pull(root: string): { status: number | null; output: string; pnpmCalls: string[] } {
  const res = spawnSync('bash', [path.join(here, 'pull.sh')], {
    encoding: 'utf-8',
    env: {
      PATH: [path.join(root, 'stub'), path.join(root, 'bin'), path.join(root, 'node'), '/usr/bin', '/bin'].join(
        path.delimiter,
      ),
      HOME: path.join(root, 'home'),
      DOCKER_CONFIG: path.join(root, 'docker'),
      STUB_STATE: path.join(root, 'state'),
      REPO,
      NANOCLAW_AGENT_IMAGE_REF: REF,
      NANOCLAW_ALLOW_UNLABELED_IMAGE: 'true',
    },
  });
  const calls = path.join(root, 'state', 'pnpm-calls');
  return {
    status: res.status,
    output: `${res.stdout}${res.stderr}`,
    pnpmCalls: fs.existsSync(calls) ? fs.readFileSync(calls, 'utf-8').trim().split('\n') : [],
  };
}

describe('container/pull.sh and a credential helper from an older setup', () => {
  it('has the installer re-install it before the pull, which then goes through', () => {
    const olderSetup = `#!${GONE_NODE}\n${SOURCE.slice(SOURCE.indexOf('\n') + 1)}`;
    const { root, helper } = install(olderSetup);

    const res = pull(root);

    expect(res.pnpmCalls).toEqual([
      `exec tsx setup/install-cred-helper.ts --refresh-installed --bin-dir ${path.dirname(helper)}`,
    ]);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(renderHelper(SOURCE, fs.realpathSync(process.execPath)));
    expect(res.output).toContain('Re-installed the credential helper');
    expect(res.status).toBe(0);
  }, 30_000);

  it('leaves a helper with the current header alone', () => {
    const current = renderHelper(SOURCE, GONE_NODE);
    const { root, helper } = install(current);

    const res = pull(root);

    expect(res.status).toBe(0);
    expect(res.pnpmCalls).toEqual([]);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(current);
  });

  it('leaves a helper that setup did not install alone', () => {
    const foreign = `#!${GONE_NODE}\nconsole.log('someone else wrote this');\n`;
    const { root, helper } = install(foreign);

    const res = pull(root);

    expect(res.status).toBe(1);
    expect(res.pnpmCalls).toEqual([]);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(foreign);
  });
});
