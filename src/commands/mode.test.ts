import { beforeEach, describe, expect, it, vi } from 'vitest';

function makeDeps() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  const group = {
    name: 'test',
    folder: 'test_folder',
    containerConfig: { cliMode: 'codex' },
  } as any;
  const sessions = { test_folder: 'codex-session-id' };
  return {
    chatJid: 'fs:oc_test',
    msg: { content: '/mode sdk', sender: 'user1', timestamp: '1' } as any,
    group,
    channels: [
      {
        name: 'mock',
        ownsJid: () => true,
        sendMessage,
        connect: vi.fn(),
      },
    ] as any,
    sessions,
    queue: { killGroup: vi.fn().mockReturnValue(true), stopGroup: vi.fn() } as any,
    registeredGroups: { 'fs:oc_test': group },
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
  };
}

describe('/mode', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('切换模式时终止旧进程并清除旧 session', async () => {
    await import('./mode.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps();

    const handled = await dispatch('/mode sdk', deps);

    expect(handled).toBe(true);
    expect(deps.group.containerConfig.cliMode).toBe('sdk');
    expect(deps.setRegisteredGroup).toHaveBeenCalledWith(
      'fs:oc_test',
      deps.group,
    );
    expect(deps.queue.killGroup).toHaveBeenCalledWith('fs:oc_test');
    expect(deps.sessions.test_folder).toBeUndefined();
    expect(deps.deleteSession).toHaveBeenCalledWith('test_folder');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('下一条消息会按新模式启动'),
      { isCommandReply: true },
    );
  });

  it('没有运行中进程时仍会清除旧 session', async () => {
    await import('./mode.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps();
    deps.queue.killGroup.mockReturnValue(false);

    const handled = await dispatch('/mode sdk', deps);

    expect(handled).toBe(true);
    expect(deps.queue.killGroup).toHaveBeenCalledWith('fs:oc_test');
    expect(deps.sessions.test_folder).toBeUndefined();
    expect(deps.deleteSession).toHaveBeenCalledWith('test_folder');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已清除旧 session'),
      { isCommandReply: true },
    );
  });
});
