import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The first-chat ping is the only setup check that exercises the path the
// agent really uses (container, gateway, model). Its outcome belongs in
// setup.log next to the steps that claimed success before it.
const fixture = vi.hoisted(() => ({
  step: vi.fn(),
  ping: vi.fn(),
  offerClaudeOnFailure: vi.fn(),
  runQuietStep: vi.fn(),
  brightSelect: vi.fn(),
}));
vi.mock('./providers/index.js', () => ({}));
// Importing the wizard takes the setup lock and resumes a saved Slack job in
// the checkout's data/; neither may touch the real checkout from a test.
vi.mock('../src/community-portal/slack-job.js', () => ({
  withSetupLock: (run: () => Promise<void>) => run(),
  launchSlackJob: async () => false,
  readSlackJob: async () => null,
  slackJobStatus: () => null,
}));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.brightSelect }));
vi.mock('./lib/setup-config-parse.js', () => ({
  parseFlags: () => ({ help: false, errors: [], values: {} }),
  readFromEnv: () => ({}),
  applyToEnv: vi.fn(),
}));
vi.mock('./environment.js', () => ({
  readEnvKey: () => undefined,
  detectRegisteredGroups: async () => false,
  detectExistingDisplayName: async () => 'Operator',
}));
vi.mock('./logs.js', () => ({
  userInput: vi.fn(),
  step: fixture.step,
  stepRawLog: (name: string) => `logs/setup-steps/${name}.log`,
}));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/agent-ping.js', () => ({ pingCliAgent: fixture.ping, PING_AGENT_FOLDER: 'ping_test' }));
vi.mock('./lib/claude-handoff.js', () => ({ offerClaudeOnFailure: fixture.offerClaudeOnFailure }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  runQuietStep: fixture.runQuietStep,
  spawnQuiet: async () => ({ ok: true, exitCode: 0 }),
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn(), message: vi.fn() }),
  log: { error: vi.fn(), info: vi.fn(), success: vi.fn(), warn: vi.fn(), step: vi.fn(), message: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,gateway,auth,mounts,echo-reminder,service');
  fixture.runQuietStep.mockResolvedValue({ ok: true });
  // End the run right after the ping branch; later steps are out of scope.
  fixture.offerClaudeOnFailure.mockRejectedValue(new Error('failure assistance finished'));
  fixture.brightSelect.mockRejectedValue(new Error('first-chat boundary'));
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

function firstChatSteps() {
  return fixture.step.mock.calls.filter(([name]) => name === 'first-chat');
}

describe('setup wizard first-chat ping', () => {
  it('records a failed ping in setup.log', async () => {
    fixture.ping.mockResolvedValue('no_reply');

    await runWizardUntilExit();

    expect(fixture.ping).toHaveBeenCalledOnce();
    expect(firstChatSteps()).toEqual([['first-chat', 'failed', expect.any(Number), { RESULT: 'no_reply' }]]);
  });

  it('records a successful ping', async () => {
    fixture.ping.mockResolvedValue('ok');

    await runWizardUntilExit();

    expect(fixture.ping).toHaveBeenCalledOnce();
    expect(firstChatSteps()).toEqual([['first-chat', 'success', expect.any(Number), { RESULT: 'ok' }]]);
  });
});
