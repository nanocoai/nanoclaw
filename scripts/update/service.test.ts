import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detectService,
  drainContainers,
  startService,
  stopService,
  verifyServiceHealth,
  type CommandRunner,
  type ServiceEnvironment,
} from './service.js';

const roots: string[] = [];

function temp(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-update-service-'));
  roots.push(root);
  return root;
}

function makeEnv(platform: NodeJS.Platform, responses: Record<string, { ok: boolean; stdout?: string }> = {}) {
  const home = temp();
  const calls: string[] = [];
  const runner: CommandRunner = {
    run(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key];
      if (response && !response.ok) throw new Error(key);
      return response?.stdout ?? '';
    },
    tryRun(command, args) {
      const key = `${command} ${args.join(' ')}`;
      calls.push(key);
      const response = responses[key] ?? { ok: true, stdout: '' };
      return { ok: response.ok, stdout: response.stdout ?? '' };
    },
  };
  const env: ServiceEnvironment = {
    platform,
    home,
    uid: 1000,
    runner,
    sleep: async () => {},
  };
  return { env, calls, home };
}

function slug(root: string): string {
  return createHash('sha1').update(root).digest('hex').slice(0, 8);
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('service-mode detection and control', () => {
  it('detects and controls a user systemd unit', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, calls, home } = makeEnv('linux', {
      [`systemctl --user is-active --quiet ${name}`]: { ok: true },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');

    const handle = detectService(root, env);
    expect(handle).toMatchObject({ mode: 'systemd-user', active: true, name });
    await stopService(handle, env);
    startService(handle, root, env);

    expect(calls).toContain(`systemctl --user stop ${name}`);
    expect(calls).toContain(`systemctl --user start ${name}`);
  });

  it('uses system-level systemctl without --user for root-installed units', async () => {
    const { env, calls } = makeEnv('linux');
    const handle = { mode: 'systemd-system' as const, active: true, name: 'nanoclaw-v2-root' };

    await stopService(handle, env);
    startService(handle, '/srv/nanoclaw', env);

    expect(calls).toEqual(['systemctl stop nanoclaw-v2-root', 'systemctl start nanoclaw-v2-root']);
  });

  it('bootstraps an unloaded launchd plist instead of relying on kickstart alone', () => {
    const root = temp();
    const name = `com.nanoclaw-v2-${slug(root)}`;
    const { env, calls, home } = makeEnv('darwin', {
      [`launchctl print gui/1000/${name}`]: { ok: false },
    });
    const plist = path.join(home, 'Library', 'LaunchAgents', `${name}.plist`);
    fs.mkdirSync(path.dirname(plist), { recursive: true });
    fs.writeFileSync(plist, '<plist/>\n');
    const detected = detectService(root, env);
    expect(detected).toMatchObject({ mode: 'launchd', active: false });

    startService({ ...detected, active: true }, root, env);
    expect(calls).toContain(`launchctl bootstrap gui/1000 ${plist}`);
    expect(calls).toContain(`launchctl kickstart gui/1000/${name}`);
  });

  it('restarts a WSL/nohup install through its recorded start script', () => {
    const root = temp();
    const definition = path.join(root, 'start-nanoclaw.sh');
    const { env, calls } = makeEnv('linux');

    startService({ mode: 'nohup', active: true, definition, pid: 4242 }, root, env);

    expect(calls).toEqual([`bash ${definition}`]);
  });

  it('refuses to mutate under an unmanaged pnpm-dev process', async () => {
    const root = temp();
    const pattern = `${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/(dist/index\\.js|src/index\\.ts)`;
    const { env } = makeEnv('linux', {
      [`pgrep -f ${pattern}`]: { ok: true, stdout: '1234' },
    });

    const handle = detectService(root, env);
    expect(handle).toMatchObject({ mode: 'unmanaged', active: true, name: '1234' });
    await expect(stopService(handle, env)).rejects.toThrow('outside a supported service wrapper');
  });
});

describe('drain and health gates', () => {
  it('filters active containers by this install slug', async () => {
    const root = temp();
    const label = `nanoclaw-install=${slug(root)}`;
    const { env, calls } = makeEnv('linux', {
      [`docker ps -q --filter label=${label}`]: { ok: true, stdout: '' },
    });

    await drainContainers(root, env);
    expect(calls).toEqual([`docker ps -q --filter label=${label}`]);
  });

  it('requires active process state, the ncl socket, and a successful CLI probe', async () => {
    const root = temp();
    const name = `nanoclaw-v2-${slug(root)}`;
    const { env, home } = makeEnv('linux', {
      [`systemctl --user is-active --quiet ${name}`]: { ok: true },
      [`${path.join(root, 'bin', 'ncl')} groups list`]: { ok: true },
    });
    const unit = path.join(home, '.config', 'systemd', 'user', `${name}.service`);
    fs.mkdirSync(path.dirname(unit), { recursive: true });
    fs.writeFileSync(unit, '[Service]\n');
    fs.mkdirSync(path.join(root, 'data'), { recursive: true });
    fs.writeFileSync(path.join(root, 'data', 'ncl.sock'), 'test socket stand-in');

    const healthy = await verifyServiceHealth(
      { mode: 'systemd-user', active: true, name, definition: unit },
      root,
      env,
      10,
    );
    expect(healthy).toBe(true);
  });
});
