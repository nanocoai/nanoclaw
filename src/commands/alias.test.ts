import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { DispatchDeps } from './registry.js';

const sent: string[] = [];
const aliases = new Map<string, string>();

vi.mock('../db.js', () => ({
  setGroupAlias: vi.fn((alias: string, chatJid: string) => {
    aliases.set(alias, chatJid);
  }),
  deleteGroupAlias: vi.fn((alias: string) => aliases.delete(alias)),
  getAllGroupAliases: vi.fn(() =>
    Object.fromEntries(
      [...aliases.entries()].sort(([a], [b]) => a.localeCompare(b)),
    ),
  ),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../router.js', () => ({
  findChannel: () => ({
    sendMessage: async (_jid: string, text: string) => {
      sent.push(text);
    },
  }),
}));

vi.mock('../cli-mode.js', () => ({
  CLAUDE_MODES: ['sdk', 'print', 'interactive'],
  resolveCliMode: () => 'sdk',
}));

function deps(isMain = true): DispatchDeps {
  return {
    chatJid: 'fs:oc_main',
    msg: {
      id: 'm1',
      chat_jid: 'fs:oc_main',
      sender: 'u1',
      sender_name: '大杰',
      content: '',
      timestamp: new Date().toISOString(),
    },
    group: {
      name: 'Main',
      folder: 'main',
      trigger: '@二狗',
      added_at: '2026-01-01T00:00:00.000Z',
      isMain,
    },
    channels: [] as DispatchDeps['channels'],
    sessions: {},
    queue: {} as DispatchDeps['queue'],
    registeredGroups: {},
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
  };
}

describe('/alias', () => {
  beforeEach(async () => {
    vi.resetModules();
    sent.length = 0;
    aliases.clear();
    await import('./index.js');
  });

  it('主群可以设置别名', async () => {
    const { dispatch } = await import('./registry.js');

    await dispatch('/alias set 2号 fs:oc_two', deps(true));

    expect(aliases.get('2号')).toBe('fs:oc_two');
    expect(sent.at(-1)).toContain('2号 → fs:oc_two');
  });

  it('列表展示已设置别名', async () => {
    aliases.set('1号', 'fs:oc_one');
    aliases.set('2号', 'fs:oc_two');
    const { dispatch } = await import('./registry.js');

    await dispatch('/alias list', deps(true));

    expect(sent.at(-1)).toContain('1号 → fs:oc_one');
    expect(sent.at(-1)).toContain('2号 → fs:oc_two');
  });

  it('非主群不能设置别名', async () => {
    const { dispatch } = await import('./registry.js');

    await dispatch('/alias set 2号 fs:oc_two', deps(false));

    expect(aliases.size).toBe(0);
    expect(sent.at(-1)).toBe('此命令仅限主群使用');
  });
});
