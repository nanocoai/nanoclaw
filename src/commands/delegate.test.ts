import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  _initTestDatabase,
  createDelegation,
  getActiveDelegationByGroup,
  getDb,
  getDelegation,
  storeChatMetadata,
  updateDelegationOnReport,
} from '../db.js';
import * as dbMod from '../db.js';
import { dispatch } from './registry.js';
// 副作用：注册 /delegate 命令（仅本测试文件加载一次）
import './delegate.js';

function createTestDelegation(
  params: Omit<
    Parameters<typeof createDelegation>[0],
    'sourceGroup' | 'sourceJid'
  > &
    Partial<
      Pick<Parameters<typeof createDelegation>[0], 'sourceGroup' | 'sourceJid'>
    >,
) {
  return createDelegation({
    sourceGroup: 'main',
    sourceJid: 'fs:oc_main',
    ...params,
  });
}

function makeDeps(
  args: string,
  isMain = true,
  folder = isMain ? 'main' : 'source',
) {
  const sendMessage = vi.fn().mockResolvedValue('om_sent');
  const group = {
    name: folder,
    folder,
    isMain,
  } as any;
  return {
    chatJid: isMain ? 'fs:oc_main' : 'fs:oc_source',
    args,
    msg: { content: `/delegate ${args}`, sender: 'u', timestamp: '1' } as any,
    group,
    channels: [
      { name: 'mock', ownsJid: () => true, sendMessage, connect: vi.fn() },
    ] as any,
    sessions: {},
    queue: {} as any,
    registeredGroups: {} as any,
    deleteSession: vi.fn(),
    setRegisteredGroup: vi.fn(),
    sendMessage,
  };
}

describe('/delegate 命令', () => {
  beforeEach(() => {
    _initTestDatabase();
    // 跨群投递会往子群 messages.db 写消息，messages 表对 chats 有外键约束。
    // 生产里子群 chat 早已存在，测试需先 seed，否则 storeMessageDirect 外键违约。
    storeChatMetadata(
      'fs:oc_3',
      new Date().toISOString(),
      'sub3',
      'mock',
      true,
    );
    storeChatMetadata(
      'fs:oc_main',
      new Date().toISOString(),
      'main',
      'mock',
      true,
    );
  });

  async function run(args: string, isMain = true, folder?: string) {
    const deps = makeDeps(args, isMain, folder);
    const handled = await dispatch(`/delegate ${args}`.trim(), deps);
    return { handled, sendMessage: deps.sendMessage };
  }

  it('非主群 status 只列出本群 source_group 发起的任务', async () => {
    const mine = createTestDelegation({
      sourceGroup: 'source',
      sourceJid: 'fs:oc_source',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
      title: '我的任务',
    } as never);
    createTestDelegation({
      sourceGroup: 'other',
      sourceJid: 'fs:oc_other',
      targetGroup: 'sub4',
      targetJid: 'fs:oc_4',
      title: '别人的任务',
    } as never);

    const { handled, sendMessage } = await run('status', false, 'source');
    expect(handled).toBe(true);
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain(mine.taskId.split('_').at(-1)!);
    expect(text).toContain('我的任务');
    expect(text).not.toContain('别人的任务');
  });

  it('status 空账本提示无记录', async () => {
    const { sendMessage } = await run('status');
    expect(sendMessage).toHaveBeenCalledWith(
      'fs:oc_main',
      expect.stringContaining('暂无派工记录'),
      expect.anything(),
    );
  });

  it('status 列出任务 + dispatched 超时显示失联', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    // 手动把 dispatched_at 改到 20 分钟前，触发失联
    getDb()
      .prepare(
        'UPDATE delegation_tasks SET dispatched_at = ? WHERE task_id = ?',
      )
      .run(new Date(Date.now() - 20 * 60 * 1000).toISOString(), t.taskId);
    const { sendMessage } = await run('status');
    const text = sendMessage.mock.calls[0][1] as string;
    expect(text).toContain('sub3');
    expect(text).toContain('⚠️失联');
  });

  it('reply 续投 question 任务 → 投子群 + 状态回 progress', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    const { sendMessage } = await run(`reply ${t.taskId} 用方案A`);
    // 投递给子群（带 task_id 前缀）
    expect(sendMessage).toHaveBeenCalledWith(
      'fs:oc_3',
      expect.stringContaining(`[task_id:${t.taskId}]`),
      expect.anything(),
    );
    expect(getDelegation(t.taskId)?.status).toBe('progress');
  });

  it('非主群 reply 只能管理自己 source_group 发起的任务', async () => {
    const t = createTestDelegation({
      sourceGroup: 'other',
      sourceJid: 'fs:oc_other',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });

    const { sendMessage } = await run(
      `reply ${t.taskId} 追加`,
      false,
      'source',
    );

    expect(sendMessage).toHaveBeenCalledWith(
      'fs:oc_source',
      expect.stringContaining('无权管理任务'),
      expect.anything(),
    );
    expect(sendMessage).not.toHaveBeenCalledWith(
      'fs:oc_3',
      expect.anything(),
      expect.anything(),
    );
    expect(getDelegation(t.taskId)?.status).toBe('question');
  });

  it('reply 拒绝关闭态任务', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    updateDelegationOnReport({ taskId: t.taskId, status: 'done' });
    const { sendMessage } = await run(`reply ${t.taskId} 追加`);
    expect(sendMessage).toHaveBeenCalledWith(
      'fs:oc_main',
      expect.stringContaining('已关闭，不能续投'),
      expect.anything(),
    );
    // 不应投到子群
    expect(sendMessage).not.toHaveBeenCalledWith(
      'fs:oc_3',
      expect.anything(),
      expect.anything(),
    );
  });

  it('retry 重派 → 状态回 dispatched', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
      title: '修登录',
    });
    updateDelegationOnReport({ taskId: t.taskId, status: 'failed' });
    await run(`retry ${t.taskId}`);
    expect(getDelegation(t.taskId)?.status).toBe('dispatched');
  });

  it('retry 同一任务允许命中自身占槽，不会被自己挡住', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
      title: '修登录',
    });

    const { sendMessage } = await run(`retry ${t.taskId}`);

    expect(sendMessage).toHaveBeenCalledWith(
      'fs:oc_3',
      expect.stringContaining(`[task_id:${t.taskId}]`),
      expect.anything(),
    );
    expect(getDelegation(t.taskId)?.status).toBe('dispatched');
    expect(getActiveDelegationByGroup('sub3')?.taskId).toBe(t.taskId);
  });

  it('close 关闭 → 状态 closed、释放槽位', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    updateDelegationOnReport({ taskId: t.taskId, status: 'blocked' });
    await run(`close ${t.taskId}`);
    expect(getDelegation(t.taskId)?.status).toBe('closed');
    expect(getActiveDelegationByGroup('sub3')).toBeUndefined();
  });

  it('retry 被拒：目标群已有另一个在办任务', async () => {
    // 旧任务已关闭，但同群已有新在办任务 → retry 旧任务应被拒绝
    const old = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    updateDelegationOnReport({ taskId: old.taskId, status: 'done' });
    const fresh = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    const { sendMessage } = await run(`retry ${old.taskId}`);
    expect(sendMessage).toHaveBeenCalledWith(
      'fs:oc_main',
      expect.stringContaining('已有在办任务'),
      expect.anything(),
    );
    // 旧任务不应被复活
    expect(getDelegation(old.taskId)?.status).toBe('done');
    expect(getActiveDelegationByGroup('sub3')?.taskId).toBe(fresh.taskId);
  });

  it('reply 入库失败 → 状态不推进 + 提示主群手动确认', async () => {
    const t = createTestDelegation({
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    const spy = vi.spyOn(dbMod, 'storeMessageDirect').mockImplementation(() => {
      throw new Error('disk full');
    });
    try {
      const { sendMessage } = await run(`reply ${t.taskId} 用方案A`);
      // 飞书发出去了（发送成功）
      expect(sendMessage).toHaveBeenCalledWith(
        'fs:oc_3',
        expect.stringContaining(`[task_id:${t.taskId}]`),
        expect.anything(),
      );
      // 但入库失败 → 状态绝不推进（仍停在 question，没变 progress）
      expect(getDelegation(t.taskId)?.status).toBe('question');
      // 主群收到「已发出但 agent 可能扫不到」的提示
      expect(sendMessage).toHaveBeenCalledWith(
        'fs:oc_main',
        expect.stringContaining('跨群入库失败'),
        expect.anything(),
      );
    } finally {
      spy.mockRestore();
    }
  });
});
