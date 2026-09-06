import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisioningCore } from './channels/slack-auto.js';

const mock = vi.hoisted(() => ({
  local: {} as Record<string, any>,
  saved: [] as Record<string, any>[],
  complete: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
  resume: vi.fn(),
  available: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  image: vi.fn(),
  clear: vi.fn(),
  login: vi.fn(),
  write: vi.fn(),
  helper: vi.fn(),
  logs: vi.fn(),
  result: { status: 'approved', id: 'setup-1', choice: { imageSource: 'local', workspaceId: 'T1', name: 'Browser choice' } },
}));
vi.mock('./portal-client.mjs', () => ({
  writePrivate: mock.write,
  SetupClient: class {
    local = mock.local;
    token = 'test-install';
    async initialize() {
      return this;
    }
    async available(...args: any[]) { return mock.available(...args); }
    async resumeEnabled(...args: any[]) { return mock.resume(...args); }
    async start() {
      mock.start();
      return { url: 'https://portal.example.test/?setup=test' };
    }
    async wait() {
      return mock.result;
    }
    async save() {
      mock.saved.push(structuredClone(this.local));
    }
    async complete(...args: any[]) {
      return mock.complete(...args);
    }
    async reconcile() {}
    async stop() { mock.stop(); }
  },
}));
vi.mock('./lib/browser.js', () => ({ openUrl: mock.open }));
vi.mock('./install-cred-helper.js', () => ({ installCredentialHelper: mock.helper }));
vi.mock('./lib/registry-state.js', () => ({
  registryAccountPath: () => '/test/account.json',
  registryAuthPath: () => '/test/registry-auth.json',
  readBrokerUrl: () => 'https://registry.example.test',
  writeImageSource: mock.image,
}));
vi.mock('@clack/prompts', () => ({ confirm: mock.confirm, isCancel: (v: unknown) => typeof v === 'symbol', log: { info: mock.logs, success: mock.logs, warn: mock.logs } }));
const { savePortalAccount, runImagePortal, runSlackPortal, runPerksPortal } = await import('./portal.js');
const core = (extra = {}) =>
  ({
    brokerListWorkspaces: vi.fn(async () => [
      { team_id: 'T1', team_name: 'Team', status: 'active', connected_as: 'U123456789' },
    ]),
    brokerProvision: vi.fn(async () => ({ appId: 'A1', appToken: 'xapp-private', botToken: 'xoxb-private' })),
    ...extra,
  }) as unknown as ProvisioningCore;

describe('browser setup handoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mock.local = { registryAccount: { token: 'test-install', account_id: 'acct-test', registry: 'image.example.test' } };
    mock.helper.mockReturnValue({ onPath: true });
    mock.saved = [];
    mock.login.mockResolvedValue(0);
    mock.resume.mockResolvedValue(false);
    mock.available.mockResolvedValue(true);
    mock.confirm.mockResolvedValue(true);
    mock.result.status = 'approved';
  });
  it('saves the browser credential for the registry helper and applies the image choice without CLI login', async () => {
    await runImagePortal();
    expect(mock.login).not.toHaveBeenCalled();
    expect(mock.write).toHaveBeenCalledWith('/test/registry-auth.json', expect.objectContaining({ token: 'test-install', broker_url: 'https://registry.example.test' }));
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
    expect(mock.complete).toHaveBeenCalled();
  });
  it('does not acknowledge setup or change the image without a saved credential', async () => {
    mock.local = {};
    await expect(runImagePortal()).rejects.toThrow('installation credential');
    expect(mock.image).not.toHaveBeenCalled();
    expect(mock.complete).not.toHaveBeenCalled();
  });
  it('uses the browser-selected workspace and name, saving credentials before completion', async () => {
    const provider = core();
    const result = await runSlackPortal(provider, 'CLI default');
    expect(provider.brokerProvision).toHaveBeenCalledWith(
      'test-install',
      expect.objectContaining({ team_id: 'T1', name: 'Browser choice' }),
    );
    expect(mock.saved[0].slackSetup.status).toBe('creating');
    expect(mock.saved.at(-1)?.slackSetup.app.appToken).toBe('xapp-private');
    expect(result).toEqual({
      connection: 'provisioned',
      app_token: 'xapp-private',
      bot_token: 'xoxb-private',
      owner_handle: 'U123456789',
    });
    expect(JSON.stringify(mock.logs.mock.calls)).not.toContain('xapp-private');
  });
  it('resumes a saved app awaiting browser approval without minting another one', async () => {
    mock.local = { ...mock.local,
      slackSetup: { setupId: 'setup-1', status: 'received', app: { appId: 'A1', appToken: 'xapp-existing' } },
    };
    const provider = core({
      waitForInstall: vi.fn(async () => ({ botToken: 'xoxb-approved' })),
      brokerAppStatus: vi.fn(),
    });
    const result = await runSlackPortal(provider, 'Nano');
    expect(provider.brokerProvision).not.toHaveBeenCalled();
    expect(result.app_token).toBe('xapp-existing');
    expect(mock.complete).toHaveBeenCalledWith('awaiting_approval', { appId: 'A1' });
    expect(mock.complete).toHaveBeenLastCalledWith('complete', { appId: 'A1' });
  });
  it('never repeats an ambiguous Slack create automatically', async () => {
    mock.local = { ...mock.local, slackSetup: { setupId: 'old', status: 'creating' } };
    const provider = core();
    await expect(runSlackPortal(provider, 'Nano')).rejects.toThrow('previous Slack create');
    expect(provider.brokerProvision).not.toHaveBeenCalled();
  });
  it('does not create a flow or open the browser when the user declines', async () => {
    mock.confirm.mockResolvedValue(false);
    await runImagePortal();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.image).toHaveBeenCalledWith('local');
    expect(mock.stop).toHaveBeenCalledOnce();
  });
  it('treats cancelling the offer as skipping the Slack channel', async () => {
    mock.confirm.mockResolvedValue(Symbol('cancel'));
    const provider = core();
    expect(await runSlackPortal(provider, 'Nano')).toEqual({ __portal_skip: 'slack' });
    expect(provider.brokerProvision).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
  });
  it('skips unavailable partners without prompting or creating a handoff', async () => {
    mock.available.mockResolvedValue(false);
    await runPerksPortal();
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.available.mock.calls).toEqual([['tavily'], ['dial']]);
    expect(mock.stop).toHaveBeenCalledTimes(2);
  });
  it('opens the browser only after consent', async () => {
    await runImagePortal();
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(mock.confirm.mock.invocationCallOrder[0]).toBeLessThan(mock.start.mock.invocationCallOrder[0]);
    expect(mock.start.mock.invocationCallOrder[0]).toBeLessThan(mock.open.mock.invocationCallOrder[0]);
  });
  it('uses a perk enabled earlier without prompting or reopening the browser', async () => {
    mock.resume.mockResolvedValue(true);
    await runImagePortal();
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.complete).toHaveBeenCalledOnce();
  });
  it('offers only the partner still disabled at a later setup point', async () => {
    mock.resume.mockImplementation(async (stage: string) => stage === 'tavily');
    await runPerksPortal();
    expect(mock.resume.mock.calls.map(call => call[0])).toEqual(['tavily', 'dial']);
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(mock.confirm.mock.calls[0][0].message).toContain('Dial');
    expect(mock.open).toHaveBeenCalledOnce();
  });
  it('returns from the dashboard without a perk or installation credential', async () => {
    mock.result.status = 'skipped'; mock.local = {};
    await runImagePortal();
    expect(mock.image).toHaveBeenCalledWith('local');
    expect(mock.write).not.toHaveBeenCalled();
    expect(mock.complete).not.toHaveBeenCalled();
    const provider = core();
    expect(await runSlackPortal(provider, 'Nano')).toEqual({ __portal_skip: 'slack' });
    expect(provider.brokerProvision).not.toHaveBeenCalled();
  });
  it('reuses the same installed Slack agent on a later setup visit', async () => {
    mock.local.slackSetup = { setupId: 'previous', workspaceId: 'T1', name: 'Browser choice', status: 'complete', app: { appId: 'A1', appToken: 'xapp-existing', botToken: 'xoxb-existing' } };
    const provider = core({ brokerAppStatus: vi.fn(async () => ({ status: 'installed' })) });
    const result = await runSlackPortal(provider, 'Nano');
    expect(provider.brokerAppStatus).toHaveBeenCalledWith('test-install', 'A1');
    expect(provider.brokerProvision).not.toHaveBeenCalled();
    expect(result.bot_token).toBe('xoxb-existing');
  });
  it('returns to channel selection after declining, without entering the manual Slack skill', async () => {
    const { registerChannelPreStep } = await import('./channels/companions.js');
    const { runChannelSkillWithPreStep } = await import('./channels/run-channel-skill.js');
    const { BACK_TO_CHANNEL_SELECTION } = await import('./lib/back-nav.js');
    const exec = vi.fn(() => { throw new Error('The channel skill must not run'); });
    registerChannelPreStep('slack', async () => ({ __portal_skip: 'slack' }));
    expect(await runChannelSkillWithPreStep('slack', 'User', { agentName: 'Nova', exec })).toBe(BACK_TO_CHANNEL_SELECTION);
    expect(exec).not.toHaveBeenCalled();
  });

});
