import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({ root: '', manager: 'none', nodePath: process.execPath }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn((command: string) => {
    if (command === 'pnpm run build') return '';
    if (command === 'systemctl --user daemon-reload') throw new Error('No user bus');
    throw new Error(`Unexpected service command: ${command}`);
  }),
}));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getNodePath: () => host.nodePath,
  getServiceManager: () => host.manager,
  isRoot: () => false,
}));
vi.mock('../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/upgrade-state.js', () => ({ writeUpgradeState: () => ({ version: 'fixture' }) }));
vi.mock('./peer-cleanup.js', () => ({ cleanupUnhealthyPeers: () => ({ unloaded: [], removed: [] }) }));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { emitStatus } from './status.js';
import { run, waitForNohupStartup } from './service.js';

const fields = () => vi.mocked(emitStatus).mock.calls.at(-1)?.[1];
const pidFile = () => path.join(host.root, 'nanoclaw.pid');
const readPid = () => Number(fs.readFileSync(pidFile(), 'utf8').trim());
const fixture = (source: string) => fs.writeFileSync(path.join(host.root, 'dist/index.js'), source);
const acceptingHost = (delay = 0, shutdownDelay = 0) =>
  fixture(`
  const net = require('net');
  const fs = require('fs');
  setTimeout(() => {
    const server = net.createServer(c => c.end());
    server.listen('data/ncl.sock');
    process.on('SIGTERM', () => setTimeout(() => server.close(() => process.exit(0)), ${shutdownDelay}));
  }, ${delay});
`);

beforeEach(() => {
  // Shell metacharacters are literal path characters, including in the generated launcher.
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), "nc-'$()-"));
  host.manager = 'none';
  host.nodePath = process.execPath;
  fs.mkdirSync(path.join(host.root, 'dist'));
  fs.mkdirSync(path.join(host.root, 'data'));
  vi.spyOn(process, 'cwd').mockReturnValue(host.root);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(host.root, 'home'));
  vi.mocked(emitStatus).mockClear();
});
afterEach(async () => {
  // Only signal fixture-owned hosts, never whatever an intentionally stale PID file names.
  if (fs.existsSync(pidFile())) {
    const pid = readPid();
    try {
      const args = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
      if (args[1] === path.join(host.root, 'dist/index.js')) {
        process.kill(pid, 'SIGKILL');
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } catch {
      /* exited */
    }
  }
  vi.restoreAllMocks();
  fs.rmSync(host.root, { recursive: true, force: true });
});

// The production fallback is Linux-only and checks Linux process ownership.
describe.runIf(process.platform === 'linux')('nohup service startup', () => {
  it.each(['none', 'systemd'])('starts the actual launcher when manager is %s', async (manager) => {
    host.manager = manager;
    acceptingHost(150);
    await run([]);
    expect(fields()).toMatchObject({ SERVICE_TYPE: 'nohup', SERVICE_LOADED: true, STATUS: 'success' });
    expect(fs.statSync(path.join(host.root, 'data/ncl.sock')).isSocket()).toBe(true);
    process.kill(readPid(), 0);
    execFileSync('/bin/bash', ['-n', path.join(host.root, 'start-nanoclaw.sh')]);
  });

  it('restarts the recorded host and waits for the replacement to be ready', async () => {
    acceptingHost(0, 250);
    await run([]);
    const oldPid = readPid();
    await run([]);
    expect(readPid()).not.toBe(oldPid);
    expect(fields()).toMatchObject({ SERVICE_LOADED: true, STATUS: 'success' });
    let oldArgs = '';
    try {
      oldArgs = fs.readFileSync(`/proc/${oldPid}/cmdline`, 'utf8');
    } catch {
      /* exited */
    }
    expect(oldArgs).not.toContain(path.join(host.root, 'dist/index.js'));
  });

  it('keeps the host alive after the interactive terminal session exits', async () => {
    acceptingHost();
    await run([]);
    const previousPid = readPid();
    const wrapper = path.join(host.root, 'start-nanoclaw.sh');
    const quoted = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    // util-linux script starts a real controlling terminal. Its shell must
    // exit after Node has started, not while nohup still owns the process.
    execFileSync(
      'script',
      [
        '-q',
        '-e',
        '-c',
        `/bin/bash ${quoted(wrapper)} && while [ ! -S ${quoted(path.join(host.root, 'data/ncl.sock'))} ]; do sleep 0.05; done`,
        '/dev/null',
      ],
      {
        stdio: 'pipe',
        timeout: 15_000,
      },
    );
    const pid = readPid();
    expect(pid).not.toBe(previousPid);
    await expect(waitForNohupStartup(host.root, pid, 1000)).resolves.toBeUndefined();
  });

  it.each(['missing', 'unrelated'])('rejects an existing listener with a %s PID file', async (pidState) => {
    acceptingHost();
    await run([]);
    const oldPid = readPid();
    if (pidState === 'missing') fs.unlinkSync(pidFile());
    else fs.writeFileSync(pidFile(), String(process.pid));
    try {
      await expect(run([])).rejects.toThrow('failed to start');
      expect(fields()).toMatchObject({ SERVICE_LOADED: false, STATUS: 'failed' });
      process.kill(oldPid, 0);
    } finally {
      fs.writeFileSync(pidFile(), String(oldPid));
    }
  });

  it('restarts its previous host after the Node installation path changes', async () => {
    acceptingHost();
    await run([]);
    const oldPid = readPid();
    host.nodePath = path.join(host.root, 'node-alias');
    fs.symlinkSync(process.execPath, host.nodePath);
    await run([]);
    expect(readPid()).not.toBe(oldPid);
    expect(fields()).toMatchObject({ SERVICE_LOADED: true, STATUS: 'success' });
  });

  it('refuses to replace a host that does not finish shutting down', async () => {
    acceptingHost(0, 60_000);
    await run([]);
    const oldPid = readPid();
    await expect(run([])).rejects.toThrow('failed to start');
    expect(readPid()).toBe(oldPid);
    expect(fields()).toMatchObject({ SERVICE_LOADED: false, STATUS: 'failed' });
  }, 15_000);

  it('reports a host startup error instead of success', async () => {
    fixture('process.exit(17);');
    await expect(run([])).rejects.toThrow();
    expect(fields()).toMatchObject({ SERVICE_TYPE: 'nohup', SERVICE_LOADED: false, STATUS: 'failed' });
  });

  it('bounds readiness when a live process never opens the admin socket', async () => {
    fixture('setInterval(() => {}, 1000);');
    const child = spawn(process.execPath, [path.join(host.root, 'dist/index.js')], { stdio: 'ignore' });
    fs.writeFileSync(pidFile(), String(child.pid));
    await expect(waitForNohupStartup(host.root, child.pid!, 100)).rejects.toThrow('Timed out');
  });

  it('does not signal an unrelated process referenced by a stale PID file', async () => {
    fs.writeFileSync(pidFile(), `${process.pid}\n`);
    acceptingHost();
    await run([]);
    expect(readPid()).not.toBe(process.pid);
    expect(fields()).toMatchObject({ SERVICE_LOADED: true, STATUS: 'success' });
  });

  it('fails when the configured Node binary cannot start', async () => {
    host.nodePath = path.join(host.root, 'missing-node');
    acceptingHost();
    await expect(run([])).rejects.toThrow();
    expect(fields()).toMatchObject({ SERVICE_LOADED: false, STATUS: 'failed' });
  });
});
