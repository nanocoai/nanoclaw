import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const host = vi.hoisted(() => ({
  root: '',
  channels: {} as Record<string, string>,
  db: { registeredGroups: 1, derivedGroups: 0, owners: 0 },
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
  host.db = { registeredGroups: 1, derivedGroups: 0, owners: 0 };
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
  // init-cli-agent grants no owner, so a terminal-only install has none.
  it('says when no owner is set, without failing', async () => {
    host.channels = { TELEGRAM_BOT_TOKEN: 'fixture-only' };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'missing' });
  });

  it('says when an owner is set', async () => {
    host.db = { ...host.db, owners: 1 };
    await expect(run([])).resolves.toBeUndefined();
    expect(fields()).toMatchObject({ STATUS: 'success', OWNER: 'present' });
  });
});
