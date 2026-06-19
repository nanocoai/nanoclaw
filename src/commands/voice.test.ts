import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeDeps(push?: boolean, mac?: boolean) {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const group = {
    name: 'test',
    folder: 'test_folder',
    containerConfig: { voiceNotify: { push, mac } },
  } as any;
  return {
    chatJid: 'fs:oc_test',
    msg: { content: '/voice', sender: 'user1', timestamp: '1' } as any,
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

describe('/voice', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('开启当前群语音播报推送', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(false);

    const handled = await dispatch('/voice on', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.voiceNotify.push).toBe(true);
    expect(deps.group.containerConfig.voiceNotify.mac).toBeUndefined();
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith(
      'fs:oc_test',
      deps.group,
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已开启当前群语音播报推送'),
      { isCommandReply: true },
    );
  });

  it('关闭当前群语音播报推送', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(true);

    const handled = await dispatch('/voice off', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.voiceNotify.push).toBe(false);
    expect(deps.group.containerConfig.voiceNotify.mac).toBeUndefined();
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith(
      'fs:oc_test',
      deps.group,
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已关闭当前群语音播报推送'),
      { isCommandReply: true },
    );
  });

  it('查看状态不持久化配置，并兼容旧 mac 开关', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(false, true);

    const handled = await dispatch('/voice status', deps);

    expect(handled).toBe(true);
    expect(deps.setRegisteredGroup).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已开启'),
      { isCommandReply: true },
    );
  });

  it('非法参数返回用法', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(false);

    const handled = await dispatch('/voice maybe', deps);

    expect(handled).toBe(true);
    expect(deps.setRegisteredGroup).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      '用法：/voice on | off | v2 on | v2 off | status',
      { isCommandReply: true },
    );
  });

  it('/voice v2 on 开启 v2 智能摘要', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(true);

    const handled = await dispatch('/voice v2 on', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.voiceNotify.summaryV2).toBe(true);
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith(
      'fs:oc_test',
      deps.group,
    );
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已开启 v2 智能摘要'),
      { isCommandReply: true },
    );
  });

  it('/voice v2 off 关闭 v2 智能摘要', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(true);
    deps.group.containerConfig.voiceNotify.summaryV2 = true;

    const handled = await dispatch('/voice v2 off', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.voiceNotify.summaryV2).toBe(false);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已关闭 v2 智能摘要'),
      { isCommandReply: true },
    );
  });

  it('/voice status 显示 v2 状态', async () => {
    await import('./voice.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps(true);
    deps.group.containerConfig.voiceNotify.summaryV2 = true;

    const handled = await dispatch('/voice status', deps);

    expect(handled).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('v2 智能分流'),
      { isCommandReply: true },
    );
  });
});
