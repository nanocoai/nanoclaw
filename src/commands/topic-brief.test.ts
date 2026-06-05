import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GroupQueue } from '../group-queue.js';
import type { Channel, NewMessage, RegisteredGroup } from '../types.js';
import type { DispatchDeps } from './registry.js';

function makeDeps(queueSendMessage = vi.fn().mockReturnValue(true)) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const msg: NewMessage = {
    id: 'msg-1',
    chat_jid: 'fs:oc_test',
    content: '/j',
    sender: 'user1',
    sender_name: '大杰',
    timestamp: '1',
  };
  const group: RegisteredGroup = {
    name: 'test',
    folder: 'test_folder',
    trigger: '@bot',
    added_at: '1',
    containerConfig: { cliMode: 'sdk' },
  };
  const channel: Channel = {
    name: 'mock',
    ownsJid: () => true,
    sendMessage,
    connect: vi.fn(),
    isConnected: () => true,
    disconnect: vi.fn(),
  };
  return {
    chatJid: 'fs:oc_test',
    msg,
    group,
    channels: [channel],
    sessions: {} as Record<string, string>,
    queue: {
      sendMessage: queueSendMessage,
      killGroup: vi.fn(),
      stopGroup: vi.fn(),
    } as unknown as GroupQueue,
    registeredGroups: {} as Record<string, RegisteredGroup>,
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
  } satisfies DispatchDeps & { sendMessage: typeof sendMessage };
}

describe('/j', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('向活跃会话注入两行话题回顾 prompt，不额外发送命令提示', async () => {
    const queueSendMessage = vi.fn().mockReturnValue(true);
    await import('./topic-brief.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(queueSendMessage);

    const handled = await dispatch('/j', deps);

    expect(handled).toBe(true);
    expect(queueSendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('[AUTO_TOPIC_BRIEF]'),
      { thinking: 'disabled' },
      null,
      'user1',
    );
    expect(queueSendMessage.mock.calls[0][1]).toContain('这是什么事：');
    expect(queueSendMessage.mock.calls[0][1]).toContain('当前结论：');
    expect(deps.sendMessage).not.toHaveBeenCalled();
  });

  it('没有活跃会话时提示用户在刚收到回复后使用', async () => {
    const queueSendMessage = vi.fn().mockReturnValue(false);
    await import('./topic-brief.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(queueSendMessage);

    const handled = await dispatch('/j', deps);

    expect(handled).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('当前没有活跃会话'),
      { isCommandReply: true },
    );
  });

  it('通过命令入口注册到 help', async () => {
    const { getHelp } = await import('./index.js');

    expect(getHelp()).toContain('/j — 手动补发当前话题两行回顾');
  });
});
