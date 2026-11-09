import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  select: vi.fn(),
  runSkill: vi.fn(async () => ({ deferred: [], agentTasks: [] })),
  detected: undefined as string | undefined,
}));
vi.mock('./lib/bright-select.js', () => ({ brightSelect: fixture.select }));
vi.mock('./lib/skill-driver.js', () => ({ runSkill: fixture.runSkill }));
vi.mock('./gateways/selection.js', async (original) => ({
  ...(await original<typeof import('./gateways/selection.js')>()),
  detectInstalledGateway: () => fixture.detected,
  isGatewayInstalled: () => false,
}));
vi.mock('./gateways/catalog.js', () => ({
  loadGatewayCatalog: () => ({
    default: 'onecli',
    gateways: ['onecli', 'iron-proxy'].map((kind) => ({ kind, label: kind, skillPath: `/skills/${kind}` })),
  }),
}));
vi.mock('./lib/setup-config-parse.js', async (original) => ({
  ...(await original<typeof import('./lib/setup-config-parse.js')>()),
  parseFlags: () => ({ help: false, errors: [], values: {} }),
}));
vi.mock('../src/community-portal/slack-job.js', () => ({
  withSetupLock: (run: () => Promise<void>) => run(),
  launchSlackJob: async () => {},
}));
vi.mock('./logs.js', () => ({ reset: vi.fn(), userInput: vi.fn() }));
vi.mock('./lib/diagnostics.js', () => ({ emit: vi.fn() }));
vi.mock('./lib/runner.js', async (original) => ({
  ...(await original<typeof import('./lib/runner.js')>()),
  fail: async () => {
    throw new Error('test stops after gateway installation');
  },
}));
vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  cancel: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  log: {
    message: vi.fn(),
    error: vi.fn(),
    success: () => {
      throw new Error('gateway boundary');
    },
  },
}));

let root: string;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'wizard-gateway-'));
  vi.spyOn(process, 'cwd').mockReturnValue(root);
  vi.stubEnv('PATH', process.env.PATH);
  vi.stubEnv('NANOCLAW_REEXEC_SG', '');
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', '');
  vi.stubEnv('NANOCLAW_TEMPLATE_PATH', '');
  vi.stubEnv('NANOCLAW_SKIP', 'environment,container,auth,mounts,service,cli-agent,timezone,channel,verify,first-chat');
  fixture.detected = undefined;
  fixture.select.mockResolvedValueOnce('advanced').mockResolvedValueOnce('__done__');
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});

async function runWizard(): Promise<void> {
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

describe('Advanced gateway selection through the real wizard', () => {
  it.each([undefined, 'iron-proxy'])('Done preserves the saved Iron gateway when detected as %s', async (detected) => {
    fixture.detected = detected;
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_GATEWAY_PROVIDER=iron-proxy\n');
    await runWizard();
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/iron-proxy', expect.anything());
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('NANOCLAW_GATEWAY_PROVIDER=iron-proxy');
    expect(fixture.select).toHaveBeenCalledTimes(2);
  });

  it('Done preserves an unstamped detected gateway', async () => {
    fixture.detected = 'iron-proxy';
    await runWizard();
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/iron-proxy', expect.anything());
  });

  it('Done keeps the default for a fresh install', async () => {
    await runWizard();
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/onecli', expect.anything());
  });

  it('allows an explicit Advanced change to replace the saved choice', async () => {
    fs.writeFileSync(path.join(root, '.env'), 'NANOCLAW_GATEWAY_PROVIDER=iron-proxy\n');
    fixture.select
      .mockReset()
      .mockResolvedValueOnce('advanced')
      .mockResolvedValueOnce('gatewayProvider')
      .mockResolvedValueOnce('onecli')
      .mockResolvedValueOnce('__done__');
    await runWizard();
    expect(fixture.runSkill).toHaveBeenCalledWith('/skills/onecli', expect.anything());
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toContain('NANOCLAW_GATEWAY_PROVIDER=onecli');
  });
});
