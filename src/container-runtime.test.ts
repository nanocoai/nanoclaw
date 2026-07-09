import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock logger
vi.mock('./logger.js', () => ({
  logger: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
const mockSpawnUnref = vi.fn();
const mockSpawn = vi.fn((..._args: unknown[]) => ({ unref: mockSpawnUnref }));
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
  spawn: (...args: unknown[]) => mockSpawn(...args),
}));

// Mock os — platform is configurable per-test; networkInterfaces only needs
// to satisfy module-load-time detectProxyBindHost().
// vi.hoisted is required here: container-runtime.ts calls os.platform() at
// module-load time (detectProxyBindHost), which runs before any non-hoisted
// const would be initialized.
const mockPlatform = vi.hoisted(() => vi.fn(() => 'linux'));
vi.mock('os', () => ({
  default: {
    platform: () => mockPlatform(),
    networkInterfaces: () => ({}),
  },
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
  startContainerRuntimeWatchdog,
  tryLaunchContainerRuntime,
} from './container-runtime.js';
import { logger } from './logger.js';

beforeEach(() => {
  vi.clearAllMocks();
  mockPlatform.mockReturnValue('linux');
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns -v flag with :ro suffix', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['-v', '/host/path:/container/path:ro']);
  });
});

describe('stopContainer', () => {
  it('calls docker stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`,
      { stdio: 'pipe' },
    );
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo$(whoami)')).toThrow(
      'Invalid container name',
    );
    expect(() => stopContainer('foo`id`')).toThrow('Invalid container name');
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

// --- ensureContainerRuntimeRunning ---

describe('ensureContainerRuntimeRunning', () => {
  it('does nothing when runtime is already running', () => {
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} info`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(logger.debug).toHaveBeenCalledWith(
      'Container runtime already running',
    );
  });

  it('throws when docker info fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('Cannot connect to the Docker daemon');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow(
      'Container runtime is required but failed to start',
    );
    expect(logger.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  it('stops orphaned nanoclaw containers', () => {
    // docker ps returns container names, one per line
    mockExecSync.mockReturnValueOnce(
      'nanoclaw-group1-111\nnanoclaw-group2-222\n',
    );
    // stop calls succeed
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    // ps + 2 stop calls
    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(
      2,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`,
      { stdio: 'pipe' },
    );
    expect(mockExecSync).toHaveBeenNthCalledWith(
      3,
      `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`,
      { stdio: 'pipe' },
    );
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'] },
      'Stopped orphaned containers',
    );
  });

  it('does nothing when no orphans exist', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(logger.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ps fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('docker not available');
    });

    cleanupOrphans(); // should not throw

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to clean up orphaned containers',
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    mockExecSync.mockReturnValueOnce('nanoclaw-a-1\nnanoclaw-b-2\n');
    // First stop fails
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    // Second stop succeeds
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans(); // should not throw

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(logger.info).toHaveBeenCalledWith(
      { count: 2, names: ['nanoclaw-a-1', 'nanoclaw-b-2'] },
      'Stopped orphaned containers',
    );
  });
});

// --- tryLaunchContainerRuntime ---

describe('tryLaunchContainerRuntime', () => {
  it('does nothing on linux (no reliable Docker Desktop launch path)', () => {
    mockPlatform.mockReturnValue('linux');
    tryLaunchContainerRuntime();
    expect(mockSpawn).not.toHaveBeenCalled();
  });

  it('spawns "open -a Docker" on macOS', () => {
    mockPlatform.mockReturnValue('darwin');
    tryLaunchContainerRuntime();
    expect(mockSpawn).toHaveBeenCalledWith(
      'open',
      ['-a', 'Docker'],
      expect.objectContaining({ detached: true }),
    );
    expect(mockSpawnUnref).toHaveBeenCalled();
  });

  it('swallows spawn errors', () => {
    mockPlatform.mockReturnValue('darwin');
    mockSpawn.mockImplementationOnce(() => {
      throw new Error('spawn failed');
    });
    expect(() => tryLaunchContainerRuntime()).not.toThrow();
    expect(logger.warn).toHaveBeenCalled();
  });
});

// --- startContainerRuntimeWatchdog ---

describe('startContainerRuntimeWatchdog', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  /** docker info: fails while `up` is false, succeeds once true. docker ps: no orphans. */
  function mockDockerState(initialUp: boolean) {
    const state = { up: initialUp };
    mockExecSync.mockImplementation((cmd: unknown) => {
      const command = String(cmd);
      if (command.includes('info')) {
        if (!state.up) throw new Error('Cannot connect to the Docker daemon');
        return '';
      }
      return ''; // docker ps — no orphans
    });
    return state;
  }

  it('stays healthy and quiet when the runtime is already up', () => {
    mockDockerState(true);
    const onDown = vi.fn();
    const onRecovered = vi.fn();

    startContainerRuntimeWatchdog({ initiallyDown: false, onDown, onRecovered });
    vi.advanceTimersByTime(2 * 60 * 1000 * 3); // 3 healthy-poll intervals

    expect(onDown).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(mockExecSync).toHaveBeenCalled();
  });

  it('attempts to launch the runtime once when a healthy check fails', () => {
    mockPlatform.mockReturnValue('darwin');
    const state = mockDockerState(true);
    startContainerRuntimeWatchdog({
      initiallyDown: false,
      onDown: vi.fn(),
      onRecovered: vi.fn(),
    });

    state.up = false;
    vi.advanceTimersByTime(2 * 60 * 1000); // trigger the healthy check, now failing
    expect(mockSpawn).toHaveBeenCalledWith(
      'open',
      ['-a', 'Docker'],
      expect.objectContaining({ detached: true }),
    );
    expect(mockSpawn).toHaveBeenCalledTimes(1);

    // Further retries while still down must not re-launch it
    vi.advanceTimersByTime(5 * 60 * 1000);
    expect(mockSpawn).toHaveBeenCalledTimes(1);
  });

  it('calls onDown exactly once, only after the outage passes the notify threshold', () => {
    mockDockerState(false);
    const onDown = vi.fn();
    const onRecovered = vi.fn();

    startContainerRuntimeWatchdog({ initiallyDown: true, onDown, onRecovered });

    // Backoff schedule (30s, 60s, 120s, 240s...) puts the 4th retry at 450s —
    // the first retry past the 5-minute (300s) threshold.
    vi.advanceTimersByTime(449 * 1000);
    expect(onDown).not.toHaveBeenCalled();

    vi.advanceTimersByTime(5 * 1000);
    expect(onDown).toHaveBeenCalledTimes(1);

    // Continuing to fail afterwards must not re-notify
    vi.advanceTimersByTime(30 * 60 * 1000);
    expect(onDown).toHaveBeenCalledTimes(1);
    expect(onRecovered).not.toHaveBeenCalled();
  });

  it('recovers quietly (no onRecovered) when the outage resolves before the notify threshold', () => {
    const state = mockDockerState(false);
    const onDown = vi.fn();
    const onRecovered = vi.fn();

    startContainerRuntimeWatchdog({ initiallyDown: true, onDown, onRecovered });

    state.up = true;
    vi.advanceTimersByTime(31 * 1000); // past the first retry at 30s

    expect(onDown).not.toHaveBeenCalled();
    expect(onRecovered).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith('Container runtime recovered');
  });

  it('calls onRecovered exactly once and cleans up orphans after a notified outage ends', () => {
    const state = mockDockerState(false);
    const onDown = vi.fn();
    const onRecovered = vi.fn();

    startContainerRuntimeWatchdog({ initiallyDown: true, onDown, onRecovered });

    vi.advanceTimersByTime(451 * 1000); // past the notify threshold
    expect(onDown).toHaveBeenCalledTimes(1);

    state.up = true;
    vi.advanceTimersByTime(300 * 1000); // next retry (backoff capped at 5 min) succeeds

    expect(onRecovered).toHaveBeenCalledTimes(1);
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.stringContaining('ps --filter name=nanoclaw-'),
      expect.any(Object),
    );

    // Staying up afterwards must not re-fire onRecovered
    vi.advanceTimersByTime(10 * 60 * 1000);
    expect(onRecovered).toHaveBeenCalledTimes(1);
  });
});
