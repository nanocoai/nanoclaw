import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// systemd is PID 1 but the user instance is unreachable — the shape of an
// exe.dev VM, a CI runner, or an SSH-only box without a user session bus.
// setup/service.ts falls back to the nohup wrapper there; verify must agree.
const host = vi.hoisted(() => ({ root: '', userBus: false }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn((command: string) => {
    if (command.startsWith('systemctl --user')) {
      if (!host.userBus) throw new Error('Failed to connect to bus: No medium found');
      throw new Error('inactive');
    }
    if (command.startsWith('ps ')) return `node ${host.root}/dist/index.js`;
    return '';
  }),
}));
vi.mock('../src/install-slug.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/install-slug.js')>()),
  getLaunchdLabel: () => 'dev.nanoclaw',
  getSystemdUnit: () => 'nanoclaw.service',
}));
vi.mock('../src/env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getServiceManager: () => 'systemd',
  isRoot: () => false,
  hasSystemd: () => true,
}));
vi.mock('./central-db-inspection.js', () => ({
  inspectCentralDb: async () => ({ registeredGroups: 1, derivedGroups: 0 }),
}));
vi.mock('./lib/registry-state.js', () => ({
  readImageSource: () => 'build',
  inspectAgentImage: () => ({ source: 'local', registryDigest: null }),
}));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { emitStatus } from './status.js';
import { run } from './verify.js';

beforeEach(() => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-verify-nohup-'));
  host.userBus = false;
  fs.mkdirSync(path.join(host.root, 'data'));
  fs.writeFileSync(path.join(host.root, '.env'), 'ANTHROPIC_API_KEY=fixture-only\n');
  vi.spyOn(process, 'cwd').mockReturnValue(host.root);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('verify_exit');
  });
  vi.mocked(emitStatus).mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(host.root, { recursive: true, force: true });
});

const fields = () => vi.mocked(emitStatus).mock.calls.at(-1)?.[1];

describe('verify with systemd present but no user instance', () => {
  it('sees a host started by the nohup wrapper as running', async () => {
    // Our own pid is alive, so the `kill -0` liveness probe passes.
    fs.writeFileSync(path.join(host.root, 'nanoclaw.pid'), `${process.pid}\n`);
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ SERVICE: 'running', STATUS: 'success' });
  });

  it('reports a stale pid file as stopped, not not_found', async () => {
    fs.writeFileSync(path.join(host.root, 'nanoclaw.pid'), '999999999\n');
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ SERVICE: 'stopped', STATUS: 'failed' });
  });

  it('still reports not_found when there is no pid file either', async () => {
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ SERVICE: 'not_found', STATUS: 'failed' });
  });

  it('does not consult the pid file when the systemd unit itself answers', async () => {
    host.userBus = true; // unit exists but is inactive → the manager branch decides
    fs.writeFileSync(path.join(host.root, 'nanoclaw.pid'), `${process.pid}\n`);
    vi.mocked((await import('child_process')).execSync).mockImplementation(((command: string) => {
      if (command.includes('is-active')) throw new Error('inactive');
      if (command.includes('list-unit-files')) return 'nanoclaw.service';
      if (command.startsWith('ps ')) return `node ${host.root}/dist/index.js`;
      return '';
    }) as never);
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ SERVICE: 'stopped' });
  });
});
