import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createDelegation,
  getActiveDelegationByGroup,
  getDb,
  getDelegation,
  storeChatMetadata,
} from './db.js';
import * as dbMod from './db.js';
import { __testing, type IpcDeps } from './ipc.js';
import type { RegisteredGroup } from './types.js';

const MAIN: RegisteredGroup = {
  name: 'Main',
  folder: 'main',
  trigger: '@bot',
  added_at: '2024-01-01',
  isMain: true,
};

const SOURCE: RegisteredGroup = {
  name: 'Source',
  folder: 'source',
  trigger: '@bot',
  added_at: '2024-01-01',
};

const TARGET: RegisteredGroup = {
  name: 'Target',
  folder: 'target',
  trigger: '@bot',
  added_at: '2024-01-01',
};

const groups: Record<string, RegisteredGroup> = {
  'fs:oc_main': MAIN,
  'fs:oc_source': SOURCE,
  'fs:oc_target': TARGET,
};

function makeDeps(sendMessage = vi.fn().mockResolvedValue('om_sent')): IpcDeps {
  return {
    sendMessage,
    registeredGroups: () => groups,
    registerGroup: vi.fn(),
    syncGroups: vi.fn(),
    getAvailableGroups: vi.fn(() => []),
    writeGroupsSnapshot: vi.fn(),
    onTasksChanged: vi.fn(),
    renameChat: vi.fn(),
    onFeishuAuthRequest: vi.fn(),
  };
}

beforeEach(() => {
  _initTestDatabase();
  storeChatMetadata(
    'fs:oc_main',
    new Date().toISOString(),
    'main',
    'mock',
    true,
  );
  storeChatMetadata(
    'fs:oc_source',
    new Date().toISOString(),
    'source',
    'mock',
    true,
  );
  storeChatMetadata(
    'fs:oc_target',
    new Date().toISOString(),
    'target',
    'mock',
    true,
  );
});

describe('Commander IPC delegation', () => {
  it('非主群可以派工给另一个注册群，账本写入 source 和 target', async () => {
    const deps = makeDeps();

    await __testing.handleDelegate(
      { target: 'fs:oc_target', text: '检查构建失败', title: '构建失败排查' },
      'source',
      groups,
      deps,
    );

    const active = getActiveDelegationByGroup('target');
    expect(active).toBeTruthy();
    expect(active?.sourceGroup).toBe('source');
    expect(active?.sourceJid).toBe('fs:oc_source');
    expect(active?.targetGroup).toBe('target');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_target',
      expect.stringContaining(`[task_id:${active?.taskId}]`),
    );

    const rows = getDb()
      .prepare('SELECT chat_jid, content FROM messages')
      .all() as Array<{ chat_jid: string; content: string }>;
    expect(rows).toEqual([
      expect.objectContaining({
        chat_jid: 'fs:oc_target',
        content: expect.stringContaining('检查构建失败'),
      }),
    ]);
  });

  it('目标群发送失败时标记 failed 并释放 target slot，同时通知 source_jid', async () => {
    const sendMessage = vi
      .fn()
      .mockRejectedValueOnce(new Error('feishu down'))
      .mockResolvedValueOnce('notify');
    const deps = makeDeps(sendMessage);

    await __testing.handleDelegate(
      { target: 'fs:oc_target', text: '检查构建失败' },
      'source',
      groups,
      deps,
    );

    const tasks = getDb()
      .prepare(
        'SELECT task_id, status, source_jid, target_group FROM delegation_tasks',
      )
      .all() as Array<{
      task_id: string;
      status: string;
      source_jid: string;
      target_group: string;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: 'failed',
      source_jid: 'fs:oc_source',
      target_group: 'target',
    });
    expect(getActiveDelegationByGroup('target')).toBeUndefined();
    expect(sendMessage).toHaveBeenLastCalledWith(
      'fs:oc_source',
      expect.stringContaining('派工失败'),
    );
  });

  it('目标群入库失败时标记 failed 并释放 target slot，同时通知 source_jid', async () => {
    const sendMessage = vi
      .fn()
      .mockResolvedValueOnce('om_sent')
      .mockResolvedValueOnce('notify');
    const deps = makeDeps(sendMessage);
    const spy = vi.spyOn(dbMod, 'storeMessageDirect').mockImplementation(() => {
      throw new Error('disk full');
    });

    try {
      await __testing.handleDelegate(
        { target: 'fs:oc_target', text: '检查构建失败' },
        'source',
        groups,
        deps,
      );
    } finally {
      spy.mockRestore();
    }

    const tasks = getDb()
      .prepare(
        'SELECT task_id, status, summary, source_jid, target_group FROM delegation_tasks',
      )
      .all() as Array<{
      task_id: string;
      status: string;
      summary: string;
      source_jid: string;
      target_group: string;
    }>;
    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({
      status: 'failed',
      source_jid: 'fs:oc_source',
      target_group: 'target',
    });
    expect(tasks[0].summary).toContain('入库失败');
    expect(getActiveDelegationByGroup('target')).toBeUndefined();
    expect(sendMessage).toHaveBeenNthCalledWith(
      1,
      'fs:oc_target',
      expect.stringContaining('检查构建失败'),
    );
    expect(sendMessage).toHaveBeenNthCalledWith(
      2,
      'fs:oc_source',
      expect.stringContaining('入库失败'),
    );
  });

  it('report 用 reporting_group 锁定 target_group，并把汇报写回 task.source_jid', () => {
    const task = createDelegation({
      sourceGroup: 'source',
      sourceJid: 'fs:oc_source',
      targetGroup: 'target',
      targetJid: 'fs:oc_target',
      title: '构建失败排查',
    });

    __testing.handleReport(
      { status: 'done', summary: '已修复', details: '修了配置' },
      'target',
      groups,
    );

    expect(getDelegation(task.taskId)?.status).toBe('done');
    const rows = getDb()
      .prepare('SELECT chat_jid, content FROM messages')
      .all() as Array<{ chat_jid: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].chat_jid).toBe('fs:oc_source');
    expect(rows[0].content).toContain('已修复');
    expect(rows[0].content).toContain(task.taskId);
  });

  it('主群派工给子群的旧路径仍写 source=main 并投递目标群', async () => {
    const deps = makeDeps();

    await __testing.handleDelegate(
      { target: 'fs:oc_target', text: '继续跑旧主群派工路径' },
      'main',
      groups,
      deps,
    );

    const active = getActiveDelegationByGroup('target');
    expect(active).toBeTruthy();
    expect(active?.sourceGroup).toBe('main');
    expect(active?.sourceJid).toBe('fs:oc_main');
    expect(active?.targetGroup).toBe('target');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_target',
      expect.stringContaining(`[task_id:${active?.taskId}]`),
    );
  });

  it('非主群可以派工给主群，main 作为 target 不再被拒', async () => {
    const deps = makeDeps();

    await __testing.handleDelegate(
      { target: 'fs:oc_main', text: '请主群帮忙兜底排查' },
      'source',
      groups,
      deps,
    );

    const active = getActiveDelegationByGroup('main');
    expect(active).toBeTruthy();
    expect(active?.sourceGroup).toBe('source');
    expect(active?.targetGroup).toBe('main');
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_main',
      expect.stringContaining(`[task_id:${active?.taskId}]`),
    );
  });

  it('自派被拒，不能创建账本占槽', async () => {
    const deps = makeDeps();

    await __testing.handleDelegate(
      { target: 'fs:oc_source', text: '派给自己' },
      'source',
      groups,
      deps,
    );

    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM delegation_tasks').get(),
    ).toEqual({
      n: 0,
    });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_source',
      expect.stringContaining('不能给自己派工'),
    );
  });

  it('目标群已有在办任务时拒绝新派工并通知发起群', async () => {
    const active = createDelegation({
      sourceGroup: 'main',
      sourceJid: 'fs:oc_main',
      targetGroup: 'target',
      targetJid: 'fs:oc_target',
      title: '已有任务',
    });
    const deps = makeDeps();

    await __testing.handleDelegate(
      { target: 'fs:oc_target', text: '第二个任务' },
      'source',
      groups,
      deps,
    );

    expect(getActiveDelegationByGroup('target')?.taskId).toBe(active.taskId);
    expect(
      getDb().prepare('SELECT COUNT(*) AS n FROM delegation_tasks').get(),
    ).toEqual({ n: 1 });
    expect(deps.sendMessage).toHaveBeenCalledWith(
      'fs:oc_source',
      expect.stringContaining('已有在办任务'),
    );
  });
});

describe('fmtGroupLabel', () => {
  const { fmtGroupLabel } = __testing;

  it('JID 格式有别名时显示 alias(jid)', () => {
    dbMod.setGroupAlias('C2', 'fs:oc_abc');
    expect(fmtGroupLabel('fs:oc_abc')).toBe('C2(fs:oc_abc)');
  });

  it('folder 格式自动转换 JID 查别名', () => {
    dbMod.setGroupAlias('C3', 'fs:oc_def');
    expect(fmtGroupLabel('fs_oc_def')).toBe('C3(fs_oc_def)');
  });

  it('无别名时返回原始标识', () => {
    expect(fmtGroupLabel('fs:oc_unknown')).toBe('fs:oc_unknown');
    expect(fmtGroupLabel('fs_oc_unknown')).toBe('fs_oc_unknown');
  });
});
