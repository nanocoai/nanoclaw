import { describe, expect, it, vi } from 'vitest';

vi.mock('child_process', () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({
    stderr: { on: vi.fn() },
    stdout: { on: vi.fn() },
    on: vi.fn(),
    kill: vi.fn(),
  })),
}));

import { spawn } from 'child_process';

import { realCli } from './cli.js';

describe('realCli.start', () => {
  it('detaches the supervision process from the host process group', () => {
    // A service manager restarting the host signals the host's WHOLE group,
    // and `docker start --attach` forwards signals into the container — an
    // undetached helper turns every host restart into the death of every
    // `--rm` container, erasing the sessions adoption exists to preserve.
    // (A launchd/systemd restart cannot be simulated in-suite; this pins the
    // spawn option the behavior depends on.)
    realCli('docker').start(['start', '--attach', 'ncl-x']);

    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      'docker',
      ['start', '--attach', 'ncl-x'],
      expect.objectContaining({ detached: true }),
    );
  });
});
