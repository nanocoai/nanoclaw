import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  runAuth: vi.fn(),
  runInstallCheck: vi.fn(),
  fail: vi.fn(),
  upsertEnvVar: vi.fn(),
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
  return { getSetupProvider: () => entry, listSetupProviders: () => [entry] };
});
vi.mock('./providers/skill-descriptor.js', () => ({
  getInstallableProviderDescriptor: () => undefined,
  listInstallableProviderDescriptors: () => [],
  providerImagePolicy: () => 'local-required',
}));
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
vi.mock('./lib/runner.js', () => ({ fail: fixture.fail }));
vi.mock('./set-env.js', () => ({ upsertEnvVar: fixture.upsertEnvVar }));
vi.mock('@clack/prompts', () => ({ intro: vi.fn(), cancel: vi.fn(), log: { error: vi.fn() } }));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '1');
  vi.stubEnv('NANOCLAW_BOOTSTRAPPED', '1');
  vi.stubEnv('NANOCLAW_AGENT_PROVIDER', 'opencode');
  vi.stubEnv(
    'NANOCLAW_SKIP',
    'environment,container,onecli,mounts,service,cli-agent,timezone,channel,verify,first-chat',
  );
  fixture.runAuth.mockResolvedValue(undefined);
  fixture.runInstallCheck.mockResolvedValue(undefined);
  fixture.fail.mockRejectedValue(new Error('failure assistance finished'));
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
    },
  );
});
