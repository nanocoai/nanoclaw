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
  DATA_DIR,
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
import { shouldFilterProgress, isModelRefusal } from './output-filters.js';
import {
  buildSessionRecoveryMessage,
  isSessionRecoveryError,
} from './session-recovery.js';
import './channels/index.js';
import type { FeishuChannel } from './channels/feishu.js';
import {
  getChannelFactory,
  getRegisteredChannelNames,
} from './channels/registry.js';
import {
  ContainerOutput,
  detectRateLimit,
  detectRateLimitResult,
  getSecretCount,
  resolveCliMode,
  rotateAccount,
  runContainerAgent,
  shouldAutoRotateAnthropicAccount,
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
  getRecentUserMessages,
  getRouterState,
  initDatabase,
  setRegisteredGroup,
  setRouterState,
  setSession,
  storeChatMetadata,
  storeMessage,
  getActiveDelegationByGroup,
  hasIpcTriggerForTask,
  storeMessageDirect,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { isValidGroupFolder, resolveGroupFolderPath } from './group-folder.js';
import {
  finalizeDelegationOnTurnEnd,
  shouldCarryReply,
  startIpcWatcher,
  type ReportMeta,
} from './ipc.js';
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
import type { CliMode } from './types.js';
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

/**
 * 单调推进 per-JID cursor。只有 ts > 当前值才写入，防止被旧值覆盖回退。
 * 所有对 lastAgentTimestamp 的赋值都必须走这个函数。
 */
function advanceAgentCursor(jid: string, ts: string, save = true): void {
  const current = lastAgentTimestamp[jid] || '';
  if (ts > current) {
    lastAgentTimestamp[jid] = ts;
    if (save) saveState();
  }
}

/** 注入回调：finalizeDelegationOnTurnEnd 和 startIpcWatcher 共用 */
function injectReportToActiveAgent(
  sourceJid: string,
  reportMeta: ReportMeta,
): boolean {
  const ok = queue.sendMessage(sourceJid, reportMeta.text);
  if (ok) {
    advanceAgentCursor(sourceJid, reportMeta.timestamp);
    logger.info(
      { sourceJid, reportId: reportMeta.id, ts: reportMeta.timestamp },
      'report injected into active agent, cursor advanced',
    );
  }
  return ok;
}

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
    advanceAgentCursor(chatJid, botTs);
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
export function parseModelPrefix(text: string): {
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

/** thinking-only 空结果的处置动作 */
export type ThinkingOnlyAction = 'retry' | 'giveup' | 'none';

const AUTO_FOLLOWUP_SUMMARY_MIN_CHARS = 200;
const AUTO_FOLLOWUP_SUMMARY_MAX_REPLY_CHARS = 6000;

export function shouldTriggerAutoFollowupSummary(input: {
  enabled: boolean;
  cliMode: CliMode;
  text: string;
  isAutoFollowupTurn: boolean;
  hadError: boolean;
}): boolean {
  if (!input.enabled) return false;
  if (input.isAutoFollowupTurn) return false;
  if (input.hadError) return false;
  if (!['sdk', 'interactive', 'codex'].includes(input.cliMode)) return false;
  return input.text.trim().length >= AUTO_FOLLOWUP_SUMMARY_MIN_CHARS;
}

export function buildAutoFollowupSummaryPrompt(originalReply: string): string {
  const clipped = originalReply
    .trim()
    .slice(0, AUTO_FOLLOWUP_SUMMARY_MAX_REPLY_CHARS);
  return [
    '[AUTO_FOLLOWUP_SUMMARY]',
    '你刚才已经把完整回复发给用户了。现在请基于下面这段已发送回复，补发一条给大杰看的极简总结。',
    '要求：',
    '1. 只输出总结，不要调用工具，不要新增事实，不要继续执行任务。',
    '2. 第一句话必须是结论。',
    '3. 最多 3 行，讲清楚：结果是什么、还要不要大杰处理。',
    '4. 如果原回复已经足够短，只输出一句话。',
    '',
    '已发送回复：',
    clipped,
  ].join('\n');
}

/**
 * 判定一次 success 结果是否属于 thinking-only 空结果，以及该如何处置。
 *
 * thinking-only：模型只产出 thinking tokens（extended thinking）就 end_turn，
 * 没有 text 输出 → result 为空但 outputTokens > 0，用户什么都收不到。
 *
 *  - 'retry'  → 还在重试上限内，pipe 一条重试消息（调用方负责关 thinking）
 *  - 'giveup' → 已达上限，放弃并提示用户，避免无限重试刷屏烧钱
 *  - 'none'   → 不是 thinking-only（正常有 text，或本轮已发过真实文本）
 *
 * 抽成纯函数便于单测 —— 防止重试上限/触发条件被悄悄改动而无 assertion 拦截。
 */
export function decideThinkingOnlyAction(input: {
  hasText: boolean;
  textSentToUser: boolean;
  outputTokens: number;
  retryCount: number;
  maxRetries: number;
}): ThinkingOnlyAction {
  const isThinkingOnly =
    !input.hasText && !input.textSentToUser && input.outputTokens > 0;
  if (!isThinkingOnly) return 'none';
  return input.retryCount >= input.maxRetries ? 'giveup' : 'retry';
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

  // 语音播报上下文：群名 + 跨轮次最近 5 条用户消息（从 DB 取，不限本轮 cursor）
  // 提前构造，agent 回复和 retry 回调都能用（闭包捕获）
  const voiceCtxParts: string[] = [];
  if (group.name) voiceCtxParts.push(`[当前任务] ${group.name}`);
  const recentUserMsgs = getRecentUserMessages(chatJid, 5).map((m) =>
    m.content.slice(0, 200),
  );
  if (recentUserMsgs.length > 0)
    voiceCtxParts.push(`[用户消息]\n${recentUserMsgs.join('\n')}`);
  const voiceContext =
    voiceCtxParts.length > 0
      ? `[对话上下文]\n${voiceCtxParts.join('\n')}`
      : undefined;

  // 本轮消息全部来自跨群 IPC（delegate 投递 / report_to_main）时，
  // agent 回复的受众是 agent 自己，不推语音播报
  const isIpcOnlyTurn = missedMessages.length > 0 && missedMessages.every((m) =>
    m.id.startsWith('ipc_'),
  );

  /** 统一发送 agent 回复，自动 merge 跨群静音标记 */
  const sendAgentMessage = (text: string, options?: import('./types.js').SendMessageOptions) =>
    channel.sendMessage(chatJid, text, {
      ...options,
      skipVoiceNotify: isIpcOnlyTurn || options?.skipVoiceNotify,
      voiceContext: isIpcOnlyTurn ? undefined : (options?.voiceContext ?? voiceContext),
    });

  // For non-main groups, check if trigger is required and present
  if (!isMainGroup && group.requiresTrigger !== false) {
    const triggerPattern = getTriggerPattern(group.trigger);
    const allowlistCfg = loadSenderAllowlist();
    const hasTrigger = missedMessages.some(
      (m) =>
        m.id.startsWith('ipc_') || // 跨群 IPC 消息直接绕过 trigger 检查
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
  // thinking-only 自动重试计数（不每轮重置，成功产出 text 后清零）。
  // 上限防止模型持续只 thinking 不输出时无限重试刷屏 + 烧钱。
  const THINKING_ONLY_MAX_RETRIES = 1;
  let thinkingOnlyRetryCount = 0;
  let outputSentToUser = false; // 当前 query 是否发过消息（每轮重置）
  let textSentToUser = false; // 当前 query 是否发过真实文本（工具进度卡不算）
  let everSentToUser = false; // 整个 agent 生命周期是否发过消息（不重置，error handler 用）
  let autoFollowupSummaryTurnsRemaining = 0; // 自动总结回合计数，用于防递归
  let autoFollowupSummaryTextParts: string[] = []; // 当前 query 已发给用户的真实文本
  let streamingRateLimitDetected = false;
  let rotatedNotificationSent = false;
  // SDK 把 fetch failed / API Error: 5xx 误包成 status:success + result 文本时
  // 由主 onOutput 拦截并设置此 flag，runAgent 返回后触发 API error 重试 loop
  let streamingApiErrorDetected = false;
  let streamingApiErrorText = '';

  // R8.1: 收集 Agent 回复文本（用于记忆更新）——整轮累计，不按 query 清空
  const agentReplies: string[] = [];
  // 当前 query 级回复（每轮 IPC query 开始时清空），自动终态只用这个，
  // 避免跨 query 串旧任务内容（大杰 2026-06-23 实锤 delegate 汇报内容被覆盖）
  let currentQueryReplies: string[] = [];
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

  const maybeEnqueueAutoFollowupSummary = () => {
    const isAutoFollowupTurn = autoFollowupSummaryTurnsRemaining > 0;
    const visibleTextForAutoFollowup = autoFollowupSummaryTextParts
      .join('\n')
      .trim();
    const cliMode = resolveCliMode(group.containerConfig);
    const autoFollowupEnabled =
      group.containerConfig?.autoFollowupSummary === true;

    if (isAutoFollowupTurn) {
      logger.info(
        {
          group: group.name,
          chatJid,
          cliMode,
          textLen: visibleTextForAutoFollowup.length,
        },
        '[auto-summary] 自动总结回合完成，跳过再次触发',
      );
      autoFollowupSummaryTurnsRemaining = 0;
      return;
    }

    if (
      shouldTriggerAutoFollowupSummary({
        enabled: autoFollowupEnabled,
        cliMode,
        text: visibleTextForAutoFollowup,
        isAutoFollowupTurn,
        hadError:
          hadError || streamingApiErrorDetected || streamingRateLimitDetected,
      })
    ) {
      const summaryPrompt = buildAutoFollowupSummaryPrompt(
        visibleTextForAutoFollowup,
      );
      const sent = queue.sendMessage(
        chatJid,
        summaryPrompt,
        { thinking: 'disabled' },
        null,
        memorySenderId,
      );
      if (sent) {
        autoFollowupSummaryTurnsRemaining = 1;
        logger.info(
          {
            group: group.name,
            chatJid,
            cliMode,
            textLen: visibleTextForAutoFollowup.length,
            promptLen: summaryPrompt.length,
          },
          '[auto-summary] 自动后置总结已入队',
        );
      } else {
        logger.warn(
          { group: group.name, chatJid, cliMode },
          '[auto-summary] 自动后置总结入队失败，容器可能已退出',
        );
      }
      return;
    }

    if (autoFollowupEnabled) {
      logger.info(
        {
          group: group.name,
          chatJid,
          cliMode,
          textLen: visibleTextForAutoFollowup.length,
          isAutoFollowupTurn,
          hadError:
            hadError || streamingApiErrorDetected || streamingRateLimitDetected,
        },
        '[auto-summary] 跳过自动后置总结',
      );
    }
  };

  // Commander 自动终态兜底共享函数
  // 在 mainOnOutput 和 retry onOutput 的 success/error 分支都调用，
  // 避免逻辑重复和遗漏（C2 review 2026-06-29 要求抽出）。
  const finalizeActiveDelegationForTurn = (opts: {
    ok: boolean;
    logPrefix: string;
  }) => {
    try {
      const activeTask = getActiveDelegationByGroup(group.folder);
      if (!opts.ok) {
        // error 终态：不携带回复内容（异常终态无归因意义）
        finalizeDelegationOnTurnEnd(group.folder, false, undefined, {
          injectReportToActiveAgent,
          sendMessage: async (jid, text) => { await channel.sendMessage(jid, text); return undefined; },
        });
        return;
      }
      let carryResult = activeTask ? shouldCarryReply(missedMessages, activeTask) : false;
      // IPC pipe 模式补偿：missedMessages 是 turn 开始时的快照，后续 query 不刷新。
      if (!carryResult && activeTask && currentQueryReplies.length > 0) {
        const dbHasTrigger = hasIpcTriggerForTask(chatJid, activeTask.taskId);
        if (dbHasTrigger) {
          carryResult = true;
          logger.info(
            { group: group.folder, taskId: activeTask.taskId },
            `${opts.logPrefix} IPC pipe 补偿：DB 有对应触发消息，携带回复`,
          );
        }
      }
      logger.info(
        {
          group: group.folder,
          hasActiveTask: !!activeTask,
          taskId: activeTask?.taskId,
          carryResult,
          missedCount: missedMessages.length,
          missedIds: missedMessages.map((m) => m.id).slice(0, 5),
          currentQueryRepliesLen: currentQueryReplies.length,
          firstReplyPreview: currentQueryReplies[0]?.slice(0, 80),
        },
        `${opts.logPrefix} auto-finalize debug: shouldCarryReply 判断`,
      );
      const finalReply = activeTask && carryResult
        ? currentQueryReplies.join('\n\n')
        : undefined;
      finalizeDelegationOnTurnEnd(group.folder, true, finalReply, {
        injectReportToActiveAgent,
        sendMessage: async (jid, text) => { await channel.sendMessage(jid, text); return undefined; },
      });
    } catch (err) {
      logger.warn({ err, group: group.folder }, `${opts.logPrefix} 自动终态汇报异常`);
    }
  };

  // 主 onOutput 回调（提取为命名 const 以便 API error 重试 loop 复用）
  const mainOnOutput = async (result: ContainerOutput) => {
    // 进度消息 — 转发给 channel 显示进度卡片
    if (result.status === 'progress' && result.result) {
      // thinking 类型的 progress 不发给用户（模型内部思考过程，发出去会触发死循环）
      if (shouldFilterProgress(result.progressType)) {
        logger.info(
          { chatJid, text: result.result.slice(0, 100) },
          '[progress] thinking 类型，跳过发送',
        );
        return;
      }
      logger.info(
        {
          chatJid,
          progressType: result.progressType,
          preview: result.result.slice(0, 80),
        },
        '[progress] 转发到 channel',
      );
      const payload = result.detail
        ? JSON.stringify({ title: result.result, detail: result.detail })
        : result.result;
      await channel.sendMessage(chatJid, payload, { isProgress: true });
      everSentToUser = true; // CLI interactive 模式下中间消息也算"发过消息"
      if (result.progressType === 'text') {
        textSentToUser = true;
        autoFollowupSummaryTextParts.push(result.result);
      }
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
        } catch {
          /* 入库失败不影响主流程 */
        }
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

    // kill 后可能还有残余 chunk 在 outputChain 里排队，直接丢弃
    if (streamingRateLimitDetected) return;

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
      // 检测到后抑制发送 + 立即 kill 子进程，让 runContainerAgent resolve
      // 之后由 runAgent 返回后的 streamingRateLimitDetected 轮换逻辑执行切账号+重试
      //
      // 两个守门（2026-06-11 oc_f0c8 群误杀死循环复盘）：
      // 1. 长度 <500：真限流的假成功 result 就是孤零零一句话；正常回答里
      //    "引用/转述"限流报错（如诊断别的群限流问题）必然长得多。
      //    误杀后 cursor 不推进 → 重试 → 回答还带同样引用 → 再杀 → 死循环。
      // 2. 仅 Claude 系 cliMode：非 Claude 系（codex/gemini）检测到也不会轮换
      //    Anthropic 账号（见 runAgent 返回后的轮换逻辑），kill 纯属白杀。
      if (
        detectRateLimitResult(raw) &&
        shouldAutoRotateAnthropicAccount(resolveCliMode(group.containerConfig))
      ) {
        streamingRateLimitDetected = true;
        logger.warn(
          { group: group.name, text: raw.slice(0, 200) },
          'Streaming 输出检测到限流文本，抑制发送并 kill 子进程触发轮换',
        );
        // kill 子进程，让 runContainerAgent 的 Promise resolve
        // 这样 runAgent 返回后的轮换逻辑能立即执行
        queue.killGroup(chatJid);
        return;
      }

      // SDK 系统消息过滤：拦截不应发给用户的内部信息
      // - "New session: UUID" — session 被强制重置时 SDK 输出
      // - "fetch failed" / "API Error: 5xx" — API 调用失败被包装成 success
      // - 纯 UUID 行 — session ID 泄露
      if (text && /^(?:🔄\s*)?New session:\s*[0-9a-f-]+$/i.test(text)) {
        logger.warn(
          { group: group.name, text },
          'SDK 系统消息被拦截（New session），不发给用户',
        );
        return;
      }
      if (text && /^(?:fetch failed|API Error:\s*\d{3}\b)/i.test(text)) {
        // SDK 把上游 API 瞬时错误（fetch failed / 5xx）包成 status:success + result 文本
        // 这条文本不能发给用户，且必须触发外层重试（不是简单 silent return）
        streamingApiErrorDetected = true;
        streamingApiErrorText = text.slice(0, 200);
        logger.warn(
          { group: group.name, text: text.slice(0, 200), chatJid },
          '[api-error] SDK 把 API 瞬时错误包成 success result，标记重试并 kill 子进程',
        );
        // kill 子进程，让 runContainerAgent resolve，由 runAgent 返回后的 API error 重试 loop 接管
        queue.killGroup(chatJid);
        return;
      }

      // 模型拒绝回复文本过滤 — "No response requested." 等不应发给用户（会触发死循环）
      if (text && isModelRefusal(text)) {
        logger.warn(
          { chatJid, text: text.slice(0, 100) },
          '[reply] 模型拒绝文本被拦截，不发给用户',
        );
        return;
      }

      if (text) {
        await channel.setTyping?.(chatJid, false);
        const feishuMsgId = await sendAgentMessage(text);
        logger.info(
          { group: group.name, feishuMsgId, textLen: text.length },
          '[reply] sendMessage 返回',
        );
        if (feishuMsgId) lastFeishuMsgId = feishuMsgId;
        outputSentToUser = true;
        textSentToUser = true;
        everSentToUser = true;
        agentReplies.push(text);
        currentQueryReplies.push(text);
        autoFollowupSummaryTextParts.push(text);

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
      // thinking-only 空结果检测与自动重试：
      // 模型偶尔会只产出 thinking tokens（extended thinking）但没有 text 输出就 end_turn，
      // 表现为 result 为空但 outputTokens > 0。此时自动 pipe 一条重试消息让模型继续回答。
      const outputTokens = result.usage?.outputTokens ?? 0;
      const hasText = !!result.result && result.result.trim().length > 0;
      logger.info(
        {
          group: group.name,
          chatJid,
          hasText,
          outputSentToUser,
          textSentToUser,
          everSentToUser,
          outputTokens,
          retries: thinkingOnlyRetryCount,
        },
        '[thinking-only] success 空结果判定输入',
      );
      const thinkingOnlyAction = decideThinkingOnlyAction({
        hasText,
        textSentToUser,
        outputTokens,
        retryCount: thinkingOnlyRetryCount,
        maxRetries: THINKING_ONLY_MAX_RETRIES,
      });
      if (thinkingOnlyAction === 'giveup') {
        // 已达重试上限：放弃并提示用户，避免无限循环刷屏烧钱。
        // 不 return —— 继续往下走正常清理（关 typing / 清进度卡片）。
        logger.warn(
          {
            group: group.name,
            chatJid,
            outputTokens,
            retries: thinkingOnlyRetryCount,
          },
          '[thinking-only] 重试已达上限，放弃并提示用户',
        );
        channel
          .sendMessage(
            chatJid,
            '⚠️ 模型连续多次只思考、不输出内容，已停止自动重试。请重新发条消息或换个问法。',
            { isCommandReply: true },
          )
          .catch((err) =>
            logger.warn({ err }, '[thinking-only] 放弃通知发送失败'),
          );
        thinkingOnlyRetryCount = 0;
      } else if (thinkingOnlyAction === 'retry') {
        thinkingOnlyRetryCount++;
        logger.warn(
          {
            group: group.name,
            chatJid,
            outputTokens,
            cost: result.usage?.totalCostUsd,
            retry: thinkingOnlyRetryCount,
          },
          '[thinking-only] 模型仅产出 thinking 无 text，自动重试（关闭 thinking 强制输出）',
        );
        // 通知用户
        channel
          .sendMessage(
            chatJid,
            '⚠️ 模型开了个小差（只有 thinking 没有输出），自动重试中...',
            { isCommandReply: true },
          )
          .catch((err) => logger.warn({ err }, '[thinking-only] 通知发送失败'));
        // pipe 重试消息到同一个 session，关闭 thinking 强制模型直接输出 text，
        // 否则 adaptive thinking 可能再次把整轮耗在 thinking 上、又是空结果。
        const retryMsg =
          '你刚才的回复只有 thinking 没有 text 输出，用户什么都没收到。请直接用文字重新回答上一个问题，不要只思考。';
        if (
          !queue.sendMessage(
            chatJid,
            retryMsg,
            { thinking: 'disabled' },
            null,
            memorySenderId,
          )
        ) {
          logger.warn(
            { chatJid },
            '[thinking-only] pipe 重试失败（容器可能已退出），入队重新处理',
          );
          queue.enqueueMessageCheck(chatJid);
        }
        // 不清理进度卡片、不重置状态，等重试结果回来再清理
        return;
      } else if (hasText) {
        // 成功产出 text → 清零重试计数，下次 thinking-only 重新计
        thinkingOnlyRetryCount = 0;
      }

      maybeEnqueueAutoFollowupSummary();

      // 每轮 query 结束时，确保 typing/spinner/进度卡片被清理
      // IPC pipe 模式下多轮 query 共享同一个闭包，必须每轮都清理
      // （之前只在 !outputSentToUser 时清理，导致第一轮设了 true 后后续轮次卡片永远不关）
      if (!outputSentToUser) {
        await channel.setTyping?.(chatJid, false);
      }
      // CLI interactive 模式：文本已通过中间 progress/send_message 发出，
      // success 到达时 text 为空，但 pendingUsage 还在 → 单独发 usage-only 卡片。
      // 只有真实文本发出过才补 footer；工具进度卡不能算，否则会产生空消息。
      // 必须在 cleanupProgressCard 之前调用（cleanup 会清理 pendingUsage）
      if (textSentToUser && 'sendUsageOnly' in channel) {
        await (
          channel as { sendUsageOnly: (jid: string) => Promise<void> }
        ).sendUsageOnly(chatJid);
      }
      // 无条件清理进度卡片（cleanupProgressCard 内部会检查卡片是否存在，不存在则 no-op）
      if ('cleanupProgressCard' in channel) {
        await (
          channel as { cleanupProgressCard: (jid: string) => Promise<void> }
        ).cleanupProgressCard(chatJid);
      }
      // Commander 自动终态兜底（共享函数，main/retry onOutput 统一调用）
      finalizeActiveDelegationForTurn({ ok: true, logPrefix: '[main]' });

      // 重置状态：IPC pipe 模式下下一轮 query 需要从干净状态开始
      outputSentToUser = false;
      textSentToUser = false;
      autoFollowupSummaryTextParts = [];
      currentQueryReplies = [];

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
      // pipe 模式下进程不退出，外层 error path 的 failed 兜底不会立刻执行，
      // 必须在此补 failed 终态（C2 review 2026-06-29 指出）
      finalizeActiveDelegationForTurn({ ok: false, logPrefix: '[main-error]' });
    }
  };

  const notifyRotation = (rotation: {
    newSecretName: string;
    oldSecretName?: string;
  }) => {
    if (rotatedNotificationSent) return;
    rotatedNotificationSent = true;
    channel
      .sendMessage(
        chatJid,
        `🔄 ${rotation.oldSecretName || '当前账号'}额度已满，已自动切换到 ${rotation.newSecretName}`,
        { isCommandReply: true },
      )
      .catch((err) => {
        logger.error(
          { err, group: group.name },
          '[rate-limit] 轮换通知发送失败',
        );
      });
  };

  const output = await runAgent(
    group,
    prompt,
    chatJid,
    mainOnOutput,
    latestUserMessage,
    memorySenderId,
    0, // retryCount
    modelOverride,
    notifyRotation,
  );

  await channel.setTyping?.(chatJid, false);
  if (idleTimer) clearTimeout(idleTimer);

  if (queue.consumeStopRequested(chatJid)) {
    advanceAgentCursor(chatJid, newCursor);
    logger.info(
      { group: group.name, chatJid },
      '/stop: 用户主动停止，cursor 已推进且不触发重试',
    );
    return true;
  }

  // SDK 假成功 API 瞬时错误（fetch failed / API Error: 5xx）重试 loop
  // onOutput 主回调拦截到这类文本后，已 kill 子进程并 set streamingApiErrorDetected
  // 此处带延迟重试（3s/6s），不轮换账号（API 瞬时错误不是账号问题）
  const API_ERROR_MAX_RETRIES = 2;
  let apiErrorAttempt = 0;
  while (streamingApiErrorDetected && apiErrorAttempt < API_ERROR_MAX_RETRIES) {
    apiErrorAttempt++;
    const delayMs = apiErrorAttempt * 3000; // 3s, 6s
    logger.warn(
      {
        group: group.name,
        attempt: apiErrorAttempt,
        maxAttempts: API_ERROR_MAX_RETRIES,
        delayMs,
        detectedText: streamingApiErrorText,
      },
      '[api-error] SDK 假成功（fetch failed/5xx），延迟后重试',
    );
    await new Promise((r) => setTimeout(r, delayMs));
    // 重置 flag 准备重试（重试时若再次拦截会重新 set）
    streamingApiErrorDetected = false;
    streamingApiErrorText = '';
    try {
      await runAgent(
        group,
        prompt,
        chatJid,
        mainOnOutput,
        latestUserMessage,
        memorySenderId,
        0, // retryCount 从 0 起，让 runAgent 内 1ef031b 重试链路也可独立工作
        modelOverride,
        notifyRotation,
      );
      logger.info(
        {
          group: group.name,
          attempt: apiErrorAttempt,
          stillFailed: streamingApiErrorDetected,
        },
        '[api-error] 重试 runAgent 返回',
      );
    } catch (err) {
      logger.error(
        {
          err,
          errMessage: (err as Error)?.message,
          errStack: (err as Error)?.stack,
          group: group.name,
          attempt: apiErrorAttempt,
        },
        '[api-error] 重试调用 runAgent 抛错',
      );
      hadError = true;
      break;
    }
  }
  if (streamingApiErrorDetected) {
    // 试完所有重试仍失败，通知用户
    logger.error(
      {
        group: group.name,
        attempts: apiErrorAttempt,
        detectedText: streamingApiErrorText,
        chatJid,
      },
      '[api-error] 重试 2 次仍失败，发送错误通知给用户',
    );
    await channel
      .sendMessage(
        chatJid,
        '⚠️ 上游 API 暂时不可用（已自动重试 2 次失败），请稍后重发消息',
      )
      .catch((err) => {
        logger.error(
          { err, errMessage: (err as Error)?.message, group: group.name },
          '[api-error] 错误通知发送失败',
        );
      });
    hadError = true;
  } else if (apiErrorAttempt > 0) {
    logger.info(
      { group: group.name, attempts: apiErrorAttempt },
      '[api-error] 重试成功，agent 恢复响应',
    );
  }

  // Streaming 模式下限流检测：onOutput 回调中发现 "hit your limit" 等文本
  // 轮换账号并重试，runAgent 内部会继续轮换直到试完所有账号
  const cliMode = resolveCliMode(group.containerConfig);
  const canAutoRotateAnthropic = shouldAutoRotateAnthropicAccount(cliMode);

  if (streamingRateLimitDetected && !canAutoRotateAnthropic) {
    logger.warn(
      { group: group.name, cliMode },
      '[rate-limit] 当前模式不是 Claude 系，跳过 Anthropic 自动轮换',
    );
    hadError = true;
  }

  if (
    streamingRateLimitDetected &&
    !output.rotatedTo &&
    canAutoRotateAnthropic
  ) {
    const agentId = group.folder.toLowerCase().replace(/_/g, '-');
    logger.warn(
      { group: group.name, agentId },
      '[rate-limit] Streaming 输出包含限流文本，尝试轮换账号',
    );
    const rotateResult = rotateAccount(agentId, group.folder);
    if (rotateResult?.success) {
      output.rotatedTo = rotateResult.newSecretName;
      output.rotatedFrom = rotateResult.oldSecretName;
      logger.info(
        {
          group: group.name,
          oldAgentId: agentId,
          newSecret: rotateResult.newSecretName,
        },
        '[rate-limit] 已轮换账号，开始重试',
      );
      notifyRotation(rotateResult);
      // 重试：复用原始 onOutput 回调，确保 progress/usage/reply 全链路完整
      const retryOutput = await runAgent(
        group,
        prompt,
        chatJid,
        async (result) => {
          // 进度消息 — 与原始回调完全一致
          if (result.status === 'progress' && result.result) {
            // thinking 类型的 progress 不发给用户（同主回调逻辑）
            if (shouldFilterProgress(result.progressType)) {
              logger.info(
                { chatJid, text: result.result.slice(0, 100) },
                '[retry-progress] thinking 类型，跳过发送',
              );
              return;
            }
            logger.info(
              {
                chatJid,
                progressType: result.progressType,
                preview: result.result.slice(0, 80),
              },
              '[retry-progress] 转发到 channel',
            );
            const payload = result.detail
              ? JSON.stringify({ title: result.result, detail: result.detail })
              : result.result;
            await channel.sendMessage(chatJid, payload, { isProgress: true });
            everSentToUser = true; // CLI interactive 模式下中间消息也算"发过消息"
            if (result.progressType === 'text') {
              textSentToUser = true;
              autoFollowupSummaryTextParts.push(result.result);
            }
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
              } catch {
                /* 入库失败不影响主流程 */
              }
            }
            return;
          }

          // usage 传递
          if (result.usage && 'setUsage' in channel) {
            (
              channel as {
                setUsage: (
                  jid: string,
                  usage: typeof result.usage,
                  thinking?: 'adaptive' | 'disabled',
                ) => void;
              }
            ).setUsage(
              chatJid,
              result.usage,
              modelOverride?.thinking === 'disabled' ? 'disabled' : 'adaptive',
            );
          }

          // 正式回复（过滤限流文本，由 runAgent 内部处理重试）
          if (result.result) {
            const raw =
              typeof result.result === 'string'
                ? result.result
                : JSON.stringify(result.result);
            // 重试也可能再次限流，必须检查并抑制 + kill 子进程避免死锁
            if (
              detectRateLimitResult(raw) &&
              shouldAutoRotateAnthropicAccount(
                resolveCliMode(group.containerConfig),
              )
            ) {
              logger.warn(
                { group: group.name, text: raw.slice(0, 200) },
                'Retry 输出仍包含限流文本，抑制发送并 kill 子进程',
              );
              queue.killGroup(chatJid);
              return;
            }
            const text = raw
              .replace(/<internal>[\s\S]*?<\/internal>/g, '')
              .trim();
            // SDK 系统消息过滤（同主回调）
            if (text && /^(?:🔄\s*)?New session:\s*[0-9a-f-]+$/i.test(text)) {
              logger.warn(
                { group: group.name, text, chatJid },
                '[rate-limit-retry] SDK 系统消息被拦截（New session），不发给用户',
              );
              return;
            }
            if (text && /^(?:fetch failed|API Error:\s*\d{3}\b)/i.test(text)) {
              // 限流重试期间也可能遇到 SDK 假成功 API 错误，同样标记触发外层 API error 重试
              streamingApiErrorDetected = true;
              streamingApiErrorText = text.slice(0, 200);
              logger.warn(
                { group: group.name, text: text.slice(0, 200), chatJid },
                '[api-error] 限流重试期间检测到 API 瞬时错误，标记重试并 kill',
              );
              queue.killGroup(chatJid);
              return;
            }
            // 模型拒绝回复文本过滤（同主回调逻辑）
            if (text && isModelRefusal(text)) {
              logger.warn(
                { chatJid, text: text.slice(0, 100) },
                '[retry-reply] 模型拒绝文本被拦截，不发给用户',
              );
              return;
            }
            if (text) {
              const retryFmid = await sendAgentMessage(text);
              if (retryFmid) lastFeishuMsgId = retryFmid;
              outputSentToUser = true;
              textSentToUser = true;
              everSentToUser = true;
              agentReplies.push(text);
              currentQueryReplies.push(text);
              autoFollowupSummaryTextParts.push(text);
            }
          }
          if (result.status === 'success') {
            maybeEnqueueAutoFollowupSummary();
            // 重试成功后也要清理进度卡片和 typing 状态
            if (!outputSentToUser) {
              await channel.setTyping?.(chatJid, false);
            }
            // CLI interactive: usage-only 卡片（同主回调，在 cleanup 之前）
            if (textSentToUser && 'sendUsageOnly' in channel) {
              await (
                channel as { sendUsageOnly: (jid: string) => Promise<void> }
              ).sendUsageOnly(chatJid);
            }
            if ('cleanupProgressCard' in channel) {
              await (
                channel as {
                  cleanupProgressCard: (jid: string) => Promise<void>;
                }
              ).cleanupProgressCard(chatJid);
            }
            // Commander 自动终态兜底（共享函数，与 mainOnOutput 统一）
            finalizeActiveDelegationForTurn({ ok: true, logPrefix: '[retry]' });
            outputSentToUser = false;
            textSentToUser = false;
            autoFollowupSummaryTextParts = [];
            currentQueryReplies = [];
            queue.notifyIdle(chatJid);
          }
          if (result.status === 'error') {
            hadError = true;
            finalizeActiveDelegationForTurn({ ok: false, logPrefix: '[retry-error]' });
          }
        },
        latestUserMessage,
        memorySenderId,
        1, // retryCount=1，runAgent 内部会继续轮换
        modelOverride,
        notifyRotation,
      );
      // 合并重试结果
      if (retryOutput.status === 'error') hadError = true;
      if (retryOutput.allExhausted) output.allExhausted = true;
      if (retryOutput.rotatedTo) output.rotatedTo = retryOutput.rotatedTo;
      logger.info(
        { group: group.name, retryStatus: retryOutput.status },
        '[rate-limit] 重试完成',
      );
    } else {
      // rotateAccount 返回 null（未开启/onecli 错误/单账号）
      logger.warn(
        { group: group.name, rotateResult },
        '[rate-limit] 轮换未执行（onecli 错误/单账号）',
      );
    }
  }

  // 轮换通知
  if (output.rotatedTo && !rotatedNotificationSent) {
    logger.info(
      { group: group.name, rotatedTo: output.rotatedTo },
      '[rate-limit] 发送轮换通知给用户',
    );
    channel
      .sendMessage(
        chatJid,
        `🔄 ${output.rotatedFrom || '当前账号'}额度已满，已自动切换到 ${output.rotatedTo}`,
        { isCommandReply: true },
      )
      .catch((err) => {
        logger.error(
          { err, group: group.name },
          '[rate-limit] 轮换通知发送失败',
        );
      });
  }
  if (output.allExhausted) {
    logger.warn({ group: group.name }, '[rate-limit] 发送配额耗尽通知给用户');
    channel
      .sendMessage(chatJid, '⚠️ 所有账号配额已耗尽，请等待恢复或添加新账号')
      .catch((err) => {
        logger.error(
          { err, group: group.name },
          '[rate-limit] 耗尽通知发送失败',
        );
      });
  }
  if (output.sessionRecoveryRequired) {
    const text = buildSessionRecoveryMessage({
      sessionId: output.sessionRecoveryRequired.sessionId,
      error: output.sessionRecoveryRequired.error,
    });
    logger.warn(
      {
        group: group.name,
        chatJid,
        sessionId: output.sessionRecoveryRequired.sessionId,
        sessionFileExists: output.sessionRecoveryRequired.sessionFileExists,
      },
      '[session-recovery] 已通知用户并保留 cursor，等待用户决定是否 /new',
    );
    await sendAgentMessage(text, { isCommandReply: true });
    everSentToUser = true;
  }

  if (output.status === 'error' || hadError) {
    // Commander 自动终态兜底：目标群容器异常结束时，若仍有进行态 delegation 任务，
    // host 自动补 failed，避免账本卡 dispatched/progress 直到 15 分钟失联。
    // 不带 agent 回复内容（异常终态无归因意义）。
    try {
      finalizeDelegationOnTurnEnd(group.folder, false, undefined, {
        injectReportToActiveAgent,
        sendMessage: async (jid, text) => { await channel.sendMessage(jid, text); return undefined; },
      });
    } catch (err) {
      logger.warn({ err, group: group.folder }, '自动终态汇报(failed)异常');
    }
    // If we already sent output to the user, don't roll back the cursor —
    // the user got their response and re-processing would send duplicates.
    if (everSentToUser) {
      // error 但已有回复发给用户：推进 cursor（防止重启后重复回复）+ 入队记忆
      advanceAgentCursor(chatJid, newCursor);
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
  const botMsgId =
    lastFeishuMsgId ??
    `bot_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
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
  advanceAgentCursor(chatJid, newCursor);

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
  rotatedFrom?: string; // 轮换前的旧 secret 名称
  allExhausted?: boolean; // 所有账号配额耗尽
  sessionRecoveryRequired?: {
    sessionId?: string;
    error?: string;
    sessionFileExists: boolean;
  };
}

async function runAgent(
  group: RegisteredGroup,
  prompt: string,
  chatJid: string,
  onOutput?: (output: ContainerOutput) => Promise<void>,
  latestUserMessage?: string,
  memorySenderId?: string,
  retryCount = 0,
  modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' },
  onRotation?: (rotation: {
    newSecretName: string;
    oldSecretName?: string;
  }) => void | Promise<void>,
): Promise<RunAgentResult> {
  const cliMode = resolveCliMode(group.containerConfig);
  const canAutoRotateAnthropic = shouldAutoRotateAnthropicAccount(cliMode);
  const maxRetries = canAutoRotateAnthropic ? getSecretCount() - 1 : 0; // 最多试完所有账号
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
        if (output.terminalSessionCorruption) {
          logger.warn(
            {
              group: group.name,
              folder: group.folder,
              sessionId: sessions[group.folder],
              outputSessionId: output.newSessionId || undefined,
              error: output.error,
            },
            'Terminal session corruption detected from agent output — preserving session pointer for user decision',
          );
          await onOutput(output);
          return;
        }
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
        cliMode,
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
      if (output.terminalSessionCorruption) {
        logger.warn(
          {
            group: group.name,
            folder: group.folder,
            sessionId,
            error: output.error,
          },
          'Terminal session corruption detected from final output — preserving session pointer for user decision',
        );
      }

      // 识别 session 恢复失败。这里不自动清指针：长会话上下文丢失的代价更高，
      // 必须先把错误告诉用户，让用户决定是否执行 /new。
      const errorLooksStale =
        sessionId && output.error && isSessionRecoveryError(output.error);

      // 加固：错误信息匹配 stale 模式 ≠ session 真失效。query 崩溃（如 resume 大会话时
      // setModel 抢跑）也会吐出假的 "no conversation found"，此时 .jsonl 其实健在。
      // 删指针前必须确认文件真的不存在，否则会误删健康会话指针、导致历史上下文丢失
      // （2026-06-02 大会话上下文被误删事故根因）。
      const sessionFileExists = (() => {
        if (!errorLooksStale) return false;
        const projectsDir = path.join(
          DATA_DIR,
          'sessions',
          group.folder,
          '.claude',
          'projects',
        );
        if (!fs.existsSync(projectsDir)) return false;
        return fs
          .readdirSync(projectsDir)
          .some((sub) =>
            fs.existsSync(path.join(projectsDir, sub, `${sessionId}.jsonl`)),
          );
      })();

      if (errorLooksStale) {
        logger.warn(
          {
            group: group.name,
            sessionId,
            sessionFileExists,
            error: output.error,
          },
          'Session 恢复失败 — 保留指针并等待用户决定',
        );
        return {
          status: 'error',
          sessionRecoveryRequired: {
            sessionId,
            error: output.error,
            sessionFileExists,
          },
        };
      }

      // API 瞬时错误自动重试（500/502/503/fetch failed）
      // 这些是上游临时故障，不需要轮换账号，等几秒重试即可
      const API_ERROR_MAX_RETRIES = 2;
      const isApiTransientError =
        output.error &&
        /API Error:\s*5\d{2}\b|fetch failed|Internal server error|overloaded|ECONNRESET|ETIMEDOUT/i.test(
          output.error,
        );
      if (isApiTransientError && retryCount < API_ERROR_MAX_RETRIES) {
        const delayMs = (retryCount + 1) * 3000; // 3s, 6s
        logger.warn(
          {
            group: group.name,
            chatJid,
            retryCount,
            maxRetries: API_ERROR_MAX_RETRIES,
            delayMs,
            error: output.error?.slice(0, 200),
          },
          '[api-error] 上游 API 瞬时错误（output.error 路径），延迟后重试',
        );
        await new Promise((r) => setTimeout(r, delayMs));
        return runAgent(
          group,
          prompt,
          chatJid,
          onOutput,
          latestUserMessage,
          memorySenderId,
          retryCount + 1,
          modelOverride,
        );
      }
      if (isApiTransientError && retryCount >= API_ERROR_MAX_RETRIES) {
        logger.error(
          {
            group: group.name,
            chatJid,
            retryCount,
            maxRetries: API_ERROR_MAX_RETRIES,
            error: output.error?.slice(0, 200),
          },
          '[api-error] 上游 API 瞬时错误（output.error 路径）重试上限耗尽，放弃',
        );
      }

      // 429 检测 + 自动轮换（试完所有账号才放弃）
      if (
        !canAutoRotateAnthropic &&
        output.error &&
        detectRateLimit(output.error)
      ) {
        logger.warn(
          { group: group.name, cliMode, error: output.error?.slice(0, 200) },
          '[rate-limit] 当前模式不是 Claude 系，跳过 Anthropic 自动轮换',
        );
      }

      if (
        retryCount < maxRetries &&
        output.error &&
        detectRateLimit(output.error)
      ) {
        const agentId = group.folder.toLowerCase().replace(/_/g, '-');
        logger.warn(
          {
            group: group.name,
            agentId,
            retryCount,
            maxRetries,
            error: output.error?.slice(0, 200),
          },
          '[rate-limit] Agent 退出错误包含限流关键词，尝试轮换',
        );
        const rotateResult = rotateAccount(agentId, group.folder);

        if (rotateResult?.success) {
          logger.info(
            {
              group: group.name,
              newSecret: rotateResult.newSecretName,
              retryCount: retryCount + 1,
            },
            '[rate-limit] 已轮换账号，重试中',
          );
          void onRotation?.(rotateResult);
          return runAgent(
            group,
            prompt,
            chatJid,
            onOutput,
            latestUserMessage,
            memorySenderId,
            retryCount + 1,
            modelOverride,
            onRotation,
          ).then((retryResult) => ({
            ...retryResult,
            rotatedTo: rotateResult.newSecretName,
            rotatedFrom: rotateResult.oldSecretName,
          }));
        }

        // rotateAccount 返回 null（未开启/onecli 错误/单账号）
        logger.warn(
          { group: group.name, agentId, rotateResult },
          '[rate-limit] 轮换未执行，按原错误处理',
        );
      }

      // 已试完所有账号仍然限流（maxRetries > 0 才算"全部耗尽"，否则只是普通错误）
      if (
        retryCount >= maxRetries &&
        maxRetries > 0 &&
        output.error &&
        detectRateLimit(output.error)
      ) {
        logger.warn(
          { group: group.name, retryCount, maxRetries },
          '[rate-limit] 所有账号均被限流',
        );
        return { status: 'error', allExhausted: true };
      }

      logger.error(
        { group: group.name, error: output.error },
        'Container agent error',
      );
      return { status: 'error' };
    }

    // Claude Code 有时以 status=success 返回限流消息（"You've hit your limit"）
    // 检查 result 文本以捕获这种假成功
    if (
      !canAutoRotateAnthropic &&
      output.result &&
      detectRateLimitResult(output.result)
    ) {
      logger.warn(
        { group: group.name, cliMode, result: output.result?.slice(0, 200) },
        '[rate-limit] 当前模式不是 Claude 系，跳过 Anthropic 自动轮换',
      );
      return { status: 'error' };
    }

    if (
      retryCount < maxRetries &&
      output.result &&
      detectRateLimitResult(output.result)
    ) {
      const agentId = group.folder.toLowerCase().replace(/_/g, '-');
      logger.warn(
        {
          group: group.name,
          agentId,
          retryCount,
          maxRetries,
          result: output.result?.slice(0, 200),
        },
        '[rate-limit] 假成功（result 包含限流关键词），尝试轮换',
      );
      const rotateResult = rotateAccount(agentId, group.folder);

      if (rotateResult?.success) {
        logger.info(
          {
            group: group.name,
            newSecret: rotateResult.newSecretName,
            retryCount: retryCount + 1,
          },
          '[rate-limit] 假成功已轮换账号，重试中',
        );
        void onRotation?.(rotateResult);
        return runAgent(
          group,
          prompt,
          chatJid,
          onOutput,
          latestUserMessage,
          memorySenderId,
          retryCount + 1,
          modelOverride,
          onRotation,
        ).then((retryResult) => ({
          ...retryResult,
          rotatedTo: rotateResult.newSecretName,
          rotatedFrom: rotateResult.oldSecretName,
        }));
      }

      // rotateAccount 返回 null
      logger.warn(
        { group: group.name, agentId },
        '假成功限流但轮换未执行，将限流消息当错误返回',
      );
      return { status: 'error' };
    }

    // 试完所有账号仍然假成功限流
    if (
      retryCount >= maxRetries &&
      maxRetries > 0 &&
      output.result &&
      detectRateLimitResult(output.result)
    ) {
      logger.warn(
        { group: group.name, retryCount },
        '[rate-limit] 假成功：所有账号均被限流',
      );
      return { status: 'error', allExhausted: true };
    }

    return { status: 'success' };
  } catch (err) {
    logger.error(
      {
        err,
        errMessage: (err as Error)?.message,
        errName: (err as Error)?.name,
        errStack: (err as Error)?.stack,
        group: group.name,
        chatJid,
        retryCount,
        sessionId,
      },
      '[runAgent] runContainerAgent 抛错',
    );
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

  // 语音回传订阅 — iOS app 语音回复经网关回流，注入对应群会话
  try {
    const { startVoiceReplySubscriber } = await import('./voice-reply.js');
    startVoiceReplySubscriber({
      isRegisteredGroup: (jid) => Boolean(registeredGroups[jid]),
      injectMessage: (jid, text) => {
        storeMessage({
          id: `voice-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          chat_jid: jid,
          sender: 'voice',
          sender_name: '大杰（语音）',
          content: text,
          timestamp: new Date().toISOString(),
          is_from_me: true,
          is_bot_message: false,
        });
        queue.enqueueMessageCheck(jid);
      },
      echoToFeishu: async (jid, text) => {
        const channel = findChannel(channels, jid);
        // skipVoiceNotify：回显的是用户刚说的话，不要再总结播回手机
        if (channel)
          await channel.sendMessage(jid, text, { skipVoiceNotify: true });
      },
    });
  } catch (err) {
    logger.warn({ err }, '[voice-reply] 订阅启动失败，不影响主流程');
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
                m.id.startsWith('ipc_') || // 跨群 IPC 消息直接绕过 trigger 检查
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
          let messagesToSend: NewMessage[];
          if (allPending.length > 0) {
            messagesToSend = allPending;
          } else {
            // 防 double-feed：只过滤已注入的 ipc_ report，保留用户消息
            const cursor = lastAgentTimestamp[chatJid] || '';
            const undelivered = groupMessages.filter(
              (m) => !(m.id.startsWith('ipc_') && m.timestamp <= cursor),
            );
            if (undelivered.length === 0) continue; // 全是已注入的 report，skip
            messagesToSend = undelivered;
          }
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
              pipeLastMsg?.sender,
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
            advanceAgentCursor(
              chatJid,
              messagesToSend[messagesToSend.length - 1].timestamp,
            );
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
    const cursor = getOrRecoverCursor(chatJid);
    const pending = getMessagesSince(
      chatJid,
      cursor,
      ASSISTANT_NAME,
      MAX_MESSAGES_PER_PROMPT,
    );
    if (pending.length > 0) {
      // 防重启循环：如果 bot 在最后一条 pending 消息之后已有回复，
      // 说明 agent 处理过了但光标没来得及推进（比如执行重启被杀），
      // 直接推进光标，不再重复处理。
      const lastPendingTs = pending[pending.length - 1].timestamp;
      const lastBotTs = getLastBotMessageTimestamp(chatJid, ASSISTANT_NAME);
      if (lastBotTs && lastBotTs > lastPendingTs) {
        logger.info(
          { group: group.name, pendingCount: pending.length, lastBotTs },
          'Recovery: bot already replied after pending messages, advancing cursor (skip re-processing)',
        );
        advanceAgentCursor(chatJid, lastBotTs);
        continue;
      }

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
          advanceCursor: (jid, ts) => advanceAgentCursor(jid, ts),
        });
        if (handled) return;
      }

      // 未知 / 命令 — 拦截并返回错误提示，不进 LLM
      if (trimmed.startsWith('/') && !trimmed.startsWith('/ ')) {
        const ch = findChannel(channels, chatJid);
        const unknownCmd = trimmed.split(/\s/)[0];
        const help = getHelp(
          `❓ 未知命令 "${unknownCmd}"，`,
          resolveCliMode(group?.containerConfig),
        );
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
        // 同步更新内存 + DB 中的群名（语音播报上下文、日志等都依赖 group.name）
        if (registeredGroups[jid]) {
          registeredGroups[jid].name = name;
          try {
            setRegisteredGroup(jid, registeredGroups[jid]);
          } catch (err) {
            logger.warn({ err, jid, name }, '[rename] 更新 DB 群名失败');
          }
        }
      } else {
        logger.warn(
          { jid, hasChannel: !!channel },
          '[rename] channel 不支持 renameChat',
        );
      }
    },
    injectReportToActiveAgent,
    notifyReportRejected: (reportingGroupFolder, reason) => {
      // 反查 reporting group 的 JID
      let reportingJid: string | undefined;
      for (const [jid, g] of Object.entries(registeredGroups)) {
        if (g.folder === reportingGroupFolder) {
          reportingJid = jid;
          break;
        }
      }
      if (!reportingJid) {
        logger.warn(
          { reportingGroupFolder, reason },
          'notifyReportRejected: 无法反查 JID，跳过反馈',
        );
        return;
      }
      const sent = queue.sendMessage(
        reportingJid,
        reason,
        undefined,
        undefined,
        'system',
      );
      if (!sent) {
        logger.debug(
          { reportingJid, reportingGroupFolder },
          'notifyReportRejected: agent 不活跃，静默忽略',
        );
      }
    },
    onFeishuAuthRequest: async (chatJid, groupFolder) => {
      const feishuChannel = channels.find((c) => c.name === 'feishu') as
        | FeishuChannel
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
    return withLogContext({ chatJid, groupFolder: group?.folder }, () =>
      processGroupMessages(chatJid),
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
