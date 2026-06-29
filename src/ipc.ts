import fs from 'fs';
import path from 'path';

import { CronExpressionParser } from 'cron-parser';

import crypto from 'crypto';

import {
  ASSISTANT_NAME,
  CHAT_INDEX_ENABLED,
  DATA_DIR,
  IPC_POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { getChatIndex } from './chat-index.js';
import { AvailableGroup, getFeishuToken } from './container-runner.js';
import {
  clampRangeParams,
  addTaskLedgerEvent,
  createDelegation,
  createTask,
  createTaskLedgerTask,
  deleteTask,
  failDelegation,
  getActiveDelegationByGroup,
  getGroupAlias,
  getMessageContext,
  getMessageContextById,
  getMessageRange,
  getTaskById,
  getTaskLedgerTask,
  listTaskLedgerTasks,
  setDelegationDispatchMsgId,
  storeMessageDirect,
  updateDelegationOnReport,
  updateTask,
  updateTaskLedgerTask,
  upsertTaskLedgerChecklistItem,
  upsertTaskLedgerTestCase,
} from './db.js';
import { partitionArtifacts } from './commander.js';
import { resolveTargetChatJid } from './group-alias.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { MemoryStore } from './memory/memory-store.js';
import { extractAndRefine } from './memory/extract-fact.js';
import { loadFacts, storeFactRaw } from './memory/storage.js';
import { isMemoryEnabled } from './memory/index.js';
import { ReportStatus, RegisteredGroup } from './types.js';

/** report_to_main 允许的 status 白名单（host 边界校验，不信任 agent schema） */
const REPORT_ALLOWED_STATUSES = new Set<string>([
  'progress',
  'done',
  'blocked',
  'failed',
  'question',
]);

/** 自动终态兜底汇报里携带的子群最终回复摘要上限（防超长撑爆主群 context） */
const FINALIZE_DETAILS_MAX = 2000;

const TASK_LEDGER_STAGE_ORDER = [
  'draft',
  'draft_prd',
  'effect_locked',
  'e2e_defined',
  'tests_planned',
  'implementing',
  'verifying',
  'done',
] as const;

function taskLedgerStageIndex(status: string): number {
  const index = TASK_LEDGER_STAGE_ORDER.indexOf(status as never);
  return index === -1 ? -1 : index;
}

function taskLedgerAtLeast(status: string, required: string): boolean {
  return taskLedgerStageIndex(status) >= taskLedgerStageIndex(required);
}

/**
 * 同一目标群 messages.db 内 ipc_ 消息的单调递增时间戳。
 * message loop cursor 按 timestamp 推进；同毫秒写多条 ipc_ 消息时，
 * 若 cursor 已停在该毫秒，后续同 timestamp 消息会被漏扫（report 合并场景易撞）。
 * 这里按 jid 记录上次发放的毫秒值，保证严格递增（无锁，单进程 watcher 足够）。
 */
const lastIpcTsMs = new Map<string, number>();
function nextIpcTimestamp(jid: string): string {
  const prev = lastIpcTsMs.get(jid) ?? 0;
  const ms = Math.max(Date.now(), prev + 1);
  lastIpcTsMs.set(jid, ms);
  return new Date(ms).toISOString();
}

/** report 消息的完整元信息，storeReportToSource 返回，注入回调和测试共用 */
export type ReportMeta = {
  id: string;
  timestamp: string;
  text: string;
  sender: string;
};

export interface IpcDeps {
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
  registeredGroups: () => Record<string, RegisteredGroup>;
  registerGroup: (jid: string, group: RegisteredGroup) => void;
  syncGroups: (force: boolean) => Promise<void>;
  getAvailableGroups: () => AvailableGroup[];
  writeGroupsSnapshot: (
    groupFolder: string,
    isMain: boolean,
    availableGroups: AvailableGroup[],
    registeredJids: Set<string>,
  ) => void;
  onTasksChanged: () => void;
  onFeishuAuthRequest?: (chatJid: string, groupFolder: string) => Promise<void>;
  renameChat?: (jid: string, name: string) => Promise<void>;
  /** 尝试将 report 实时注入发起群活跃 agent（通过 queue.sendMessage），返回是否成功 */
  injectReportToActiveAgent?: (
    sourceJid: string,
    reportMeta: ReportMeta,
  ) => boolean;
  /** report 被拒时通知 reporting agent（通过 queue.sendMessage 注入错误消息） */
  notifyReportRejected?: (
    reportingGroupFolder: string,
    reason: string,
  ) => void;
}

/**
 * 写入 IPC response 文件（原子写入：.tmp + rename）。
 * 用于 memory_recall 等 request-response 模式。
 */
export function writeIpcResponse(
  groupFolder: string,
  requestId: string,
  data: object,
): void {
  const responsesDir = path.join(DATA_DIR, 'ipc', groupFolder, 'responses');
  fs.mkdirSync(responsesDir, { recursive: true });
  const filepath = path.join(responsesDir, `${requestId}.json`);
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);
}

let ipcWatcherRunning = false;

// 短窗口去重：防止 session resume 重复执行 send_message
/** @internal Exported for testing only */
export const recentMessages = new Map<string, number>(); // hash → timestamp
const DEDUP_WINDOW_MS = 30_000;

/** @internal Exported for testing only */
export function isDuplicateMessage(chatJid: string, text: string): boolean {
  const key = `${chatJid}:${crypto.createHash('md5').update(text).digest('hex')}`;
  const now = Date.now();
  // 清理过期条目 + 防无限增长
  for (const [k, t] of recentMessages) {
    if (now - t > DEDUP_WINDOW_MS) recentMessages.delete(k);
  }
  if (recentMessages.size > 1000) recentMessages.clear();
  if (recentMessages.has(key)) return true;
  recentMessages.set(key, now);
  return false;
}

export function canSendMessageViaIpc(
  sourceGroup: string,
  targetChatJid: string,
  registeredGroups: Record<string, RegisteredGroup>,
): boolean {
  const targetGroup = registeredGroups[targetChatJid];
  return !!targetGroup && targetGroup.folder === sourceGroup;
}

export function startIpcWatcher(deps: IpcDeps): void {
  if (ipcWatcherRunning) {
    logger.debug('IPC watcher already running, skipping duplicate start');
    return;
  }
  ipcWatcherRunning = true;

  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  fs.mkdirSync(ipcBaseDir, { recursive: true });

  const processIpcFiles = async () => {
    // Scan all group IPC directories (identity determined by directory)
    let groupFolders: string[];
    try {
      groupFolders = fs.readdirSync(ipcBaseDir).filter((f) => {
        const stat = fs.statSync(path.join(ipcBaseDir, f));
        return stat.isDirectory() && f !== 'errors';
      });
    } catch (err) {
      logger.error({ err }, 'Error reading IPC base directory');
      setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
      return;
    }

    const registeredGroups = deps.registeredGroups();

    // Build folder→isMain lookup from registered groups
    const folderIsMain = new Map<string, boolean>();
    for (const group of Object.values(registeredGroups)) {
      if (group.isMain) folderIsMain.set(group.folder, true);
    }

    for (const sourceGroup of groupFolders) {
      const isMain = folderIsMain.get(sourceGroup) === true;
      const messagesDir = path.join(ipcBaseDir, sourceGroup, 'messages');
      const tasksDir = path.join(ipcBaseDir, sourceGroup, 'tasks');

      // Process messages from this group's IPC directory
      try {
        if (fs.existsSync(messagesDir)) {
          const messageFiles = fs
            .readdirSync(messagesDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of messageFiles) {
            const filePath = path.join(messagesDir, file);
            try {
              const raw = fs.readFileSync(filePath, 'utf-8');
              // 先删除文件再处理，防止 async 操作期间下一个 poll cycle 重复读取
              fs.unlinkSync(filePath);
              const data = JSON.parse(raw);
              if (data.type === 'message' && data.chatJid && data.text) {
                // 飞书授权请求 — text 中包含 feishu_auth_request JSON
                let isAuthRequest = false;
                try {
                  const parsed =
                    typeof data.text === 'string'
                      ? JSON.parse(data.text)
                      : null;
                  if (parsed?.type === 'feishu_auth_request')
                    isAuthRequest = true;
                } catch {
                  /* 不是 JSON，正常消息 */
                }
                if (isAuthRequest || data.type === 'feishu_auth_request') {
                  if (deps.onFeishuAuthRequest) {
                    await deps.onFeishuAuthRequest(data.chatJid, sourceGroup);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'Feishu auth request processed',
                    );
                  }
                  continue;
                }
              }

              if (
                data.type === 'rename_chat' &&
                data.chatJid &&
                data.name &&
                deps.renameChat
              ) {
                const targetGroup = registeredGroups[data.chatJid];
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
                  await deps.renameChat(data.chatJid, data.name);
                  logger.info(
                    { chatJid: data.chatJid, name: data.name, sourceGroup },
                    'IPC rename_chat processed',
                  );
                } else {
                  logger.warn(
                    { chatJid: data.chatJid, sourceGroup },
                    'Unauthorized IPC rename_chat blocked',
                  );
                }
                continue;
              }

              if (data.type === 'message' && data.chatJid && data.text) {
                const originalTarget = data.chatJid;
                const resolvedTarget = resolveTargetChatJid(
                  String(data.chatJid),
                  getGroupAlias,
                );
                data.chatJid = resolvedTarget.chatJid;
                if (resolvedTarget.alias) {
                  logger.info(
                    {
                      alias: resolvedTarget.alias,
                      chatJid: data.chatJid,
                      sourceGroup,
                    },
                    'IPC message target alias resolved',
                  );
                }
                // 短窗口去重：session resume 可能重复执行 send_message
                if (isDuplicateMessage(data.chatJid, data.text)) {
                  logger.info(
                    { chatJid: data.chatJid, originalTarget, sourceGroup },
                    'IPC message deduplicated (same content within 30s window)',
                  );
                  continue;
                }
                // Authorization: send_message 仅允许同群即时通知。
                // 跨群派工必须走 delegate，避免绕过 delegation 账本导致汇报闭环断裂。
                const isSameGroup = canSendMessageViaIpc(
                  sourceGroup,
                  data.chatJid,
                  registeredGroups,
                );
                const isCrossGroup = !isSameGroup;
                if (isSameGroup) {
                  await deps.sendMessage(data.chatJid, data.text);
                  // 存入 messages.db，供巡检和搜索使用
                  try {
                    // 跨群消息：is_from_me=false + sender_name 带源群标识
                    // 让目标 agent 视为「其他群 agent 发来的用户消息」而非自己的历史
                    // trigger 检查由 ipc_ ID 前缀绕过（见 index.ts），不再靠 is_from_me
                    const crossGroupSender = isCrossGroup
                      ? `${ASSISTANT_NAME}(${sourceGroup})`
                      : data.sender || ASSISTANT_NAME;
                    storeMessageDirect({
                      id: `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                      chat_jid: data.chatJid,
                      sender: crossGroupSender,
                      sender_name: crossGroupSender,
                      content: data.text,
                      // 跨群消息用 host 入库时刻，而非源 agent 写 IPC 文件时的旧时间。
                      // 否则在「源 agent 发消息」到「host 入库」的窗口里，别的群消息
                      // 可能把全局 lastTimestamp 推过这条旧 timestamp，导致 message loop
                      // 的 timestamp > lastTimestamp 永远扫不到它（删掉主动 enqueue 后
                      // message loop 是唯一投喂路径，扫不到 = 消息发出去但目标 agent 不接活）。
                      // 同群消息是 bot message（is_bot_message=1），本就被 getNewMessages
                      // 过滤掉，不走这条路径，故只对跨群覆盖时间。
                      timestamp: isCrossGroup
                        ? new Date().toISOString()
                        : data.timestamp || new Date().toISOString(),
                      is_from_me: !isCrossGroup,
                      is_bot_message: !isCrossGroup,
                    });
                  } catch (storeErr) {
                    logger.warn(
                      { storeErr },
                      'IPC send_message 入库失败，不影响发送',
                    );
                  }
                  // 跨群消息不在此处主动 enqueue：统一交给 message loop 发现并处理。
                  // message loop 已对 ipc_ 消息放行 trigger（index.ts），冷启动则
                  // enqueueMessageCheck 起容器、热容器则 pipe，并在成功后推进
                  // lastAgentTimestamp。若此处再 enqueue 会形成与 message loop 并行的
                  // 第二条投喂路径，导致同一条消息进同一 agent stream 两次、重复回复。
                  logger.info(
                    {
                      chatJid: data.chatJid,
                      originalTarget,
                      alias: resolvedTarget.alias,
                      sourceGroup,
                    },
                    'IPC message sent',
                  );
                } else {
                  logger.warn(
                    {
                      chatJid: data.chatJid,
                      originalTarget,
                      alias: resolvedTarget.alias,
                      sourceGroup,
                    },
                    'Cross-group send_message blocked; use delegate for cross-group work',
                  );
                }
              }

              // --- Commander：派工 delegate（已注册群可发起，host 侧校验 source/target）---
              if (data.type === 'delegate' && data.target && data.text) {
                await handleDelegate(data, sourceGroup, registeredGroups, deps);
              }

              // --- Commander：汇报 report（目标群回任务发起群）---
              if (data.type === 'report' && data.status && data.summary) {
                handleReport(data, sourceGroup, registeredGroups, deps);
              }
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC message',
              );
              // 文件可能已被 unlinkSync 删除，只在文件仍存在时移到 errors
              if (fs.existsSync(filePath)) {
                const errorDir = path.join(ipcBaseDir, 'errors');
                fs.mkdirSync(errorDir, { recursive: true });
                fs.renameSync(
                  filePath,
                  path.join(errorDir, `${sourceGroup}-${file}`),
                );
              }
            }
          }
        }
      } catch (err) {
        logger.error(
          { err, sourceGroup },
          'Error reading IPC messages directory',
        );
      }

      // Process tasks from this group's IPC directory
      try {
        if (fs.existsSync(tasksDir)) {
          const taskFiles = fs
            .readdirSync(tasksDir)
            .filter((f) => f.endsWith('.json'));
          for (const file of taskFiles) {
            const filePath = path.join(tasksDir, file);
            try {
              const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
              // Pass source group identity to processTaskIpc for authorization
              await processTaskIpc(data, sourceGroup, isMain, deps);
              fs.unlinkSync(filePath);
            } catch (err) {
              logger.error(
                { file, sourceGroup, err },
                'Error processing IPC task',
              );
              const errorDir = path.join(ipcBaseDir, 'errors');
              fs.mkdirSync(errorDir, { recursive: true });
              fs.renameSync(
                filePath,
                path.join(errorDir, `${sourceGroup}-${file}`),
              );
            }
          }
        }
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Error reading IPC tasks directory');
      }

      // 清理孤儿 response 文件（超过 60s 未被读取）
      try {
        const responsesDir = path.join(ipcBaseDir, sourceGroup, 'responses');
        if (fs.existsSync(responsesDir)) {
          const now = Date.now();
          for (const file of fs.readdirSync(responsesDir)) {
            const filePath = path.join(responsesDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (now - stat.mtimeMs > 60_000) {
                fs.unlinkSync(filePath);
                logger.debug(
                  { file, sourceGroup },
                  'Cleaned stale IPC response',
                );
              }
            } catch {
              // 文件可能已被 agent 读走
            }
          }
        }
      } catch {
        // responses 目录不存在或读取失败，忽略
      }
    }

    setTimeout(processIpcFiles, IPC_POLL_INTERVAL);
  };

  processIpcFiles();
  logger.info('IPC watcher started (per-group namespaces)');
}

/** 找某 folder 对应的 chatJid（用于给主群回提示） */
function findJidByFolder(
  registeredGroups: Record<string, RegisteredGroup>,
  folder: string,
): string | undefined {
  for (const [jid, g] of Object.entries(registeredGroups)) {
    if (g.folder === folder) return jid;
  }
  return undefined;
}

/**
 * 处理 delegate IPC：任意已注册 source 群派活给另一个已注册 target 群。
 * 先校验 source/target + 一目标群一在办任务约束 → 落账本拿 task_id → host 注入
 * [task_id:xxx] 前缀 → 复用跨群投递 → 回写 dispatch_msg_id。
 */
async function handleDelegate(
  data: {
    target?: string;
    text?: string;
    title?: string;
  },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps: IpcDeps,
): Promise<void> {
  const sourceJid = findJidByFolder(registeredGroups, sourceGroup);
  if (!sourceJid) {
    logger.warn({ sourceGroup }, 'delegate source group not registered');
    return;
  }
  const notifySource = async (text: string) => {
    await deps.sendMessage(sourceJid, text);
  };

  // 解析目标群别名 → jid
  const rawTarget = String(data.target);
  const resolved = resolveTargetChatJid(rawTarget, getGroupAlias);
  const targetJid = resolved.chatJid;
  const targetGroup = registeredGroups[targetJid];
  if (!targetGroup) {
    logger.warn(
      { rawTarget, targetJid, sourceGroup },
      'delegate target group not registered',
    );
    await notifySource(`派工失败：目标群 ${rawTarget} 未注册。`);
    return;
  }
  const targetFolder = targetGroup.folder;
  if (targetFolder === sourceGroup) {
    logger.warn(
      { rawTarget, sourceGroup },
      'delegate self-delegation rejected',
    );
    await notifySource(`派工失败：不能给自己派工。`);
    return;
  }

  // 一群一在办任务约束
  const active = getActiveDelegationByGroup(targetFolder);
  if (active) {
    logger.warn(
      { targetFolder, activeTaskId: active.taskId },
      'delegate rejected: target group has an in-flight task',
    );
    await notifySource(
      `派工被拒：${rawTarget} 已有在办任务 ${active.taskId}（${active.status}）。` +
        `用 /delegate reply ${active.taskId} <内容> 续投，或 /delegate close ${active.taskId} 关闭后再派。`,
    );
    return;
  }

  // 先落账本拿 task_id
  const task = createDelegation({
    sourceGroup,
    sourceJid,
    targetGroup: targetFolder,
    targetJid,
    title: data.title,
  });

  // host 注入 task_id 前缀（不靠 agent）
  const prefixedText = `[task_id:${task.taskId}]\n${data.text}`;

  // 复用跨群投递：发飞书 + 入目标群 messages.db（host 时刻 + ipc_ 前缀 + 跨群 sender）
  let msgId: string | undefined;
  try {
    msgId = await deps.sendMessage(targetJid, prefixedText);
  } catch (sendErr) {
    // 发送失败：失败终态回滚槽位，保留审计，避免 dispatched 幽灵占槽。
    failDelegation(task.taskId, `派工失败：发送给 ${rawTarget} 出错。`);
    logger.error(
      { sendErr, taskId: task.taskId, targetFolder },
      'delegate 发送失败，已标记 failed 回滚槽位',
    );
    await notifySource(`派工失败：发送给 ${rawTarget} 出错，已回滚。`);
    return;
  }
  try {
    const crossGroupSender = `${ASSISTANT_NAME}(${sourceGroup})`;
    storeMessageDirect({
      id: `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      chat_jid: targetJid,
      sender: crossGroupSender,
      sender_name: crossGroupSender,
      content: prefixedText,
      timestamp: nextIpcTimestamp(targetJid),
      is_from_me: false,
      is_bot_message: false,
    });
  } catch (storeErr) {
    // 飞书发出去了但入目标群库失败：agent 靠 message loop 扫 DB 才收得到，
    // 入库失败 = agent 收不到这条任务，但账本却占着 dispatched 槽。
    // 必须回滚为 failed 释放槽位并通知发起群重派，否则目标群被幽灵任务永久占住。
    failDelegation(
      task.taskId,
      `派工异常：${rawTarget} 消息已发但入库失败，目标群 agent 可能收不到。`,
    );
    logger.error(
      { storeErr, taskId: task.taskId, targetFolder },
      'delegate 入目标群库失败，已标记 failed 回滚槽位（飞书消息已发但 agent 收不到）',
    );
    await notifySource(
      `派工异常：${rawTarget} 消息已发但入库失败，子群 agent 可能收不到，已回滚槽位，请重新派工。`,
    );
    return;
  }

  if (msgId) setDelegationDispatchMsgId(task.taskId, msgId);

  logger.info(
    { taskId: task.taskId, targetFolder, sourceGroup },
    'delegate dispatched',
  );
}

/**
 * 处理 report IPC：目标群向任务发起群汇报。
 * 用 reporting_group 锁 target_group 的在办 task → 读取 task.source_jid
 * → 更新账本 → 组装可读消息入发起群 messages.db（host 时刻 + ipc_ 前缀，
 * 不调 enqueueMessageCheck，交给 message loop 统一限流投喂）。
 */
function handleReport(
  data: {
    status?: string;
    summary?: string;
    details?: string;
    artifacts?: string[];
  },
  sourceGroup: string,
  registeredGroups: Record<string, RegisteredGroup>,
  deps?: Pick<IpcDeps, 'injectReportToActiveAgent' | 'notifyReportRejected'>,
): void {
  const reportingGroup = sourceGroup;

  // host 边界白名单校验 status：report_to_main 只允许这 5 个值。
  // 不信任 agent 端 MCP schema —— 绕过 schema 直接写 IPC 文件就能注入
  // closed/dispatched/任意字符串，必须在 host 拒绝。
  if (!REPORT_ALLOWED_STATUSES.has(data.status as string)) {
    logger.warn(
      { sourceGroup, status: data.status },
      'report 非法 status，丢弃汇报',
    );
    return;
  }
  const status = data.status as ReportStatus;

  // reporting_group 反查唯一在办任务。无在办任务 = 当前群越界汇报（没人派工却 report），
  // 直接拒绝，不投任何群——否则会变成任意发消息通道。
  const task = getActiveDelegationByGroup(reportingGroup);
  if (!task) {
    logger.warn(
      { reportingGroup, status },
      'report 该群无在办任务，拒绝汇报（疑似越界）',
    );
    deps?.notifyReportRejected?.(
      reportingGroup,
      '⚠️ 你当前没有在办的 delegation 任务，report 已被 host 拒绝。' +
        '刚才工具返回的成功只是本地提交成功，host 实际拒绝了该 report。' +
        '请直接回复用户而不是使用汇报工具。',
    );
    return;
  }

  // artifacts 白名单校验
  const sourceReg = registeredGroups[
    findJidByFolder(registeredGroups, reportingGroup) || ''
  ] as RegisteredGroup | undefined;
  const allowedRoots = [
    resolveGroupFolderPath(reportingGroup),
    sourceReg?.customCwd || process.env.NANOCLAW_DEFAULT_CWD || '',
    '/tmp/nanoclaw-artifacts',
  ].filter(Boolean);
  const { valid, rejected } = partitionArtifacts(data.artifacts, allowedRoots);
  if (rejected.length > 0) {
    logger.warn(
      { sourceGroup, rejected },
      'report artifacts 含非法路径，已降级为纯文本备注',
    );
  }

  // 更新账本
  updateDelegationOnReport({
    taskId: task.taskId,
    status,
    summary: data.summary,
    details: data.details,
    artifacts: valid.length > 0 ? valid : undefined,
  });

  // 组装可读汇报消息
  const lines = [`【汇报｜${reportingGroup}｜${status}】${data.summary}`];
  if (data.details) lines.push(data.details);
  if (valid.length > 0) lines.push(`产物: ${valid.join(', ')}`);
  if (rejected.length > 0)
    lines.push(`[artifact 路径不合法已忽略: ${rejected.join(', ')}]`);
  lines.push(`(task ${task.taskId})`);
  const reportText = lines.join('\n');

  const meta = deliverReportToSource(
    task.sourceJid,
    reportingGroup,
    reportText,
    deps,
  );
  logger.info(
    {
      reportingGroup,
      status,
      taskId: task.taskId,
      sourceJid: task.sourceJid,
      reportId: meta.id,
    },
    'report delivered to source group',
  );
}

/**
 * 把一条汇报文本入任务发起群 messages.db。
 * host 时刻（nextIpcTimestamp 保证同群严格递增）+ ipc_ 前缀（绕 trigger）+
 * is_from_me=false。绝不 enqueueMessageCheck —— 交给 message loop 统一发现，
 * 把同一周期内的多条汇报合并成一次 context 喂给主群 agent（复用 2026-06-07
 * 删双投喂修复后的统一路径，避免 N 个子群同时 done 触发主群 N 次 + 双投喂）。
 */
function storeReportToSource(
  sourceJid: string,
  reportingGroup: string,
  reportText: string,
): ReportMeta {
  const reportSender = `${ASSISTANT_NAME}(${reportingGroup})`;
  const id = `ipc_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const timestamp = nextIpcTimestamp(sourceJid);
  storeMessageDirect({
    id,
    chat_jid: sourceJid,
    sender: reportSender,
    sender_name: reportSender,
    content: reportText,
    timestamp,
    is_from_me: false,
    is_bot_message: false,
  });
  return { id, timestamp, text: reportText, sender: reportSender };
}

/**
 * 统一投递：DB 写入 + 尝试注入活跃 agent。
 * handleReport 和 finalizeDelegationOnTurnEnd 共用此函数。
 */
function deliverReportToSource(
  sourceJid: string,
  reportingGroup: string,
  reportText: string,
  deps?: Pick<IpcDeps, 'injectReportToActiveAgent'>,
): ReportMeta {
  const meta = storeReportToSource(sourceJid, reportingGroup, reportText);
  if (deps?.injectReportToActiveAgent) {
    const injected = deps.injectReportToActiveAgent(sourceJid, meta);
    logger.info(
      { sourceJid, reportId: meta.id, injected },
      'deliverReportToSource: injection attempt',
    );
  }
  return meta;
}

/**
 * 子群 agent 一轮结束时的自动终态兜底汇报（host 侧调用）。
 *
 * 背景：report_to_main 是子群主动汇报的主路径，但 agent 可能正常干完却忘了调，
 * 账本就停在 dispatched/progress，要等 15 分钟失联才暴露。这里在 host 侧的
 * 「一轮 query 结束」信号里兜底：若该群仍有进行态任务，自动补 done/failed。
 *
 * 仅对进行态（dispatched/progress）生效：
 * - 等待态（blocked/question）是 agent 主动留给主群的信号，不能被自动 done 覆盖；
 * - 关闭态（done/failed/closed）已结束，getActiveDelegationByGroup 查不到，天然跳过。
 * 因此 agent 若已自主汇报，本函数自动不触发，无重复。
 *
 * @returns 是否实际触发了一次自动汇报（用于日志）
 */

/**
 * 判断当前 query 的回复内容是否应携带进自动终态汇报。
 * 归因校验：
 * 1. 触发消息全部为 ipc_（跨群派工触发，非用户直接消息）
 * 2. 至少一条消息含活跃任务的 task_id（允许混入旧任务的 stale 消息）
 *
 * 放宽原因：进程重启/游标未推进时，DB 可能残留上一次派工的 ipc_ 消息，
 * 其 task_id 与当前活跃任务不同。旧的"只含一个 task_id"检查会误判 false。
 */
export function shouldCarryReply(
  missedMessages: Array<{ id: string; content: string }>,
  activeTask: { taskId: string },
): boolean {
  // 必须全部是 IPC 消息
  if (!missedMessages.every((m) => m.id.startsWith('ipc_'))) return false;

  // 提取消息中引用的 task_id（格式：[task_id:dlg_xxx]，由 delegate 注入）
  const taskIds = new Set<string>();
  for (const m of missedMessages) {
    const match = m.content.match(/\[task_id:(dlg_[a-z0-9_]+)\]/);
    if (match) taskIds.add(match[1]);
  }

  // 至少一条消息含活跃任务的 task_id（容忍旧 stale 消息混入）
  if (taskIds.size === 0) return false;
  return taskIds.has(activeTask.taskId);
}

export function finalizeDelegationOnTurnEnd(
  reportingGroup: string,
  ok: boolean,
  finalReply?: string,
  deps?: Pick<IpcDeps, 'injectReportToActiveAgent'>,
): boolean {
  const task = getActiveDelegationByGroup(reportingGroup);
  if (!task) return false;
  if (task.status !== 'dispatched' && task.status !== 'progress') return false;

  const status: ReportStatus = ok ? 'done' : 'failed';
  const baseSummary = ok
    ? '子群本轮结束未显式汇报，host 自动标记完成。'
    : '子群本轮异常结束，host 自动标记失败。';
  // agent 忘了主动 report_to_main，host 兜底时把子群本轮最终回复当作结果摘要带给
  // 主群，避免主群只收到「host 自动标记完成」却不知道完成了什么。截断防超长。
  const details = finalReply?.trim()
    ? finalReply.trim().slice(0, FINALIZE_DETAILS_MAX)
    : undefined;
  updateDelegationOnReport({
    taskId: task.taskId,
    status,
    summary: baseSummary,
    details,
  });

  let reportText = `【汇报｜${reportingGroup}｜${status}】${baseSummary}`;
  if (details) reportText += `\n结果：${details}`;
  reportText += `\n(task ${task.taskId}，自动终态)`;
  try {
    const meta = deliverReportToSource(
      task.sourceJid,
      reportingGroup,
      reportText,
      deps,
    );
    logger.info(
      {
        reportingGroup,
        taskId: task.taskId,
        status,
        sourceJid: task.sourceJid,
        reportId: meta.id,
      },
      '自动终态汇报已投递发起群',
    );
  } catch (storeErr) {
    logger.error(
      {
        storeErr,
        reportingGroup,
        taskId: task.taskId,
        sourceJid: task.sourceJid,
        status,
      },
      '自动终态汇报入发起群库失败',
    );
  }
  return true;
}

export const __testing = {
  handleDelegate,
  handleReport,
};

export async function processTaskIpc(
  data: {
    type: string;
    taskId?: string;
    prompt?: string;
    schedule_type?: string;
    schedule_value?: string;
    context_mode?: string;
    script?: string;
    groupFolder?: string;
    chatJid?: string;
    targetJid?: string;
    // For register_group
    jid?: string;
    name?: string;
    folder?: string;
    trigger?: string;
    requiresTrigger?: boolean;
    containerConfig?: RegisteredGroup['containerConfig'];
    // For memory operations
    requestId?: string;
    query?: string;
    limit?: number;
    category?: string;
    content?: string;
    senderId?: string;
    options?: Record<string, unknown>;
  },
  sourceGroup: string, // Verified identity from IPC directory
  isMain: boolean, // Verified from directory path
  deps: IpcDeps,
): Promise<void> {
  const registeredGroups = deps.registeredGroups();

  switch (data.type) {
    case 'schedule_task':
      if (
        data.prompt &&
        data.schedule_type &&
        data.schedule_value &&
        data.targetJid
      ) {
        // Resolve the target group from JID
        const targetJid = data.targetJid as string;
        const targetGroupEntry = registeredGroups[targetJid];

        if (!targetGroupEntry) {
          logger.warn(
            { targetJid },
            'Cannot schedule task: target group not registered',
          );
          break;
        }

        const targetFolder = targetGroupEntry.folder;

        // Authorization: non-main groups can only schedule for themselves
        if (!isMain && targetFolder !== sourceGroup) {
          logger.warn(
            { sourceGroup, targetFolder },
            'Unauthorized schedule_task attempt blocked',
          );
          break;
        }

        const scheduleType = data.schedule_type as 'cron' | 'interval' | 'once';

        let nextRun: string | null = null;
        if (scheduleType === 'cron') {
          try {
            const interval = CronExpressionParser.parse(data.schedule_value, {
              tz: TIMEZONE,
            });
            nextRun = interval.next().toISOString();
          } catch {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid cron expression',
            );
            break;
          }
        } else if (scheduleType === 'interval') {
          const ms = parseInt(data.schedule_value, 10);
          if (isNaN(ms) || ms <= 0) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid interval',
            );
            break;
          }
          nextRun = new Date(Date.now() + ms).toISOString();
        } else if (scheduleType === 'once') {
          const date = new Date(data.schedule_value);
          if (isNaN(date.getTime())) {
            logger.warn(
              { scheduleValue: data.schedule_value },
              'Invalid timestamp',
            );
            break;
          }
          nextRun = date.toISOString();
        }

        const taskId =
          data.taskId ||
          `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
        const contextMode =
          data.context_mode === 'group' || data.context_mode === 'isolated'
            ? data.context_mode
            : 'isolated';
        createTask({
          id: taskId,
          group_folder: targetFolder,
          chat_jid: targetJid,
          prompt: data.prompt,
          script: data.script || null,
          schedule_type: scheduleType,
          schedule_value: data.schedule_value,
          context_mode: contextMode,
          next_run: nextRun,
          status: 'active',
          created_at: new Date().toISOString(),
        });
        logger.info(
          { taskId, sourceGroup, targetFolder, contextMode },
          'Task created via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'pause_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'paused' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task paused via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task pause attempt',
          );
        }
      }
      break;

    case 'resume_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          updateTask(data.taskId, { status: 'active' });
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task resumed via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task resume attempt',
          );
        }
      }
      break;

    case 'cancel_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (task && (isMain || task.group_folder === sourceGroup)) {
          deleteTask(data.taskId);
          logger.info(
            { taskId: data.taskId, sourceGroup },
            'Task cancelled via IPC',
          );
          deps.onTasksChanged();
        } else {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task cancel attempt',
          );
        }
      }
      break;

    case 'update_task':
      if (data.taskId) {
        const task = getTaskById(data.taskId);
        if (!task) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Task not found for update',
          );
          break;
        }
        if (!isMain && task.group_folder !== sourceGroup) {
          logger.warn(
            { taskId: data.taskId, sourceGroup },
            'Unauthorized task update attempt',
          );
          break;
        }

        const updates: Parameters<typeof updateTask>[1] = {};
        if (data.prompt !== undefined) updates.prompt = data.prompt;
        if (data.script !== undefined) updates.script = data.script || null;
        if (data.schedule_type !== undefined)
          updates.schedule_type = data.schedule_type as
            | 'cron'
            | 'interval'
            | 'once';
        if (data.schedule_value !== undefined)
          updates.schedule_value = data.schedule_value;

        // Recompute next_run if schedule changed
        if (data.schedule_type || data.schedule_value) {
          const updatedTask = {
            ...task,
            ...updates,
          };
          if (updatedTask.schedule_type === 'cron') {
            try {
              const interval = CronExpressionParser.parse(
                updatedTask.schedule_value,
                { tz: TIMEZONE },
              );
              updates.next_run = interval.next().toISOString();
            } catch {
              logger.warn(
                { taskId: data.taskId, value: updatedTask.schedule_value },
                'Invalid cron in task update',
              );
              break;
            }
          } else if (updatedTask.schedule_type === 'interval') {
            const ms = parseInt(updatedTask.schedule_value, 10);
            if (!isNaN(ms) && ms > 0) {
              updates.next_run = new Date(Date.now() + ms).toISOString();
            }
          }
        }

        updateTask(data.taskId, updates);
        logger.info(
          { taskId: data.taskId, sourceGroup, updates },
          'Task updated via IPC',
        );
        deps.onTasksChanged();
      }
      break;

    case 'refresh_groups':
      // Only main group can request a refresh
      if (isMain) {
        logger.info(
          { sourceGroup },
          'Group metadata refresh requested via IPC',
        );
        await deps.syncGroups(true);
        // Write updated snapshot immediately
        const availableGroups = deps.getAvailableGroups();
        deps.writeGroupsSnapshot(
          sourceGroup,
          true,
          availableGroups,
          new Set(Object.keys(registeredGroups)),
        );
      } else {
        logger.warn(
          { sourceGroup },
          'Unauthorized refresh_groups attempt blocked',
        );
      }
      break;

    case 'register_group':
      // Only main group can register new groups
      if (!isMain) {
        logger.warn(
          { sourceGroup },
          'Unauthorized register_group attempt blocked',
        );
        break;
      }
      if (data.jid && data.name && data.folder && data.trigger) {
        if (!isValidGroupFolder(data.folder)) {
          logger.warn(
            { sourceGroup, folder: data.folder },
            'Invalid register_group request - unsafe folder name',
          );
          break;
        }
        // Defense in depth: agent cannot set isMain via IPC.
        // Preserve isMain from the existing registration so IPC config
        // updates (e.g. adding additionalMounts) don't strip the flag.
        const existingGroup = registeredGroups[data.jid];
        deps.registerGroup(data.jid, {
          name: data.name,
          folder: data.folder,
          trigger: data.trigger,
          added_at: new Date().toISOString(),
          containerConfig: data.containerConfig,
          requiresTrigger: data.requiresTrigger,
          isMain: existingGroup?.isMain,
        });
      } else {
        logger.warn(
          { data },
          'Invalid register_group request - missing required fields',
        );
      }
      break;

    case 'memory_recall': {
      if (!isMemoryEnabled()) {
        if (data.requestId) {
          writeIpcResponse(sourceGroup, data.requestId as string, {
            facts: [],
            error: 'Memory system is disabled',
          });
        }
        break;
      }

      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'memory_recall missing requestId');
        break;
      }

      try {
        const query = (data.query as string) || '';
        const limit = (data.limit as number) || 10;
        const category = data.category as string | undefined;
        let facts;
        if (query) {
          const store = MemoryStore.getInstance();
          const results = await store.recall(query, limit);
          facts = results.map((r) => ({
            id: r.id,
            content: r.content,
            category: r.metadata?.category,
            score: r.score,
            createdAt: r.createdAt,
          }));
        } else {
          const allFacts = loadFacts();
          facts = allFacts.map((f) => ({
            id: f.id,
            content: f.content,
            category: f.category,
            confidence: f.confidence,
            createdAt: f.createdAt,
          }));
        }

        if (category) {
          facts = facts.filter((f) => String(f.category || '') === category);
        }

        writeIpcResponse(sourceGroup, requestId, { facts });
        logger.info(
          { sourceGroup, query: query.slice(0, 50), count: facts.length },
          'Memory recall via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Memory recall failed');
        writeIpcResponse(sourceGroup, requestId, {
          facts: [],
          error: String(err),
        });
      }
      break;
    }

    case 'memory_remember': {
      if (!isMemoryEnabled()) {
        logger.debug(
          { sourceGroup },
          'memory_remember skipped: memory disabled',
        );
        break;
      }

      const content = data.content as string;
      if (!content) {
        logger.warn({ sourceGroup }, 'memory_remember missing content');
        break;
      }

      try {
        const userId = (data.senderId as string) || '';
        // 阶段 1：立即存原文（不调 embedding API）
        const factId = crypto.randomUUID();
        storeFactRaw(
          sourceGroup,
          {
            id: factId,
            content,
            category: (data.category as string) || 'context',
            confidence: 0.5,
            source: 'agent',
          },
          userId,
        );
        logger.info({ sourceGroup, factId }, 'Memory stored (raw) via IPC');

        // 阶段 2：后台异步 LLM 标准化 + embedding
        extractAndRefine(factId, content, sourceGroup).catch((err) => {
          logger.warn(
            { err, factId },
            'Async fact refinement failed, raw content preserved',
          );
        });
      } catch (err) {
        logger.error({ err, sourceGroup }, 'Memory remember failed');
      }
      break;
    }

    case 'get_feishu_token': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'get_feishu_token missing requestId');
        break;
      }
      try {
        const chatJid = data.chatJid as string;
        const senderId = data.senderId as string | undefined;
        const token = await getFeishuToken(chatJid, senderId);
        writeIpcResponse(sourceGroup, requestId, {
          token: token || null,
          error: token ? null : '无法获取飞书 token（需要用户授权）',
        });
        logger.info({ sourceGroup, hasToken: !!token }, 'Feishu token via IPC');
      } catch (err) {
        logger.error({ err, sourceGroup }, 'get_feishu_token failed');
        writeIpcResponse(sourceGroup, requestId, {
          token: null,
          error: String(err),
        });
      }
      break;
    }

    case 'search_chat': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'search_chat missing requestId');
        break;
      }

      if (!CHAT_INDEX_ENABLED) {
        writeIpcResponse(sourceGroup, requestId, {
          results: [],
          error: 'Chat index is disabled',
        });
        break;
      }

      const query = data.query as string;
      if (!query) {
        writeIpcResponse(sourceGroup, requestId, {
          results: [],
          error: 'Missing query parameter',
        });
        break;
      }

      try {
        const options = (data as Record<string, unknown>).options as
          | Record<string, unknown>
          | undefined;
        const searchTimeout = 15_000;
        const results = await Promise.race([
          getChatIndex().search(query, {
            group: options?.group as string | undefined,
            sender: options?.sender as string | undefined,
            days: options?.days as number | undefined,
            startTime: options?.startTime as string | undefined,
            endTime: options?.endTime as string | undefined,
            limit: options?.limit as number | undefined,
            includeToolCalls: options?.includeToolCalls as boolean | undefined,
          }),
          new Promise<never>((_, reject) =>
            setTimeout(
              () => reject(new Error('search_chat timeout')),
              searchTimeout,
            ),
          ),
        ]);
        writeIpcResponse(sourceGroup, requestId, { results });
        logger.info(
          { sourceGroup, query: query.slice(0, 50), count: results.length },
          'Chat search via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'search_chat failed');
        writeIpcResponse(sourceGroup, requestId, {
          results: [],
          error: String(err),
        });
      }
      break;
    }

    case 'get_chat_context': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'get_chat_context missing requestId');
        break;
      }

      const raw = data as Record<string, unknown>;
      const chatJid = raw.chat_jid as string;
      const timestamp = raw.timestamp as string;
      if (!chatJid || !timestamp) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing chat_jid or timestamp parameter',
        });
        break;
      }

      try {
        const before = (raw.before as number) || 5;
        const after = (raw.after as number) || 5;
        const includeToolCalls = raw.include_tool_calls === true;
        const result = getMessageContext(
          chatJid,
          timestamp,
          before,
          after,
          includeToolCalls,
        );
        writeIpcResponse(sourceGroup, requestId, result);
        logger.info(
          {
            sourceGroup,
            chatJid: chatJid.slice(0, 20),
            timestamp,
            beforeCount: result.before.length,
            afterCount: result.after.length,
            includeToolCalls,
          },
          'Chat context via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'get_chat_context failed');
        writeIpcResponse(sourceGroup, requestId, {
          before: [],
          anchor: null,
          after: [],
          error: String(err),
        });
      }
      break;
    }

    case 'get_message_by_id': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'get_message_by_id missing requestId');
        break;
      }

      const raw = data as Record<string, unknown>;
      const messageId = raw.message_id as string;
      if (!messageId) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing message_id parameter',
        });
        break;
      }

      try {
        const before = typeof raw.before === 'number' ? raw.before : 5;
        const after = typeof raw.after === 'number' ? raw.after : 5;
        const includeToolCalls = raw.include_tool_calls === true;
        const result = getMessageContextById(
          messageId,
          before,
          after,
          includeToolCalls,
        );
        writeIpcResponse(sourceGroup, requestId, result);
        logger.info(
          {
            sourceGroup,
            messageId,
            beforeCount: result.before.length,
            afterCount: result.after.length,
            includeToolCalls,
          },
          'get_message_by_id via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'get_message_by_id failed');
        writeIpcResponse(sourceGroup, requestId, {
          before: [],
          anchor: null,
          after: [],
          error: String(err),
        });
      }
      break;
    }

    case 'get_message_range': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'get_message_range missing requestId');
        break;
      }

      const raw = data as Record<string, unknown>;
      const chatJid = raw.chat_jid as string;
      if (!chatJid) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing chat_jid parameter',
        });
        break;
      }

      try {
        const { offset, limit } = clampRangeParams(
          raw.offset as number | undefined,
          raw.limit as number | undefined,
        );
        const includeToolCalls = raw.include_tool_calls === true;
        const messages = getMessageRange(
          chatJid,
          offset,
          limit,
          includeToolCalls,
        );
        writeIpcResponse(sourceGroup, requestId, { messages, offset, limit });
        logger.info(
          {
            sourceGroup,
            chatJid: chatJid.slice(0, 20),
            offset,
            limit,
            count: messages.length,
            includeToolCalls,
          },
          'get_message_range via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'get_message_range failed');
        writeIpcResponse(sourceGroup, requestId, {
          messages: [],
          error: String(err),
        });
      }
      break;
    }

    case 'task_create': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_create missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const title = raw.title as string;
      const project = raw.project as string;
      const taskType = raw.task_type as string;
      if (!title || !project || !taskType) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing title, project or task_type parameter',
        });
        break;
      }
      try {
        const detail = createTaskLedgerTask({
          title,
          project,
          task_type: taskType as never,
          status: (raw.status as never) || 'draft',
          priority: (raw.priority as string) || 'normal',
          description: (raw.description as string | undefined) || null,
          desired_outcome: (raw.desired_outcome as string | undefined) || null,
          acceptance_criteria: Array.isArray(raw.acceptance_criteria)
            ? (raw.acceptance_criteria as unknown[]).map(String)
            : [],
          owner_group: sourceGroup,
          chat_jid: (raw.chat_jid as string | undefined) || null,
          created_by: (data.senderId as string | undefined) || null,
          artifact_root: (raw.artifact_root as string | undefined) || null,
          prd_path: (raw.prd_path as string | undefined) || null,
          spec_path: (raw.spec_path as string | undefined) || null,
          checklist: Array.isArray(raw.checklist)
            ? (raw.checklist as Array<Record<string, unknown>>)
                .map((item) => ({
                  title: String(item.title || ''),
                  status: item.status as never,
                  notes: (item.notes as string | undefined) || null,
                }))
                .filter((item) => item.title)
            : [],
          test_cases: Array.isArray(raw.test_cases)
            ? (raw.test_cases as Array<Record<string, unknown>>)
                .map((item) => ({
                  title: String(item.title || ''),
                  description: (item.description as string | undefined) || null,
                  status: item.status as never,
                  evidence: (item.evidence as string | undefined) || null,
                }))
                .filter((item) => item.title)
            : [],
        });
        writeIpcResponse(sourceGroup, requestId, detail);
        logger.info(
          { sourceGroup, taskId: detail.task.id },
          'Task ledger created via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'task_create failed');
        writeIpcResponse(sourceGroup, requestId, { error: String(err) });
      }
      break;
    }

    case 'task_get': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_get missing requestId');
        break;
      }
      const taskId = data.taskId as string;
      if (!taskId) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing taskId parameter',
        });
        break;
      }
      const detail = getTaskLedgerTask(taskId);
      if (!detail || (!isMain && detail.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      writeIpcResponse(sourceGroup, requestId, detail);
      break;
    }

    case 'task_list': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_list missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const tasks = listTaskLedgerTasks({
        owner_group: isMain
          ? (raw.owner_group as string | undefined)
          : sourceGroup,
        project: raw.project as never,
        status: raw.status as never,
        task_type: raw.task_type as never,
        include_done: raw.include_done === true,
        limit: raw.limit as number | undefined,
      });
      writeIpcResponse(sourceGroup, requestId, { tasks });
      break;
    }

    case 'task_update': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_update missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      if (raw.status !== undefined) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Status must be changed via workflow tools, not task_update',
        });
        break;
      }
      const detail = updateTaskLedgerTask(taskId, {
        title: raw.title as string | undefined,
        project: raw.project as string | undefined,
        task_type: raw.task_type as never,
        priority: raw.priority as string | undefined,
        description: raw.description as string | null | undefined,
        desired_outcome: raw.desired_outcome as string | null | undefined,
        acceptance_criteria: Array.isArray(raw.acceptance_criteria)
          ? (raw.acceptance_criteria as unknown[]).map(String)
          : undefined,
        artifact_root: raw.artifact_root as string | null | undefined,
        prd_path: raw.prd_path as string | null | undefined,
        spec_path: raw.spec_path as string | null | undefined,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        detail || { error: 'Task not found' },
      );
      break;
    }

    case 'task_add_log': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_add_log missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      const summary = raw.summary as string;
      if (!summary) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing summary parameter',
        });
        break;
      }
      const event = addTaskLedgerEvent({
        task_id: taskId,
        event_type: (raw.event_type as string) || 'progress',
        summary,
        details: (raw.details as string | undefined) || null,
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(sourceGroup, requestId, { event });
      break;
    }

    case 'task_update_checklist': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_update_checklist missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      const title = raw.title as string;
      if (!title) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing title parameter',
        });
        break;
      }
      const item = upsertTaskLedgerChecklistItem({
        task_id: taskId,
        id: raw.item_id as string | undefined,
        title,
        status: raw.status as never,
        notes: raw.notes as string | null | undefined,
        position: raw.position as number | undefined,
      });
      writeIpcResponse(sourceGroup, requestId, { item });
      break;
    }

    case 'task_update_test_case': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_update_test_case missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      const title = raw.title as string;
      if (!title) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing title parameter',
        });
        break;
      }
      const test_case = upsertTaskLedgerTestCase({
        task_id: taskId,
        id: raw.test_case_id as string | undefined,
        title,
        description: raw.description as string | null | undefined,
        status: raw.status as never,
        evidence: raw.evidence as string | null | undefined,
        position: raw.position as number | undefined,
      });
      writeIpcResponse(sourceGroup, requestId, { test_case });
      break;
    }

    case 'task_lock_effect': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_lock_effect missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      const desiredOutcome = raw.desired_outcome as string;
      const acceptanceCriteria = Array.isArray(raw.acceptance_criteria)
        ? (raw.acceptance_criteria as unknown[]).map(String)
        : [];
      if (!desiredOutcome || acceptanceCriteria.length === 0) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing desired_outcome or acceptance_criteria',
        });
        break;
      }
      const detail = updateTaskLedgerTask(taskId, {
        status: 'effect_locked',
        desired_outcome: desiredOutcome,
        acceptance_criteria: acceptanceCriteria,
      });
      addTaskLedgerEvent({
        task_id: taskId,
        event_type: 'effect_locked',
        summary: '最终效果已锁定',
        details: desiredOutcome,
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        detail || { error: 'Task not found' },
      );
      break;
    }

    case 'task_define_e2e': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_define_e2e missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      if (!taskLedgerAtLeast(current.task.status, 'effect_locked')) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Lock desired outcome before defining E2E cases',
        });
        break;
      }
      const cases = Array.isArray(raw.test_cases)
        ? (raw.test_cases as Array<Record<string, unknown>>)
        : [];
      if (cases.length === 0) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing test_cases',
        });
        break;
      }
      for (const [index, item] of cases.entries()) {
        const title = String(item.title || '');
        if (!title) continue;
        upsertTaskLedgerTestCase({
          task_id: taskId,
          title,
          description: (item.description as string | undefined) || null,
          status: 'pending',
          position: index,
        });
      }
      updateTaskLedgerTask(taskId, { status: 'e2e_defined' });
      addTaskLedgerEvent({
        task_id: taskId,
        event_type: 'e2e_defined',
        summary: `已定义 ${cases.length} 个端到端验收用例`,
        details: JSON.stringify(cases),
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        getTaskLedgerTask(taskId) || { error: 'Task not found' },
      );
      break;
    }

    case 'task_plan_tests': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_plan_tests missing requestId');
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      if (!taskLedgerAtLeast(current.task.status, 'e2e_defined')) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Define E2E cases before planning tests',
        });
        break;
      }
      const checklist = Array.isArray(raw.checklist)
        ? (raw.checklist as Array<Record<string, unknown>>)
        : [];
      if (checklist.length === 0) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing checklist',
        });
        break;
      }
      for (const [index, item] of checklist.entries()) {
        const title = String(item.title || '');
        if (!title) continue;
        upsertTaskLedgerChecklistItem({
          task_id: taskId,
          title,
          status: 'todo',
          notes: (item.notes as string | undefined) || null,
          position: index,
        });
      }
      updateTaskLedgerTask(taskId, { status: 'tests_planned' });
      addTaskLedgerEvent({
        task_id: taskId,
        event_type: 'tests_planned',
        summary: `已拆解 ${checklist.length} 个测试/执行清单项`,
        details: JSON.stringify(checklist),
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        getTaskLedgerTask(taskId) || { error: 'Task not found' },
      );
      break;
    }

    case 'task_start_implementation': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn(
          { sourceGroup },
          'task_start_implementation missing requestId',
        );
        break;
      }
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      if (!taskLedgerAtLeast(current.task.status, 'tests_planned')) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Plan tests before starting implementation',
        });
        break;
      }
      const detail = updateTaskLedgerTask(taskId, { status: 'implementing' });
      addTaskLedgerEvent({
        task_id: taskId,
        event_type: 'implementation_started',
        summary: '进入实现阶段',
        details: (data as Record<string, unknown>).summary as
          | string
          | undefined,
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        detail || { error: 'Task not found' },
      );
      break;
    }

    case 'task_record_verification': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn(
          { sourceGroup },
          'task_record_verification missing requestId',
        );
        break;
      }
      const raw = data as Record<string, unknown>;
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      if (!taskLedgerAtLeast(current.task.status, 'implementing')) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Start implementation before recording verification',
        });
        break;
      }
      const title = raw.title as string;
      if (!title) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Missing title parameter',
        });
        break;
      }
      upsertTaskLedgerTestCase({
        task_id: taskId,
        id: raw.test_case_id as string | undefined,
        title,
        description: raw.description as string | null | undefined,
        status: raw.status as never,
        evidence: raw.evidence as string | null | undefined,
      });
      updateTaskLedgerTask(taskId, { status: 'verifying' });
      addTaskLedgerEvent({
        task_id: taskId,
        event_type: 'verification',
        summary: title,
        details: raw.evidence as string | undefined,
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        getTaskLedgerTask(taskId) || { error: 'Task not found' },
      );
      break;
    }

    case 'task_mark_done': {
      const requestId = data.requestId as string;
      if (!requestId) {
        logger.warn({ sourceGroup }, 'task_mark_done missing requestId');
        break;
      }
      const taskId = data.taskId as string;
      const current = taskId ? getTaskLedgerTask(taskId) : undefined;
      if (!current || (!isMain && current.task.owner_group !== sourceGroup)) {
        writeIpcResponse(sourceGroup, requestId, { error: 'Task not found' });
        break;
      }
      if (!taskLedgerAtLeast(current.task.status, 'verifying')) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Record verification before marking done',
        });
        break;
      }
      const failedCases = current.test_cases.filter((item) =>
        ['pending', 'failed', 'blocked'].includes(item.status),
      );
      const openChecklist = current.checklist.filter((item) =>
        ['todo', 'doing', 'blocked'].includes(item.status),
      );
      if (failedCases.length > 0 || openChecklist.length > 0) {
        writeIpcResponse(sourceGroup, requestId, {
          error: 'Cannot mark done with open checklist or unpassed test cases',
          open_checklist: openChecklist,
          open_test_cases: failedCases,
        });
        break;
      }
      const detail = updateTaskLedgerTask(taskId, { status: 'done' });
      addTaskLedgerEvent({
        task_id: taskId,
        event_type: 'done',
        summary: '任务验收完成',
        details: (data as Record<string, unknown>).summary as
          | string
          | undefined,
        actor_group: sourceGroup,
        actor_sender: (data.senderId as string | undefined) || null,
      });
      writeIpcResponse(
        sourceGroup,
        requestId,
        detail || { error: 'Task not found' },
      );
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
