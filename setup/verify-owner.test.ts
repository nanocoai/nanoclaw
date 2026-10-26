import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  root: '',
  channels: {} as Record<string, string>,
  db: {
    registeredGroups: 1,
    derivedGroups: 0,
    owners: 0,
    approvers: 0,
    wiredChannels: [] as string[],
    droppedChannels: [] as string[],
  },
}));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  execSync: vi.fn((command: string) => {
    if (command.includes('MainPID')) return '123';
    if (command.startsWith('ps ')) return `node ${host.root}/dist/index.js`;
    return '';
  }),
}));
vi.mock('../src/install-slug.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/install-slug.js')>()),
  getLaunchdLabel: () => 'dev.nanoclaw',
  getSystemdUnit: () => 'nanoclaw.service',
}));
vi.mock('../src/env.js', () => ({ readEnvFile: () => host.channels }));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getServiceManager: () => 'systemd',
  isRoot: () => false,
  hasSystemd: () => true,
}));
vi.mock('./central-db-inspection.js', () => ({ inspectCentralDb: async () => host.db }));
vi.mock('./lib/registry-state.js', () => ({
  readImageSource: () => 'build',
  inspectAgentImage: () => ({ source: 'local', registryDigest: null }),
}));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { emitStatus } from './status.js';
import { run } from './verify.js';

beforeEach(() => {
  host.root = fs.mkdtempSync(path.join(os.tmpdir(), 'nc-verify-owner-'));
  host.channels = {};
  host.db = { registeredGroups: 1, derivedGroups: 0, owners: 0, approvers: 0, wiredChannels: [], droppedChannels: [] };
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

describe('verify reports the owner', () => {
  it('a terminal-only install has no owner by design and still passes, with no hint', async () => {
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'missing', REGISTERED_GROUPS: 1 });
    expect(fields()).not.toHaveProperty('OWNER_HINT');
    expect(fields()).not.toHaveProperty('DROPPED_CHANNELS');
  });

  it('reports a present owner without a hint', async () => {
    host.channels = { TELEGRAM_BOT_TOKEN: 'fixture-only' };
    host.db = { ...host.db, owners: 1, approvers: 1, wiredChannels: ['telegram'] };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'present' });
    expect(fields()).not.toHaveProperty('OWNER_HINT');
  });

  it('warns, without failing, when a chat channel is set up but nobody can approve on it', async () => {
    host.channels = { SLACK_BOT_TOKEN: 'fixture-only', SLACK_APP_TOKEN: 'fixture-only' };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'missing' });
    expect(fields()?.OWNER_HINT).toMatch(/slack.*\/init-first-agent/);
  });

  it('counts Slack in webhook mode as set up', async () => {
    host.channels = { SLACK_BOT_TOKEN: 'fixture-only', SLACK_SIGNING_SECRET: 'fixture-only' };
    host.db = { ...host.db, droppedChannels: ['slack'] };
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed', CONFIGURED_CHANNELS: 'slack', DROPPED_CHANNELS: 'slack' });
  });

  it('an admin can approve, so a missing owner alone is no hint', async () => {
    host.channels = { TELEGRAM_BOT_TOKEN: 'fixture-only' };
    host.db = { ...host.db, approvers: 1, wiredChannels: ['telegram'], droppedChannels: ['telegram'] };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'missing' });
    expect(fields()).not.toHaveProperty('OWNER_HINT');
  });

  it('fails when a channel with no wired chat is dropping messages and nobody can approve them', async () => {
    host.channels = { SLACK_BOT_TOKEN: 'fixture-only', SLACK_APP_TOKEN: 'fixture-only' };
    host.db = { ...host.db, droppedChannels: ['slack'] };
    await expect(run([])).rejects.toThrow('verify_exit');
    expect(fields()).toMatchObject({ STATUS: 'failed', OWNER: 'missing', DROPPED_CHANNELS: 'slack' });
    expect(fields()?.OWNER_HINT).toMatch(/slack.*dropped.*\/init-first-agent/);
  });

  it('old drops from a channel that is no longer set up do not fail a terminal-only install', async () => {
    host.db = { ...host.db, droppedChannels: ['slack'] };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'missing', CONFIGURED_CHANNELS: '' });
    expect(fields()).not.toHaveProperty('DROPPED_CHANNELS');
    expect(fields()).not.toHaveProperty('OWNER_HINT');
  });

  it('a wired chat on that channel keeps a stranger drop to a warning', async () => {
    host.channels = { TELEGRAM_BOT_TOKEN: 'fixture-only' };
    host.db = { ...host.db, wiredChannels: ['telegram'], droppedChannels: ['telegram'] };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'missing' });
    expect(fields()?.OWNER_HINT).toMatch(/telegram/);
    expect(fields()).not.toHaveProperty('DROPPED_CHANNELS');
  });
});
