import { execSync } from 'child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forceRemoveContainer, reapUntrackedForFolder } from './container-runtime.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

const execSyncMock = vi.mocked(execSync);

describe('reapUntrackedForFolder', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('force-removes every untracked container and returns their names', () => {
    execSyncMock.mockReturnValueOnce('nanoclaw-v2-dm-with-robby-100\nnanoclaw-v2-dm-with-robby-200\n' as never);

    expect(reapUntrackedForFolder('dm-with-robby', new Set())).toEqual([
      'nanoclaw-v2-dm-with-robby-100',
      'nanoclaw-v2-dm-with-robby-200',
    ]);
    expect(execSyncMock).toHaveBeenNthCalledWith(2, 'docker rm -f nanoclaw-v2-dm-with-robby-100', { stdio: 'pipe' });
    expect(execSyncMock).toHaveBeenNthCalledWith(3, 'docker rm -f nanoclaw-v2-dm-with-robby-200', { stdio: 'pipe' });
  });

  it('leaves tracked containers running and removes only the untracked one', () => {
    execSyncMock.mockReturnValueOnce('nanoclaw-v2-dm-with-robby-100\nnanoclaw-v2-dm-with-robby-200\n' as never);

    expect(reapUntrackedForFolder('dm-with-robby', new Set(['nanoclaw-v2-dm-with-robby-100']))).toEqual([
      'nanoclaw-v2-dm-with-robby-200',
    ]);
    expect(execSyncMock).toHaveBeenCalledTimes(2);
    expect(execSyncMock).toHaveBeenLastCalledWith('docker rm -f nanoclaw-v2-dm-with-robby-200', { stdio: 'pipe' });
  });

  it('returns an empty list when docker ps throws', () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('runtime unavailable');
    });

    expect(reapUntrackedForFolder('dm-with-robby', new Set())).toEqual([]);
    expect(execSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('forceRemoveContainer', () => {
  beforeEach(() => {
    execSyncMock.mockReset();
  });

  it('swallows a throwing docker rm -f', () => {
    execSyncMock.mockImplementationOnce(() => {
      throw new Error('already gone');
    });

    expect(() => forceRemoveContainer('nanoclaw-v2-dm-with-robby-100')).not.toThrow();
  });
});
