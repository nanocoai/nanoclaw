import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  detectInstalledGateway: vi.fn<() => string | undefined>(),
  isGatewayInstalled: vi.fn<() => boolean>(),
  runSkill: vi.fn(async () => ({ deferred: [], agentTasks: [] })),
  upsertEnvVar: vi.fn(),
}));

vi.mock('../../scripts/skill-apply.js', () => ({ fullyApplied: () => true }));
vi.mock('../lib/skill-driver.js', () => ({ runSkill: mocks.runSkill }));
vi.mock('../set-env.js', () => ({ upsertEnvVar: mocks.upsertEnvVar }));
vi.mock('./selection.js', async (original) => ({
  ...(await original<typeof import('./selection.js')>()),
  detectInstalledGateway: mocks.detectInstalledGateway,
  isGatewayInstalled: mocks.isGatewayInstalled,
}));
vi.mock('./catalog.js', () => ({
  loadGatewayCatalog: () => ({
    default: 'onecli',
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

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function stampedInstall(kind: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-install-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, '.env'), `NANOCLAW_GATEWAY_PROVIDER=${kind}\n`);
  return root;
}

describe('gateway installation', () => {
  it('preserves the saved gateway when its service is stopped and no process override is present', async () => {
    const root = stampedInstall('iron-proxy');
    await installGateway(undefined, root);
    expect(mocks.runSkill).toHaveBeenCalledWith('/skills/iron-proxy', expect.objectContaining({ mode: 'install' }));
    expect(mocks.upsertEnvVar).toHaveBeenCalledWith('NANOCLAW_GATEWAY_PROVIDER', 'iron-proxy', root);
    expect(mocks.detectInstalledGateway).not.toHaveBeenCalled();
  });

  it('does not replace an unknown saved gateway with the default', async () => {
    const root = stampedInstall('missing-provider');
    await expect(installGateway(undefined, root)).rejects.toThrow('Unknown gateway provider');
    expect(mocks.runSkill).not.toHaveBeenCalled();
    expect(mocks.upsertEnvVar).not.toHaveBeenCalled();
  });

  it('allows an explicit selection to override the saved gateway', async () => {
    const root = stampedInstall('iron-proxy');
    await installGateway('onecli', root);
    expect(mocks.runSkill).toHaveBeenCalledWith('/skills/onecli', expect.objectContaining({ mode: 'install' }));
  });

  it('installs the catalog default for standard setup on a fresh copy', async () => {
    await installGateway(undefined, '/install');

    expect(mocks.runSkill).toHaveBeenCalledWith('/skills/onecli', expect.objectContaining({ mode: 'install' }));
    expect(mocks.upsertEnvVar).toHaveBeenCalledWith('NANOCLAW_GATEWAY_PROVIDER', 'onecli', '/install');
  });

  it('preserves a detected gateway instead of replacing it with the catalog default', async () => {
    mocks.detectInstalledGateway.mockReturnValue('iron-proxy');
    mocks.isGatewayInstalled.mockReturnValue(true);

    await installGateway(undefined, '/install');

    expect(mocks.runSkill.mock.calls.map(([, options]) => options.mode)).toEqual(['refresh', 'install']);
    expect(mocks.upsertEnvVar).toHaveBeenCalledWith('NANOCLAW_GATEWAY_PROVIDER', 'iron-proxy', '/install');
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
