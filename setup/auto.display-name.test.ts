import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The display name becomes part of the operator's agent folders. A name too
 * long for them is refused where it's given: the prompt asks again, a preset
 * stops setup, a saved one is not reused. One wizard run per case.
 */
const TOO_LONG = "That name is too long for your agent's folder. Use at most 54 characters.";

const fixture = vi.hoisted(() => ({
  fail: vi.fn(),
  text: vi.fn(),
  intro: vi.fn(),
  logError: vi.fn(),
  runQuietStep: vi.fn(),
  savedName: undefined as string | undefined,
  registered: false,
  askChannelChoice: vi.fn(),
  runInitialChannel: vi.fn(),
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => ({ getSetupProvider: () => undefined, listSetupProviders: () => [] }));
vi.mock('./providers/install.js', () => ({ applyProviderSkill: vi.fn() }));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.askChannelChoice }));
vi.mock('./channels/initial-setup.js', async (original) => ({
  ...(await original<typeof import('./channels/initial-setup.js')>()),
  runInitialChannel: fixture.runInitialChannel,
}));
// Keep a pending Slack job in the checkout from starting a real worker.
vi.mock('../src/community-portal/slack-job.js', async (original) => ({
  ...(await original<typeof import('../src/community-portal/slack-job.js')>()),
  withSetupLock: (run: () => Promise<unknown>) => run(),
  launchSlackJob: async () => false,
}));
vi.mock('./portal.js', () => ({
  portalEnabled: () => false,
  runImagePortal: vi.fn(),
  offerPortalReminder: vi.fn(async () => false),
}));
vi.mock('./lib/setup-config-parse.js', () => ({
  parseFlags: () => ({ help: false, errors: [], values: {} }),
  readFromEnv: () => ({}),
  applyToEnv: vi.fn(),
}));
vi.mock('./environment.js', () => ({
  readEnvKey: () => undefined,
  detectRegisteredGroups: async () => fixture.registered,
  detectExistingDisplayName: async () => fixture.savedName,
}));
vi.mock('./logs.js', () => ({ userInput: vi.fn(), step: vi.fn(), completedStepNames: () => [] }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  runQuietStep: fixture.runQuietStep,
}));
vi.mock('./set-env.js', () => ({ upsertEnvVar: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  intro: fixture.intro,
  cancel: vi.fn(),
  text: fixture.text,
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { error: fixture.logError, warn: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.savedName = undefined;
  fixture.registered = false;
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('USER', 'alex');
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'claude');
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', '');
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,gateway,auth,mounts,service,first-chat,timezone,channel,verify');
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.runQuietStep.mockResolvedValue({ ok: false });
  fixture.text.mockResolvedValue('Alex');
  fixture.runInitialChannel.mockRejectedValue(new Error('channel step reached'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
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

function cliAgentStepName(): string | undefined {
  const call = fixture.runQuietStep.mock.calls.find(([step]) => step === 'cli-agent');
  const args = call?.[2] as string[] | undefined;
  return args?.[args.indexOf('--display-name') + 1];
}

it('asks again, saying why, when the typed name is too long for the folder', async () => {
  await runWizardUntilExit();
  expect(fixture.text).toHaveBeenCalledOnce();
  const { validate } = fixture.text.mock.calls[0][0] as { validate: (v: string | undefined) => string | undefined };
  expect(validate('x'.repeat(55))).toBe(TOO_LONG);
  expect(validate('x'.repeat(54))).toBeUndefined();
  // Enter on an empty prompt takes the default, which is checked too.
  expect(validate('')).toBeUndefined();
  expect(cliAgentStepName()).toBe('Alex');
});

it('stops before any step when the preset display name is too long', async () => {
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'x'.repeat(55));
  await runWizardUntilExit();
  expect(fixture.logError).toHaveBeenCalledWith(`NANOCLAW_DISPLAY_NAME (--display-name): ${TOO_LONG}`);
  expect(fixture.intro).not.toHaveBeenCalled();
  expect(fixture.runQuietStep).not.toHaveBeenCalled();
});

it('uses a preset display name that fits without asking', async () => {
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'x'.repeat(54));
  await runWizardUntilExit();
  expect(fixture.text).not.toHaveBeenCalled();
  expect(cliAgentStepName()).toBe('x'.repeat(54));
});

it('asks instead of reusing a saved display name that is too long', async () => {
  fixture.savedName = 'x'.repeat(55);
  await runWizardUntilExit();
  expect(fixture.text).toHaveBeenCalledOnce();
  expect(cliAgentStepName()).toBe('Alex');
});

describe('with no terminal agent to create', () => {
  // Only the DM folder (dm-with-, one character shorter) has to fit.
  beforeEach(() => {
    vi.stubEnv('NANOCLAW_SKIP', 'environment,container,gateway,auth,mounts,service,cli-agent,timezone,verify');
    fixture.askChannelChoice.mockResolvedValue('telegram');
  });

  it('keeps a saved display name that fits the DM folder', async () => {
    // Reconnecting a channel then finds the DM agent the saved name already named.
    fixture.savedName = 'x'.repeat(55);
    await runWizardUntilExit();
    expect(fixture.text).not.toHaveBeenCalled();
    expect(fixture.runInitialChannel).toHaveBeenCalledWith('telegram', 'x'.repeat(55), expect.any(Function));
  });

  it('takes a preset that fits the DM folder', async () => {
    vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'x'.repeat(55));
    await runWizardUntilExit();
    expect(fixture.runInitialChannel).toHaveBeenCalledWith('telegram', 'x'.repeat(55), expect.any(Function));
  });

  it('takes a typed name that fits the DM folder', async () => {
    await runWizardUntilExit();
    const { validate } = fixture.text.mock.calls[0][0] as { validate: (v: string | undefined) => string | undefined };
    expect(validate('x'.repeat(55))).toBeUndefined();
    expect(validate('x'.repeat(56))).toBe("That name is too long for your agent's folder. Use at most 55 characters.");
  });
});

it('takes a preset that fits the DM folder on an install whose wired agents skip the terminal agent', async () => {
  fixture.registered = true;
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,gateway,auth,mounts,service,timezone,verify');
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'x'.repeat(55));
  fixture.askChannelChoice.mockResolvedValue('telegram');
  await runWizardUntilExit();
  expect(fixture.logError).not.toHaveBeenCalledWith(expect.stringContaining('NANOCLAW_DISPLAY_NAME'));
  expect(fixture.runInitialChannel).toHaveBeenCalledWith('telegram', 'x'.repeat(55), expect.any(Function));
});
