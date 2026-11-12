import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  platform: 'linux' as 'linux' | 'macos',
  root: false,
  hasSudo: true,
  /** Exit code of `sudo -n true`. */
  cached: 1,
  /** Exit code of the foreground `sudo -v`. */
  validate: 0,
  hasDocker: true,
  /** Exit code of `docker info`. */
  dockerInfo: 0,
  /** What `docker info` prints to stderr. */
  dockerStderr: '',
  spawnSync: vi.fn(),
  runInheritScript: vi.fn(),
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  spawnSync: fixture.spawnSync,
}));
vi.mock('../platform.js', () => ({
  getPlatform: () => fixture.platform,
  isRoot: () => fixture.root,
  commandExists: (name: string) => (name === 'docker' ? fixture.hasDocker : name === 'sudo' && fixture.hasSudo),
}));
vi.mock('./inherit-script.js', () => ({ runInheritScript: fixture.runInheritScript }));

import { SUDO_PROMPT, dockerSudoReason, sudoUpFront } from './sudo-preflight.js';

const stdinTTY = process.stdin.isTTY;
beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(fixture, {
    platform: 'linux',
    root: false,
    hasSudo: true,
    cached: 1,
    validate: 0,
    hasDocker: true,
    dockerInfo: 0,
    dockerStderr: '',
  });
  fixture.spawnSync.mockImplementation((cmd: string) =>
    cmd === 'docker'
      ? { status: fixture.dockerInfo, stdout: '', stderr: fixture.dockerStderr }
      : { status: fixture.cached },
  );
  fixture.runInheritScript.mockImplementation(async () => fixture.validate);
  process.stdin.isTTY = true;
});
afterEach(() => {
  process.stdin.isTTY = stdinTTY;
});

describe('sudoUpFront', () => {
  it('explains, then asks for the password in the foreground', async () => {
    const explain = vi.fn();
    expect(await sudoUpFront(explain)).toBe('granted');
    expect(fixture.spawnSync).toHaveBeenCalledWith('sudo', ['-n', 'true'], { stdio: 'ignore' });
    expect(explain).toHaveBeenCalledOnce();
    expect(fixture.runInheritScript).toHaveBeenCalledWith('sudo', ['-v', '-p', SUDO_PROMPT]);
    expect(explain.mock.invocationCallOrder[0]).toBeLessThan(fixture.runInheritScript.mock.invocationCallOrder[0]);
  });

  it('reports a refused password', async () => {
    fixture.validate = 1;
    expect(await sudoUpFront(vi.fn())).toBe('refused');
  });

  it('stays quiet when sudo needs no password', async () => {
    fixture.cached = 0;
    const explain = vi.fn();
    expect(await sudoUpFront(explain)).toBe('not-needed');
    expect(explain).not.toHaveBeenCalled();
    expect(fixture.runInheritScript).not.toHaveBeenCalled();
  });

  it.each([
    ['root', () => (fixture.root = true)],
    ['macOS', () => (fixture.platform = 'macos')],
    ['no sudo installed', () => (fixture.hasSudo = false)],
    ['no terminal', () => (process.stdin.isTTY = false)],
  ])('never touches sudo for %s', async (_name, arrange) => {
    arrange();
    const explain = vi.fn();
    expect(await sudoUpFront(explain)).toBe('not-needed');
    expect(fixture.spawnSync).not.toHaveBeenCalled();
    expect(fixture.runInheritScript).not.toHaveBeenCalled();
    expect(explain).not.toHaveBeenCalled();
  });
});

describe('dockerSudoReason', () => {
  it('is install when Docker is missing', () => {
    fixture.hasDocker = false;
    expect(dockerSudoReason()).toBe('install');
    expect(fixture.spawnSync).not.toHaveBeenCalled();
  });

  // The container step runs `sudo systemctl start docker` (and `usermod` when
  // needed) whenever `docker info` fails, not only on a fresh install.
  it('is start when Docker is installed but not reachable', () => {
    fixture.dockerInfo = 1;
    fixture.dockerStderr =
      'Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?';
    expect(dockerSudoReason()).toBe('start');
    expect(fixture.spawnSync).toHaveBeenCalledWith('docker', ['info'], expect.objectContaining({ timeout: 15_000 }));
  });

  // Docker runs but the user isn't in the docker group (or the session
  // predates joining it). The step still uses sudo, for `usermod`.
  it('is group when the Docker socket refuses the user', () => {
    fixture.dockerInfo = 1;
    fixture.dockerStderr =
      'permission denied while trying to connect to the Docker daemon socket at unix:///var/run/docker.sock: Get "http://%2Fvar%2Frun%2Fdocker.sock/v1.47/info": dial unix /var/run/docker.sock: connect: permission denied';
    expect(dockerSudoReason()).toBe('group');
  });

  it('leaves a probe that timed out to the step, as before', () => {
    fixture.spawnSync.mockImplementation(() => ({ status: null, error: new Error('spawnSync docker ETIMEDOUT') }));
    expect(dockerSudoReason()).toBeUndefined();
  });

  it('is nothing when Docker answers', () => {
    expect(dockerSudoReason()).toBeUndefined();
  });

  it.each([
    ['root', () => (fixture.root = true)],
    ['macOS', () => (fixture.platform = 'macos')],
  ])('is nothing for %s, without probing Docker', (_name, arrange) => {
    arrange();
    fixture.hasDocker = false;
    expect(dockerSudoReason()).toBeUndefined();
    expect(fixture.spawnSync).not.toHaveBeenCalled();
  });
});
