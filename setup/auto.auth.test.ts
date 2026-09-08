import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  runAuth: vi.fn(),
  runInstallCheck: vi.fn(),
  fail: vi.fn(),
  upsertEnvVar: vi.fn(),
  brightSelect: vi.fn(),
  applyProviderSkill: vi.fn(),
  opencodeInstalled: true,
}));
vi.mock('./providers/index.js', () => ({}));
vi.mock('./providers/registry.js', () => {
  const entry = {
    value: 'opencode',
    label: 'OpenCode',
    hint: '',
    runAuth: fixture.runAuth,
    runInstallCheck: fixture.runInstallCheck,
  };
  const claude = { ...entry, value: 'claude', label: 'Claude' };
  const entries = () => (fixture.opencodeInstalled ? [claude, entry] : [claude]);
  return {
    getSetupProvider: (name: string) => entries().find((provider) => provider.value === name),
    listSetupProviders: entries,
  };
});
vi.mock('./providers/install.js', () => ({ applyProviderSkill: fixture.applyProviderSkill }));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.brightSelect }));
vi.mock('./lib/registry-state.js', async (original) => ({
  ...(await original<typeof import('./lib/registry-state.js')>()),
  readImageSource: () => 'local',
}));
vi.mock('./lib/setup-config-parse.js', () => ({
  parseFlags: () => ({ help: false, errors: [], values: {} }),
  readFromEnv: () => ({}),
  applyToEnv: vi.fn(),
}));
vi.mock('./environment.js', () => ({ readEnvKey: () => undefined }));
vi.mock('./logs.js', () => ({ userInput: vi.fn() }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: fixture.fail,
}));
vi.mock('./set-env.js', () => ({ upsertEnvVar: fixture.upsertEnvVar }));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  log: { error: vi.fn() },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'opencode');
  vi.stubEnv('DEFAULT_AGENT_PROVIDER', 'claude');
  vi.stubEnv(
    'NANOCLAW_SKIP',
    'environment,container,onecli,mounts,service,cli-agent,timezone,channel,verify,first-chat',
  );
  fixture.runAuth.mockResolvedValue(undefined);
  fixture.runInstallCheck.mockResolvedValue(undefined);
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
  fixture.opencodeInstalled = true;
  fixture.brightSelect.mockResolvedValue('opencode');
  fixture.applyProviderSkill.mockRejectedValue(new Error('installation boundary'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('setup wizard provider authentication failures', () => {
  it.each(['runAuth', 'runInstallCheck'] as const)(
    'routes a %s error through assistance before aborting, without saving a default',
    async (callback) => {
      fixture[callback].mockRejectedValue(new Error(`${callback} failed`));
      let finish!: () => void;
      const exited = new Promise<void>((resolve) => {
        finish = resolve;
      });
      vi.spyOn(process, 'exit').mockImplementation((() => {
        finish();
      }) as typeof process.exit);
      await import('./auto.js');
      await exited;
      expect(fixture.runAuth).toHaveBeenCalledOnce();
      expect(fixture.fail).toHaveBeenCalledWith(
        'auth',
        "Couldn't authenticate or verify opencode.",
        `${callback} failed`,
      );
      expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
      expect(process.exit).toHaveBeenCalledWith(1);
      expect(fixture.brightSelect).not.toHaveBeenCalled();
    },
  );
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

describe('setup wizard interactive provider choice', () => {
  it.each(['claude', 'opencode'])(
    'offers a choice with %s highlighted when no provider is preset',
    async (currentDefault) => {
      vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
      vi.stubEnv('DEFAULT_AGENT_PROVIDER', currentDefault);
      fixture.runAuth.mockRejectedValue(new Error('authentication boundary'));

      await runWizardUntilExit();

      expect(fixture.brightSelect).toHaveBeenCalledWith(
        expect.objectContaining({
          message: 'Which agent runtime should power your assistant?',
          initialValue: currentDefault,
          options: expect.arrayContaining([
            expect.objectContaining({ value: 'claude' }),
            expect.objectContaining({ value: 'opencode' }),
          ]),
        }),
      );
      expect(fixture.fail).toHaveBeenCalledWith(
        'auth',
        "Couldn't authenticate or verify opencode.",
        'authentication boundary',
      );
      expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
    },
  );

  it('offers an uninstalled OpenCode skill on a fresh install and applies the selected skill', async () => {
    vi.stubEnv('NANOCLAW_AGENT_PROVIDER', '');
    fixture.opencodeInstalled = false;
    fixture.runAuth.mockRejectedValue(new Error('unexpected Claude authentication'));

    await runWizardUntilExit();

    expect(fixture.brightSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialValue: 'claude',
        options: expect.arrayContaining([
          expect.objectContaining({
            value: 'opencode',
            label: 'OpenCode',
            hint: expect.stringContaining('installs now'),
          }),
        ]),
      }),
    );
    expect(fixture.applyProviderSkill).toHaveBeenCalledWith('.claude/skills/add-opencode', process.cwd());
    expect(fixture.fail).toHaveBeenCalledWith('add-opencode', "Couldn't install opencode.", 'installation boundary');
    expect(fixture.runAuth).not.toHaveBeenCalled();
    expect(fixture.upsertEnvVar).not.toHaveBeenCalled();
  });
});
