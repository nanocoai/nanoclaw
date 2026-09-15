import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectInstalledGateway: vi.fn<() => string | undefined>(),
  isGatewayInstalled: vi.fn<() => boolean>(),
  runSkill: vi.fn(async () => ({ deferred: [], agentTasks: [] })),
  upsertEnvVar: vi.fn(),
}));

vi.mock('../../scripts/skill-apply.js', () => ({ fullyApplied: () => true }));
vi.mock('../lib/skill-driver.js', () => ({ runSkill: mocks.runSkill }));
vi.mock('../set-env.js', () => ({ upsertEnvVar: mocks.upsertEnvVar }));
vi.mock('./selection.js', () => ({
  detectInstalledGateway: mocks.detectInstalledGateway,
  isGatewayInstalled: mocks.isGatewayInstalled,
}));
vi.mock('./catalog.js', () => ({
  loadGatewayCatalog: () => ({
    default: 'iron-proxy',
    gateways: [
      { kind: 'iron-proxy', label: 'Iron Proxy', description: 'Iron', skillPath: '/skills/iron-proxy' },
      { kind: 'onecli', label: 'OneCLI', description: 'OneCLI', skillPath: '/skills/onecli' },
    ],
  }),
}));

import { installGateway } from './install.js';

beforeEach(() => {
  vi.clearAllMocks();
  mocks.detectInstalledGateway.mockReturnValue(undefined);
  mocks.isGatewayInstalled.mockReturnValue(false);
});

describe('gateway installation', () => {
  it('preserves a detected gateway instead of replacing it with the catalog default', async () => {
    mocks.detectInstalledGateway.mockReturnValue('onecli');
    mocks.isGatewayInstalled.mockReturnValue(true);

    await installGateway(undefined, '/install');

    expect(mocks.runSkill.mock.calls.map(([, options]) => options.mode)).toEqual(['refresh', 'install']);
    expect(mocks.upsertEnvVar).toHaveBeenCalledWith('NANOCLAW_GATEWAY_PROVIDER', 'onecli', '/install');
  });

  it('runs the full install path when the selected gateway is absent', async () => {
    await installGateway('iron-proxy', '/install');

    expect(mocks.runSkill).toHaveBeenCalledWith('/skills/iron-proxy', expect.objectContaining({ mode: 'install' }));
    expect(mocks.detectInstalledGateway).not.toHaveBeenCalled();
  });

  it('can materialize a staged gateway without touching runtime state or env', async () => {
    await installGateway('onecli', '/stage', { mode: 'refresh', stamp: false });

    expect(mocks.runSkill).toHaveBeenCalledWith('/skills/onecli', expect.objectContaining({ mode: 'refresh' }));
    expect(mocks.runSkill).toHaveBeenCalledTimes(1);
    expect(mocks.isGatewayInstalled).not.toHaveBeenCalled();
    expect(mocks.upsertEnvVar).not.toHaveBeenCalled();
  });
});
