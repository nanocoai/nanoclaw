import fs from 'fs';
import path from 'path';

import { OneCLI } from '@onecli-sh/sdk';

import { dispatch, getHelp } from './commands/index.js';

import {
  getMemoryQueue,
  injectMemory,
  isMemoryEnabled,
  buildMessageContext,
  hashContext,
  getLastContextHash,
  setLastContextHash,
} from './memory/index.js';
import type { MessageContext } from './memory/index.js';
import {
  ASSISTANT_NAME,
  CHAT_INDEX_ENABLED,
  DEFAULT_TRIGGER,
  getTriggerPattern,
  GROUPS_DIR,
  IDLE_TIMEOUT,
  MAX_MESSAGES_PER_PROMPT,
  ONECLI_URL,
  POLL_INTERVAL,
  TIMEZONE,
} from './config.js';
import { getChatIndex } from './chat-index.js';
import './channels/index.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  detectRateLimit,
  rotateAccount,
  runContainerAgent,
  writeGroupsSnapshot,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllChats,
  getAllRegisteredGroups,
  getAllSessions,
  getChatName,
  deleteSession,
  getAllTasks,
  getLastBotMessageTimestamp,
  getMessagesSince,
  getNewMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import { startIpcWatcher } from './ipc.js';
import { findChannel, formatMessages, formatOutbound } from './router.js';
import { restoreRemoteControl } from './remote-control.js';
import {
  isSenderAllowed,
  isTriggerAllowed,
  loadSenderAllowlist,
  shouldDropMessage,
} from './sender-allowlist.js';
import { startSessionCleanup } from './session-cleanup.js';
import { startSchedulerLoop } from './task-scheduler.js';
import { Channel, NewMessage, RegisteredGroup } from './types.js';
import { logger } from './logger.js';
import { withLogContext } from './log-context.js';

// Re-export for backwards compatibility during refactor
export { escapeXml, formatMessages } from './router.js';

let lastTimestamp = '';
let sessions: Record<string, string> = {};
let registeredGroups: Record<string, RegisteredGroup> = {};
let lastAgentTimestamp: Record<string, string> = {};
// 动态记忆注入去重：per-group context hash（在 inject.ts 管理）
let messageLoopRunning = false;

const channels: Channel[] = [];
const queue = new GroupQueue();

const onecli = new OneCLI({ url: ONECLI_URL });

function ensureOneCLIAgent(jid: string, group: RegisteredGroup): void {
  // 所有群（包括 main group）都创建独立 agent，防止 rotateAccount fallback 到 Default Agent
  const identifier = group.folder.toLowerCase().replace(/_/g, '-');
  onecli.ensureAgent({ name: group.name, identifier }).then(
    (res) => {
      logger.info(
        { jid, identifier, created: res.created },
        'OneCLI agent ensured',
      );
    },
    (err) => {
      logger.debug(
        { jid, identifier, err: String(err) },
        'OneCLI agent ensure skipped',
      );
    },
  );
}

function loadState(): void {
  lastTimestamp = getRouterState('last_timestamp') || '';
  const agentTs = getRouterState('last_agent_timestamp');
  try {
    lastAgentTimestamp = agentTs ? JSON.parse(agentTs) : {};
  } catch {
    logger.warn('Corrupted last_agent_timestamp in DB, resetting');
    lastAgentTimestamp = {};
  }
  sessions = getAllSessions();
  registeredGroups = getAllRegisteredGroups();
  logger.info(
    { groupCount: Object.keys(registeredGroups).length },
    'State loaded',
  );
}

/**
 * 自动注册未注册的群聊。从 chat metadata 中取名称，生成合法的 folder name，
 * 以 requiresTrigger: true 注册，这样必须 @触发 才会响应。
 * 返回是否成功注册。
 */
function autoRegisterGroup(chatJid: string): boolean {
  if (registeredGroups[chatJid]) return false;

  const chatName = getChatName(chatJid);
  if (!chatName) {
    logger.debug({ chatJid }, '自动注册跳过：找不到群名');
    return false;
  }

  // 从群名生成 folder name：去除非法字符，截断到 64 字符
  let folder = chatName
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 64);

  // 确保 folder 以字母或数字开头
  if (!folder || !/^[A-Za-z0-9]/.test(folder)) {
    folder = `grp_${folder || chatJid.replace(/[^A-Za-z0-9]/g, '').slice(0, 50)}`;
  }

  if (!isValidGroupFolder(folder)) {
    logger.warn({ chatJid, folder }, '自动注册失败：生成的 folder name 不合法');
    return false;
  }

  // 检查 folder 是否已被其他群占用
  const folderInUse = Object.values(registeredGroups).some(
    (g) => g.folder === folder,
  );
  if (folderInUse) {
    // 追加 JID hash 后缀避免冲突
    const suffix = chatJid.replace(/[^A-Za-z0-9]/g, '').slice(-6);
    folder = `${folder.slice(0, 57)}_${suffix}`;
    if (!isValidGroupFolder(folder)) {
      logger.warn({ chatJid, folder }, '自动注册失败：去重后 folder 不合法');
      return false;
    }
  }

  const group: RegisteredGroup = {
    name: chatName,
    folder,
    trigger: DEFAULT_TRIGGER,
    added_at: new Date().toISOString(),
    requiresTrigger: true,
  };

  registerGroup(chatJid, group);
  logger.info({ chatJid, name: chatName, folder }, '群聊已自动注册');
  return true;
}

/**
 * 处理 /trigger 和 /notrigger 指令，切换群的 requiresTrigger 状态。
 * 返回要发送给用户的确认消息，如果不适用则返回 null。
 */

/**
 * Return the message cursor for a group, recovering from the last bot reply
 * if lastAgentTimestamp is missing (new group, corrupted state, restart).
 */
function getOrRecoverCursor(chatJid: string): string {
  const existing = lastAgentTimestamp[chatJid];
  if (existing) return existing;

  const botTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
  if (botTs) {
    logger.info(
      { chatJid, recoveredFrom: botTs },
      'Recovered message cursor from last bot reply',
    );
    lastAgentTimestamp[chatJid] = botTs;
    saveState();
    return botTs;
  }
  return '';
}

function saveState(): void {
  setRouterState('last_timestamp', lastTimestamp);
  setRouterState('last_agent_timestamp', JSON.stringify(lastAgentTimestamp));
}

function registerGroup(jid: string, group: RegisteredGroup): void {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(group.folder);
  } catch (err) {
    logger.warn(
      { jid, folder: group.folder, err },
      'Rejecting group registration with invalid folder',
    );
    return;
  }

  registeredGroups[jid] = group;
  setRegisteredGroup(jid, group);

  // Create group folder
  fs.mkdirSync(path.join(groupDir, 'logs'), { recursive: true });

  // Copy CLAUDE.md template into the new group folder so agents have
  // identity and instructions from the first run.  (Fixes #1391)
  const groupMdFile = path.join(groupDir, 'CLAUDE.md');
  if (!fs.existsSync(groupMdFile)) {
    const templateFile = path.join(
      GROUPS_DIR,
      group.isMain ? 'main' : 'global',
      'CLAUDE.md',
    );
    if (fs.existsSync(templateFile)) {
      let content = fs.readFileSync(templateFile, 'utf-8');
      if (ASSISTANT_NAME !== 'Andy') {
        content = content.replace(/^# Andy$/m, `# ${ASSISTANT_NAME}`);
        content = content.replace(/You are Andy/g, `You are ${ASSISTANT_NAME}`);
      }
      fs.writeFileSync(groupMdFile, content);
      logger.info({ folder: group.folder }, 'Created CLAUDE.md from template');
    }
  }

  // Ensure a corresponding OneCLI agent exists (best-effort, non-blocking)
  ensureOneCLIAgent(jid, group);

  logger.info(
    { jid, name: group.name, folder: group.folder },
    'Group registered',
  );
}

/**
 * Get available groups list for the agent.
 * Returns groups ordered by most recent activity.
 */
export function getAvailableGroups(): import('./container-runner.js').AvailableGroup[] {
  const chats = getAllChats();
  const registeredJids = new Set(Object.keys(registeredGroups));

  return chats
    .filter((c) => c.jid !== '__group_sync__' && c.is_group)
    .map((c) => ({
      jid: c.jid,
      name: c.name,
      lastActivity: c.last_message_time,
      isRegistered: registeredJids.has(c.jid),
    }));
}

/** @internal - exported for testing */
export function _setRegisteredGroups(
  groups: Record<string, RegisteredGroup>,
): void {
  registeredGroups = groups;
}

/**
 * 解析消息文本中的模型/思考前缀。
 * 返回 override 对象 + 去除前缀后的文本，或 null（无前缀）。
 *
 * ! 或 ！ + 空格 → Sonnet 无思考
 * !! 或 ！！ + 空格 → Sonnet 深度思考
 * + + 空格 → Opus 深度思考
 * ~ + 空格 → 关闭思考
 */
export function parseModelPrefix(
  text: string,
): {
  override: { model?: string; thinking?: 'adaptive' | 'disabled' };
  cleanedText: string;
} | null {
  const trimmed = text.trim();
  if (/^[!！]{2}\s/.test(trimmed)) {
    return {
      override: { model: 'claude-sonnet-4-6', thinking: 'adaptive' },
      cleanedText: trimmed.replace(/^[!！]{2}\s*/, ''),
    };
  }
  if (/^[!！]\s/.test(trimmed)) {
    return {
      override: { model: 'claude-sonnet-4-6', thinking: 'disabled' },
      cleanedText: trimmed.replace(/^[!！]\s*/, ''),
    };
  }
  if (/^\+\s/.test(trimmed)) {
    return {
      override: { model: 'claude-opus-4-6', thinking: 'adaptive' },
      cleanedText: trimmed.replace(/^\+\s*/, ''),
    };
  }
  if (/^~\s/.test(trimmed)) {
    return {
      override: { thinking: 'disabled' },
      cleanedText: trimmed.replace(/^~\s*/, ''),
    };
  }
  return null;
}

/**
 * Process all pending messages for a group.
 * Called by the GroupQueue when it's this group's turn.
 */
async function processGroupMessages(chatJid: string): Promise<boolean> {
  const group = registeredGroups[chatJid];
  if (!group) return true;

  const channel = findChannel(channels, chatJid);
  if (!channel) {
    logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
    return true;
  }


  const isMainGroup = group.isMain === true;

  const missedMessages = getMessagesSince(
    chatJid,
    getOrRecoverCursor(chatJid),
    ASSISTANT_NAME,
    MAX_MESSAGES_PER_PROMPT,
  );

  if (missedMessages.length === 0) return true;

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        m.is_from_me || // 跨群/系统消息直接绕过 trigger 检查
        (triggerPattern.test(m.content.trim()) &&
          isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
    );
    if (!hasTrigger) return true;
  }

  // 模型/思考前缀检测（最后一条消息，单次生效）
  let modelOverride:
    | { model?: string; thinking?: 'adaptive' | 'disabled' }
    | undefined;
  const lastMsg = missedMessages[missedMessages.length - 1];
  if (lastMsg) {
    const parsed = parseModelPrefix(lastMsg.content);
    if (parsed) {
      lastMsg.content = parsed.cleanedText;
      modelOverride = parsed.override;
      logger.info({ chatJid, ...modelOverride }, '模式切换');
    }
  }

  const prompt = formatMessages(missedMessages, TIMEZONE);

  // Cursor 在回复成功后才推进（而非提前推进），防止进程被杀时消息丢失。
  // GroupQueue 保证同一群同一时间只跑一个 agent，不会重复处理。
  const newCursor = missedMessages[missedMessages.length - 1].timestamp;

  logger.info(
    { group: group.name, messageCount: missedMessages.length },
    'Processing messages',
  );

  // Track idle timer for closing stdin when agent is idle
  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      logger.debug(
        { group: group.name },
        'Idle timeout, closing container stdin',
      );
      queue.closeStdin(chatJid);
    }, IDLE_TIMEOUT);
  };

  await channel.setTyping?.(chatJid, true);
  let hadError = false;
  let outputSentToUser = false;
  let streamingRateLimitDetected = false;

  // R8.1: 收集 Agent 回复文本（用于记忆更新）
  const agentReplies: string[] = [];
  let memoryEnqueued = false; // 标记是否已在 onOutput 中入队记忆
  let lastFeishuMsgId: string | undefined; // 最后一条正式回复的飞书 message_id

  // 取最近消息用于记忆召回（用户+agent 各最多 2 条，拼接提升语义丰富度）
  const recentMsgs = [...missedMessages].reverse();
  const userMsgs: string[] = [];
  const botMsgs: string[] = [];
  let memorySenderId = '';
  for (const m of recentMsgs) {
    if (!m.is_bot_message && !m.is_from_me) {
      if (userMsgs.length < 2) userMsgs.push(m.content);
      if (!memorySenderId) memorySenderId = m.sender || '';
    } else {
      if (botMsgs.length < 2) botMsgs.push(m.content);
    }
    if (userMsgs.length >= 2 && botMsgs.length >= 2) break;
  }
  const recallParts: string[] = [];
  for (const u of userMsgs.reverse()) recallParts.push(`User: ${u}`);
  for (const b of botMsgs.reverse()) recallParts.push(`Assistant: ${b}`);
  const latestUserMessage =
    recallParts.length > 0 ? recallParts.join('\n') : undefined;

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    async (result) => {
      // 进度消息 — 转发给 channel 显示进度卡片
      if (result.status === 'progress' && result.result) {
        const payload = result.detail
          ? JSON.stringify({ title: result.result, detail: result.detail })
          : result.result;
        await channel.sendMessage(chatJid, payload);
        // tool_use 摘要存入 messages.db（供巡检和搜索使用）
        // result.result 格式如 "🔧 Bash: ls -la"，已含工具名和简短输入
        if (result.progressType === 'tool_use' && result.result) {
          try {
            storeMessageDirect({
              id: `tool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              chat_jid: chatJid,
              sender: ASSISTANT_NAME,
              sender_name: ASSISTANT_NAME,
              content: result.result,
              timestamp: new Date().toISOString(),
              is_from_me: true,
              is_bot_message: true,
            });
          } catch { /* 入库失败不影响主流程 */ }
        }
        return;
      }

      // 传递 usage 数据到飞书 channel（在发送文本回复之前）
      if (result.usage && 'setUsage' in channel) {
        (
          channel as {
            setUsage: (
              jid: string,
              usage: typeof result.usage,
              thinking?: 'adaptive' | 'disabled',
            ) => void;
          }
        )
          // agent-runner 默认 thinking adaptive（除非显式 disabled），所以 undefined → 'adaptive'
          .setUsage(
            chatJid,
            result.usage,
            modelOverride?.thinking === 'disabled' ? 'disabled' : 'adaptive',
          );
      }

      // Streaming output callback — called for each agent result
      if (result.result) {
        const raw =
          typeof result.result === 'string'
            ? result.result
            : JSON.stringify(result.result);
        // Strip <internal>...</internal> blocks — agent uses these for internal reasoning
        const text = raw.replace(/<internal>[\s\S]*?<\/internal>/g, '').trim();
        logger.info({ group: group.name }, `Agent output: ${raw.length} chars`);

        // Streaming 模式下检测限流文本（"You've hit your limit" 等）
        // 检测到后不发给用户，后续补偿轮换+重试
        if (detectRateLimit(raw)) {
          streamingRateLimitDetected = true;
          logger.warn(
            { group: group.name, text: raw.slice(0, 200) },
            'Streaming 输出检测到限流文本，抑制发送',
          );
          return;
        }

        if (text) {
          await channel.setTyping?.(chatJid, false);
          const feishuMsgId = await channel.sendMessage(chatJid, text);
          if (feishuMsgId) lastFeishuMsgId = feishuMsgId;
          outputSentToUser = true;
          agentReplies.push(text);

          // 实时索引聊天记录（不等 agent 退出，因为 agent 可能跑数小时）
          if (CHAT_INDEX_ENABLED) {
            const latestUserMsg = missedMessages[missedMessages.length - 1];
            if (latestUserMsg) {
              getChatIndex().enqueue({
                userContent: latestUserMsg.content,
                botContent: text,
                userMsgId: latestUserMsg.id,
                botMsgId: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
                chat_jid: chatJid,
                group_folder: group.folder,
                sender_name: latestUserMsg.sender_name || '用户',
                timestamp: latestUserMsg.timestamp || new Date().toISOString(),
              });
            }
          }
        }
        // Only reset idle timer on actual results, not session-update markers (result: null)
        resetIdleTimer();
      }

      if (result.status === 'success') {
        // 无论是否有文本输出，确保 typing/spinner/进度卡片被清理
        // （agent 可能只通过 send_message 发了结果，最终 result 为空或被 <internal> 包裹）
        if (!outputSentToUser) {
          await channel.setTyping?.(chatJid, false);
          // 清理孤儿进度卡片（sendMessage 未被调用时，卡片不会被自动清理）
          if ('cleanupProgressCard' in channel) {
            await (
              channel as { cleanupProgressCard: (jid: string) => Promise<void> }
            ).cleanupProgressCard(chatJid);
          }
        }

        // R8.1 实时记忆入队：agent 回复完成后立即入队，不等进程退出
        // agent-runner 完成回复后会进入 IPC 等待循环（可达 8 小时），
        // 如果等进程退出才入队，记忆会延迟数小时甚至因 SIGTERM 丢失
        if (!memoryEnqueued && isMemoryEnabled() && agentReplies.length > 0) {
          const memoryMessages = [
            ...missedMessages.map((m) => ({
              content: m.content,
              sender_name: m.sender_name,
              is_bot_message: m.is_bot_message,
              is_from_me: m.is_from_me,
            })),
            ...agentReplies.map((text) => ({
              content: text,
              is_bot_message: true,
            })),
          ];
          getMemoryQueue().add(
            group.folder,
            memoryMessages,
            sessions[group.folder],
            memorySenderId,
          );
          memoryEnqueued = true;
        }

        queue.notifyIdle(chatJid);
      }

      if (result.status === 'error') {
        hadError = true;
      }
    },
    latestUserMessage,
    memorySenderId,
    undefined, // isRetry
    modelOverride,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  // Streaming 模式下限流检测：onOutput 回调中发现 "hit your limit" 等文本
  // 轮换账号并立即重试（保留 session 上下文）
  if (streamingRateLimitDetected && !output.rotatedTo) {
    const agentId = group.folder.toLowerCase().replace(/_/g, '-');
    logger.warn(
      { group: group.name, agentId },
      'Streaming 输出包含限流文本，尝试轮换账号并重试',
    );
    const rotateResult = rotateAccount(agentId, group.folder);
    if (rotateResult?.success) {
      output.rotatedTo = rotateResult.newSecretName;
      // 重试：用新账号重跑，保留 session 上下文
      logger.info(
        { group: group.name, newSecret: rotateResult.newSecretName },
        'Streaming 限流，已轮换账号，重试中',
      );
      const retryOutput = await runAgent(
        group,
        prompt,
        chatJid,
        async (result) => {
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            if (text) {
              const retryFmid = await channel.sendMessage(chatJid, text);
              if (retryFmid) lastFeishuMsgId = retryFmid;
              outputSentToUser = true;
              agentReplies.push(text);
            }
          }
          if (result.status === 'success') {
            queue.notifyIdle(chatJid);
          }
          if (result.status === 'error') {
            hadError = true;
          }
        },
        latestUserMessage,
        memorySenderId,
        true,
        modelOverride,
      );
      // 合并重试结果
      if (retryOutput.status === 'error') hadError = true;
    } else if (rotateResult && !rotateResult.success) {
      output.allExhausted = true;
    }
  }

  // 轮换通知
  if (output.rotatedTo) {
    channel
      .sendMessage(chatJid, `🔄 当前额度已满，已自动切换到备用账号 (${output.rotatedTo})`, { isCommandReply: true })
      .catch(() => {});
  }
  if (output.allExhausted) {
    channel
      .sendMessage(chatJid, '⚠️ 所有账号配额已耗尽，请等待恢复或添加新账号')
      .catch(() => {});
  }

  if (output.status === 'error' || hadError) {
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (outputSentToUser) {
      // error 但已有回复发给用户：推进 cursor（防止重启后重复回复）+ 入队记忆
      lastAgentTimestamp[chatJid] = newCursor;
      saveState();
      if (!memoryEnqueued && isMemoryEnabled() && agentReplies.length > 0) {
        const memoryMessages = [
          ...missedMessages.map((m) => ({
            content: m.content,
            sender_name: m.sender_name,
            is_bot_message: m.is_bot_message,
            is_from_me: m.is_from_me,
          })),
          ...agentReplies.map((text) => ({
            content: text,
            is_bot_message: true,
          })),
        ];
        getMemoryQueue().add(
          group.folder,
          memoryMessages,
          sessions[group.folder],
          memorySenderId,
        );
      }
      logger.warn(
        { group: group.name },
        'Agent error after output was sent, cursor advanced to prevent duplicates',
      );
      return true;
    }
    // 未发回复 + error：cursor 不推进，重启后会重新处理这些消息
    logger.warn(
      { group: group.name },
      'Agent error, cursor NOT advanced so messages will be retried',
    );
    return false;
  }

  // Bot 回复入库（优先用飞书 message_id，引用时可直接命中 DB）
  const botReplyText = agentReplies.join('\n');
  const botMsgId = lastFeishuMsgId ?? `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  if (agentReplies.length > 0) {
    try {
      storeMessage({
        id: botMsgId,
        chat_jid: chatJid,
        sender: ASSISTANT_NAME,
        sender_name: ASSISTANT_NAME,
        content: botReplyText,
        timestamp: new Date().toISOString(),
        is_from_me: true,
        is_bot_message: true,
      });
    } catch (err) {
      logger.warn({ err }, 'Bot 回复入库失败，不影响主流程');
    }
  }

  // 成功处理完毕，推进 cursor（在回复入库之后，确保进程被杀时不丢消息）
  lastAgentTimestamp[chatJid] = newCursor;
  saveState();

  // chatIndex 已在 onOutput 回调中实时索引，此处无需重复

  // R8.1 兜底：如果 onOutput 中未能入队（如 agent 未发 success 状态），在进程退出后补入队
  if (!memoryEnqueued && isMemoryEnabled()) {
    const memoryMessages = [
      ...missedMessages.map((m) => ({
        content: m.content,
        sender_name: m.sender_name,
        is_bot_message: m.is_bot_message,
        is_from_me: m.is_from_me,
      })),
      ...agentReplies.map((text) => ({
        content: text,
        is_bot_message: true,
      })),
    ];
    getMemoryQueue().add(
      group.folder,
      memoryMessages,
      sessions[group.folder],
      memorySenderId,
    );
  }

  return true;
}

interface RunAgentResult {
  status: 'success' | 'error';
  rotatedTo?: string; // 轮换到的新 secret 名称（用于通知用户）
  allExhausted?: boolean; // 所有账号配额耗尽
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  latestUserMessage?: string,
  memorySenderId?: string,
  isRetry?: boolean,
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' },
): Promise<RunAgentResult> {
  const isMain = group.isMain === true;
  const sessionId = sessions[group.folder];

  // R8.2: 启动容器前注入记忆
  if (isMemoryEnabled()) {
    try {
      const groupDir = resolveGroupFolderPath(group.folder);
      await injectMemory(
        group.folder,
        groupDir,
        latestUserMessage,
        memorySenderId,
      );
    } catch (err) {
      logger.warn({ err, group: group.name }, '记忆注入失败，继续启动容器');
    }
  }

  // Update tasks snapshot for container to read (filtered by group)
  const tasks = getAllTasks();
  writeTasksSnapshot(
    group.folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script || undefined,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  // Update available groups snapshot (main group only can see all groups)
  const availableGroups = getAvailableGroups();
  writeGroupsSnapshot(
    group.folder,
    isMain,
    availableGroups,
    new Set(Object.keys(registeredGroups)),
  );

  // Wrap onOutput to track session ID from streamed results
  const wrappedOnOutput = onOutput
    ? async (output: ContainerOutput) => {
        if (output.newSessionId) {
          sessions[group.folder] = output.newSessionId;
          setSession(group.folder, output.newSessionId);
        }
        await onOutput(output);
      }
    : undefined;

  try {
    const output = await runContainerAgent(
      group,
      {
        prompt,
        sessionId,
        groupFolder: group.folder,
        chatJid,
        isMain,
        assistantName: ASSISTANT_NAME,
        modelOverride,
        senderId: memorySenderId,
        useCliMode: group.containerConfig?.useCliMode,
      },
      (proc, containerName) =>
        queue.registerProcess(chatJid, proc, containerName, group.folder),
      wrappedOnOutput,
    );

    if (output.newSessionId) {
      sessions[group.folder] = output.newSessionId;
      setSession(group.folder, output.newSessionId);
    }

    if (output.status === 'error') {
      // Detect stale/corrupt session — clear it so the next retry starts fresh.
      // The session .jsonl can go missing after a crash mid-write, manual
      // deletion, or disk-full. The existing backoff in group-queue.ts
      // handles the retry; we just need to remove the broken session ID.
      const isStaleSession =
        sessionId &&
        output.error &&
        /no conversation found|ENOENT.*\.jsonl|session.*not found/i.test(
          output.error,
        );

      if (isStaleSession) {
        logger.warn(
          { group: group.name, staleSessionId: sessionId, error: output.error },
          'Stale session detected — clearing for next retry',
        );
        delete sessions[group.folder];
        deleteSession(group.folder);
      }

      // 429 检测 + 自动轮换
      if (!isRetry && output.error && detectRateLimit(output.error)) {
        const agentId = group.folder.toLowerCase().replace(/_/g, '-');
        logger.warn(
          { group: group.name, agentId, error: output.error?.slice(0, 200) },
          '检测到限流错误，尝试轮换账号',
        );
        const rotateResult = rotateAccount(agentId, group.folder);

        if (rotateResult && !rotateResult.success) {
          logger.warn({ group: group.name }, '所有账号配额已耗尽');
          return { status: 'error', allExhausted: true };
        }

        if (rotateResult && rotateResult.success) {
          logger.info(
            { group: group.name, newSecret: rotateResult.newSecretName },
            '429 检测到，已轮换账号，重试中（保留 session）',
          );
          return runAgent(
            group,
            prompt,
            chatJid,
            onOutput,
            latestUserMessage,
            memorySenderId,
            true,
            modelOverride,
          ).then((retryResult) => ({
            ...retryResult,
            rotatedTo: rotateResult.newSecretName,
          }));
        }

        // rotateAccount 返回 null（未开启/防抖/onecli 错误等）
        logger.warn(
          { group: group.name, agentId },
          '轮换未执行（可能：防抖中/onecli 错误/单账号），按原错误处理',
        );
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return { status: 'error' };
    }

    // Claude Code 有时以 status=success 返回限流消息（"You've hit your limit"）
    // 检查 result 文本以捕获这种假成功
    if (!isRetry && output.result && detectRateLimit(output.result)) {
      const agentId = group.folder.toLowerCase().replace(/_/g, '-');
      logger.warn(
        { group: group.name, agentId, result: output.result?.slice(0, 200) },
        '检测到假成功限流（result 包含 rate limit 关键词），尝试轮换',
      );
      const rotateResult = rotateAccount(agentId, group.folder);

      if (rotateResult && !rotateResult.success) {
        logger.warn({ group: group.name }, '所有账号配额已耗尽');
        return { status: 'error', allExhausted: true };
      }

      if (rotateResult && rotateResult.success) {
        logger.info(
          { group: group.name, newSecret: rotateResult.newSecretName },
          '假成功限流检测到，已轮换账号，重试中（保留 session）',
        );
        return runAgent(
          group,
          prompt,
          chatJid,
          onOutput,
          latestUserMessage,
          memorySenderId,
          true,
          modelOverride,
        ).then((retryResult) => ({
          ...retryResult,
          rotatedTo: rotateResult.newSecretName,
        }));
      }

      // rotateAccount 返回 null
      logger.warn(
        { group: group.name, agentId },
        '假成功限流但轮换未执行，将限流消息当错误返回',
      );
      return { status: 'error' };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error({ group: group.name, err }, 'Agent error');
    return { status: 'error' };
  }
}

async function startMessageLoop(): Promise<void> {
  if (messageLoopRunning) {
    logger.debug('Message loop already running, skipping duplicate start');
    return;
  }
  messageLoopRunning = true;

  // 启动飞书 OAuth 回调 server（用户点击授权卡片后的回调）
  try {
    const { startOAuthCallbackServer, startTokenRefreshTimer } =
      await import('./channels/feishu-oauth.js');
    startTokenRefreshTimer();
    startOAuthCallbackServer(async ({ openId, chatJid }) => {
      logger.info({ openId, chatJid }, '飞书 OAuth 授权成功回调');
      const channel = findChannel(channels, chatJid);
      if (channel) {
        await channel.sendMessage(
          chatJid,
          '✅ 飞书文档授权成功！后续文档操作将使用你的权限。',
        );
        logger.info({ chatJid }, '飞书授权成功通知已发送');
      } else {
        logger.warn({ chatJid }, '飞书授权成功但找不到对应 channel');
      }
    });
  } catch (err) {
    logger.warn({ err }, '飞书 OAuth server 启动失败');
  }

  // Debug API — 方便测试模型切换等
  try {
    const { startDebugApi } = await import('./debug-api.js');
    startDebugApi({
      sendTestMessage: async (jid: string, text: string) => {
        // 模拟消息存入 DB 并触发处理
        const id = `debug-${Date.now()}`;
        storeMessage({
          id,
          chat_jid: jid,
          sender: 'debug',
          sender_name: 'Debug',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: false,
        });
        queue.enqueueMessageCheck(jid);
        return `message stored and enqueued: ${id}`;
      },
      getStatus: () => ({
        pid: process.pid,
        uptime: process.uptime(),
        groups: Object.keys(registeredGroups),
        activeAgents: Array.from(
          (
            queue as unknown as {
              groups: Map<
                string,
                {
                  active: boolean;
                  groupFolder: string | null;
                  containerName: string | null;
                }
              >;
            }
          ).groups.entries(),
        )
          .filter(([, s]) => s.active)
          .map(([jid, s]) => ({
            jid,
            folder: s.groupFolder,
            container: s.containerName,
          })),
      }),
    });
  } catch {
    /* debug api 启动失败不影响主流程 */
  }

  logger.info(`NanoClaw running (default trigger: ${DEFAULT_TRIGGER})`);

  while (true) {
    try {
      const jids = Object.keys(registeredGroups);
      const { messages, newTimestamp } = getNewMessages(
        jids,
        lastTimestamp,
        ASSISTANT_NAME,
      );

      if (messages.length > 0) {
        logger.info({ count: messages.length }, 'New messages');

        // Advance the "seen" cursor for all messages immediately
        lastTimestamp = newTimestamp;
        saveState();

        // Deduplicate by group
        const messagesByGroup = new Map<string, NewMessage[]>();
        for (const msg of messages) {
          const existing = messagesByGroup.get(msg.chat_jid);
          if (existing) {
            existing.push(msg);
          } else {
            messagesByGroup.set(msg.chat_jid, [msg]);
          }
        }

        for (const [chatJid, groupMessages] of messagesByGroup) {
          const group = registeredGroups[chatJid];
          if (!group) continue;

          const channel = findChannel(channels, chatJid);
          if (!channel) {
            logger.warn({ chatJid }, 'No channel owns JID, skipping messages');
            continue;
          }

          const isMainGroup = group.isMain === true;
          const needsTrigger = !isMainGroup && group.requiresTrigger !== false;

          // For non-main groups, only act on trigger messages.
          // Non-trigger messages accumulate in DB and get pulled as
          // context when a trigger eventually arrives.
          if (needsTrigger) {
            const triggerPattern = getTriggerPattern(group.trigger);
            const allowlistCfg = loadSenderAllowlist();
            const hasTrigger = groupMessages.some(
              (m) =>
                m.is_from_me || // 跨群/系统消息直接绕过 trigger 检查
                (triggerPattern.test(m.content.trim()) &&
                  isTriggerAllowed(chatJid, m.sender, allowlistCfg)),
            );
            if (!hasTrigger) continue;
          }

          // Pull all messages since lastAgentTimestamp so non-trigger
          // context that accumulated between triggers is included.
          const allPending = getMessagesSince(
            chatJid,
            getOrRecoverCursor(chatJid),
            ASSISTANT_NAME,
            MAX_MESSAGES_PER_PROMPT,
          );
          const messagesToSend =
            allPending.length > 0 ? allPending : groupMessages;
          logger.info(
            {
              chatJid,
              allPendingLen: allPending.length,
              groupMessagesLen: groupMessages.length,
              cursor: getOrRecoverCursor(chatJid),
            },
            'Message loop: preparing to send/enqueue',
          );
          // 检测 piped 消息的模型前缀
          let pipeModelOverride:
            | { model?: string; thinking?: 'adaptive' | 'disabled' }
            | undefined;
          const pipeLastMsg = messagesToSend[messagesToSend.length - 1];
          if (pipeLastMsg) {
            const t = pipeLastMsg.content.trim();
            if (/^[!！]{2}\s/.test(t)) {
              pipeLastMsg.content = t.replace(/^[!！]{2}\s*/, '');
              pipeModelOverride = {
                model: 'claude-sonnet-4-6',
                thinking: 'adaptive',
              };
            } else if (/^[!！]\s/.test(t)) {
              pipeLastMsg.content = t.replace(/^[!！]\s*/, '');
              pipeModelOverride = {
                model: 'claude-sonnet-4-6',
                thinking: 'disabled',
              };
            } else if (/^\+\s/.test(t)) {
              pipeLastMsg.content = t.replace(/^\+\s*/, '');
              pipeModelOverride = {
                model: 'claude-opus-4-6',
                thinking: 'adaptive',
              };
            } else if (/^~\s/.test(t)) {
              pipeLastMsg.content = t.replace(/^~\s*/, '');
              pipeModelOverride = { thinking: 'disabled' };
            }
          }
          const formatted = formatMessages(messagesToSend, TIMEZONE);

          // 动态记忆/Wiki 注入：仅 container active 时才做（避免冷启动路径浪费）
          // 用最后一条原始用户消息做 query，避免 formatted 中的时间戳/发送者噪声
          let dynamicContext: MessageContext | null = null;
          if (isMemoryEnabled() && queue.isActive(chatJid)) {
            try {
              const lastMsg = messagesToSend[messagesToSend.length - 1];
              const queryText = lastMsg?.content || formatted;
              const groupDir = resolveGroupFolderPath(group.folder);
              dynamicContext = await buildMessageContext(queryText, groupDir);
              // 去重：与上次相同则不注入
              if (dynamicContext) {
                const hash = hashContext(dynamicContext);
                if (hash === getLastContextHash(group.folder)) {
                  dynamicContext = null;
                } else {
                  setLastContextHash(group.folder, hash);
                  logger.info(
                    {
                      chatJid,
                      wikiCount: dynamicContext.wiki.length,
                      factsCount: dynamicContext.facts.length,
                    },
                    '动态 context 注入',
                  );
                }
              }
            } catch (err) {
              logger.warn(
                { err, chatJid },
                'buildMessageContext 失败，降级跳过',
              );
              dynamicContext = null;
            }
          }

          if (
            queue.sendMessage(
              chatJid,
              formatted,
              pipeModelOverride,
              dynamicContext,
            )
          ) {
            logger.debug(
              { chatJid, count: messagesToSend.length },
              'Piped messages to active container',
            );
            // piped 消息的 thinking 模式传给 channel，供脚注显示
            if ('setUsage' in channel && pipeModelOverride) {
              const thinkVal =
                pipeModelOverride.thinking === 'disabled'
                  ? ('disabled' as const)
                  : ('adaptive' as const);
              (
                channel as {
                  setUsage: (
                    jid: string,
                    usage: undefined,
                    thinking?: 'adaptive' | 'disabled',
                  ) => void;
                }
              ).setUsage(chatJid, undefined, thinkVal);
            }
            lastAgentTimestamp[chatJid] =
              messagesToSend[messagesToSend.length - 1].timestamp;
            saveState();
            // Show typing indicator while the container processes the piped message
            channel
              .setTyping?.(chatJid, true)
              ?.catch((err) =>
                logger.warn({ chatJid, err }, 'Failed to set typing indicator'),
              );
          } else {
            // No active container — enqueue for a new one
            queue.enqueueMessageCheck(chatJid);
          }
        }
      }
    } catch (err) {
      logger.error({ err }, 'Error in message loop');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL));
  }
}

/**
 * Startup recovery: check for unprocessed messages in registered groups.
 * Handles crash between advancing lastTimestamp and processing messages.
 */
function recoverPendingMessages(): void {
  for (const [chatJid, group] of Object.entries(registeredGroups)) {
    const pending = getMessagesSince(
      chatJid,
      getOrRecoverCursor(chatJid),
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      logger.info(
        { group: group.name, pendingCount: pending.length },
        'Recovery: found unprocessed messages',
      );
      queue.enqueueMessageCheck(chatJid);
    }
  }
}

async function main(): Promise<void> {
  // 清理上次运行遗留的孤儿 agent 进程
  const { cleanupOrphanAgents } = await import('./container-runner.js');
  cleanupOrphanAgents();

  initDatabase();
  logger.info('Database initialized');
  loadState();

  // Ensure OneCLI agents exist for all registered groups.
  // Recovers from missed creates (e.g. OneCLI was down at registration time).
  for (const [jid, group] of Object.entries(registeredGroups)) {
    ensureOneCLIAgent(jid, group);
  }

  restoreRemoteControl();

  // Initialize memory system (if enabled)
  if (isMemoryEnabled()) {
    getMemoryQueue();
  }

  // 初始化聊天记录索引（如启用）
  if (CHAT_INDEX_ENABLED) {
    getChatIndex()
      .init()
      .catch((err) => {
        logger.warn({ err }, 'Chat index 初始化失败，不影响主流程');
      });
  }

  // Graceful shutdown handlers
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'Shutdown signal received');
    // 先杀所有 agent 子进程（5 秒宽限期）
    await queue.shutdown(5000);
    // flush 聊天索引
    if (CHAT_INDEX_ENABLED) {
      await getChatIndex().dispose();
    }
    // 再 flush 记忆
    if (isMemoryEnabled()) {
      await getMemoryQueue().flush();
    }
    for (const ch of channels) await ch.disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  // Channel callbacks (shared by all channels)
  const channelOpts = {
    onMessage: async (chatJid: string, msg: NewMessage) => {
      // 剥离 trigger 前缀（如 "@Andy "）以匹配 slash 命令
      const rawContent = msg.content.trim();
      let trimmed = rawContent;
      const group = registeredGroups[chatJid];
      if (group) {
        const triggerPattern = getTriggerPattern(group.trigger);
        trimmed = trimmed.replace(triggerPattern, '').trim();
      }

      // Command Registry dispatch（已迁移的命令）
      if (group) {
        const handled = await dispatch(trimmed, {
          chatJid,
          msg,
          group,
          channels,
          sessions,
          queue,
          registeredGroups,
          deleteSession,
          setRegisteredGroup,
        });
        if (handled) return;
      }

      // 未知 / 命令 — 拦截并返回错误提示，不进 LLM
      if (trimmed.startsWith('/') && !trimmed.startsWith('/ ')) {
        const ch = findChannel(channels, chatJid);
        const unknownCmd = trimmed.split(/\s/)[0];
        const help = getHelp(`❓ 未知命令 "${unknownCmd}"，`);
        ch?.sendMessage(chatJid, help).catch((err) =>
          logger.error({ err }, 'unknown command reply failed'),
        );
        return;
      }

      // 自动注册未注册的群聊
      if (!registeredGroups[chatJid]) {
        autoRegisterGroup(chatJid);
      }

      // Sender allowlist drop mode: discard messages from denied senders before storing
      if (!msg.is_from_me && !msg.is_bot_message && registeredGroups[chatJid]) {
        const cfg = loadSenderAllowlist();
        if (
          shouldDropMessage(chatJid, cfg) &&
          !isSenderAllowed(chatJid, msg.sender, cfg)
        ) {
          if (cfg.logDenied) {
            logger.debug(
              { chatJid, sender: msg.sender },
              'sender-allowlist: dropping message (drop mode)',
            );
          }
          return;
        }
      }
      storeMessage(msg);
    },
    onChatMetadata: (
      chatJid: string,
      timestamp: string,
      name?: string,
      channel?: string,
      isGroup?: boolean,
    ) => storeChatMetadata(chatJid, timestamp, name, channel, isGroup),
    registeredGroups: () => registeredGroups,
  };

  // Create and connect all registered channels.
  // Each channel self-registers via the barrel import above.
  // Factories return null when credentials are missing, so unconfigured channels are skipped.
  for (const channelName of getRegisteredChannelNames()) {
    const factory = getChannelFactory(channelName)!;
    const channel = factory(channelOpts);
    if (!channel) {
      logger.warn(
        { channel: channelName },
        'Channel installed but credentials missing — skipping. Check .env or re-run the channel skill.',
      );
      continue;
    }
    channels.push(channel);
    await channel.connect();
  }
  if (channels.length === 0) {
    logger.fatal('No channels connected');
    process.exit(1);
  }

  // 启动时同步一次群列表（获取飞书群名等元数据）
  Promise.all(
    channels.filter((ch) => ch.syncGroups).map((ch) => ch.syncGroups!(false)),
  ).catch((err) => logger.warn({ err }, '启动时群列表同步失败'));

  // Start subsystems (independently of connection handler)
  startSchedulerLoop({
    registeredGroups: () => registeredGroups,
    getSessions: () => sessions,
    queue,
    onProcess: (groupJid, proc, containerName, groupFolder) =>
      queue.registerProcess(groupJid, proc, containerName, groupFolder),
    sendMessage: async (jid, rawText) => {
      const channel = findChannel(channels, jid);
      if (!channel) {
        logger.warn({ jid }, 'No channel owns JID, cannot send message');
        return undefined;
      }
      const text = formatOutbound(rawText);
      if (text) return channel.sendMessage(jid, text);
      return undefined;
    },
  });
  startIpcWatcher({
    sendMessage: async (jid, text) => {
      const channel = findChannel(channels, jid);
      if (!channel) throw new Error(`No channel for JID: ${jid}`);
      // 优先用 sendDirectMessage（跳过进度卡片清理），fallback 到 sendMessage
      if ('sendDirectMessage' in channel) {
        await (
          channel as {
            sendDirectMessage: (jid: string, text: string) => Promise<void>;
          }
        ).sendDirectMessage(jid, text);
        return undefined;
      }
      return channel.sendMessage(jid, text);
    },
    registeredGroups: () => registeredGroups,
    registerGroup,
    syncGroups: async (force: boolean) => {
      await Promise.all(
        channels
          .filter((ch) => ch.syncGroups)
          .map((ch) => ch.syncGroups!(force)),
      );
    },
    getAvailableGroups,
    writeGroupsSnapshot: (gf, im, ag, rj) =>
      writeGroupsSnapshot(gf, im, ag, rj),
    enqueueMessageCheck: (chatJid: string) => queue.enqueueMessageCheck(chatJid),
    onTasksChanged: () => {
      const tasks = getAllTasks();
      const taskRows = tasks.map((t) => ({
        id: t.id,
        groupFolder: t.group_folder,
        prompt: t.prompt,
        script: t.script || undefined,
        schedule_type: t.schedule_type,
        schedule_value: t.schedule_value,
        status: t.status,
        next_run: t.next_run,
      }));
      for (const group of Object.values(registeredGroups)) {
        writeTasksSnapshot(group.folder, group.isMain === true, taskRows);
      }
    },
    renameChat: async (jid, name) => {
      const channel = findChannel(channels, jid);
      if (channel?.renameChat) {
        await channel.renameChat(jid, name);
      } else {
        logger.warn(
          { jid, hasChannel: !!channel },
          '[rename] channel 不支持 renameChat',
        );
      }
    },
    onFeishuAuthRequest: async (chatJid, groupFolder) => {
      const feishuMod = await import('./channels/feishu.js');
      const feishuChannel = channels.find((c) => c.name === 'feishu') as
        | InstanceType<typeof feishuMod.FeishuChannel>
        | undefined;
      if (!feishuChannel?.sendAuthCard) return;
      const { buildAuthUrl } = await import('./channels/feishu-oauth.js');
      const state = `${chatJid}|${groupFolder}`;
      const authUrl = buildAuthUrl(state);
      if (authUrl) {
        await feishuChannel.sendAuthCard(chatJid, authUrl);
        logger.info({ chatJid }, '飞书授权卡片已发送');
      }
    },
  });
  startSessionCleanup();
  queue.setProcessMessagesFn((chatJid) => {
    const group = registeredGroups[chatJid];
    return withLogContext(
      { chatJid, groupFolder: group?.folder },
      () => processGroupMessages(chatJid),
    );
  });
  recoverPendingMessages();
  startMessageLoop().catch((err) => {
    logger.fatal({ err }, 'Message loop crashed unexpectedly');
    process.exit(1);
  });
}

// Guard: only run when executed directly, not when imported by tests
const isDirectRun =
  process.argv[1] &&
  new URL(import.meta.url).pathname ===
    new URL(`file://${process.argv[1]}`).pathname;

if (isDirectRun) {
  main().catch((err) => {
    logger.error({ err }, 'Failed to start NanoClaw');
    process.exit(1);
  });
}
