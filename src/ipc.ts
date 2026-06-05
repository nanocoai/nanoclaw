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
  createTask,
  deleteTask,
  getGroupAlias,
  getMessageContext,
  getMessageContextById,
  getMessageRange,
  getTaskById,
  storeMessageDirect,
  updateTask,
} from './db.js';
import { resolveTargetChatJid } from './group-alias.js';
import { isValidGroupFolder } from './group-folder.js';
import { logger } from './logger.js';
import { MemoryStore } from './memory/memory-store.js';
import { extractAndRefine } from './memory/extract-fact.js';
import { loadFacts, storeFactRaw } from './memory/storage.js';
import { isMemoryEnabled } from './memory/index.js';
import { RegisteredGroup } from './types.js';

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
  enqueueMessageCheck?: (chatJid: string) => void;
  onFeishuAuthRequest?: (chatJid: string, groupFolder: string) => Promise<void>;
  renameChat?: (jid: string, name: string) => Promise<void>;
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
                // Authorization: verify this group can send to this chatJid
                const targetGroup = registeredGroups[data.chatJid];
                const isSameGroup =
                  targetGroup && targetGroup.folder === sourceGroup;
                const isCrossGroup = !isSameGroup;
                if (
                  isMain ||
                  (targetGroup && targetGroup.folder === sourceGroup)
                ) {
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
                      timestamp: data.timestamp || new Date().toISOString(),
                      is_from_me: !isCrossGroup,
                      is_bot_message: !isCrossGroup,
                    });
                  } catch (storeErr) {
                    logger.warn(
                      { storeErr },
                      'IPC send_message 入库失败，不影响发送',
                    );
                  }
                  // 跨群消息：enqueue 目标群，让目标 agent 处理
                  if (isCrossGroup && deps.enqueueMessageCheck) {
                    deps.enqueueMessageCheck(data.chatJid);
                    logger.info(
                      { chatJid: data.chatJid, sourceGroup },
                      'Cross-group message enqueued for target agent',
                    );
                  }
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
                    'Unauthorized IPC message attempt blocked',
                  );
                }
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
        const result = getMessageContext(chatJid, timestamp, before, after);
        writeIpcResponse(sourceGroup, requestId, result);
        logger.info(
          {
            sourceGroup,
            chatJid: chatJid.slice(0, 20),
            timestamp,
            beforeCount: result.before.length,
            afterCount: result.after.length,
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
        writeIpcResponse(sourceGroup, requestId, { error: 'Missing message_id parameter' });
        break;
      }

      try {
        const before = typeof raw.before === 'number' ? raw.before : 5;
        const after = typeof raw.after === 'number' ? raw.after : 5;
        const result = getMessageContextById(messageId, before, after);
        writeIpcResponse(sourceGroup, requestId, result);
        logger.info(
          { sourceGroup, messageId, beforeCount: result.before.length, afterCount: result.after.length },
          'get_message_by_id via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'get_message_by_id failed');
        writeIpcResponse(sourceGroup, requestId, { before: [], anchor: null, after: [], error: String(err) });
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
        writeIpcResponse(sourceGroup, requestId, { error: 'Missing chat_jid parameter' });
        break;
      }

      try {
        const { offset, limit } = clampRangeParams(
          raw.offset as number | undefined,
          raw.limit as number | undefined,
        );
        const messages = getMessageRange(chatJid, offset, limit);
        writeIpcResponse(sourceGroup, requestId, { messages, offset, limit });
        logger.info(
          { sourceGroup, chatJid: chatJid.slice(0, 20), offset, limit, count: messages.length },
          'get_message_range via IPC',
        );
      } catch (err) {
        logger.error({ err, sourceGroup }, 'get_message_range failed');
        writeIpcResponse(sourceGroup, requestId, { messages: [], error: String(err) });
      }
      break;
    }

    default:
      logger.warn({ type: data.type }, 'Unknown IPC task type');
  }
}
