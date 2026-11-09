import { afterEach, beforeEach, expect, it, vi } from 'vitest';

/**
 * The Echo perk reminder re-offers the sandbox-image question and is only for
 * a run that never reached it. The answer lives in `.env`; a resumed run and a
 * plain re-run are fresh processes that skip the question, so the reminder
 * has to read it from there. One wizard process per case, aborted at the
 * cli-agent step.
 */
const fixture = vi.hoisted(() => ({
  fail: vi.fn(),
  offerPortalReminder: vi.fn(),
  /** Whether `.env` already holds an answer. */
  decided: false,
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => ({ getSetupProvider: () => undefined, listSetupProviders: () => [] }));
vi.mock('./providers/install.js', () => ({ applyProviderSkill: vi.fn() }));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: vi.fn() }));
vi.mock('./portal.js', () => ({
  portalEnabled: () => true,
  runImagePortal: vi.fn(),
  offerPortalReminder: fixture.offerPortalReminder,
}));
vi.mock('./lib/registry-state.js', async (original) => ({
  ...(await original<typeof import('./lib/registry-state.js')>()),
  readAgentImagePin: () => 'reg.example.test/nanoclaw/agent@sha256:abc',
  imageSourceDecided: () => fixture.decided,
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
vi.mock('./logs.js', () => ({ userInput: vi.fn(), step: vi.fn(), completedStepNames: () => [] }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
  runQuietStep: vi.fn(async () => ({ ok: false })),
}));
vi.mock('./set-env.js', () => ({ upsertEnvVar: vi.fn() }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), message: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  fixture.decided = false;
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'claude');
  vi.stubEnv('NANOCLAW_DISPLAY_NAME', 'Operator');
  // Every step but the terminating cli-agent step; the container step, where
  // the question is asked, is skipped as on any re-entry.
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,gateway,auth,mounts,service,first-chat,timezone,channel,verify');
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.offerPortalReminder.mockResolvedValue(false);
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
  expect(fixture.fail).toHaveBeenCalledWith('cli-agent', expect.any(String), expect.any(String));
}

it('does not re-offer Echo on a re-entered run once the sandbox-image question has an answer in .env', async () => {
  fixture.decided = true;
  await runWizardUntilExit();
  expect(fixture.offerPortalReminder).not.toHaveBeenCalled();
});

it('still offers Echo once to a run that never reached the question', async () => {
  await runWizardUntilExit();
  expect(fixture.offerPortalReminder).toHaveBeenCalledExactlyOnceWith('echo', expect.any(Function));
});
