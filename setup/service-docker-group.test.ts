import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A user added to the docker group after login: this shell reaches Docker but
 * the user systemd manager still has its old groups. Host commands are faked
 * and recorded in order in `sys.calls`.
 */
const sys = vi.hoisted(() => ({
  root: '',
  calls: [] as string[],
  stale: true,
  setfacl: false,
  apt: true,
  sudoCached: true,
  aclApplied: false,
  aclReaches: true,
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn((command: string) => {
    sys.calls.push(command);
    if (command === 'systemd-run --user --pipe --wait docker info') {
      if (!sys.stale || (sys.aclApplied && sys.aclReaches)) return '';
      throw new Error('permission denied while trying to connect to the docker API');
    }
    if (
      command === 'pnpm run build' ||
      command === 'docker info' ||
      command === 'loginctl enable-linger' ||
      command.startsWith('systemctl --user ') ||
      command.startsWith('pkill ')
    ) {
      return '';
    }
    throw new Error(`Unexpected service command: ${command}`);
  }),
  execFileSync: vi.fn((file: string, args: string[]) => {
    sys.calls.push([file, ...args].join(' '));
    if (file !== 'sudo') throw new Error(`Unexpected exec: ${file}`);
    if (args[0] !== '-n' || !sys.sudoCached) throw new Error('sudo: a password is required');
    if (args.includes('apt-get')) {
      sys.setfacl = true;
      return '';
    }
    if (args[1] === 'setfacl') {
      sys.aclApplied = true;
      return '';
    }
    throw new Error(`Unexpected sudo command: ${args.join(' ')}`);
  }),
}));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getNodePath: () => '/usr/bin/node',
  getServiceManager: () => 'systemd',
  isRoot: () => false,
  commandExists: (name: string) => (name === 'setfacl' ? sys.setfacl : name === 'apt-get' ? sys.apt : false),
}));
vi.mock('../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/upgrade-state.js', () => ({ writeUpgradeState: () => ({ version: 'fixture' }) }));
vi.mock('./peer-cleanup.js', () => ({ cleanupUnhealthyPeers: () => ({ unloaded: [], removed: [] }) }));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { getSystemdUnit } from '../src/install-slug.js';
import { emitStatus } from './status.js';
import { run } from './service.js';

const fields = () => vi.mocked(emitStatus).mock.calls.at(-1)?.[1];
const sudoCalls = () => sys.calls.filter((c) => c.startsWith('sudo '));
const aclCommand = () => `sudo -n setfacl -m u:${os.userInfo().username}:rw /var/run/docker.sock`;
const aptCommand = 'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o DPkg::Lock::Timeout=60 acl';

beforeEach(() => {
  sys.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-docker-group-'));
  Object.assign(sys, {
    calls: [],
    stale: true,
    setfacl: false,
    apt: true,
    sudoCached: true,
    aclApplied: false,
    aclReaches: true,
  });
  for (const key of ['HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
  vi.spyOn(process, 'cwd').mockReturnValue(sys.root);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(sys.root, 'home'));
  vi.mocked(emitStatus).mockClear();
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  fs.rmSync(sys.root, { recursive: true, force: true });
});

describe('user service and a docker group added mid-session', () => {
  it('installs acl, applies the socket ACL before starting, and clears the flag once Docker answers', async () => {
    await run([]);
    expect(sudoCalls()).toEqual([aptCommand, aclCommand()]);
    const restart = sys.calls.indexOf(`systemctl --user restart ${getSystemdUnit(sys.root)}`);
    const recheck = sys.calls.lastIndexOf('systemd-run --user --pipe --wait docker info');
    expect(sys.calls.indexOf(aclCommand())).toBeLessThan(recheck);
    expect(recheck).toBeLessThan(restart);
    expect(fields()).toMatchObject({ SERVICE_TYPE: 'systemd-user', STATUS: 'success' });
    expect(fields()).not.toHaveProperty('DOCKER_GROUP_STALE');
    expect(fields()).not.toHaveProperty('SETFACL_MISSING');
    expect(fields()).not.toHaveProperty('DOCKER_ACL_APPLIED');
  });

  it('fails fast without a cached sudo ticket and reports setfacl as missing', async () => {
    sys.sudoCached = false;
    await run([]);
    expect(sudoCalls()).toEqual([aptCommand]);
    expect(fields()).toMatchObject({ DOCKER_GROUP_STALE: true, SETFACL_MISSING: true, STATUS: 'success' });
    expect(fields()).not.toHaveProperty('DOCKER_ACL_APPLIED');
  });

  it('does not report the ACL as applied when setfacl itself fails', async () => {
    sys.setfacl = true;
    sys.sudoCached = false;
    await run([]);
    expect(sudoCalls()).toEqual([aclCommand()]);
    expect(fields()).toMatchObject({ DOCKER_GROUP_STALE: true });
    expect(fields()).not.toHaveProperty('DOCKER_ACL_APPLIED');
  });

  it('keeps the flag when the ACL is applied but the user manager still cannot reach Docker', async () => {
    sys.setfacl = true;
    sys.aclReaches = false;
    await run([]);
    expect(sudoCalls()).toEqual([aclCommand()]);
    expect(fields()).toMatchObject({ DOCKER_GROUP_STALE: true, DOCKER_ACL_APPLIED: true });
    expect(fields()).not.toHaveProperty('SETFACL_MISSING');
  });

  it('does not reach for apt-get on other distributions', async () => {
    sys.apt = false;
    await run([]);
    expect(sudoCalls()).toEqual([]);
    expect(fields()).toMatchObject({ DOCKER_GROUP_STALE: true, SETFACL_MISSING: true });
  });

  it('runs no sudo when the user manager already reaches Docker', async () => {
    sys.stale = false;
    await run([]);
    expect(sudoCalls()).toEqual([]);
    expect(fields()).not.toHaveProperty('DOCKER_GROUP_STALE');
    expect(fields()).not.toHaveProperty('SETFACL_MISSING');
  });
});
