/**
 * `container/pull.sh` re-points a credential helper whose node has moved. These
 * run the real script and the real helper source; only docker is a stand-in,
 * because what matters is whether docker can start the helper at pull time.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { HELPER_BINARY_NAME, renderHelper } from '../setup/install-cred-helper.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PULL_SH = path.join(here, 'pull.sh');
const HELPER_SOURCE = fs.readFileSync(path.join(here, '..', 'setup', 'registry', 'credential-helper.mjs'), 'utf-8');
const REF = `reg.example.com/nanoclaw/agent@sha256:${'a'.repeat(64)}`;
const NODE = fs.realpathSync(process.execPath);
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
    helper="$(command -v ${HELPER_BINARY_NAME})" || { echo "error getting credentials - err: exec: not found in \\$PATH" >&2; exit 1; }
    "$helper" version 2>/dev/null | grep -q nanoclaw-docker-credential-helper || { echo "error getting credentials - err: fork/exec $helper: no such file or directory" >&2; exit 1; }
    touch "$STUB_STATE/pulled" ;;
esac
`;

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function install(contents: string): { root: string; helper: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pull-helper-'));
  scratch.push(root);
  for (const dir of ['stub', 'bin', 'node', 'home', 'state']) fs.mkdirSync(path.join(root, dir));
  fs.writeFileSync(path.join(root, 'stub', 'docker'), DOCKER_STUB, { mode: 0o755 });
  // A directory holding node and nothing else: whatever sits beside the real
  // node, a helper installed on this machine included, stays off PATH.
  fs.symlinkSync(NODE, path.join(root, 'node', 'node'));
  const helper = path.join(root, 'bin', HELPER_BINARY_NAME);
  fs.writeFileSync(helper, contents, { mode: 0o755 });
  return { root, helper };
}

/** `nodeDir` is where pull.sh finds `node`. The scratch helper comes first, so no other one is ever reached. */
function pull(root: string, nodeDir: string = path.join(root, 'node')): { status: number | null; output: string } {
  const res = spawnSync('bash', [PULL_SH], {
    encoding: 'utf-8',
    env: {
      PATH: [path.join(root, 'stub'), path.join(root, 'bin'), nodeDir, '/usr/bin', '/bin'].join(path.delimiter),
      HOME: path.join(root, 'home'),
      STUB_STATE: path.join(root, 'state'),
      NANOCLAW_AGENT_IMAGE_REF: REF,
      NANOCLAW_ALLOW_UNLABELED_IMAGE: 'true',
    },
  });
  return { status: res.status, output: `${res.stdout}${res.stderr}` };
}

describe('container/pull.sh and a credential helper whose node has moved', () => {
  it('re-points the helper at the node on PATH, and the pull goes through', () => {
    const { root, helper } = install(renderHelper(HELPER_SOURCE, GONE_NODE));

    const res = pull(root);

    expect(res.output).toContain(`re-pointed it at ${NODE}`);
    expect(res.status).toBe(0);
    // Only the first line changes: the installed body is not swapped for this checkout's.
    expect(fs.readFileSync(helper, 'utf-8')).toBe(renderHelper(HELPER_SOURCE, NODE));
    expect(fs.statSync(helper).mode & 0o777).toBe(0o755);
    expect(fs.readdirSync(path.dirname(helper))).toEqual([HELPER_BINARY_NAME]);
  });

  it('leaves a helper that starts alone', () => {
    const { root, helper } = install(renderHelper(HELPER_SOURCE, NODE));
    const before = fs.statSync(helper).ino;

    const res = pull(root);

    expect(res.status).toBe(0);
    expect(res.output).not.toContain('re-pointed');
    expect(fs.statSync(helper).ino).toBe(before);
  });

  it('never rewrites a helper it did not install', () => {
    const foreign = `#!${GONE_NODE}\nconsole.log('someone else wrote this');\n`;
    const { root, helper } = install(foreign);

    const res = pull(root);

    expect(res.status).toBe(1);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(foreign);
    expect(res.output).toContain('docker login');
    expect(res.output).not.toContain('does not start');
  });

  it('names the helper as the cause when there is no node to re-point it at', () => {
    const stale = renderHelper(HELPER_SOURCE, GONE_NODE);
    const { root, helper } = install(stale);
    const noNode = path.join(root, 'no-node');
    fs.mkdirSync(noNode);
    fs.writeFileSync(path.join(noNode, 'node'), '#!/bin/bash\nexit 127\n', { mode: 0o755 });

    const res = pull(root, noNode);

    expect(res.status).toBe(1);
    expect(fs.readFileSync(helper, 'utf-8')).toBe(stale);
    expect(fs.readdirSync(path.dirname(helper))).toEqual([HELPER_BINARY_NAME]);
    expect(res.output).toContain(`The NanoClaw credential helper does not start: ${helper}`);
    expect(res.output).toContain(`setup/install-cred-helper.ts --bin-dir "${path.dirname(helper)}"`);
    // The registry may not be wired to the helper at all, so the login hint stays, second.
    expect(res.output.indexOf('does not start')).toBeLessThan(res.output.indexOf('docker login'));
  });
});
