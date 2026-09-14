import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
const fixtureHost = `
const fs = require('node:fs');
const net = require('node:net');
const socketPath = process.argv[2];
try { fs.unlinkSync(socketPath); } catch {}
net.createServer((socket) => {
  let request = '';
  socket.on('error', () => {});
  socket.on('data', (chunk) => {
    request += chunk.toString('utf8');
    if (!request.includes('\\n')) return;
    const frame = JSON.parse(request.slice(0, request.indexOf('\\n')));
    socket.end(JSON.stringify({
      id: frame.id,
      ok: true,
      data: {
        pid: process.pid,
        started_at: new Date(performance.timeOrigin).toISOString(),
        instance_id: 'fallback-instance',
        project_root: process.cwd(),
        channels: [],
      },
    }) + '\\n');
  });
}).listen(socketPath);
`;

afterEach(() => {
  for (const root of roots.splice(0)) {
    const pidFile = path.join(root, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) {
      try {
        process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL');
      } catch {
        // The fixture listener already exited.
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  }
});

describe.runIf(process.platform !== 'win32')('restart helper', () => {
  it('uses the nohup launcher when systemd cannot restart the install', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restart-'));
    roots.push(root);
    const lib = path.join(root, 'setup', 'lib');
    const bin = path.join(root, 'fixture-bin');
    fs.mkdirSync(lib, { recursive: true });
    fs.mkdirSync(bin);
    fs.mkdirSync(path.join(root, 'data'));
    for (const name of ['host-status.mjs', 'restart.sh', 'install-slug.sh']) {
      fs.copyFileSync(new URL(`./${name}`, import.meta.url), path.join(lib, name));
    }

    fs.writeFileSync(path.join(bin, 'uname'), '#!/bin/sh\necho Linux\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    fs.writeFileSync(path.join(bin, 'sudo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const fixtureHostPath = path.join(root, 'fixture-host.cjs');
    fs.writeFileSync(fixtureHostPath, fixtureHost);
    fs.writeFileSync(
      path.join(root, 'start-nanoclaw.sh'),
      `#!/bin/bash
set -e
touch ${JSON.stringify(path.join(root, 'launcher-ran'))}
nohup ${JSON.stringify(process.execPath)} ${JSON.stringify(fixtureHostPath)} ${JSON.stringify(
        path.join(root, 'data', 'ncl.sock'),
      )} </dev/null >/dev/null 2>&1 &
echo $! > ${JSON.stringify(path.join(root, 'nanoclaw.pid'))}
`,
      { mode: 0o755 },
    );

    execFileSync('/bin/bash', [path.join(lib, 'restart.sh')], {
      cwd: root,
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH ?? ''}`,
        NANOCLAW_READY_TIMEOUT_MS: '10000',
      },
      stdio: 'pipe',
      timeout: 15000,
    });

    expect(fs.existsSync(path.join(root, 'launcher-ran'))).toBe(true);
    expect(Number(fs.readFileSync(path.join(root, 'nanoclaw.pid'), 'utf8'))).toBeGreaterThan(0);
  }, 20000);
});
