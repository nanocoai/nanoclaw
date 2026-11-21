import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  source: 'local' as 'local' | 'hardened',
  spawnSync: vi.fn(),
  runWindowedChild: vi.fn(),
}));
vi.mock('child_process', () => ({ spawnSync: fixture.spawnSync }));
vi.mock('./registry-state.js', () => ({
  HARDENED_IMAGE_ENV_KEY: 'NANOCLAW_HARDENED_IMAGE',
  readImageSource: () => fixture.source,
}));
vi.mock('./windowed-runner.js', () => ({ runWindowedChild: fixture.runWindowedChild }));

import { buildContainerImage, buildContainerImageWindowed } from './container-build.js';

const ROOT = '/install';
const SCRIPT = path.join(ROOT, 'container', 'build.sh');
const LABELS = { running: 'Rebuilding…', done: 'Rebuilt.' };
const RAW_LOG = 'logs/setup-steps/07-container-rebuild.log';

function windowedExit(res: { exitCode: number; signal?: string; error?: Error }): void {
  fixture.runWindowedChild.mockResolvedValue({
    ok: res.exitCode === 0 && !res.signal && !res.error,
    rawLog: RAW_LOG,
    ...res,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  fixture.source = 'local';
});

describe('buildContainerImageWindowed', () => {
  it('runs build.sh in the progress window, never on the terminal', async () => {
    windowedExit({ exitCode: 0 });

    await expect(buildContainerImageWindowed(LABELS, ROOT)).resolves.toEqual({ ok: true, rawLog: RAW_LOG });
    expect(fixture.runWindowedChild).toHaveBeenCalledWith('container-rebuild', SCRIPT, [], LABELS, { cwd: ROOT });
    expect(fixture.spawnSync).not.toHaveBeenCalled();
  });

  it('refuses a pinned image before building, with the same message and hint as the terminal build', async () => {
    fixture.source = 'hardened';

    const windowed = await buildContainerImageWindowed(LABELS, ROOT);
    expect(windowed).toEqual(buildContainerImage(ROOT));
    expect(windowed).toMatchObject({
      ok: false,
      message: expect.stringContaining('NANOCLAW_HARDENED_IMAGE=true'),
      hint: expect.stringContaining('./container/build.sh pull'),
    });
    expect(fixture.runWindowedChild).not.toHaveBeenCalled();
    expect(fixture.spawnSync).not.toHaveBeenCalled();
  });

  it.each([
    [{ exitCode: 1 }, 'The container image build failed (exit 1).', 'The build output above has the reason.'],
    [{ exitCode: 1, signal: 'SIGKILL' }, 'The container image build was terminated by SIGKILL.', 'killed for memory'],
    [{ exitCode: -2, error: new Error('spawn ENOENT') }, `Couldn't run ${SCRIPT}: spawn ENOENT`, 'executable'],
  ])('turns %o into the same failure the terminal build reports, plus the raw log', async (exit, message, hint) => {
    windowedExit(exit);
    fixture.spawnSync.mockReturnValue({ status: exit.signal ? null : exit.exitCode, ...exit });

    const windowed = await buildContainerImageWindowed(LABELS, ROOT);
    expect(windowed).toEqual({ ...buildContainerImage(ROOT), rawLog: RAW_LOG });
    expect(windowed).toMatchObject({ ok: false, message, hint: expect.stringContaining(hint), rawLog: RAW_LOG });
  });
});

describe('buildContainerImage', () => {
  // The standalone provider-auth step has no progress window; docker's own
  // output stays its progress indicator.
  it('keeps inheriting stdio', () => {
    fixture.spawnSync.mockReturnValue({ status: 0, signal: null });

    expect(buildContainerImage(ROOT)).toEqual({ ok: true });
    expect(fixture.spawnSync).toHaveBeenCalledWith(SCRIPT, [], { cwd: ROOT, stdio: 'inherit' });
    expect(fixture.runWindowedChild).not.toHaveBeenCalled();
  });
});
