import { execFile, execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { queryHost, waitForHost } from './host-status.mjs';

const execFileAsync = promisify(execFile);
const sourceLib = dirname(fileURLToPath(import.meta.url));
const fixtureHost = `
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');

fs.mkdirSync('data', { recursive: true });
const socketPath = 'data/ncl.sock';
if (fs.existsSync(socketPath)) fs.unlinkSync(socketPath);
const instanceId = crypto.randomUUID();
const server = net.createServer((socket) => {
  let request = '';
  socket.on('data', (chunk) => {
    request += chunk.toString('utf8');
    if (!request.includes('\\n')) return;
    const frame = JSON.parse(request.slice(0, request.indexOf('\\n')));
    socket.end(JSON.stringify({
      id: frame.id,
      ok: true,
      data: {
        pid: process.pid,
        instance_id: instanceId,
        project_root: process.cwd(),
        channels: [{ instance: 'mattermost', type: 'mattermost', connected: true }],
      },
    }) + '\\n');
  });
});
server.listen(socketPath);
process.on('SIGTERM', () => server.close(() => process.exit(0)));
`;

const shellQuote = (value: string): string => `'${value.replaceAll("'", `'"'"'`)}'`;

let root: string;
let binDir: string;
let ownedPids: Set<number>;

beforeEach(() => {
  // Keep the fixture's Unix socket path below macOS's 104-byte limit.
  root = realpathSync(mkdtempSync(join(tmpdir(), 'ncl-rst-')));
  binDir = join(root, 'test-bin');
  ownedPids = new Set();
  mkdirSync(join(root, 'setup/lib'), { recursive: true });
  mkdirSync(join(root, 'dist'));
  mkdirSync(join(root, 'logs'));
  mkdirSync(binDir);
  for (const name of ['host-status.mjs', 'restart.sh', 'install-slug.sh']) {
    copyFileSync(join(sourceLib, name), join(root, 'setup/lib', name));
  }
  writeFileSync(join(root, 'dist/index.js'), fixtureHost);
  writeFileSync(join(binDir, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
  writeFileSync(join(binDir, 'node'), `#!/bin/sh\nexec ${shellQuote(process.execPath)} "$@"\n`, { mode: 0o755 });
  writeFileSync(
    join(root, 'start-nanoclaw.sh'),
    `#!/bin/bash
set -eu
cd ${shellQuote(root)}
[[ -f dist/index.js ]]
old_pid="$(cat nanoclaw.pid 2>/dev/null || true)"
if [ -n "$old_pid" ] && kill -0 "$old_pid" 2>/dev/null; then
  kill "$old_pid"
  while kill -0 "$old_pid" 2>/dev/null; do sleep 0.02; done
fi
${shellQuote(process.execPath)} dist/index.js >> logs/nanoclaw.log 2>> logs/nanoclaw.error.log < /dev/null &
echo $! > nanoclaw.pid
`,
    { mode: 0o755 },
  );
});

afterEach(async () => {
  try {
    ownedPids.add(Number(readFileSync(join(root, 'nanoclaw.pid'), 'utf8').trim()));
  } catch {
    // No host was started.
  }
  for (const pid of ownedPids) {
    if (!Number.isInteger(pid) || pid <= 0) continue;
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Already exited.
    }
  }
  await delay(50);
  rmSync(root, { recursive: true, force: true });
});

function env(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    NANOCLAW_READY_TIMEOUT_MS: '1000',
  };
}

async function startHost(): Promise<{ pid: number; instance_id: string }> {
  execFileSync('/bin/bash', [join(root, 'start-nanoclaw.sh')], { env: env(), stdio: 'pipe' });
  const pid = Number(readFileSync(join(root, 'nanoclaw.pid'), 'utf8').trim());
  ownedPids.add(pid);
  try {
    return await waitForHost(root, { pid, timeoutMs: 1000 });
  } catch (error) {
    const stderr = readFileSync(join(root, 'logs/nanoclaw.error.log'), 'utf8').trim();
    throw new Error(`${error instanceof Error ? error.message : String(error)}${stderr ? `: ${stderr}` : ''}`);
  }
}

describe('restart host identity and readiness', () => {
  it('restarts the fallback from another directory and requires the requested channel', async () => {
    const first = await startHost();
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });

    await execFileAsync('bash', [join(root, 'setup/lib/restart.sh'), '--channel', 'mattermost'], {
      cwd: tmpdir(),
      env: { ...env(), NANOCLAW_PROJECT_ROOT: '/wrong-checkout' },
    });

    const nextPid = Number(readFileSync(join(root, 'nanoclaw.pid'), 'utf8').trim());
    ownedPids.add(nextPid);
    const next = await queryHost(root);
    expect(next.pid).toBe(nextPid);
    expect(next.instance_id).not.toBe(first.instance_id);
  });

  it('rejects an old live host, the wrong process, and a missing adapter', async () => {
    const status = await startHost();
    await expect(waitForHost(root, { previous: status.instance_id, timeoutMs: 100 })).rejects.toThrow('previous host');
    await expect(waitForHost(root, { pid: process.pid, timeoutMs: 100 })).rejects.toThrow('different process');
    await expect(waitForHost(root, { channel: 'missing', timeoutMs: 100 })).rejects.toThrow('not connected');
  });

  it('propagates a failed systemd restart despite a healthy old host', async () => {
    const status = await startHost();
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\ncase "$*" in *"--user cat"*) exit 0;; *) exit 5;; esac\n', {
      mode: 0o755,
    });

    expect(() => execFileSync('bash', [join(root, 'setup/lib/restart.sh')], { env: env(), stdio: 'pipe' })).toThrow();
    expect(await queryHost(root)).toMatchObject({ pid: status.pid, instance_id: status.instance_id });
  });

  it('fails when no service manager or fallback launcher is installed', () => {
    rmSync(join(root, 'start-nanoclaw.sh'));
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() => execFileSync('bash', [join(root, 'setup/lib/restart.sh')], { env: env(), stdio: 'pipe' })).toThrow();
  });

  it('rejects malformed channel arguments before attempting a restart', () => {
    writeFileSync(join(binDir, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    expect(() =>
      execFileSync('bash', [join(root, 'setup/lib/restart.sh'), '--channel'], { env: env(), stdio: 'pipe' }),
    ).toThrow();
  });
});
