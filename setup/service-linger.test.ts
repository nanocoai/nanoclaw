import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({ execSync: vi.fn(() => ''), execFileSync: vi.fn(() => '') }));
vi.mock('./platform.js', () => ({
  getPlatform: () => 'linux',
  getNodePath: () => process.execPath,
  getServiceManager: () => 'systemd',
  isRoot: () => false,
  commandExists: () => false,
}));
vi.mock('../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../src/upgrade-state.js', () => ({ writeUpgradeState: () => ({ version: 'fixture' }) }));
vi.mock('./peer-cleanup.js', () => ({ cleanupUnhealthyPeers: () => ({ unloaded: [], removed: [] }) }));
vi.mock('./lib/systemd-linger.js', () => ({ ensureUserLinger: vi.fn() }));
vi.mock('./status.js', () => ({ emitStatus: vi.fn() }));

import { ensureUserLinger } from './lib/systemd-linger.js';
import { run } from './service.js';
import { emitStatus } from './status.js';

let root: string;
beforeEach(() => {
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-linger-status-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.spyOn(process, 'getuid').mockReturnValue(1000);
  vi.spyOn(os, 'homedir').mockReturnValue(path.join(root, 'home'));
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform === 'linux')('systemd service linger status', () => {
  it.each([true, false])('reports the verified linger value %s independently of service startup', async (enabled) => {
    vi.mocked(ensureUserLinger).mockReturnValue(enabled);
    await run([]);
    expect(ensureUserLinger).toHaveBeenCalledWith(1000);
    expect(emitStatus).toHaveBeenCalledWith(
      'SETUP_SERVICE',
      expect.objectContaining({
        SERVICE_TYPE: 'systemd-user',
        SERVICE_LOADED: true,
        LINGER_ENABLED: enabled,
        STATUS: 'success',
      }),
    );
  });
});
