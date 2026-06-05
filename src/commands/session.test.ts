import { beforeEach, describe, expect, it, vi } from 'vitest';

let mockCliMode: 'sdk' | 'print' | 'interactive' | 'codex' | 'gemini' = 'codex';

vi.mock('../container-runner.js', () => ({
  resolveCliMode: () => mockCliMode,
}));

function makeDeps() {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    chatJid: 'fs:oc_test',
    msg: { content: '/stop', sender: 'user1', timestamp: '1' } as any,
    group: {
      name: 'test',
      folder: 'test_folder',
      containerConfig: { cliMode: mockCliMode },
    } as any,
    channels: [
      {
        name: 'mock',
        ownsJid: () => true,
        sendMessage,
        connect: vi.fn(),
      },
    ] as any,
    sessions: {} as Record<string, string>,
    queue: { stopGroup: vi.fn().mockReturnValue(true), killGroup: vi.fn() } as any,
    registeredGroups: {} as any,
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
  };
}

describe('/stop', () => {
  beforeEach(() => {
    vi.resetModules();
    mockCliMode = 'codex';
  });

  it('codex mode 下停止当前任务', async () => {
    await import('./session.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps();

    const handled = await dispatch('/stop', deps);

    expect(handled).toBe(true);
    expect(deps.queue.stopGroup).toHaveBeenCalledWith('fs:oc_test');
    expect(deps.queue.killGroup).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('已停止当前 Codex 任务'),
      { isCommandReply: true },
    );
  });

  it('非 codex mode 下不杀进程', async () => {
    mockCliMode = 'interactive';
    await import('./session.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps();

    const handled = await dispatch('/stop', deps);

    expect(handled).toBe(true);
    expect(deps.queue.stopGroup).not.toHaveBeenCalled();
    expect(deps.queue.killGroup).not.toHaveBeenCalled();
    // dispatch 现在按 modes 在进 handler 前拦截，提示「不可用」
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_test',
      expect.stringContaining('不可用'),
      { isCommandReply: true },
    );
  });
});
