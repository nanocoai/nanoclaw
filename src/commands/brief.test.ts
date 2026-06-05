import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeDeps(autoFollowupSummary?: boolean) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const group = {
    name: 'test',
    folder: 'test_folder',
    containerConfig: { autoFollowupSummary },
  } as any;
  return {
    chatJid: 'fs:oc_test',
    msg: { content: '/brief', sender: 'user1', timestamp: '1' } as any,
    group,
    channels: [
      {
        name: 'mock',
        ownsJid: () => true,
        sendMessage,
        connect: vi.fn(),
      },
    ] as any,
    sessions: {} as Record<string, string>,
    queue: { killGroup: vi.fn() } as any,
    registeredGroups: {} as any,
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
  };
}

describe('/brief', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('开启自动后置总结', async () => {
    await import('./brief.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(false);

    const handled = await dispatch('/brief', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.autoFollowupSummary).toBe(true);
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith('fs:oc_test', deps.group);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('brief 已开启'),
      { isCommandReply: true },
    );
  });

  it('关闭自动后置总结', async () => {
    await import('./brief.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(true);

    const handled = await dispatch('/brief', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.autoFollowupSummary).toBe(false);
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith('fs:oc_test', deps.group);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('brief 已关闭'),
      { isCommandReply: true },
    );
  });
});
