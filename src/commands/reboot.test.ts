import { beforeEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'child_process';

vi.mock('child_process', () => ({
  spawn: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() })),
}));

function makeDeps(command = '/reboot') {
  const sendMessage = vi.fn().mockResolvedValue(undefined);
  return {
    chatJid: 'fs:oc_main',
    msg: { content: command, sender: 'user1', timestamp: '1' } as any,
    group: {
      name: 'main',
      folder: 'main',
      isMain: true,
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
    sessions: {} as Record<string, string>,
    queue: { killGroup: vi.fn(), stopGroup: vi.fn() } as any,
    registeredGroups: {} as any,
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
  };
}

describe('/reboot', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  it('主群触发 restart.sh 并先回复用户', async () => {
    await import('./reboot.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps();

    const handled = await dispatch('/reboot', deps);

    expect(handled).toBe(true);
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_main',
      expect.stringContaining('正在执行 restart.sh'),
      { isCommandReply: true },
    );
    expect(spawn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-lc', expect.stringContaining('restart.sh')],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
      }),
    );
  });

  it('支持 /Reboot 大写别名', async () => {
    await import('./reboot.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps('/Reboot');

    const handled = await dispatch('/Reboot', deps);

    expect(handled).toBe(true);
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('非主群不能触发重启', async () => {
    await import('./reboot.js');
    const { dispatch } = await import('./registry.js');
    const deps = makeDeps();
    deps.group.isMain = false;

    const handled = await dispatch('/reboot', deps);

    expect(handled).toBe(true);
    expect(spawn).not.toHaveBeenCalled();
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_main',
      '此命令仅限主群使用',
      { isCommandReply: true },
    );
  });
});
