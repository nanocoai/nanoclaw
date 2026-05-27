/**
 * Tests for setup/channels/signal.ts:restartService — the bug surfaced in
 * issue #2583. The previous implementation called `launchctl kickstart -k`
 * with `stdio: 'ignore'`, ignored the exit code, then slept 5s and reported
 * "NanoClaw restarted." When the plist had been unloaded (e.g. by
 * setup/peer-cleanup.ts), kickstart silently no-op'd and the next step
 * failed with a confusing `connect ENOENT data/cli.sock`.
 *
 * These tests verify the new probe-first behavior:
 *   - When the service is loaded → use `kickstart -k`.
 *   - When the service is unloaded → use `launchctl bootstrap`.
 *   - When the socket never appears → throw a meaningful error.
 *   - When `kickstart` / `bootstrap` returns non-zero → throw, not silent success.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock child_process.spawnSync so we can drive launchctl exit codes.
const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

// Mock fs so we can control whether data/cli.sock appears.
const statSyncMock = vi.fn();
const existsSyncMock = vi.fn();
vi.mock('fs', () => ({
  default: {
    statSync: (...args: unknown[]) => statSyncMock(...args),
    existsSync: (...args: unknown[]) => existsSyncMock(...args),
    // Stubbed but not exercised by restartService tests.
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    copyFileSync: vi.fn(),
  },
  statSync: (...args: unknown[]) => statSyncMock(...args),
  existsSync: (...args: unknown[]) => existsSyncMock(...args),
}));

// Silence @clack/prompts spinner output during tests.
vi.mock('@clack/prompts', () => ({
  spinner: () => ({
    start: vi.fn(),
    stop: vi.fn(),
  }),
}));

// Silence the setup log module.
vi.mock('../../logs.js', () => ({
  step: vi.fn(),
  userInput: vi.fn(),
  stepRawLog: vi.fn(() => '/tmp/raw.log'),
}));

// Use a fixed launchd label so we can match arguments exactly.
vi.mock('../../../src/install-slug.js', () => ({
  getLaunchdLabel: () => 'com.nanoclaw-v2-deadbeef',
  getSystemdUnit: () => 'nanoclaw-v2-deadbeef',
}));

// Import AFTER mocks so the SUT sees the mocked modules.
const { restartService, probeLaunchdLoaded } = await import('../signal.js');

const ORIGINAL_PLATFORM = process.platform;

function setDarwin(): void {
  Object.defineProperty(process, 'platform', {
    value: 'darwin',
    configurable: true,
  });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', {
    value: ORIGINAL_PLATFORM,
    configurable: true,
  });
}

beforeEach(() => {
  spawnSyncMock.mockReset();
  statSyncMock.mockReset();
  existsSyncMock.mockReset();
  setDarwin();
  // getuid → 501 by default on darwin in real life; pin it so tests are deterministic.
  Object.defineProperty(process, 'getuid', {
    value: () => 501,
    configurable: true,
  });
});

describe('probeLaunchdLoaded', () => {
  it('returns true when launchctl print exits 0', () => {
    spawnSyncMock.mockReturnValue({ status: 0, error: undefined });
    expect(probeLaunchdLoaded('gui/501/com.nanoclaw-v2-deadbeef')).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      'launchctl',
      ['print', 'gui/501/com.nanoclaw-v2-deadbeef'],
      { stdio: 'ignore' },
    );
  });

  it('returns false when launchctl print exits non-zero', () => {
    spawnSyncMock.mockReturnValue({ status: 1, error: undefined });
    expect(probeLaunchdLoaded('gui/501/com.nanoclaw-v2-deadbeef')).toBe(false);
  });

  it('returns false when spawnSync errors', () => {
    spawnSyncMock.mockReturnValue({ status: null, error: new Error('ENOENT') });
    expect(probeLaunchdLoaded('gui/501/com.nanoclaw-v2-deadbeef')).toBe(false);
  });
});

describe('restartService — darwin', () => {
  it('uses kickstart -k when the service is already loaded', async () => {
    // 1st spawnSync = probe (loaded), 2nd = kickstart (success).
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, error: undefined }) // probe
      .mockReturnValueOnce({ status: 0, error: undefined }); // kickstart
    statSyncMock.mockReturnValue({} as never); // socket exists immediately

    await restartService();

    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      1,
      'launchctl',
      ['print', 'gui/501/com.nanoclaw-v2-deadbeef'],
      { stdio: 'ignore' },
    );
    expect(spawnSyncMock).toHaveBeenNthCalledWith(
      2,
      'launchctl',
      ['kickstart', '-k', 'gui/501/com.nanoclaw-v2-deadbeef'],
      { stdio: 'ignore' },
    );
  });

  it('bootstraps when the service is unloaded — this is the #2583 fix', async () => {
    // probe → not loaded; existsSync(plist) → true; bootstrap → success.
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, error: undefined }) // probe (unloaded)
      .mockReturnValueOnce({ status: 0, error: undefined }); // bootstrap
    existsSyncMock.mockReturnValue(true);
    statSyncMock.mockReturnValue({} as never); // socket exists

    await restartService();

    // Verify the 2nd call is `bootstrap`, not `kickstart`.
    const secondCall = spawnSyncMock.mock.calls[1];
    expect(secondCall[0]).toBe('launchctl');
    expect(secondCall[1][0]).toBe('bootstrap');
    expect(secondCall[1][1]).toBe('gui/501');
    expect(secondCall[1][2]).toMatch(
      /Library\/LaunchAgents\/com\.nanoclaw-v2-deadbeef\.plist$/,
    );
  });

  it('throws a meaningful error when the plist file is missing', async () => {
    spawnSyncMock.mockReturnValueOnce({ status: 1, error: undefined }); // unloaded
    existsSyncMock.mockReturnValue(false); // plist gone

    await expect(restartService()).rejects.toThrow(/launchd plist missing/);
  });

  it('throws when kickstart returns non-zero (no more silent no-op)', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, error: undefined }) // probe: loaded
      .mockReturnValueOnce({ status: 5, error: undefined }); // kickstart fails

    await expect(restartService()).rejects.toThrow(/kickstart .* exited 5/);
  });

  it('throws when bootstrap returns non-zero', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 1, error: undefined }) // probe: unloaded
      .mockReturnValueOnce({ status: 113, error: undefined }); // bootstrap fails
    existsSyncMock.mockReturnValue(true);

    await expect(restartService()).rejects.toThrow(/bootstrap .* exited 113/);
  });

  it('throws when data/cli.sock never appears within 5s', async () => {
    spawnSyncMock
      .mockReturnValueOnce({ status: 0, error: undefined }) // probe: loaded
      .mockReturnValueOnce({ status: 0, error: undefined }); // kickstart OK
    // Socket never appears — every statSync throws.
    statSyncMock.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    vi.useFakeTimers();
    try {
      const promise = restartService();
      // Attach the rejection handler synchronously so vitest doesn't see an
      // unhandled rejection while we advance the fake timers past the 5s
      // socket-wait deadline.
      const assertion = expect(promise).rejects.toThrow(
        /data\/cli\.sock did not appear/,
      );
      await vi.advanceTimersByTimeAsync(6000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

// Restore the original platform once the suite ends so other tests in the
// same process aren't perturbed.
restorePlatform();
