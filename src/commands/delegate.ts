import { ASSISTANT_NAME, TIMEZONE } from '../config.js';
import {
  closeDelegation,
  getActiveDelegationByGroup,
  getDelegation,
  listDelegations,
  replyDelegation,
  resetDelegationToDispatched,
  storeMessageDirect,
} from '../db.js';
import { logger } from '../logger.js';
import type { DelegationTask } from '../types.js';
import { registerCommand } from './registry.js';

/** 失联阈值（毫秒）：仅 dispatched/progress 参与判定 */
const STALE_THRESHOLD_MS = 15 * 60 * 1000;

/** 续投/重派可作用的占槽态（reply 仅限进行/等待态） */
const REPLYABLE = new Set(['progress', 'blocked', 'question']);

function shortId(taskId: string): string {
  // dlg_<ts>_<rand> → 取末段 rand，足够人眼区分
  const parts = taskId.split('_');
  return parts[parts.length - 1] || taskId;
}

function fmtTime(iso?: string): string {
  if (!iso) return '-';
  try {
    return new Date(iso).toLocaleString('zh-CN', {
      timeZone: TIMEZONE,
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function isStale(t: DelegationTask): boolean {
  if (t.status !== 'dispatched' && t.status !== 'progress') return false;
  const ref = t.lastReportAt || t.dispatchedAt;
  return Date.now() - new Date(ref).getTime() > STALE_THRESHOLD_MS;
}

function truncate(s: string | undefined, n: number): string {
  if (!s) return '';
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function renderStatus(tasks: DelegationTask[]): string {
  if (tasks.length === 0) return '📋 暂无派工记录。';
  const lines = ['📋 派工状态：', ''];
  for (const t of tasks) {
    const stale = isStale(t) ? ' ⚠️失联' : '';
    const last = fmtTime(t.lastReportAt || t.dispatchedAt);
    lines.push(
      `• [${shortId(t.taskId)}] ${t.targetGroup} | ${t.status}${stale} | ${last}`,
    );
    const detail = truncate(t.summary || t.title, 40);
    if (detail) lines.push(`    ${detail}`);
  }
  return lines.join('\n');
}

/**
 * deliverToSubgroup 结果：
 * - ok            投递+入库都成功，调用方可推进状态
 * - send-failed   飞书发送就失败，消息没出去，状态绝不能动
 * - store-failed  飞书发出去了但跨群入库失败 → message loop 扫不到这条，
 *                 子群 agent 收不到，状态同样不能推进（否则账本说 progress
 *                 但 agent 根本没接到活，是更隐蔽的幽灵续投）
 */
type DeliverResult = 'ok' | 'send-failed' | 'store-failed';

/**
 * 主群续投/重派时把消息投到子群（host 注入 task_id 前缀 + 跨群入库）。
 *
 * 顺序：先发飞书成功，再入库。和 ipc.ts 的 delegate 一致——飞书发送失败绝不
 * 入库；发送成功但入库失败也不推进状态（返回 store-failed），因为子群 agent
 * 是靠 message loop 扫 DB 接活的，DB 没这条就等于没派到，调用方需提示主群手动确认。
 */
async function deliverToSubgroup(
  targetJid: string,
  taskId: string,
  text: string,
  sourceGroup: string,
  channel: {
    sendMessage: (
      jid: string,
      text: string,
      opts?: object,
    ) => Promise<string | undefined>;
  },
): Promise<DeliverResult> {
  const prefixedText = `[task_id:${taskId}]\n${text}`;
  const crossGroupSender = `${ASSISTANT_NAME}(${sourceGroup})`;
  try {
    await channel.sendMessage(targetJid, prefixedText);
  } catch (err) {
    logger.error({ err, taskId }, '/delegate 投递发送失败，不入库不推进状态');
    return 'send-failed';
  }
  try {
    storeMessageDirect({
      id: `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: targetJid,
      sender: crossGroupSender,
      sender_name: crossGroupSender,
      content: prefixedText,
      timestamp: new Date().toISOString(),
      is_from_me: false,
      is_bot_message: false,
    });
  } catch (err) {
    logger.error({ err, taskId }, '/delegate 发送成功但入库失败，agent 收不到，不推进状态');
    return 'store-failed';
  }
  return 'ok';
}

registerCommand({
  name: '/delegate',
  description:
    '派工账本管理：status 查看 / reply 续投 / retry 重派 / close 关闭',
  hasArgs: true,
  requiresMain: true,
  order: 30,
  subcommands: [
    { usage: '/delegate status [group]', description: '查看派工状态表' },
    {
      usage: '/delegate reply <task_id> <text>',
      description: '对进行/等待态任务续投（状态回 progress）',
    },
    { usage: '/delegate retry <task_id>', description: '重派任务（状态回 dispatched）' },
    { usage: '/delegate close <task_id>', description: '关闭任务，释放在办槽位' },
  ],
  handler: async (ctx) => {
    const reply = (text: string) =>
      ctx.channel.sendMessage(ctx.chatJid, text, { isCommandReply: true });

    const args = ctx.args.trim();
    const [sub, ...rest] = args.split(/\s+/);

    // 无参数或 status：展示状态表
    if (!sub || sub === 'status') {
      const groupFilter = rest[0];
      const tasks = listDelegations(groupFilter);
      await reply(renderStatus(tasks));
      return;
    }

    if (sub === 'reply') {
      const taskId = rest[0];
      const text = rest.slice(1).join(' ');
      if (!taskId || !text) {
        await reply('用法：/delegate reply <task_id> <续投内容>');
        return;
      }
      const task = getDelegation(taskId);
      if (!task) {
        await reply(`未找到任务 ${taskId}`);
        return;
      }
      if (!REPLYABLE.has(task.status)) {
        await reply(
          `任务 ${taskId} 当前状态 ${task.status}，已关闭，不能续投。`,
        );
        return;
      }
      const sent = await deliverToSubgroup(
        task.targetJid,
        task.taskId,
        text,
        ctx.group.folder,
        ctx.channel,
      );
      if (sent === 'send-failed') {
        await reply(`续投失败：发送给 ${task.targetGroup} 出错，状态未变更，请重试。`);
        return;
      }
      if (sent === 'store-failed') {
        await reply(
          `⚠️ 续投消息已发到 ${task.targetGroup}，但跨群入库失败，` +
            `子群 agent 可能扫不到，状态未变更。请重试或在子群确认是否收到。`,
        );
        return;
      }
      replyDelegation(task.taskId);
      logger.info({ taskId: task.taskId }, '/delegate reply 续投');
      await reply(`✅ 已续投给 ${task.targetGroup}（${taskId}），状态回 progress。`);
      return;
    }

    if (sub === 'retry') {
      const taskId = rest[0];
      if (!taskId) {
        await reply('用法：/delegate retry <task_id>');
        return;
      }
      const task = getDelegation(taskId);
      if (!task) {
        await reply(`未找到任务 ${taskId}`);
        return;
      }
      // 防破坏"一群一在办"：若目标群当前已有"另一个"占槽任务，retry 会让该群
      // 出现两个在办任务（且会撞 DB 唯一索引）。要求先关掉那个再 retry。
      const active = getActiveDelegationByGroup(task.targetGroup);
      if (active && active.taskId !== task.taskId) {
        await reply(
          `重派被拒：${task.targetGroup} 已有在办任务 ${active.taskId}（${active.status}）。` +
            `先 /delegate close ${active.taskId} 再重派 ${taskId}。`,
        );
        return;
      }
      const sent = await deliverToSubgroup(
        task.targetJid,
        task.taskId,
        task.title || '(重派任务)',
        ctx.group.folder,
        ctx.channel,
      );
      if (sent === 'send-failed') {
        await reply(`重派失败：发送给 ${task.targetGroup} 出错，状态未变更，请重试。`);
        return;
      }
      if (sent === 'store-failed') {
        await reply(
          `⚠️ 重派消息已发到 ${task.targetGroup}，但跨群入库失败，` +
            `子群 agent 可能扫不到，状态未变更。请重试或在子群确认是否收到。`,
        );
        return;
      }
      resetDelegationToDispatched(task.taskId);
      logger.info({ taskId: task.taskId }, '/delegate retry 重派');
      await reply(`✅ 已重派给 ${task.targetGroup}（${taskId}），状态回 dispatched。`);
      return;
    }

    if (sub === 'close') {
      const taskId = rest[0];
      if (!taskId) {
        await reply('用法：/delegate close <task_id>');
        return;
      }
      const task = getDelegation(taskId);
      if (!task) {
        await reply(`未找到任务 ${taskId}`);
        return;
      }
      closeDelegation(task.taskId);
      logger.info({ taskId: task.taskId }, '/delegate close 关闭');
      await reply(`✅ 已关闭任务 ${taskId}，释放 ${task.targetGroup} 在办槽位。`);
      return;
    }

    await reply(
      '未知子命令。可用：/delegate status | reply | retry | close',
    );
  },
});
