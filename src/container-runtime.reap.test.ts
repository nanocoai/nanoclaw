import { execFileSync } from 'child_process';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { forceRemoveContainer, reapUntrackedForFolder } from './container-runtime.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

const execFileSyncMock = vi.mocked(execFileSync);

describe('reapUntrackedForFolder', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('force-removes every untracked container and returns their names', () => {
    execFileSyncMock.mockReturnValueOnce('nanoclaw-v2-dm-with-robby-100\nnanoclaw-v2-dm-with-robby-200\n' as never);

    expect(reapUntrackedForFolder('dm-with-robby', new Set())).toEqual([
      'nanoclaw-v2-dm-with-robby-100',
      'nanoclaw-v2-dm-with-robby-200',
    ]);
    // first execFileSync call is the `docker ps` query
    expect(execFileSyncMock.mock.calls[0][0]).toBe('docker');
    expect(execFileSyncMock.mock.calls[0][1]).toEqual(
      expect.arrayContaining(['ps', '--filter', 'name=nanoclaw-v2-dm-with-robby-', '--format', '{{.Names}}']),
    );
    // subsequent calls force-remove each untracked container via argument vector
    expect(execFileSyncMock).toHaveBeenNthCalledWith(2, 'docker', ['rm', '-f', 'nanoclaw-v2-dm-with-robby-100'], { stdio: 'pipe' });
    expect(execFileSyncMock).toHaveBeenNthCalledWith(3, 'docker', ['rm', '-f', 'nanoclaw-v2-dm-with-robby-200'], { stdio: 'pipe' });
  });

  it('leaves tracked containers running and removes only the untracked one', () => {
    execFileSyncMock.mockReturnValueOnce('nanoclaw-v2-dm-with-robby-100\nnanoclaw-v2-dm-with-robby-200\n' as never);

    expect(reapUntrackedForFolder('dm-with-robby', new Set(['nanoclaw-v2-dm-with-robby-100']))).toEqual([
      'nanoclaw-v2-dm-with-robby-200',
    ]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(2);
    expect(execFileSyncMock).toHaveBeenLastCalledWith('docker', ['rm', '-f', 'nanoclaw-v2-dm-with-robby-200'], { stdio: 'pipe' });
  });

  it('returns an empty list when docker ps throws', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('runtime unavailable');
    });

    expect(reapUntrackedForFolder('dm-with-robby', new Set())).toEqual([]);
    expect(execFileSyncMock).toHaveBeenCalledTimes(1);
  });
});

describe('forceRemoveContainer', () => {
  beforeEach(() => {
    execFileSyncMock.mockReset();
  });

  it('swallows a throwing docker rm -f', () => {
    execFileSyncMock.mockImplementationOnce(() => {
      throw new Error('already gone');
    });

    expect(() => forceRemoveContainer('nanoclaw-v2-dm-with-robby-100')).not.toThrow();
  });
});
