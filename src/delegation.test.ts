import Database from 'better-sqlite3';
import { describe, it, expect, beforeEach } from 'vitest';

import {
  __testing as dbTesting,
  _initTestDatabase,
  closeDelegation,
  createDelegation,
  getActiveDelegationByGroup,
  getDelegation,
  getDb,
  getMainGroup,
  listDelegations,
  replyDelegation,
  resetDelegationToDispatched,
  setDelegationDispatchMsgId,
  setRegisteredGroup,
  storeChatMetadata,
  updateDelegationOnReport,
} from './db.js';
import { finalizeDelegationOnTurnEnd, shouldCarryReply } from './ipc.js';

beforeEach(() => {
  _initTestDatabase();
});

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

describe('delegation_tasks 账本', () => {
  it('source 字段列已存在但值为空时，迁移重跑会继续回填', () => {
    const legacyDb = new Database(':memory:');
    try {
      legacyDb.exec(`
        CREATE TABLE registered_groups (
          jid TEXT PRIMARY KEY,
          folder TEXT NOT NULL,
          is_main INTEGER DEFAULT 0
        );
        INSERT INTO registered_groups (jid, folder, is_main)
        VALUES ('fs:oc_main', 'main', 1);

        CREATE TABLE delegation_tasks (
          task_id TEXT PRIMARY KEY,
          source_group TEXT,
          source_jid TEXT,
          target_group TEXT NOT NULL,
          target_jid TEXT NOT NULL,
          status TEXT NOT NULL
        );
        INSERT INTO delegation_tasks (
          task_id,
          source_group,
          source_jid,
          target_group,
          target_jid,
          status
        )
        VALUES ('dlg_partial', NULL, '', 'target', 'fs:oc_target', 'dispatched');
      `);

      dbTesting.migrateDelegationSourceFields(legacyDb);

      const row = legacyDb
        .prepare(
          `SELECT source_group, source_jid FROM delegation_tasks WHERE task_id = ?`,
        )
        .get('dlg_partial') as { source_group: string; source_jid: string };
      expect(row).toEqual({
        source_group: 'main',
        source_jid: 'fs:oc_main',
      });
    } finally {
      legacyDb.close();
    }
  });

  it('createDelegation 落 dispatched 行并生成 task_id', () => {
    const t = createTestDelegation({
      sourceGroup: 'fs_oc_2',
      sourceJid: 'fs:oc_2',
      targetGroup: 'fs_oc_3',
      targetJid: 'fs:oc_3',
      title: '修复登录超时',
    } as never);
    expect(t.taskId).toMatch(/^dlg_/);
    expect(t.status).toBe('dispatched');
    expect(t.sourceGroup).toBe('fs_oc_2');
    expect(t.sourceJid).toBe('fs:oc_2');
    expect(t.targetGroup).toBe('fs_oc_3');
    expect(t.title).toBe('修复登录超时');
    const got = getDelegation(t.taskId);
    expect(got?.status).toBe('dispatched');
    expect(got?.sourceGroup).toBe('fs_oc_2');
    expect(got?.sourceJid).toBe('fs:oc_2');
  });

  it('setDelegationDispatchMsgId 回写消息 id', () => {
    const t = createTestDelegation({ targetGroup: 'g', targetJid: 'j' });
    setDelegationDispatchMsgId(t.taskId, 'om_abc');
    expect(getDelegation(t.taskId)?.dispatchMsgId).toBe('om_abc');
  });

  it('updateDelegationOnReport 更新状态/摘要/产物', () => {
    const t = createTestDelegation({ targetGroup: 'g', targetJid: 'j' });
    updateDelegationOnReport({
      taskId: t.taskId,
      status: 'progress',
      summary: '改了一半',
      artifacts: ['/tmp/nanoclaw-artifacts/x.patch'],
    });
    let got = getDelegation(t.taskId)!;
    expect(got.status).toBe('progress');
    expect(got.summary).toBe('改了一半');
    expect(got.artifacts).toEqual(['/tmp/nanoclaw-artifacts/x.patch']);
    expect(got.lastReportAt).toBeTruthy();

    updateDelegationOnReport({
      taskId: t.taskId,
      status: 'done',
      summary: '完成',
    });
    got = getDelegation(t.taskId)!;
    expect(got.status).toBe('done');
    expect(got.summary).toBe('完成');
  });

  it('getActiveDelegationByGroup 反查唯一占槽态任务', () => {
    const a = createTestDelegation({ targetGroup: 'g1', targetJid: 'j1' });
    expect(getActiveDelegationByGroup('g1')?.taskId).toBe(a.taskId);

    // done 后释放槽位，反查不到
    updateDelegationOnReport({ taskId: a.taskId, status: 'done' });
    expect(getActiveDelegationByGroup('g1')).toBeUndefined();
  });

  it('blocked/question 仍占槽（可被反查到）', () => {
    const t = createTestDelegation({ targetGroup: 'g2', targetJid: 'j2' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    expect(getActiveDelegationByGroup('g2')?.taskId).toBe(t.taskId);
    updateDelegationOnReport({ taskId: t.taskId, status: 'blocked' });
    expect(getActiveDelegationByGroup('g2')?.taskId).toBe(t.taskId);
  });

  it('replyDelegation 把 question/blocked 回置 progress', () => {
    const t = createTestDelegation({ targetGroup: 'g', targetJid: 'j' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    replyDelegation(t.taskId);
    expect(getDelegation(t.taskId)?.status).toBe('progress');
  });

  it('closeDelegation 置 closed 并释放槽位', () => {
    const t = createTestDelegation({ targetGroup: 'g3', targetJid: 'j3' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'blocked' });
    closeDelegation(t.taskId);
    expect(getDelegation(t.taskId)?.status).toBe('closed');
    expect(getActiveDelegationByGroup('g3')).toBeUndefined();
  });

  it('resetDelegationToDispatched 重派回 dispatched 并刷新计时', () => {
    const t = createTestDelegation({ targetGroup: 'g', targetJid: 'j' });
    updateDelegationOnReport({
      taskId: t.taskId,
      status: 'failed',
      summary: '失败了',
    });
    const before = getDelegation(t.taskId)!;
    expect(before.lastReportAt).toBeTruthy();
    resetDelegationToDispatched(t.taskId);
    const after = getDelegation(t.taskId)!;
    expect(after.status).toBe('dispatched');
    // 重派清空 last_report_at（重新计时，避免立刻被判失联）
    expect(after.lastReportAt).toBeUndefined();
    expect(new Date(after.dispatchedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(before.dispatchedAt).getTime(),
    );
  });

  it('replyDelegation 刷新 last_report_at（续投算新交互）', () => {
    const t = createTestDelegation({ targetGroup: 'g', targetJid: 'j' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    replyDelegation(t.taskId);
    expect(getDelegation(t.taskId)?.lastReportAt).toBeTruthy();
  });

  it('DB 唯一索引兜底：同群第二个占槽任务插入失败', () => {
    createTestDelegation({ targetGroup: 'dup', targetJid: 'j' });
    expect(() =>
      createTestDelegation({ targetGroup: 'dup', targetJid: 'j' }),
    ).toThrow();
    // 关闭后释放槽位，可再派
    const active = getActiveDelegationByGroup('dup')!;
    closeDelegation(active.taskId);
    expect(() =>
      createTestDelegation({ targetGroup: 'dup', targetJid: 'j' }),
    ).not.toThrow();
  });

  it('listDelegations 可按 group 过滤、按时间倒序', () => {
    const a = createTestDelegation({ targetGroup: 'ga', targetJid: 'j' });
    const b = createTestDelegation({ targetGroup: 'gb', targetJid: 'j' });
    expect(listDelegations().length).toBe(2);
    expect(listDelegations({ targetGroup: 'ga' }).map((d) => d.taskId)).toEqual(
      [a.taskId],
    );
    expect(listDelegations({ targetGroup: 'gb' }).map((d) => d.taskId)).toEqual(
      [b.taskId],
    );
  });
});

describe('getMainGroup', () => {
  function reg(jid: string, folder: string, isMain: boolean) {
    setRegisteredGroup(jid, {
      name: folder,
      folder,
      trigger: '@bot',
      added_at: new Date().toISOString(),
      isMain,
    });
  }

  it('0 个 main 群抛错', () => {
    reg('j1', 'sub1', false);
    expect(() => getMainGroup()).toThrow(/No main group/);
  });

  it('唯一 main 群正常返回', () => {
    reg('j1', 'sub1', false);
    reg('jmain', 'main', true);
    const m = getMainGroup();
    expect(m.jid).toBe('jmain');
    expect(m.isMain).toBe(true);
  });

  it('>1 个 main 群抛错', () => {
    reg('jmain1', 'main', true);
    reg('jmain2', 'mainx', true);
    expect(() => getMainGroup()).toThrow(/Multiple main groups/);
  });
});

describe('finalizeDelegationOnTurnEnd 自动终态兜底', () => {
  function regMain() {
    setRegisteredGroup('fs:oc_main', {
      name: 'main',
      folder: 'main',
      trigger: '@bot',
      added_at: new Date().toISOString(),
      isMain: true,
    });
  }

  it('dispatched 任务一轮结束自动补 done', () => {
    regMain();
    const t = createTestDelegation({
      sourceGroup: 'main',
      sourceJid: 'fs:oc_main',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);
    expect(finalizeDelegationOnTurnEnd('sub3', true)).toBe(true);
    expect(getDelegation(t.taskId)?.status).toBe('done');
    // 已关闭，再次调用不重复触发
    expect(finalizeDelegationOnTurnEnd('sub3', true)).toBe(false);
  });

  it('异常结束自动补 failed', () => {
    regMain();
    const t = createTestDelegation({
      sourceGroup: 'main',
      sourceJid: 'fs:oc_main',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);
    updateDelegationOnReport({ taskId: t.taskId, status: 'progress' });
    expect(finalizeDelegationOnTurnEnd('sub3', false)).toBe(true);
    expect(getDelegation(t.taskId)?.status).toBe('failed');
  });

  it('question 等待态不被自动 done 覆盖', () => {
    regMain();
    const t = createTestDelegation({
      sourceGroup: 'main',
      sourceJid: 'fs:oc_main',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    expect(finalizeDelegationOnTurnEnd('sub3', true)).toBe(false);
    expect(getDelegation(t.taskId)?.status).toBe('question');
  });

  it('无在办任务不触发', () => {
    regMain();
    expect(finalizeDelegationOnTurnEnd('sub3', true)).toBe(false);
  });

  it('携带子群最终回复写入 details（截断 2000 字）', () => {
    regMain();
    const t = createTestDelegation({
      sourceGroup: 'main',
      sourceJid: 'fs:oc_main',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);
    const longReply = 'x'.repeat(5000);
    expect(finalizeDelegationOnTurnEnd('sub3', true, longReply)).toBe(true);
    const got = getDelegation(t.taskId)!;
    expect(got.status).toBe('done');
    expect(got.details).toBe('x'.repeat(2000));
  });

  it('空回复时 details 留空，不写无意义占位', () => {
    regMain();
    const t = createTestDelegation({
      sourceGroup: 'main',
      sourceJid: 'fs:oc_main',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);
    expect(finalizeDelegationOnTurnEnd('sub3', true, '   ')).toBe(true);
    expect(getDelegation(t.taskId)?.details).toBeUndefined();
  });

  it('自动终态汇报写回任务发起群 source_jid，而不是固定主群', () => {
    regMain();
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
    const t = createTestDelegation({
      sourceGroup: 'source',
      sourceJid: 'fs:oc_source',
      targetGroup: 'sub3',
      targetJid: 'fs:oc_3',
    } as never);

    expect(finalizeDelegationOnTurnEnd('sub3', true, '已完成')).toBe(true);

    const rows = getDb()
      .prepare('SELECT chat_jid, content FROM messages ORDER BY timestamp')
      .all() as Array<{ chat_jid: string; content: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].chat_jid).toBe('fs:oc_source');
    expect(rows[0].content).toContain(t.taskId);
  });
});

describe('shouldCarryReply', () => {
  it('全部 ipc_ 消息且 task_id 匹配 → true', () => {
    const task = createTestDelegation({
      targetGroup: 'sub',
      targetJid: 'fs:oc_sub',
    });
    const msgs = [
      { id: 'ipc_1', content: `派工内容 (task ${task.taskId})` },
    ];
    expect(shouldCarryReply(msgs, task)).toBe(true);
  });

  it('含非 ipc_ 消息 → false', () => {
    const task = createTestDelegation({
      targetGroup: 'sub',
      targetJid: 'fs:oc_sub',
    });
    const msgs = [
      { id: 'ipc_1', content: `派工内容 (task ${task.taskId})` },
      { id: 'user_msg_1', content: '用户直接发的消息' },
    ];
    expect(shouldCarryReply(msgs, task)).toBe(false);
  });

  it('task_id 不匹配活跃任务 → false', () => {
    const task = createTestDelegation({
      targetGroup: 'sub',
      targetJid: 'fs:oc_sub',
    });
    const msgs = [
      { id: 'ipc_1', content: '派工内容 (task dlg_other_task)' },
    ];
    expect(shouldCarryReply(msgs, task)).toBe(false);
  });

  it('多个不同 task_id → false', () => {
    const task = createTestDelegation({
      targetGroup: 'sub',
      targetJid: 'fs:oc_sub',
    });
    const msgs = [
      { id: 'ipc_1', content: `内容A (task ${task.taskId})` },
      { id: 'ipc_2', content: '内容B (task dlg_other_task)' },
    ];
    expect(shouldCarryReply(msgs, task)).toBe(false);
  });

  it('ipc_ 消息无 task_id 标记 → false（taskIds 为空集）', () => {
    const task = createTestDelegation({
      targetGroup: 'sub',
      targetJid: 'fs:oc_sub',
    });
    const msgs = [
      { id: 'ipc_1', content: '没有 task 标记的 IPC 消息' },
    ];
    expect(shouldCarryReply(msgs, task)).toBe(false);
  });
});
