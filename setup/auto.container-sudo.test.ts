import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The container step installs or starts Docker with sudo inside a windowed
 * step, where sudo's prompt is hidden. The wizard asks for sudo first when
 * the step will need it, and its docker-group hint has to match the platform.
 * One wizard process per case, stopped at the container step.
 */
const fixture = vi.hoisted(() => ({
  fail: vi.fn(),
  runWindowedStep: vi.fn(),
  sudoUpFront: vi.fn(),
  message: vi.fn(),
  dockerSudo: 'install' as 'install' | 'start' | 'group' | undefined,
  wsl: false,
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => ({ getSetupProvider: () => undefined, listSetupProviders: () => [] }));
vi.mock('./providers/install.js', () => ({ applyProviderSkill: vi.fn() }));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: vi.fn() }));
vi.mock('./portal.js', () => ({ portalEnabled: () => false, runImagePortal: vi.fn(), offerPortalReminder: vi.fn() }));
vi.mock('./lib/registry-state.js', async (original) => ({
  ...(await original<typeof import('./lib/registry-state.js')>()),
  imageSourceDecided: () => true,
  readImageSource: () => 'local',
}));
vi.mock('./lib/setup-config-parse.js', () => ({
  parseFlags: () => ({ help: false, errors: [], values: {} }),
  readFromEnv: () => ({}),
  applyToEnv: vi.fn(),
}));
vi.mock('./environment.js', () => ({
  readEnvKey: () => undefined,
  detectRegisteredGroups: async () => false,
  detectExistingDisplayName: async () => undefined,
}));
vi.mock('../src/community-portal/slack-job.js', () => ({
  withSetupLock: (run: () => Promise<void>) => run(),
  launchSlackJob: async () => {},
}));
vi.mock('./logs.js', () => ({ userInput: vi.fn(), step: vi.fn(), completedStepNames: () => [] }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
}));
vi.mock('./lib/windowed-runner.js', () => ({ runWindowedStep: fixture.runWindowedStep }));
vi.mock('./lib/sudo-preflight.js', () => ({
  sudoUpFront: fixture.sudoUpFront,
  dockerSudoReason: () => fixture.dockerSudo,
}));
vi.mock('./platform.js', async (original) => ({
  ...(await original<typeof import('./platform.js')>()),
  isWSL: () => fixture.wsl,
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: fixture.message },
}));

// Each fresh import of the wizard adds src/log.ts's process handlers again.
const processEvents: NodeJS.EventEmitter = process;
const processHandlers = ['uncaughtException', 'unhandledRejection'].map(
  (event) => [event, processEvents.listeners(event)] as const,
);

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.dockerSudo = 'install';
  fixture.wsl = false;
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_SKIP', 'environment');
  vi.stubEnv('WSL_DISTRO_NAME', '');
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.sudoUpFront.mockImplementation(async (explain: () => void) => {
    explain();
    return 'granted';
  });
  fixture.runWindowedStep.mockResolvedValue({ ok: false, terminal: { fields: {} } });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const [event, kept] of processHandlers) {
    for (const handler of processEvents.listeners(event)) {
      if (!kept.includes(handler)) processEvents.off(event, handler as (...args: unknown[]) => void);
    }
  }
});

async function runWizardUntilExit(): Promise<void> {
  let finish!: () => void;
  const exited = new Promise<void>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(process, 'exit').mockImplementation((() => {
    finish();
  }) as typeof process.exit);
  await import('./auto.js');
  await exited;
}

describe('container step: sudo up front', () => {
  it('asks for sudo before the step when Docker is missing', async () => {
    await runWizardUntilExit();
    expect(fixture.sudoUpFront).toHaveBeenCalledOnce();
    expect(fixture.message).toHaveBeenCalledWith(expect.stringContaining('Setup needs to install Docker'));
    expect(fixture.runWindowedStep).toHaveBeenCalledWith('container', expect.anything());
    expect(fixture.sudoUpFront.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.runWindowedStep.mock.invocationCallOrder[0],
    );
  });

  it('asks too when Docker is installed but the step will have to start it', async () => {
    fixture.dockerSudo = 'start';
    await runWizardUntilExit();
    expect(fixture.message).toHaveBeenCalledWith(expect.stringContaining('Setup needs to start Docker'));
    expect(fixture.sudoUpFront.mock.invocationCallOrder[0]).toBeLessThan(
      fixture.runWindowedStep.mock.invocationCallOrder[0],
    );
  });

  it('does not ask when Docker already answers', async () => {
    fixture.dockerSudo = undefined;
    await runWizardUntilExit();
    expect(fixture.sudoUpFront).not.toHaveBeenCalled();
    expect(fixture.runWindowedStep).toHaveBeenCalledWith('container', expect.anything());
  });

  // `group`: Docker runs but its socket refuses the user, so the step will
  // `usermod` them into the docker group.
  it.each([
    ['install', 'install Docker', 'install Docker yourself first'],
    ['start', 'start Docker', 'start Docker yourself first'],
    [
      'group',
      'add you to the docker group',
      'add yourself to the docker group and run setup from a `newgrp docker` shell',
    ],
  ] as const)('explains, then stops before the step when sudo for %s is refused', async (reason, task, diy) => {
    fixture.dockerSudo = reason;
    fixture.sudoUpFront.mockImplementation(async (explain: () => void) => {
      explain();
      return 'refused';
    });
    await runWizardUntilExit();
    expect(fixture.message.mock.calls.map(([text]) => String(text).replace(/\s+/g, ' '))).toContain(
      `Setup needs to ${task}, so it will ask for your Linux password (sudo).`,
    );
    expect(fixture.fail).toHaveBeenCalledWith(
      'container',
      `Couldn't get sudo access to ${task}.`,
      `Run setup again and enter your Linux password, or ${diy}.`,
    );
    expect(fixture.runWindowedStep).not.toHaveBeenCalled();
  });
});

describe('container step: docker group not active', () => {
  beforeEach(() => {
    fixture.dockerSudo = undefined;
    fixture.runWindowedStep.mockResolvedValue({
      ok: false,
      terminal: { fields: { ERROR: 'docker_group_not_active' } },
    });
  });

  it('keeps the log-out hint off WSL', async () => {
    await runWizardUntilExit();
    expect(fixture.fail).toHaveBeenCalledWith(
      'container',
      "Docker was just installed but your shell doesn't know yet.",
      'Log out and back in (or run `newgrp docker` in a new shell), then retry.',
    );
  });

  it('tells WSL users to shut WSL down, since logging out does not refresh groups there', async () => {
    fixture.wsl = true;
    await runWizardUntilExit();
    expect(fixture.fail).toHaveBeenCalledWith(
      'container',
      "Docker was just installed but your shell doesn't know yet.",
      'Close Ubuntu, run `wsl --shutdown` in PowerShell, then reopen Ubuntu, go back to the NanoClaw folder and run `bash nanoclaw.sh`.',
    );
  });

  it('names the WSL distro when WSL reports it', async () => {
    fixture.wsl = true;
    vi.stubEnv('WSL_DISTRO_NAME', 'Debian');
    await runWizardUntilExit();
    expect(fixture.fail).toHaveBeenCalledWith(
      'container',
      expect.any(String),
      'Close Debian, run `wsl --shutdown` in PowerShell, then reopen Debian, go back to the NanoClaw folder and run `bash nanoclaw.sh`.',
    );
  });
});
