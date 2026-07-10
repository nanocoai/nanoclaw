import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  askOperatorRole: vi.fn(),
  fail: vi.fn(),
  runPhotonSetup: vi.fn(),
  runQuietChild: vi.fn(),
  text: vi.fn(),
  userInput: vi.fn(),
}));

vi.mock('@clack/prompts', () => ({ text: mocks.text }));
vi.mock('../../scripts/photon-setup.js', () => ({
  isE164: (value: string) => /^\+[1-9]\d{6,14}$/.test(value),
  normalizePhone: (value: string) => value.replace(/[^\d+]/g, ''),
  main: mocks.runPhotonSetup,
}));
vi.mock('../logs.js', () => ({ userInput: mocks.userInput }));
vi.mock('../lib/role-prompt.js', () => ({ askOperatorRole: mocks.askOperatorRole }));
vi.mock('../lib/runner.js', () => ({
  ensureAnswer: <T>(value: T) => value,
  fail: mocks.fail,
  runQuietChild: mocks.runQuietChild,
}));
vi.mock('../lib/theme.js', () => ({
  accentGreen: (value: string) => value,
  note: vi.fn(),
}));

import { runIMessageCloudChannel } from './imessage-cloud.js';

describe('native iMessage (Photon) setup flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.text.mockResolvedValueOnce('+1 (555) 123-4567').mockResolvedValueOnce('Nano');
    mocks.runPhotonSetup.mockResolvedValue(0);
    mocks.askOperatorRole.mockResolvedValue('owner');
    mocks.runQuietChild.mockResolvedValue({ ok: true, rawLog: '/tmp/setup.log' });
    mocks.fail.mockRejectedValue(new Error('setup failed'));
  });

  it('provisions Photon without mode, server URL, or API key prompts', async () => {
    await runIMessageCloudChannel('Ryan');

    expect(mocks.text).toHaveBeenCalledTimes(2);
    expect(mocks.text).toHaveBeenNthCalledWith(1, expect.objectContaining({ message: 'Your iMessage phone number' }));
    expect(mocks.runPhotonSetup).toHaveBeenCalledWith(['setup', '--phone', '+15551234567', '--embedded']);

    // First child step fetches the adapter + installs the pinned runtime + builds.
    expect(mocks.runQuietChild).toHaveBeenNthCalledWith(
      1,
      'imessage-cloud-install',
      'bash',
      ['setup/add-imessage-cloud.sh'],
      expect.any(Object),
    );

    const initArgs = mocks.runQuietChild.mock.calls[2][2];
    expect(initArgs).toEqual([
      'exec',
      'tsx',
      'scripts/init-first-agent.ts',
      '--channel',
      'imessage-cloud',
      '--user-id',
      'imessage-cloud:+15551234567',
      '--platform-id',
      '+15551234567',
      '--display-name',
      'Ryan',
      '--agent-name',
      'Nano',
      '--role',
      'owner',
    ]);
    expect(mocks.fail).not.toHaveBeenCalled();
  });
});
