import { describe, it, expect, beforeEach } from 'vitest';

import {
  _initTestDatabase,
  closeDelegation,
  createDelegation,
  getActiveDelegationByGroup,
  getDelegation,
  getMainGroup,
  listDelegations,
  replyDelegation,
  resetDelegationToDispatched,
  setDelegationDispatchMsgId,
  setRegisteredGroup,
  updateDelegationOnReport,
} from './db.js';
import { finalizeDelegationOnTurnEnd } from './ipc.js';

beforeEach(() => {
  _initTestDatabase();
});

describe('delegation_tasks 账本', () => {
  it('createDelegation 落 dispatched 行并生成 task_id', () => {
    const t = createDelegation({
      targetGroup: 'fs_oc_3',
      targetJid: 'fs:oc_3',
      title: '修复登录超时',
    });
    expect(t.taskId).toMatch(/^dlg_/);
    expect(t.status).toBe('dispatched');
    expect(t.targetGroup).toBe('fs_oc_3');
    expect(t.title).toBe('修复登录超时');
    expect(getDelegation(t.taskId)?.status).toBe('dispatched');
  });

  it('setDelegationDispatchMsgId 回写消息 id', () => {
    const t = createDelegation({ targetGroup: 'g', targetJid: 'j' });
    setDelegationDispatchMsgId(t.taskId, 'om_abc');
    expect(getDelegation(t.taskId)?.dispatchMsgId).toBe('om_abc');
  });

  it('updateDelegationOnReport 更新状态/摘要/产物', () => {
    const t = createDelegation({ targetGroup: 'g', targetJid: 'j' });
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
    const a = createDelegation({ targetGroup: 'g1', targetJid: 'j1' });
    expect(getActiveDelegationByGroup('g1')?.taskId).toBe(a.taskId);

    // done 后释放槽位，反查不到
    updateDelegationOnReport({ taskId: a.taskId, status: 'done' });
    expect(getActiveDelegationByGroup('g1')).toBeUndefined();
  });

  it('blocked/question 仍占槽（可被反查到）', () => {
    const t = createDelegation({ targetGroup: 'g2', targetJid: 'j2' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    expect(getActiveDelegationByGroup('g2')?.taskId).toBe(t.taskId);
    updateDelegationOnReport({ taskId: t.taskId, status: 'blocked' });
    expect(getActiveDelegationByGroup('g2')?.taskId).toBe(t.taskId);
  });

  it('replyDelegation 把 question/blocked 回置 progress', () => {
    const t = createDelegation({ targetGroup: 'g', targetJid: 'j' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    replyDelegation(t.taskId);
    expect(getDelegation(t.taskId)?.status).toBe('progress');
  });

  it('closeDelegation 置 closed 并释放槽位', () => {
    const t = createDelegation({ targetGroup: 'g3', targetJid: 'j3' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'blocked' });
    closeDelegation(t.taskId);
    expect(getDelegation(t.taskId)?.status).toBe('closed');
    expect(getActiveDelegationByGroup('g3')).toBeUndefined();
  });

  it('resetDelegationToDispatched 重派回 dispatched 并刷新计时', () => {
    const t = createDelegation({ targetGroup: 'g', targetJid: 'j' });
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
    const t = createDelegation({ targetGroup: 'g', targetJid: 'j' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'question' });
    replyDelegation(t.taskId);
    expect(getDelegation(t.taskId)?.lastReportAt).toBeTruthy();
  });

  it('DB 唯一索引兜底：同群第二个占槽任务插入失败', () => {
    createDelegation({ targetGroup: 'dup', targetJid: 'j' });
    expect(() =>
      createDelegation({ targetGroup: 'dup', targetJid: 'j' }),
    ).toThrow();
    // 关闭后释放槽位，可再派
    const active = getActiveDelegationByGroup('dup')!;
    closeDelegation(active.taskId);
    expect(() =>
      createDelegation({ targetGroup: 'dup', targetJid: 'j' }),
    ).not.toThrow();
  });

  it('listDelegations 可按 group 过滤、按时间倒序', () => {
    const a = createDelegation({ targetGroup: 'ga', targetJid: 'j' });
    const b = createDelegation({ targetGroup: 'gb', targetJid: 'j' });
    expect(listDelegations().length).toBe(2);
    expect(listDelegations('ga').map((d) => d.taskId)).toEqual([a.taskId]);
    expect(listDelegations('gb').map((d) => d.taskId)).toEqual([b.taskId]);
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
    const t = createDelegation({ targetGroup: 'sub3', targetJid: 'fs:oc_3' });
    expect(finalizeDelegationOnTurnEnd('sub3', true)).toBe(true);
    expect(getDelegation(t.taskId)?.status).toBe('done');
    // 已关闭，再次调用不重复触发
    expect(finalizeDelegationOnTurnEnd('sub3', true)).toBe(false);
  });

  it('异常结束自动补 failed', () => {
    regMain();
    const t = createDelegation({ targetGroup: 'sub3', targetJid: 'fs:oc_3' });
    updateDelegationOnReport({ taskId: t.taskId, status: 'progress' });
    expect(finalizeDelegationOnTurnEnd('sub3', false)).toBe(true);
    expect(getDelegation(t.taskId)?.status).toBe('failed');
  });

  it('question 等待态不被自动 done 覆盖', () => {
    regMain();
    const t = createDelegation({ targetGroup: 'sub3', targetJid: 'fs:oc_3' });
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
    const t = createDelegation({ targetGroup: 'sub3', targetJid: 'fs:oc_3' });
    const longReply = 'x'.repeat(5000);
    expect(finalizeDelegationOnTurnEnd('sub3', true, longReply)).toBe(true);
    const got = getDelegation(t.taskId)!;
    expect(got.status).toBe('done');
    expect(got.details).toBe('x'.repeat(2000));
  });

  it('空回复时 details 留空，不写无意义占位', () => {
    regMain();
    const t = createDelegation({ targetGroup: 'sub3', targetJid: 'fs:oc_3' });
    expect(finalizeDelegationOnTurnEnd('sub3', true, '   ')).toBe(true);
    expect(getDelegation(t.taskId)?.details).toBeUndefined();
  });
});
