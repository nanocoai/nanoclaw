import { describe, expect, it, vi } from 'vitest';

import { normalizeTargetChatJid, resolveTargetChatJid } from './group-alias.js';

describe('group alias target resolver', () => {
  it('把裸 oc_xxx 补成飞书 JID', () => {
    expect(normalizeTargetChatJid('oc_abc')).toBe('fs:oc_abc');
  });

  it('保留已完整的 JID', () => {
    expect(normalizeTargetChatJid('fs:oc_abc')).toBe('fs:oc_abc');
  });

  it('优先把别名解析成 JID', () => {
    const lookup = vi.fn((alias: string) =>
      alias === '2号' ? 'fs:oc_two' : undefined,
    );

    expect(resolveTargetChatJid('2号', lookup)).toEqual({
      chatJid: 'fs:oc_two',
      alias: '2号',
    });
    expect(lookup).toHaveBeenCalledWith('2号');
  });

  it('别名值也支持裸 oc_xxx', () => {
    expect(
      resolveTargetChatJid('3号', (alias) =>
        alias === '3号' ? 'oc_three' : undefined,
      ),
    ).toEqual({ chatJid: 'fs:oc_three', alias: '3号' });
  });

  it('别名不存在时按原目标处理', () => {
    expect(resolveTargetChatJid('fs:oc_raw', () => undefined)).toEqual({
      chatJid: 'fs:oc_raw',
    });
  });
});
