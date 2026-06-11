import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecSync = vi.fn();
const mockSetRotateIndex = vi.fn();
const mockSetLastRotateAt = vi.fn();

vi.mock('child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock('../db.js', () => ({
  getRotateEnabled: vi.fn(() => true),
  setRotateEnabled: vi.fn(),
  setLastRotateAt: (...args: unknown[]) => mockSetLastRotateAt(...args),
  setRotateIndex: (...args: unknown[]) => mockSetRotateIndex(...args),
}));

function oneCli(data: unknown): string {
  return JSON.stringify({ data });
}

async function loadAccountCommand() {
  vi.resetModules();
  const registry = await import('./registry.js');
  await import('./account.js');
  return registry;
}

function makeDeps() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const killGroup = vi.fn();
  return {
    chatJid: 'fs:test',
    msg: { content: '/account tian', sender: 'user1', timestamp: '1' } as any,
    group: {
      name: 'SDK 群',
      folder: 'fs_oc_sdk_group',
      containerConfig: { cliMode: 'sdk' },
    } as any,
    channels: [
      {
        name: 'mock',
        ownsJid: () => true,
        sendMessage,
        connect: vi.fn(),
      },
    ] as any,
    sessions: {},
    queue: { killGroup } as any,
    registeredGroups: {},
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
    killGroup,
  };
}

describe('/account', () => {
  beforeEach(() => {
    mockExecSync.mockReset();
    mockSetRotateIndex.mockReset();
    mockSetLastRotateAt.mockReset();
  });

  it('Claude 系模式切换账号时过滤 openai secret，避免 /account tian 命中 codex-tian', async () => {
    const secrets = [
      { id: 'openai-1', name: 'codex-tian', type: 'openai' },
      { id: 'anthropic-1', name: 'tian', type: 'anthropic' },
    ];
    const agents = [{ id: 'agent-1', identifier: 'fs-oc-sdk-group' }];

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'onecli secrets list') return oneCli(secrets);
      if (cmd === 'onecli agents list --max 1000') return oneCli(agents);
      if (
        cmd ===
        'onecli agents set-secrets --id agent-1 --secret-ids anthropic-1'
      ) {
        return '';
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const { dispatch } = await loadAccountCommand();
    const deps = makeDeps();

    await expect(dispatch('/account tian', deps)).resolves.toBe(true);

    expect(mockExecSync).toHaveBeenCalledWith(
      'onecli agents set-secrets --id agent-1 --secret-ids anthropic-1',
      { encoding: 'utf-8', timeout: 5000 },
    );
    expect(mockExecSync).not.toHaveBeenCalledWith(
      'onecli agents set-secrets --id agent-1 --secret-ids openai-1',
      expect.anything(),
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:test',
      '✅ 已切换到 tian。下次对话生效。',
      { isCommandReply: true },
    );
    expect(deps.killGroup).toHaveBeenCalledWith('fs:test');
  });

  it('列出账号时只显示 Anthropic 账号，避免 Claude 群看到 Codex 账号', async () => {
    const secrets = [
      { id: 'openai-1', name: 'codex-tian', type: 'openai' },
      { id: 'anthropic-1', name: 'tian', type: 'anthropic' },
    ];
    const agents = [{ id: 'agent-1', identifier: 'fs-oc-sdk-group' }];

    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd === 'onecli secrets list') return oneCli(secrets);
      if (cmd === 'onecli agents list --max 1000') return oneCli(agents);
      if (cmd === 'onecli agents secrets --id agent-1') {
        return oneCli(['anthropic-1']);
      }
      throw new Error(`unexpected command: ${cmd}`);
    });

    const { dispatch } = await loadAccountCommand();
    const deps = makeDeps();

    await expect(dispatch('/account', deps)).resolves.toBe(true);

    const reply = String(deps.sendMessage.mock.calls[0]?.[1] ?? '');
    expect(reply).toContain('tian (anthropic) ← 当前');
    expect(reply).not.toContain('codex-tian');
  });
});
