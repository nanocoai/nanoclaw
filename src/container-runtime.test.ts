import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock log
vi.mock('./log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  },
}));

// Mock child_process — store the mock fn so tests can configure it
const mockExecSync = vi.fn();
vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

import {
  CONTAINER_RUNTIME_BIN,
  readonlyMountArgs,
  stopContainer,
  ensureContainerRuntimeRunning,
  cleanupOrphans,
} from './container-runtime.js';
import { CONTAINER_INSTALL_LABEL } from './config.js';
import { log } from './log.js';

beforeEach(() => {
  vi.clearAllMocks();
});

// --- Pure functions ---

describe('readonlyMountArgs', () => {
  it('returns --mount bind with readonly flag', () => {
    const args = readonlyMountArgs('/host/path', '/container/path');
    expect(args).toEqual(['--mount', 'type=bind,source=/host/path,target=/container/path,readonly']);
  });
});

describe('stopContainer', () => {
  it('calls container stop for valid container names', () => {
    stopContainer('nanoclaw-test-123');
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-test-123`, {
      stdio: 'pipe',
    });
  });

  it('rejects names with shell metacharacters', () => {
    expect(() => stopContainer('foo; rm -rf /')).toThrow('Invalid container name');
    expect(() => stopContainer('foo$(whoami)')).toThrow('Invalid container name');
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
    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} system status`, {
      stdio: 'pipe',
      timeout: 10000,
    });
    expect(log.debug).toHaveBeenCalledWith('Container runtime already running');
  });

  it('attempts auto-start when status check fails, then succeeds', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('not running');
    });
    mockExecSync.mockReturnValueOnce('');

    ensureContainerRuntimeRunning();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} system start`, {
      stdio: 'pipe',
      timeout: 30000,
    });
    expect(log.info).toHaveBeenCalledWith('Container runtime started');
  });

  it('throws when both status and start fail', () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('runtime unavailable');
    });

    expect(() => ensureContainerRuntimeRunning()).toThrow('Container runtime is required but failed to start');
    expect(log.error).toHaveBeenCalled();
  });
});

// --- cleanupOrphans ---

describe('cleanupOrphans', () => {
  const [installKey, installVal] = CONTAINER_INSTALL_LABEL.split('=');

  it('lists all containers as JSON', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledWith(`${CONTAINER_RUNTIME_BIN} ls --all --format json`, expect.any(Object));
  });

  it('stops orphaned nanoclaw containers matching the install label (object label form)', () => {
    const rows = [
      {
        status: 'running',
        configuration: { id: 'nanoclaw-group1-111', labels: { [installKey]: installVal } },
      },
      {
        status: 'running',
        configuration: { id: 'nanoclaw-group2-222', labels: { [installKey]: installVal } },
      },
    ];
    mockExecSync.mockReturnValueOnce(JSON.stringify(rows));
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group1-111`, {
      stdio: 'pipe',
    });
    expect(mockExecSync).toHaveBeenNthCalledWith(3, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-group2-222`, {
      stdio: 'pipe',
    });
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-group1-111', 'nanoclaw-group2-222'],
    });
  });

  it('stops orphans with array-form labels', () => {
    const rows = [
      {
        status: 'running',
        configuration: {
          id: 'nanoclaw-a',
          labels: [{ key: installKey, value: installVal }],
        },
      },
    ];
    mockExecSync.mockReturnValueOnce(JSON.stringify(rows));
    mockExecSync.mockReturnValue('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(2);
    expect(mockExecSync).toHaveBeenNthCalledWith(2, `${CONTAINER_RUNTIME_BIN} stop -t 1 nanoclaw-a`, {
      stdio: 'pipe',
    });
  });

  it('skips containers from peer installs (different label value)', () => {
    const rows = [
      { status: 'running', configuration: { id: 'peer-install', labels: { [installKey]: 'other-install' } } },
      { status: 'running', configuration: { id: 'no-labels' } },
      { status: 'stopped', configuration: { id: 'mine-stopped', labels: { [installKey]: installVal } } },
    ];
    mockExecSync.mockReturnValueOnce(JSON.stringify(rows));

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('does nothing when ls returns empty output', () => {
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(1);
    expect(log.info).not.toHaveBeenCalled();
  });

  it('warns and continues when ls fails', () => {
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('container runtime not available');
    });

    cleanupOrphans();

    expect(log.warn).toHaveBeenCalledWith(
      'Failed to clean up orphaned containers',
      expect.objectContaining({ err: expect.any(Error) }),
    );
  });

  it('continues stopping remaining containers when one stop fails', () => {
    const rows = [
      { status: 'running', configuration: { id: 'nanoclaw-a-1', labels: { [installKey]: installVal } } },
      { status: 'running', configuration: { id: 'nanoclaw-b-2', labels: { [installKey]: installVal } } },
    ];
    mockExecSync.mockReturnValueOnce(JSON.stringify(rows));
    mockExecSync.mockImplementationOnce(() => {
      throw new Error('already stopped');
    });
    mockExecSync.mockReturnValueOnce('');

    cleanupOrphans();

    expect(mockExecSync).toHaveBeenCalledTimes(3);
    expect(log.info).toHaveBeenCalledWith('Stopped orphaned containers', {
      count: 2,
      names: ['nanoclaw-a-1', 'nanoclaw-b-2'],
    });
  });
});
