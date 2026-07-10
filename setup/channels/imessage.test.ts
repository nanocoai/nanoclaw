import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  platform: vi.fn(() => 'darwin'),
  execSync: vi.fn(() => ''),
  brightSelect: vi.fn(),
  askOperatorRole: vi.fn(),
  fail: vi.fn(),
  runPhotonSetup: vi.fn(),
  runQuietChild: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  userInput: vi.fn(),
}));

vi.mock('os', () => ({ default: { platform: mocks.platform }, platform: mocks.platform }));
vi.mock('child_process', () => ({ execSync: mocks.execSync }));
vi.mock('@clack/prompts', () => ({ text: mocks.text, confirm: mocks.confirm }));
vi.mock('../../scripts/photon-setup.js', () => ({
  isE164: (value: string) => /^\+[1-9]\d{6,14}$/.test(value),
  normalizePhone: (value: string) => value.replace(/[^\d+]/g, ''),
  main: mocks.runPhotonSetup,
}));
vi.mock('../logs.js', () => ({ userInput: mocks.userInput }));
vi.mock('../lib/bright-select.js', () => ({ brightSelect: mocks.brightSelect }));
vi.mock('../lib/role-prompt.js', () => ({ askOperatorRole: mocks.askOperatorRole }));
vi.mock('../lib/runner.js', () => ({
  ensureAnswer: <T>(value: T) => value,
  fail: mocks.fail,
  runQuietChild: mocks.runQuietChild,
}));
vi.mock('../lib/theme.js', () => ({
  accentGreen: (value: string) => value,
  note: vi.fn(),
  wrapForGutter: (value: string) => value,
}));

import { runIMessageChannel } from './imessage.js';

const INIT_TAIL = ['--display-name', 'Ryan', '--agent-name', 'Nano', '--role', 'owner'];

describe('iMessage setup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.NANOCLAW_AGENT_NAME;
    mocks.platform.mockReturnValue('darwin');
    mocks.execSync.mockReturnValue('');
    mocks.confirm.mockResolvedValue(true);
    mocks.runPhotonSetup.mockResolvedValue(0);
    mocks.askOperatorRole.mockResolvedValue('owner');
    mocks.runQuietChild.mockResolvedValue({ ok: true, rawLog: '/tmp/setup.log' });
    mocks.fail.mockRejectedValue(new Error('setup failed'));
  });

  it('hosted: runs the Photon wizard and wires --channel imessage (no URL/key prompts)', async () => {
    mocks.brightSelect.mockResolvedValueOnce('hosted');
    mocks.text.mockResolvedValueOnce('+1 (555) 123-4567').mockResolvedValueOnce('Nano');

    await runIMessageChannel('Ryan');

    // Only the phone is asked; no legacy server-URL / API-key prompts.
    expect(mocks.runPhotonSetup).toHaveBeenCalledWith(['setup', '--phone', '+15551234567', '--embedded']);

    // install → service → init, install carrying the hosted backend selector.
    expect(mocks.runQuietChild).toHaveBeenNthCalledWith(
      1,
      'imessage-install',
      'bash',
      ['setup/add-imessage.sh'],
      expect.any(Object),
      expect.objectContaining({ env: expect.objectContaining({ IMESSAGE_BACKEND: 'hosted' }) }),
    );
    expect(mocks.runQuietChild).toHaveBeenNthCalledWith(
      2,
      'imessage-service',
      'pnpm',
      ['exec', 'tsx', 'setup/index.ts', '--step', 'service'],
      expect.any(Object),
    );
    expect(mocks.runQuietChild.mock.calls[2][2]).toEqual([
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'imessage',
      '--user-id',
      'imessage:+15551234567',
      '--platform-id',
      '+15551234567',
      ...INIT_TAIL,
    ]);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('local: walks Full Disk Access then wires --channel imessage with the handle', async () => {
    mocks.brightSelect.mockResolvedValueOnce('local');
    mocks.text.mockResolvedValueOnce('+15551234567').mockResolvedValueOnce('Nano');

    await runIMessageChannel('Ryan');

    // No Photon provisioning for local; the FDA confirmation ran.
    expect(mocks.runPhotonSetup).not.toHaveBeenCalled();
    expect(mocks.confirm).toHaveBeenCalled();

    expect(mocks.runQuietChild).toHaveBeenNthCalledWith(
      1,
      'imessage-install',
      'bash',
      ['setup/add-imessage.sh'],
      expect.any(Object),
      expect.objectContaining({ env: expect.objectContaining({ IMESSAGE_BACKEND: 'local', IMESSAGE_ENABLED: 'true' }) }),
    );
    expect(mocks.runQuietChild.mock.calls[2][2]).toEqual([
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'imessage',
      '--user-id',
      '+15551234567',
      '--platform-id',
      '+15551234567',
      ...INIT_TAIL,
    ]);
    expect(mocks.fail).not.toHaveBeenCalled();
  });

  it('back: returns to channel selection without installing anything', async () => {
    mocks.brightSelect.mockResolvedValueOnce('back');

    const result = await runIMessageChannel('Ryan');

    const { BACK_TO_CHANNEL_SELECTION } = await import('../lib/back-nav.js');
    expect(result).toBe(BACK_TO_CHANNEL_SELECTION);
    expect(mocks.runQuietChild).not.toHaveBeenCalled();
    expect(mocks.runPhotonSetup).not.toHaveBeenCalled();
  });
});
