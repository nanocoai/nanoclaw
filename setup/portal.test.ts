import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProvisioningCore } from './channels/slack-auto.js';

const mock = vi.hoisted(() => ({
  local: {} as Record<string, any>,
  saved: [] as Record<string, any>[],
  options: [] as Record<string, any>[],
  complete: vi.fn(),
  open: vi.fn(),
  confirm: vi.fn(),
  resume: vi.fn(),
  available: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  image: vi.fn(),
  deviceStart: vi.fn(),
  deviceFinish: vi.fn(),
  claim: vi.fn(),
  account: vi.fn(),
  identity: vi.fn(),
  key: vi.fn(),
  register: vi.fn(),
  reconcile: vi.fn(),
  logs: vi.fn(),
  request: vi.fn(),
  result: {
    status: 'approved',
    id: 'setup-1',
    choice: { imageSource: 'local', workspaceId: 'T1', name: 'Browser choice' },
  },
}));
vi.mock('../src/community-portal/index.js', () => ({
  SetupClient: class {
    local = mock.local;
    identity: any;
    deviceKey: any;
    constructor(options: Record<string, any>) {
      mock.options.push(options);
      this.identity = options.identity;
      this.deviceKey = options.deviceKey;
    }
    get token() {
      return this.identity?.token;
    }
    async initialize() {
      return this;
    }
    async register() {
      return mock.register();
    }
    async available(...args: any[]) {
      return mock.available(...args);
    }
    async resumeEnabled(...args: any[]) {
      return mock.resume(...args);
    }
    async start(...args: any[]) {
      mock.start(...args);
      return { url: 'https://portal.example.test/?setup=test' };
    }
    async claim() {
      return mock.claim();
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
    async reconcile() {
      mock.reconcile();
    }
    async request(...args: any[]) {
      return mock.request(...args);
    }
    async stop() {
      mock.stop();
    }
  },
  ensureDeviceKey: mock.key,
  readInstallIdentity: mock.identity,
  errorCode: (error: any, fallback = 'unavailable') => (typeof error?.code === 'string' && error.code) || fallback,
  errorStatus: (error: any) => (typeof error?.status === 'number' ? error.status : undefined),
}));
vi.mock('../src/community-portal/slack-job.js', () => ({
  readSlackJob: vi.fn(async () => null),
  launchSlackJob: vi.fn(),
  queueSlackJob: vi.fn(),
}));
vi.mock('./lib/browser.js', () => ({ openUrl: mock.open }));
vi.mock('./registry-login.js', () => ({
  LoginError: class LoginError extends Error {
    constructor(
      message: string,
      readonly hint?: string,
    ) {
      super(message);
    }
  },
  startDeviceFlow: mock.deviceStart,
  finishDeviceFlow: mock.deviceFinish,
}));
vi.mock('./lib/registry-state.js', () => ({
  readRegistryAccount: mock.account,
  readImageSource: () => 'local',
  writeImageSource: mock.image,
}));
vi.mock('@clack/prompts', () => ({
  confirm: mock.confirm,
  isCancel: (v: unknown) => typeof v === 'symbol',
  log: { info: mock.logs, success: mock.logs, warn: mock.logs, step: mock.logs, message: mock.logs },
}));
const { runImagePortal, runSlackPortal, offerPortalReminder } = await import('./portal.js');
const { LoginError } = await import('./registry-login.js');
const core = (extra = {}) =>
  ({
    brokerListWorkspaces: vi.fn(async () => [
      { team_id: 'T1', team_name: 'Team', status: 'active', connected_as: 'U123456789' },
    ]),
    brokerProvision: vi.fn(async () => ({ appId: 'A1', appToken: 'xapp-private', botToken: 'xoxb-private' })),
    ...extra,
  }) as unknown as ProvisioningCore;
const ACCOUNT = { token: 'test-install', account_id: 'acct-test', registry: 'image.example.test' };
const IDENTITY = { token: 'test-install', accountId: 'acct-test', installId: 'install-test' };
const KEY = { fingerprint: 'fp-test', publicKeyJwk: { kty: 'EC', crv: 'P-256', x: 'x', y: 'y' } };
const DEVICE_FLOW = {
  api: 'https://registry.example.test',
  idp: {
    clientId: 'client',
    deviceEndpoint: 'https://auth.example.test/device',
    tokenEndpoint: 'https://auth.example.test/token',
  },
  device: {
    deviceCode: 'device-secret',
    userCode: 'ABCD-EFGH',
    verificationUri: 'https://auth.example.test/activate',
    verificationUriComplete: 'https://auth.example.test/activate?user_code=ABCD-EFGH',
    expiresInS: 300,
    expiresAt: new Date(Date.now() + 300_000).toISOString(),
    intervalS: 5,
  },
};
const stdout: string[] = [];
const warnings = () => mock.logs.mock.calls.map((call) => String(call[0]));

describe('browser setup handoffs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    stdout.length = 0;
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);
    mock.local = {};
    mock.saved = [];
    mock.options = [];
    mock.account.mockReturnValue(ACCOUNT);
    mock.identity.mockResolvedValue(IDENTITY);
    mock.key.mockReturnValue(KEY);
    mock.deviceStart.mockResolvedValue(DEVICE_FLOW);
    mock.deviceFinish.mockResolvedValue({ token: 'test-install', account_id: 'acct-test' });
    mock.claim.mockResolvedValue({ id: 'setup-1', status: 'pending' });
    mock.register.mockResolvedValue({ deviceId: 'dev_test', accountId: 'acct-test', installId: 'install-test' });
    mock.resume.mockResolvedValue(false);
    mock.available.mockResolvedValue(true);
    mock.confirm.mockResolvedValue(true);
    mock.result.status = 'approved';
    mock.result.choice.imageSource = 'local';
    mock.request.mockResolvedValue({ activations: { echo: { enabled: false }, slack: { enabled: false } } });
  });
  it('registers the signed-in machine with its device key and applies the image choice without a second sign-in', async () => {
    await runImagePortal();
    expect(mock.deviceStart).not.toHaveBeenCalled();
    expect(mock.claim).not.toHaveBeenCalled();
    expect(mock.start).toHaveBeenCalledExactlyOnceWith('echo', 'Nano');
    expect(mock.key).toHaveBeenCalledOnce();
    expect(mock.options[0]).toMatchObject({ identity: IDENTITY, deviceKey: KEY, exclusive: true });
    expect(mock.register).toHaveBeenCalledOnce();
    expect(mock.register.mock.invocationCallOrder[0]).toBeLessThan(mock.available.mock.invocationCallOrder[0]);
    expect(mock.reconcile).toHaveBeenCalledOnce();
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
    expect(mock.complete).toHaveBeenCalled();
  });
  it('folds sign-in into one browser visit for a machine without an account: anonymous start, device flow, register, claim', async () => {
    mock.account.mockReturnValue(undefined);
    await runImagePortal();
    expect(mock.options[0]).toMatchObject({ exclusive: true });
    expect(mock.options[0].identity).toBeUndefined();
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(mock.deviceStart).toHaveBeenCalledOnce();
    expect(mock.confirm.mock.invocationCallOrder[0]).toBeLessThan(mock.deviceStart.mock.invocationCallOrder[0]);
    expect(mock.start).toHaveBeenCalledExactlyOnceWith('echo', 'Nano', {
      verification: { userCode: 'ABCD-EFGH', verificationUri: DEVICE_FLOW.device.verificationUriComplete },
    });
    expect(mock.open).toHaveBeenCalledExactlyOnceWith('https://portal.example.test/?setup=test');
    expect(stdout.join('')).toContain('https://portal.example.test/?setup=test\n');
    expect(stdout.join('')).toContain('ABCD-EFGH\n');
    expect(stdout.join('')).toContain(`${DEVICE_FLOW.device.verificationUriComplete}\n`);
    expect(stdout.join('')).not.toContain('device-secret');
    expect(mock.deviceFinish).toHaveBeenCalledExactlyOnceWith(DEVICE_FLOW);
    expect(mock.open.mock.invocationCallOrder[0]).toBeLessThan(mock.deviceFinish.mock.invocationCallOrder[0]);
    expect(mock.deviceFinish.mock.invocationCallOrder[0]).toBeLessThan(mock.key.mock.invocationCallOrder[0]);
    expect(mock.key.mock.invocationCallOrder[0]).toBeLessThan(mock.register.mock.invocationCallOrder[0]);
    expect(mock.register.mock.invocationCallOrder[0]).toBeLessThan(mock.claim.mock.invocationCallOrder[0]);
    expect(mock.register).toHaveBeenCalledOnce();
    expect(mock.claim).toHaveBeenCalledOnce();
    expect(mock.reconcile).toHaveBeenCalledOnce();
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
    expect(mock.complete).toHaveBeenCalledOnce();
  });
  it('skips the stage when the device flow is declined, expires, fails to start, or the user declines the offer', async () => {
    mock.account.mockReturnValue(undefined);
    mock.deviceFinish.mockRejectedValueOnce(
      new LoginError('The sign-in was declined in the browser.', 'Re-run setup.'),
    );
    await runImagePortal();
    expect(warnings()).toContainEqual(expect.stringContaining('declined in the browser'));
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
    mock.deviceFinish.mockRejectedValueOnce(new LoginError('That sign-in code expired before it was approved.'));
    expect(await runSlackPortal(core(), 'Nano')).toEqual({ __portal_skip: 'slack' });
    expect(warnings()).toContainEqual(expect.stringContaining('expired'));
    expect(mock.start).toHaveBeenCalledTimes(2);
    expect(mock.open).toHaveBeenCalledTimes(2);
    mock.deviceStart.mockRejectedValueOnce(
      new LoginError('Browser authentication is not configured for this registry.'),
    );
    await runImagePortal();
    expect(warnings()).toContainEqual(expect.stringContaining('not configured'));
    expect(mock.start).toHaveBeenCalledTimes(2);
    mock.confirm.mockResolvedValueOnce(false);
    await runImagePortal();
    expect(mock.deviceStart).toHaveBeenCalledTimes(3);
    expect(mock.key).not.toHaveBeenCalled();
    expect(mock.register).not.toHaveBeenCalled();
    expect(mock.claim).not.toHaveBeenCalled();
    expect(mock.complete).not.toHaveBeenCalled();
    expect(mock.stop).toHaveBeenCalledTimes(4);
    mock.deviceFinish.mockRejectedValueOnce(new Error('disk full'));
    await expect(runImagePortal()).rejects.toThrow('disk full');
  });
  it('signs in a machine whose sign-in record is present but skips a stage the portal refuses to register', async () => {
    mock.account.mockReturnValue(undefined);
    mock.register.mockRejectedValueOnce(Object.assign(new Error('Too many.'), { status: 409, code: 'device_limit' }));
    await runImagePortal();
    expect(mock.deviceFinish).toHaveBeenCalledOnce();
    expect(mock.claim).not.toHaveBeenCalled();
    expect(warnings()).toContainEqual(expect.stringContaining('maximum number of devices'));
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
  });
  it('skips the stage when the portal no longer accepts the sign-in or the device, and surfaces other failures', async () => {
    mock.register.mockRejectedValueOnce(
      Object.assign(new Error('Sign in again.'), { status: 401, code: 'invalid_token' }),
    );
    await runImagePortal();
    expect(warnings()).toContainEqual(expect.stringContaining('no longer valid'));
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
    mock.register.mockRejectedValueOnce(Object.assign(new Error('Too many.'), { status: 409, code: 'device_limit' }));
    expect(await runSlackPortal(core(), 'Nano')).toEqual({ __portal_skip: 'slack' });
    expect(warnings()).toContainEqual(expect.stringContaining('maximum number of devices'));
    mock.register.mockRejectedValueOnce(Object.assign(new Error('Pinned.'), { status: 409, code: 'device_pinned' }));
    expect(await runSlackPortal(core(), 'Nano')).toEqual({ __portal_skip: 'slack' });
    expect(warnings()).toContainEqual(expect.stringContaining('different device key'));
    expect(mock.stop).toHaveBeenCalledTimes(3);
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
    mock.register.mockRejectedValueOnce(new Error('offline'));
    await expect(runImagePortal()).rejects.toThrow('offline');
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
      __portal_pending: 'slack',
      app_token: 'xapp-private',
      bot_token: 'xoxb-private',
      owner_handle: 'U123456789',
    });
    expect(JSON.stringify(mock.logs.mock.calls)).not.toContain('xapp-private');
  });
  it('resumes a saved app awaiting browser approval without minting another one', async () => {
    mock.local = {
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
    expect(result.__portal_pending).toBe('slack');
    expect(provider.waitForInstall).not.toHaveBeenCalled();
    expect(mock.complete).not.toHaveBeenCalledWith('complete', expect.anything());
  });
  it('never repeats an ambiguous Slack create automatically', async () => {
    mock.local = { slackSetup: { setupId: 'old', status: 'creating' } };
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
  it('skips a stage the catalog does not offer without prompting or creating a handoff', async () => {
    mock.available.mockResolvedValue(false);
    await runImagePortal();
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(mock.start).not.toHaveBeenCalled();
    expect(mock.open).not.toHaveBeenCalled();
    expect(mock.available).toHaveBeenCalledExactlyOnceWith('echo');
    expect(mock.image).toHaveBeenCalledExactlyOnceWith('local');
    expect(mock.stop).toHaveBeenCalledOnce();
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
  it('returns from the dashboard without a perk, keeping the local image and completing nothing', async () => {
    mock.result.status = 'skipped';
    await runImagePortal();
    expect(mock.image).toHaveBeenCalledWith('local');
    expect(mock.reconcile).toHaveBeenCalledOnce();
    expect(mock.complete).not.toHaveBeenCalled();
    const provider = core();
    expect(await runSlackPortal(provider, 'Nano')).toEqual({ __portal_skip: 'slack' });
    expect(provider.brokerProvision).not.toHaveBeenCalled();
  });
  it('reuses the same installed Slack agent on a later setup visit', async () => {
    mock.local.slackSetup = {
      setupId: 'previous',
      workspaceId: 'T1',
      name: 'Browser choice',
      status: 'complete',
      app: { appId: 'A1', appToken: 'xapp-existing', botToken: 'xoxb-existing' },
    };
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
    const exec = vi.fn(() => {
      throw new Error('The channel skill must not run');
    });
    registerChannelPreStep('slack', async () => ({ __portal_skip: 'slack' }));
    expect(await runChannelSkillWithPreStep('slack', 'User', { agentName: 'Nova', role: 'owner', exec })).toBe(
      BACK_TO_CHANNEL_SELECTION,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it('offers skipped Echo once at a later milestone and applies the image before completing', async () => {
    mock.confirm.mockResolvedValueOnce(false);
    await runImagePortal();
    mock.confirm.mockResolvedValueOnce(true);
    mock.result.choice.imageSource = 'hardened';
    const apply = vi.fn(async () => {
      expect(mock.complete).not.toHaveBeenCalled();
      expect(mock.image).toHaveBeenLastCalledWith('hardened');
    });
    const enable = vi.fn(() => runImagePortal({ browserConsent: true, apply }));
    expect(await offerPortalReminder('echo', enable)).toBe(true);
    expect(mock.confirm).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenCalledOnce();
    expect(mock.open).toHaveBeenCalledOnce();
    expect(mock.complete).toHaveBeenCalledOnce();
    expect(mock.stop.mock.invocationCallOrder[1]).toBeLessThan(enable.mock.invocationCallOrder[0]);
    expect(await offerPortalReminder('echo', enable)).toBe(false);
    expect(enable).toHaveBeenCalledOnce();
  });

  it('persists a declined reminder and never opens the browser or starts installation', async () => {
    mock.confirm.mockResolvedValue(false);
    const enable = vi.fn();
    expect(await offerPortalReminder('slack', enable)).toBe(false);
    expect(await offerPortalReminder('slack', enable)).toBe(false);
    expect(mock.local.reminders.slack).toBe(true);
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(mock.open).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });

  it('does not remind for an enabled account perk or a saved Slack installation', async () => {
    mock.request.mockResolvedValue({ activations: { echo: { enabled: true } } });
    const enable = vi.fn();
    expect(await offerPortalReminder('echo', enable)).toBe(false);
    mock.local.slackSetup = { status: 'received', app: { appId: 'A1' } };
    expect(await offerPortalReminder('slack', enable)).toBe(false);
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
  });

  it('still offers the reminder on a machine that is not signed in or not registered, without signing in', async () => {
    mock.identity.mockResolvedValue(null);
    const enable = vi.fn();
    expect(await offerPortalReminder('echo', enable)).toBe(true);
    expect(mock.request).not.toHaveBeenCalled();
    expect(mock.deviceStart).not.toHaveBeenCalled();
    expect(mock.key).not.toHaveBeenCalled();
    expect(enable).toHaveBeenCalledOnce();
    mock.local = {};
    mock.identity.mockResolvedValue(IDENTITY);
    mock.request.mockRejectedValue(Object.assign(new Error('Register first.'), { status: 403 }));
    expect(await offerPortalReminder('echo', enable)).toBe(true);
    expect(mock.confirm).toHaveBeenCalledTimes(2);
  });

  it('keeps the working image and leaves the reminder retryable if the late image pull fails', async () => {
    mock.result.choice.imageSource = 'hardened';
    const enable = () =>
      runImagePortal({
        browserConsent: true,
        apply: async () => {
          throw new Error('pull failed');
        },
      });
    await expect(offerPortalReminder('echo', enable)).rejects.toThrow('pull failed');
    expect(mock.image).toHaveBeenLastCalledWith('local');
    expect(mock.complete).toHaveBeenCalledExactlyOnceWith('failed');
    expect(mock.local.reminders?.echo).toBeUndefined();
    expect(mock.local.reminderPending.echo).toBe(true);
    mock.request.mockResolvedValue({ activations: { echo: { enabled: true } } });
    mock.resume.mockResolvedValue(true);
    const pull = vi.fn();
    await offerPortalReminder('echo', () => runImagePortal({ browserConsent: true, apply: pull }));
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(pull).toHaveBeenCalledOnce();
    expect(mock.local.reminderPending.echo).toBeUndefined();
    expect(mock.local.reminders.echo).toBe(true);
  });

  it('keeps core setup running when optional perk status is temporarily unavailable', async () => {
    mock.request.mockRejectedValue(new Error('offline'));
    const enable = vi.fn();
    expect(await offerPortalReminder('echo', enable)).toBe(false);
    expect(mock.confirm).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    expect(mock.local.reminders?.echo).toBeUndefined();
  });

  it('does not change or pull the image after dismissing the later browser offer', async () => {
    mock.result.status = 'skipped';
    const apply = vi.fn();
    await runImagePortal({ browserConsent: true, apply });
    expect(mock.image).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
    expect(mock.complete).not.toHaveBeenCalled();
    expect(mock.confirm).not.toHaveBeenCalled();
  });

  it('passes consent to the Slack handoff once and still queues the saved background job', async () => {
    const { registerChannelPreStep } = await import('./channels/companions.js');
    const { runChannelSkillWithPreStep } = await import('./channels/run-channel-skill.js');
    const { queueSlackJob } = await import('../src/community-portal/slack-job.js');
    const provider = core();
    registerChannelPreStep('slack', (_name, options) => runSlackPortal(provider, 'Nova', undefined, options));
    await offerPortalReminder('slack', async () => {
      await runChannelSkillWithPreStep('slack', 'Operator', { agentName: 'Nova', role: 'owner', browserConsent: true });
    });
    expect(mock.confirm).toHaveBeenCalledOnce();
    expect(mock.open).toHaveBeenCalledOnce();
    expect(queueSlackJob).toHaveBeenCalledWith(
      expect.objectContaining({ agentName: 'Nova', role: 'owner', ownerHandle: 'U123456789' }),
      expect.any(String),
    );
  });
});
