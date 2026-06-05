import { execSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import * as lark from '@larksuiteoapi/node-sdk';

import { ASSISTANT_NAME } from '../config.js';
import { resolveCliMode } from '../cli-mode.js';
import type { ContainerOutput } from '../container-runner.js';
import { getMessageById } from '../db.js';
import { readEnvFile } from '../env.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { logger } from '../logger.js';
import {
  startProgressServer,
  getProgressUrl,
  upsertSession,
  completeSession,
  deleteSession,
} from '../progress-server.js';
import { Channel, NewMessage, SendMessageOptions } from '../types.js';
import type { CliMode } from '../types.js';
import { notifyVoice } from '../voice-notify.js';

import { registerChannel, ChannelOpts } from './registry.js';

// ---- 配置 ----

const JID_PREFIX = 'fs:';
const TYPING_EMOJI_BY_MODE: Record<CliMode, string> = {
  sdk: 'OnIt', // 在做了
  print: 'PROUD', // 得意
  interactive: 'HAUGHTY', // 白眼
  codex: 'OneSecond', // 稍等
  gemini: 'INNOCENTSMILE', // 无辜笑
};
const CARD_THRESHOLD = 500;
const MD_PATTERN = /```|\*\*|^##?\s|^\|.*\||\*[^*\s]|^[-*+]\s|^>\s/m;
const PROGRESS_JSON_PATTERN = /^\{"title":"[🔧📖✏️🔍🌐📋⚙️⏳💭💬✅]/u;
const THINKING_PHRASES = ['思考中', '分析中', '处理中', '推理中'];

// ---- 多媒体安全限制 ----
const MAX_MERGE_TEXT_LEN = 8000;
const MAX_MERGE_IMAGES = 5;
const MAX_MERGE_DEPTH = 1;
const MAX_IMAGE_SIZE = 20 * 1024 * 1024; // 20MB

// 发送图片路径检测模式：[图片: path]、[image: path]、![alt](path)
// 支持 /workspace/group/ 容器路径和宿主机绝对路径
const IMAGE_SEND_PATTERN =
  /(?:\[(?:图片|image):\s*(\/[^\]\s]+)\]|!\[.*?\]\((\/[^\s)]+)\))/gi;

// 发送文件路径检测模式：[文件: path]、[file: path]
const FILE_SEND_PATTERN = /\[(?:文件|file):\s*(\/[^\]\s]+)\]/gi;

// 飞书图片 API 支持的格式（234011: Can't recognize image format 之外的都走文件通道）
const FEISHU_IMAGE_EXTS = new Set([
  '.jpg',
  '.jpeg',
  '.png',
  '.gif',
  '.bmp',
  '.webp',
  '.tiff',
  '.tif',
  '.ico',
  '.heic',
]);

/** 根据扩展名推断飞书文件类型 */
function feishuFileType(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') return 'pdf';
  if (['.mp4', '.mov', '.avi'].includes(ext)) return 'mp4';
  if (['.opus', '.ogg'].includes(ext)) return 'opus';
  return 'stream'; // 通用二进制，支持 txt/md/zip 等所有文件
}

// ---- 工具函数 ----

/** 从 JID 提取飞书 chat_id */
function chatIdFromJid(jid: string): string {
  return jid.slice(JID_PREFIX.length);
}

/** 判断文本是否应该用卡片发送 */
function shouldUseCard(text: string): boolean {
  return text.length > CARD_THRESHOLD || MD_PATTERN.test(text);
}

/** 按 ## 标题拆分 markdown（卡片 400 时用于拆分成多个 markdown 元素重试） */
function splitMarkdownByHeadings(text: string): string[] {
  const parts = text.split(/(?=^##\s)/m);
  // 过滤空段落，保留原文如果拆不开
  const chunks = parts.map((p) => p.trim()).filter(Boolean);
  return chunks.length > 0 ? chunks : [text];
}

/** 构建飞书交互卡片 JSON */
function buildCard(
  text: string,
  headerText?: string,
  headerColor?: string,
): string {
  const card: Record<string, unknown> = {
    config: { wide_screen_mode: true },
    elements: [{ tag: 'markdown', content: text, text_size: 'normal' }],
  };
  // 只有明确传了标题才显示 header（进度卡片等），正式回复不带标题栏
  if (headerText) {
    card.header = {
      template: headerColor || 'blue',
      title: { tag: 'plain_text', content: headerText },
    };
  }
  return JSON.stringify(card);
}

interface ProgressStep {
  title: string;
  detail?: string;
  /** 该步骤进入主进程的时间戳（毫秒，用于进度页每步时间显示） */
  ts?: number;
}

/** 截断 step 标题：取第一行，最多 80 字符 */
function truncateTitle(title: string): string {
  const firstLine = title.split('\n')[0];
  return firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine;
}

/** 对 diff 内容着色：+ 行绿色，- 行红色 */
function colorizeDiff(text: string): string {
  return text
    .replace(/^(\+\s?.*)$/gm, '<font color="green">$1</font>')
    .replace(/^(-\s?.*)$/gm, '<font color="red">$1</font>');
}

/** 将 step 转为卡片 element */
function stepToElement(step: ProgressStep): unknown {
  const title = truncateTitle(step.title);
  if (step.detail) {
    return {
      tag: 'collapsible_panel',
      expanded: false,
      background_color: 'grey',
      header: {
        title: { tag: 'plain_text', content: title },
        vertical_align: 'center',
      },
      vertical_spacing: '2px',
      padding: '4px 8px 4px 8px',
      elements: [{ tag: 'markdown', content: colorizeDiff(step.detail) }],
    };
  }
  return { tag: 'markdown', content: title };
}

/** 格式化耗时字符串 */
function formatElapsed(startTime: number): string {
  const ms = Date.now() - startTime;
  if (ms >= 60_000) {
    const min = Math.floor(ms / 60_000);
    const sec = Math.floor((ms % 60_000) / 1000);
    return `(${min}m${sec}s)`;
  }
  return `(${Math.floor(ms / 1000)}s)`;
}

/**
 * 标题行组件：左侧标题文字 + 右侧可选链接，同行布局。
 * 后跟一条 hr 分割线，与内容区隔开。
 * 复用于进度卡片和完成卡片。
 */
function buildTitleRow(leftText: string, rightUrl?: string): unknown[] {
  if (!rightUrl) {
    return [{ tag: 'markdown', content: leftText }, { tag: 'hr' }];
  }
  return [
    {
      tag: 'column_set',
      flex_mode: 'none',
      background_style: 'default',
      columns: [
        {
          tag: 'column',
          width: 'weighted',
          weight: 1,
          elements: [{ tag: 'markdown', content: leftText }],
        },
        {
          tag: 'column',
          width: 'auto',
          elements: [
            {
              tag: 'markdown',
              content: `[过程记录](${rightUrl})`,
              text_size: 'notation',
              text_align: 'right',
            },
          ],
        },
      ],
    },
    { tag: 'hr' },
  ];
}

/** 构建进度卡片（schema 2.0，无原生 header） */
function buildProgressCard(
  steps: ProgressStep[],
  frame: number = 0,
  startTime?: number,
  sessionId?: string,
): string {
  // 短语轮换：按时间（每 5 秒切换一次），不按 frame，避免 tool_call 密集时切换过快
  const elapsedSec = startTime
    ? Math.floor((Date.now() - startTime) / 5000)
    : frame;
  const phrase = THINKING_PHRASES[elapsedSec % THINKING_PHRASES.length];
  const timeStr = startTime ? ` ${formatElapsed(startTime)}` : '';
  const titleText = `**✨ ${phrase}...${timeStr}**`;
  const progressUrl = sessionId ? getProgressUrl(sessionId) : undefined;

  // 没有步骤时显示占位文字，避免卡片内容区域为空
  const stepElements =
    steps.length > 0
      ? steps.map(stepToElement)
      : [
          {
            tag: 'markdown',
            content: '<font color="grey">正在等待响应...</font>',
          },
        ];

  const elements: unknown[] = [
    ...buildTitleRow(titleText, progressUrl),
    ...stepElements,
  ];

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { elements },
  });
}

/** 各模型 context window 的兜底值（当 SDK 未返回时使用） */
const CLAUDE_CONTEXT_WINDOW_FALLBACK: Record<string, number> = {
  'claude-opus-4': 1_000_000, // opus-4-8 为 1M context（CLI 二进制确认）
  'claude-sonnet-4': 200_000,
  'claude-haiku-4': 200_000,
  'claude-3-5-sonnet': 200_000,
  'claude-3-5-haiku': 200_000,
  'claude-3-opus': 200_000,
};
const DEFAULT_CONTEXT_WINDOW = 200_000;

/** 向卡片 elements 追加 usage 脚注（hr + 灰色统计行） */
function appendUsageFooter(
  elements: unknown[],
  usage: NonNullable<ContainerOutput['usage']>,
  thinking?: 'adaptive' | 'disabled',
): void {
  const inp = usage.inputTokens.toLocaleString();
  const cacheRead = usage.cacheReadInputTokens.toLocaleString();
  const cacheCreate = usage.cacheCreationInputTokens.toLocaleString();
  const out = usage.outputTokens.toLocaleString();
  const turns = usage.numTurns;
  const dur = (usage.durationMs / 1000).toFixed(1);
  const cost = usage.totalCostUsd.toFixed(2);

  // 获取实际 context window 大小：SDK 值与兜底表取最大值（SDK 有时返回偏小的值）
  let maxContextTokens = DEFAULT_CONTEXT_WINDOW;
  const modelNames = Object.keys(usage.modelContextWindows ?? {});

  // SDK 返回值
  if (usage.modelContextWindows) {
    const windows = Object.values(usage.modelContextWindows);
    if (windows.length > 0) {
      maxContextTokens = Math.max(...windows);
    }
    logger.info(
      {
        modelContextWindows: usage.modelContextWindows,
        sdkMax: maxContextTokens,
      },
      'SDK modelContextWindows',
    );
  }

  // 兜底表：对每个模型名查表，取更大值（修正 SDK 返回偏小的情况）
  // 来源 1: modelContextWindows 的 key（SDK 模式）
  for (const [fallbackModel, fallbackWindow] of Object.entries(
    CLAUDE_CONTEXT_WINDOW_FALLBACK,
  )) {
    if (modelNames.some((k) => k.includes(fallbackModel))) {
      maxContextTokens = Math.max(maxContextTokens, fallbackWindow);
    }
  }
  // 来源 2: usage.model（CLI 模式下 modelContextWindows 为空，但 model 字段有值）
  if (usage.model) {
    for (const [fallbackModel, fallbackWindow] of Object.entries(
      CLAUDE_CONTEXT_WINDOW_FALLBACK,
    )) {
      if (usage.model.includes(fallbackModel)) {
        maxContextTokens = Math.max(maxContextTokens, fallbackWindow);
      }
    }
  }

  // 计算 context window 占用率
  // 优先使用最后一轮 API 调用的实际 context 大小，fallback 到累计值
  const totalContextTokens =
    usage.lastTurnContext ??
    usage.inputTokens +
      usage.cacheReadInputTokens +
      usage.cacheCreationInputTokens;
  const ctxPct = Math.min(
    100,
    Math.max(0, Math.round((totalContextTokens / maxContextTokens) * 100)),
  );
  const ctxBar = ctxPct >= 80 ? '🔴' : ctxPct >= 50 ? '🟡' : '🟢';
  const maxK =
    maxContextTokens >= 1_000_000
      ? `${maxContextTokens / 1_000_000}M`
      : `${maxContextTokens / 1_000}k`;

  elements.push({ tag: 'hr' });
  const thinkIcon = thinking === 'adaptive' ? '+' : '~';
  elements.push({
    tag: 'markdown',
    content: `<font color="grey">↑${inp}/${cacheRead}/${cacheCreate} ↓${out} 🔄${turns} ⏱${dur}s 💰≈$${cost} ${ctxBar}ctx${ctxPct}%/${maxK} 🤖${usage.model ? usage.model.replace(/^claude-/, '') : 'unknown'} ${thinkIcon}</font>`,
  });
}

/** 构建完成卡片（schema 2.0，无原生 header） */
function buildCompletedCard(
  steps: ProgressStep[],
  usage?: ContainerOutput['usage'],
  startTime?: number,
  sessionId?: string,
  thinking?: 'adaptive' | 'disabled',
): string {
  const timeStr = startTime ? ` ${formatElapsed(startTime)}` : '';
  const titleText = `**✓ 已完成${timeStr}**`;
  const progressUrl = sessionId ? getProgressUrl(sessionId) : undefined;

  const elements: unknown[] = [
    ...buildTitleRow(titleText, progressUrl),
    ...steps.map(stepToElement),
  ];
  if (usage) appendUsageFooter(elements, usage, thinking);

  return JSON.stringify({
    schema: '2.0',
    config: { update_multi: true },
    body: { elements },
  });
}

// ---- 飞书 Channel 实现 ----

export class FeishuChannel implements Channel {
  readonly name = 'feishu';

  private client: lark.Client;
  private ws: lark.WSClient | null = null;
  private connected = false;
  private opts: ChannelOpts;
  private appId: string;
  private appSecret: string;

  // 机器人自身的 open_id，用于识别 @机器人 mention
  private botOpenId: string | null = null;

  // 记录 jid → { messageId, reactionId }，用于移除 typing indicator
  private typingReactions = new Map<
    string,
    { messageId: string; reactionId: string }
  >();

  // 进度卡片状态：每个 chat 一张进度卡片，持续更新
  private progressCards = new Map<
    string,
    {
      messageId: string;
      sessionId: string;
      steps: ProgressStep[];
      allSteps: ProgressStep[]; // 完整历史（给网页用，不 shift）
      frame: number;
      startTime: number;
    }
  >();

  // 正式回复已到达标记：防止迟到的进度消息再创建卡片
  private progressDone = new Set<string>();

  // 当前会话的 thinking 模式和 usage（per-jid，setUsage 时写入，sendMessage 时读取并清理）
  // 独立于 progressCards，确保快速回复（无进度卡片）也能拿到
  private thinkingMode = new Map<string, 'adaptive' | 'disabled'>();
  private pendingUsage = new Map<string, ContainerOutput['usage']>();

  // open_id → 用户姓名缓存，避免重复调飞书 API
  private userNameCache = new Map<string, string>();

  // Spinner 自动刷新定时器（每个 chat 一个）
  private spinnerTimers = new Map<string, NodeJS.Timeout>();
  // 停止标记：clearSpinnerTimer 设置后，正在运行的 callback 检测到后不再调度下一轮
  private spinnerStopped = new Set<string>();
  // 存储 scheduleSpinner 闭包，供 resetSpinnerTimer 重新启动定时器
  private spinnerSchedulers = new Map<string, () => void>();

  constructor(appId: string, appSecret: string, opts: ChannelOpts) {
    this.appId = appId;
    this.appSecret = appSecret;
    this.opts = opts;
    this.client = new lark.Client({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
    });
  }

  // ---- Channel 接口 ----

  async connect(): Promise<void> {
    // 启动进度查看 HTTP 服务（幂等，多次调用无副作用）
    startProgressServer();

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': (data: any) => {
        this.handleMessage(data).catch((err: any) => {
          logger.error({ err }, '飞书消息处理失败');
        });
      },
    });

    this.ws = new lark.WSClient({
      appId: this.appId,
      appSecret: this.appSecret,
      eventDispatcher: dispatcher,
      domain: lark.Domain.Feishu,
      loggerLevel: lark.LoggerLevel.info,
    } as ConstructorParameters<typeof lark.WSClient>[0]);

    await (
      this.ws as unknown as {
        start(p: { eventDispatcher: lark.EventDispatcher }): Promise<void>;
      }
    ).start({ eventDispatcher: dispatcher });
    this.connected = true;

    // 获取机器人自身 open_id，用于将 @机器人 替换为 @ASSISTANT_NAME 以匹配触发词
    try {
      const tokenResp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        },
      );
      const tokenData = (await tokenResp.json()) as {
        tenant_access_token?: string;
      };
      if (tokenData.tenant_access_token) {
        const botResp = await fetch(
          'https://open.feishu.cn/open-apis/bot/v3/info',
          {
            headers: {
              Authorization: `Bearer ${tokenData.tenant_access_token}`,
            },
          },
        );
        const botData = (await botResp.json()) as {
          bot?: { open_id?: string };
        };
        this.botOpenId = botData?.bot?.open_id ?? null;
      }
    } catch {
      /* 非致命 */
    }

    logger.info({ botOpenId: this.botOpenId }, '飞书 WebSocket 已连接');
  }

  async disconnect(): Promise<void> {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
    logger.info('飞书 WebSocket 已断开');
  }

  isConnected(): boolean {
    return this.connected;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith(JID_PREFIX);
  }

  /** 发送消息，正式回复返回飞书 message_id（进度/命令回复返回 undefined） */
  async sendMessage(
    jid: string,
    text: string,
    options?: SendMessageOptions,
  ): Promise<string | undefined> {
    const chatId = chatIdFromJid(jid);

    // 命令回复：直接发消息，跳过进度卡片逻辑，避免打断正在运行的 agent
    if (options?.isCommandReply) {
      await this.sendPlainOrCard(chatId, text);
      return;
    }

    // 进度消息 → 聚合到进度卡片（由调用方通过 isProgress 显式标记）
    if (options?.isProgress) {
      const isProgressJson = PROGRESS_JSON_PATTERN.test(text);
      let title = text;
      let detail: string | undefined;
      if (isProgressJson) {
        try {
          const parsed = JSON.parse(text) as {
            title?: string;
            detail?: string;
          };
          if (parsed.title) {
            title = parsed.title;
            detail = parsed.detail;
          }
        } catch {
          /* 降级为纯文本 */
        }
      }

      // 正式回复已到达，忽略迟到的进度消息（包括 💭）
      if (this.progressDone.has(jid)) {
        logger.info(
          { jid, title },
          '[progress] 正式回复已到达，忽略迟到的进度消息',
        );
        return;
      }

      // 💭 消息：模型内部独白（历史兼容），直接丢弃不暴露给用户
      if (title.startsWith('💭')) {
        logger.info(
          { jid, len: title.length },
          '[progress] 💭 thinking 消息，丢弃',
        );
        return;
      }

      // 💬 消息：LLM 中间文字输出
      //   Codex/quietProgress=true → 塞进进度卡片（折叠面板），减少刷屏
      //   其他模式 quietProgress=false/undefined → 保持独立发送（默认行为）
      if (title.startsWith('💬')) {
        const fullText = (detail ?? title).replace(/^💬\s*/u, '').trim();
        if (!fullText) return;

        const group = this.opts.registeredGroups()[jid];
        const cliMode = resolveCliMode(group?.containerConfig);
        const quiet =
          group?.containerConfig?.quietProgress === true || cliMode === 'codex';

        if (quiet) {
          // 安静模式：包装成卡片步骤，继续走 progressCards 路径
          const firstLine = fullText.split('\n')[0];
          title = `💬 ${firstLine.length > 80 ? firstLine.slice(0, 80) + '…' : firstLine}`;
          detail =
            fullText.length > firstLine.length || firstLine.length > 80
              ? fullText
              : undefined;
          // 不 return，下面走 progressCards 创建/更新
        } else {
          // 默认模式：独立发消息
          logger.info(
            { jid, len: fullText.length, preview: fullText.slice(0, 80) },
            '[progress] 中间叙述消息，独立发送（不进进度卡片）',
          );
          const chatId = chatIdFromJid(jid);
          this.sendPlainOrCard(chatId, fullText).catch((err) =>
            logger.debug({ err, jid }, '中间叙述消息发送失败'),
          );
          return;
        }
      }

      // 首次工具进度到达：移除 emoji + 创建卡片
      if (!this.progressCards.has(jid)) {
        logger.info(
          { jid, title },
          '[progress] 首次工具进度到达，开始创建卡片（移除 emoji + 创建卡片并行）',
        );
        // 占位防并发（createProgressCard 有 await，期间可能有后续进度进入）
        this.progressCards.set(jid, {
          messageId: '',
          sessionId: '',
          steps: [],
          allSteps: [],
          frame: 0,
          startTime: Date.now(),
        } as any);
        const chatId = chatIdFromJid(jid);
        await Promise.all([
          this.removeTypingReaction(jid),
          this.createProgressCard(jid, chatId, { title, detail, ts: Date.now() }),
        ]);
        return;
      }

      const existing = this.progressCards.get(jid);
      if (existing) {
        const stepTs = Date.now();
        existing.steps.push({ title, detail, ts: stepTs });
        existing.allSteps.push({ title, detail, ts: stepTs });
        if (existing.steps.length > 3) existing.steps.shift();
        if (existing.allSteps.length > 500) existing.allSteps.shift();
        // 卡片尚在创建中（messageId 为空），先缓冲步骤，createProgressCard 完成后会统一 patch
        if (!existing.messageId) {
          logger.info(
            { jid, title, buffered: existing.steps.length },
            '[progress] 卡片创建中，缓冲步骤',
          );
          return;
        }
        // 同步到进度查看页面
        upsertSession(
          existing.sessionId,
          existing.allSteps,
          existing.startTime,
        );
        // 新步骤到来：立即 patch 卡片
        existing.frame++;
        this.client.im.message
          .patch({
            path: { message_id: existing.messageId },
            data: {
              content: buildProgressCard(
                existing.steps,
                existing.frame,
                existing.startTime,
                existing.sessionId,
              ),
            },
          })
          .catch((err: any) =>
            logger.debug({ err, jid }, '进度步骤实时 patch 失败（非致命）'),
          );
        // 重置 spinner 定时器
        this.resetSpinnerTimer(jid);
      }
      return;
    }

    // 正式回复到达：读取 usage/thinking，然后清理进度卡片
    const usage = this.pendingUsage.get(jid);
    const thinking = this.thinkingMode.get(jid);
    logger.info(
      { jid, thinking, hasUsage: !!usage },
      '[reply] 读取 usage/thinkingMode',
    );
    // cleanupProgressCard 会清理 pendingUsage/thinkingMode/progressCards
    await this.cleanupProgressCard(jid);
    logger.info({ jid, chatId }, '[reply] cleanupProgressCard 完成');

    // 统一媒体提取与发送（图片/文件标记提取、文本发送、媒体上传，互不阻塞）
    const groupFolder = this.getGroupFolder(jid);

    // 语音通知（只对主会话）：剥离媒体标记后送 LLM 摘要 → Pushover → iOS 朗读
    // fire-and-forget，不 await，不影响飞书主流程
    const textForSpeech = text
      .replace(new RegExp(IMAGE_SEND_PATTERN.source, 'gi'), '')
      .replace(new RegExp(FILE_SEND_PATTERN.source, 'gi'), '')
      .replace(/\s{2,}/g, ' ')
      .trim();
    notifyVoice(groupFolder, textForSpeech);

    return this.extractAndSendMedia(chatId, text, groupFolder, usage, thinking);
  }

  /** 统一路径解析：容器路径 /workspace/group/xxx → 宿主机路径，绝对路径直接用 */
  private resolveMediaPath(inputPath: string, groupFolder: string): string {
    if (inputPath.startsWith('/workspace/group/')) {
      const relativePath = inputPath.replace(/^\/workspace\/group\//, '');
      return path.join(resolveGroupFolderPath(groupFolder), relativePath);
    }
    // 正则只匹配以 / 开头的路径，此处必为绝对路径
    return inputPath;
  }

  /** 统一媒体标记提取与发送，返回文本消息的飞书 message_id */
  private async extractAndSendMedia(
    chatId: string,
    text: string,
    groupFolder: string | null,
    usage?: ContainerOutput['usage'],
    thinking?: 'adaptive' | 'disabled',
  ): Promise<string | undefined> {
    // 用 matchAll + new RegExp 副本避免全局正则 lastIndex 状态污染
    const imageMatches = [
      ...text.matchAll(new RegExp(IMAGE_SEND_PATTERN.source, 'gi')),
    ].map((m) => m[1] || m[2]);
    const fileMatches = [
      ...text.matchAll(new RegExp(FILE_SEND_PATTERN.source, 'gi')),
    ].map((m) => m[1]);

    const hasMedia = imageMatches.length > 0 || fileMatches.length > 0;
    logger.info({ chatId, textLen: text.length, hasMedia, images: imageMatches.length, files: fileMatches.length }, '[reply] extractAndSendMedia 入口');

    // 无标记 → 直接发文本
    if (!hasMedia) {
      return this.sendPlainOrCard(chatId, text, usage, thinking);
    }

    // groupFolder 为 null → 无法上传媒体，原文本直接发
    if (!groupFolder) {
      logger.warn('群未注册 groupFolder，跳过媒体提取，原文本直接发送');
      return this.sendPlainOrCard(chatId, text, usage, thinking);
    }

    // strip 标记，合并连续空白，发送剩余文本
    const remainingText = text
      .replace(new RegExp(IMAGE_SEND_PATTERN.source, 'gi'), '')
      .replace(new RegExp(FILE_SEND_PATTERN.source, 'gi'), '')
      .replace(/\s{2,}/g, ' ')
      .trim();

    let textSent = !remainingText; // 无文本需要发则视为成功
    let textMsgId: string | undefined;
    if (remainingText) {
      try {
        textMsgId = await this.sendPlainOrCard(chatId, remainingText, usage, thinking);
        textSent = true;
      } catch (err) {
        logger.warn({ err }, '飞书文本卡片发送失败，媒体发送继续');
      }
    }

    const errors: Error[] = [];

    // 逐个发送图片标记：支持的格式走图片 API，不支持的走文件 API，图片 API 失败 fallback 文件 API
    for (const imgPath of imageMatches) {
      const ext = path.extname(imgPath).toLowerCase();
      const useImageApi = FEISHU_IMAGE_EXTS.has(ext);
      try {
        if (useImageApi) {
          try {
            await this.sendImageMsg(chatId, imgPath, groupFolder);
          } catch (imgErr) {
            logger.warn(
              { err: imgErr, path: imgPath },
              '图片 API 失败，fallback 文件通道',
            );
            await this.sendFileMsg(chatId, imgPath, groupFolder);
          }
        } else {
          await this.sendFileMsg(chatId, imgPath, groupFolder);
        }
      } catch (err) {
        errors.push(err as Error);
        logger.error(
          { err, path: imgPath },
          '飞书媒体发送失败（图片+文件通道均失败）',
        );
      }
    }

    // 逐个发送文件标记
    for (const filePath of fileMatches) {
      try {
        await this.sendFileMsg(chatId, filePath, groupFolder);
      } catch (err) {
        errors.push(err as Error);
        logger.error({ err, path: filePath }, '飞书文件发送失败');
      }
    }

    // 文本和全部媒体都失败时，向调用方抛出错误
    if (
      !textSent &&
      errors.length === imageMatches.length + fileMatches.length
    ) {
      throw new Error(
        `飞书消息发送全部失败 (${errors.length} 个媒体): ${errors[0]?.message}`,
      );
    }
    return textMsgId;
  }

  /** 发送仅含 usage footer 的小卡片（CLI interactive 模式：文本已通过中间消息发出，success 无文本载体） */
  async sendUsageOnly(jid: string): Promise<void> {
    const usage = this.pendingUsage.get(jid);
    if (!usage) return;
    const thinking = this.thinkingMode.get(jid);
    const chatId = chatIdFromJid(jid);
    const elements: unknown[] = [];
    appendUsageFooter(elements, usage, thinking);
    if (elements.length === 0) return;
    try {
      await this.client.im.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'interactive',
          content: JSON.stringify({ schema: '2.0', body: { elements } }),
        },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info({ jid, chatId }, '[sendUsageOnly] usage-only 卡片发送成功');
    } catch (err) {
      logger.warn({ jid, err }, '[sendUsageOnly] usage-only 卡片发送失败');
    }
    this.pendingUsage.delete(jid);
    this.thinkingMode.delete(jid);
  }

  /** IPC send_message 专用：直接发消息，不触发进度卡片清理逻辑 */
  async sendDirectMessage(jid: string, text: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    const groupFolder = this.getGroupFolder(jid);
    // 读取 pendingUsage/thinkingMode 给最终回复附加 usage footer
    // （send_message MCP 走此路径，不经过 sendMessage 的 [reply] 清理链路）
    const usage = this.pendingUsage.get(jid);
    const thinking = this.thinkingMode.get(jid);
    if (usage) {
      logger.info({ jid, hasUsage: true, thinking }, '[sendDirect] 读取 pendingUsage');
    }
    await this.extractAndSendMedia(chatId, text, groupFolder, usage, thinking);
    // 消费后清理，避免下条消息重复附加
    if (usage) {
      this.pendingUsage.delete(jid);
      this.thinkingMode.delete(jid);
    }
  }

  /** 修改飞书群名称，同时生成缩略字头像（仅群聊生效） */
  async renameChat(jid: string, name: string): Promise<void> {
    const chatId = jid.replace(JID_PREFIX, '');
    logger.info({ jid, chatId, name }, '[rename] 开始修改群名');

    try {
      const resp = await this.client.im.chat.update({
        path: { chat_id: chatId },
        data: { name },
      });
      logger.info(
        { jid, name, code: resp?.code },
        '[rename] 群名已更新',
      );
    } catch (err: any) {
      logger.warn({ err, jid, name }, '[rename] 修改群名失败');
    }
  }

  /** 清理进度卡片（撤回或转完成卡片）+ 清理 pendingUsage/thinkingMode。
   *  用于 agent 结束但无正式回复的场景（如 send_message 已发内容，result 为空）。
   *  注意：usage footer 只在正式回复上显示，完成卡片不带 usage。 */
  async cleanupProgressCard(jid: string): Promise<void> {
    // 清理 pendingUsage/thinkingMode（usage 留给正式回复的 sendPlainOrCard 使用）
    // 注意：正式回复路径在调用此方法前已读取了 pendingUsage
    this.pendingUsage.delete(jid);
    this.thinkingMode.delete(jid);

    const progressEntry = this.progressCards.get(jid);
    if (!progressEntry) return;

    logger.info(
      {
        jid,
        hasMessageId: !!progressEntry.messageId,
        steps: progressEntry.steps.length,
      },
      '[cleanup] 清理孤儿进度卡片',
    );
    this.progressDone.add(jid);
    this.clearSpinnerTimer(jid);
    this.progressCards.delete(jid);

    if (!progressEntry.messageId) {
      deleteSession(progressEntry.sessionId);
      return;
    }

    try {
      const hasToolSteps = progressEntry.steps.some(
        (s) => !s.title.startsWith('💭'),
      );
      if (!hasToolSteps) {
        deleteSession(progressEntry.sessionId);
        await this.client.im.message.delete({
          path: { message_id: progressEntry.messageId },
        });
      } else {
        completeSession(progressEntry.sessionId);
        try {
          await this.client.im.message.patch({
            path: { message_id: progressEntry.messageId },
            data: {
              content: buildCompletedCard(
                progressEntry.steps,
                undefined,
                progressEntry.startTime,
                progressEntry.sessionId,
                undefined,
              ),
            },
          });
        } catch (patchErr) {
          // patch 失败（常见 200800）→ 删除卡住的卡片，避免永远显示"思考中"
          logger.warn(
            { err: patchErr, jid, messageId: progressEntry.messageId },
            '[cleanup] patch 完成卡片失败，fallback 删除卡片',
          );
          await this.client.im.message
            .delete({ path: { message_id: progressEntry.messageId } })
            .catch((delErr: unknown) =>
              logger.warn({ err: delErr, jid }, '[cleanup] 删除卡片也失败'),
            );
        }
      }
    } catch (err) {
      logger.warn({ err, jid }, '飞书进度卡片清理失败（兜底 catch）');
    }
  }

  /** 发送纯文本或卡片消息，返回飞书 message_id（用于 DB 关联） */
  private async sendPlainOrCard(
    chatId: string,
    text: string,
    usage?: ContainerOutput['usage'],
    thinking?: 'adaptive' | 'disabled',
  ): Promise<string | undefined> {
    logger.info({ chatId, textLen: text.length, hasUsage: !!usage, thinking }, '[sendPlainOrCard] 准备发送');
    if (usage || shouldUseCard(text)) {
      const elements: unknown[] = [
        { tag: 'markdown', content: text, text_size: 'normal' },
      ];
      if (usage) appendUsageFooter(elements, usage, thinking);
      try {
        const resp = await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: JSON.stringify({
              schema: '2.0',
              body: { elements },
            }),
          },
          params: { receive_id_type: 'chat_id' },
        });
        logger.info({ chatId, msgId: resp?.data?.message_id }, '[sendPlainOrCard] 卡片发送成功');
        return resp?.data?.message_id;
      } catch (cardErr) {
        // 卡片发送失败 → 拆分 markdown 元素重试（长内容/复杂表格常触发飞书 400）
        logger.warn({ err: cardErr }, '飞书卡片发送失败，尝试拆分 markdown 重试');
        const chunks = splitMarkdownByHeadings(text);
        if (chunks.length > 1) {
          try {
            const splitElements: unknown[] = chunks.map((chunk) => ({
              tag: 'markdown',
              content: chunk,
              text_size: 'normal',
            }));
            if (usage) appendUsageFooter(splitElements, usage, thinking);
            const resp = await this.client.im.message.create({
              data: {
                receive_id: chatId,
                msg_type: 'interactive',
                content: JSON.stringify({
                  schema: '2.0',
                  body: { elements: splitElements },
                }),
              },
              params: { receive_id_type: 'chat_id' },
            });
            logger.info('飞书卡片拆分 markdown 重试成功');
            return resp?.data?.message_id;
          } catch (splitErr) {
            logger.warn({ err: splitErr }, '飞书卡片拆分重试也失败，降级为纯文本');
          }
        }
        // 最终降级：纯文本
        const resp = await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({ text }),
          },
          params: { receive_id_type: 'chat_id' },
        });
        return resp?.data?.message_id;
      }
    } else {
      const resp = await this.client.im.message.create({
        data: {
          receive_id: chatId,
          msg_type: 'text',
          content: JSON.stringify({ text }),
        },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info({ chatId, msgId: resp?.data?.message_id }, '[sendPlainOrCard] 纯文本发送成功');
      return resp?.data?.message_id;
    }
  }

  /** 设置指定 chat 的最新 usage 数据（下次完成卡片渲染时使用） */
  setUsage(
    jid: string,
    usage: ContainerOutput['usage'],
    thinking?: 'adaptive' | 'disabled',
  ): void {
    // 存到独立 Map，不依赖 progressCards entry 是否存在
    if (usage) this.pendingUsage.set(jid, usage);
    // thinking: 只在 Map 中无值时写入（piped 路径已设的值优先，不被 result callback 覆盖）
    if (thinking !== undefined && !this.thinkingMode.has(jid)) {
      this.thinkingMode.set(jid, thinking);
    }
    logger.info(
      { jid, thinking, effective: this.thinkingMode.get(jid) },
      '[usage] setUsage 调用',
    );
  }

  private clearSpinnerTimer(jid: string): void {
    this.spinnerStopped.add(jid); // 防止正在运行的 callback 再次调度
    const timer = this.spinnerTimers.get(jid);
    if (timer) {
      clearTimeout(timer);
      this.spinnerTimers.delete(jid);
    }
    this.spinnerSchedulers.delete(jid);
  }

  /** 重置 spinner 定时器：取消当前计时，调用存储的 scheduleSpinner 重新开始 */
  private resetSpinnerTimer(jid: string): void {
    const timer = this.spinnerTimers.get(jid);
    if (timer) {
      clearTimeout(timer);
      this.spinnerTimers.delete(jid);
    }
    // 调用存储的 scheduleSpinner 闭包重新启动定时器
    const scheduler = this.spinnerSchedulers.get(jid);
    if (scheduler) scheduler();
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    const chatId = chatIdFromJid(jid);
    try {
      if (isTyping) {
        // 新对话开始，清除上一轮的 progressDone 标记
        this.progressDone.delete(jid);
        // 添加 emoji reaction 到用户消息，不同执行模式使用不同表情。
        const lastMsgId = this.getLastMessageId(jid);
        const group = this.opts.registeredGroups()[jid];
        const cliMode = resolveCliMode(group?.containerConfig);
        const emoji = TYPING_EMOJI_BY_MODE[cliMode] ?? TYPING_EMOJI_BY_MODE.sdk;
        logger.info(
          { jid, lastMsgId, cliMode, emoji },
          '[typing] 开始加 emoji reaction',
        );
        if (lastMsgId) {
          const resp = await this.client.im.messageReaction.create({
            data: { reaction_type: { emoji_type: emoji } },
            path: { message_id: lastMsgId },
          });
          const reactionId = resp?.data?.reaction_id;
          if (reactionId) {
            this.typingReactions.set(jid, { messageId: lastMsgId, reactionId });
            logger.info({ jid, reactionId }, '[typing] emoji reaction 已添加');
          } else {
            logger.warn(
              { jid },
              '[typing] emoji reaction 创建未返回 reactionId',
            );
          }
        } else {
          logger.warn({ jid }, '[typing] 找不到 lastMsgId，跳过 emoji');
        }

        // 进度卡片延迟创建：等第一条工具进度到达时再创建（见 onAgentProgress）
      } else {
        logger.info(
          {
            jid,
            hasCard: this.progressCards.has(jid),
            hasEmoji: this.typingReactions.has(jid),
          },
          '[typing] 结束，清理 spinner + emoji',
        );
        // 清理 spinner 定时器
        this.clearSpinnerTimer(jid);
        // 移除 emoji reaction（先删 Map 再调 API，防与 removeTypingReaction 并发）
        await this.removeTypingReaction(jid);
      }
    } catch (err) {
      logger.debug({ err, jid, isTyping }, '飞书 typing indicator 操作失败');
    }
  }

  /** 移除 typing emoji reaction（幂等，先删 Map 再调 API 防并发） */
  private async removeTypingReaction(jid: string): Promise<void> {
    const entry = this.typingReactions.get(jid);
    if (!entry) {
      logger.info(
        { jid },
        '[emoji] removeTypingReaction: Map 中无 entry，跳过（可能已被并发移除）',
      );
      return;
    }
    this.typingReactions.delete(jid); // 先删，防止并发双重删除
    logger.info(
      { jid, messageId: entry.messageId, reactionId: entry.reactionId },
      '[emoji] 开始移除 emoji reaction',
    );
    try {
      await this.client.im.messageReaction.delete({
        path: {
          message_id: entry.messageId,
          reaction_id: entry.reactionId,
        },
      });
      logger.info({ jid }, '[emoji] emoji reaction 已移除');
    } catch (err) {
      logger.info({ jid, err }, '[emoji] emoji reaction 移除失败（静默忽略）');
    }
  }

  /** 创建进度卡片 + 启动 spinner 定时器（从 setTyping 延迟到首次进度时调用） */
  private async createProgressCard(
    jid: string,
    chatId: string,
    initialStep: ProgressStep,
  ): Promise<void> {
    const SPINNER_INTERVAL_MS = 1000;
    const SPINNER_MAX_DURATION_MS = 60 * 60 * 1000; // 60 分钟硬上限

    const now = Date.now();
    this.spinnerStopped.delete(jid);
    const sessionId = crypto.randomBytes(8).toString('hex');
    const initialSteps: ProgressStep[] = [initialStep];
    upsertSession(sessionId, initialSteps, now);
    logger.info(
      { jid, chatId, sessionId, step: initialStep.title },
      '[card] 开始创建进度卡片（调飞书 API）',
    );
    const resp = await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'interactive',
        content: buildProgressCard(initialSteps, 0, now, sessionId),
      },
      params: { receive_id_type: 'chat_id' },
    });
    const msgId = resp?.data?.message_id;
    if (msgId) {
      logger.info({ jid, msgId, sessionId }, '[card] 飞书卡片创建成功');
      // 正式回复可能已先到达，删除了占位 entry — 此时不应再插入
      const placeholder = this.progressCards.get(jid);
      if (!placeholder) {
        logger.info(
          { jid, msgId },
          '[card] 占位 entry 已被正式回复删除，卡片已无用，删除之',
        );
        this.client.im.message
          .delete({ path: { message_id: msgId } })
          .catch(() => {});
        return;
      }
      // 合并缓冲期间（卡片创建 await 期间）积累的步骤
      const bufferedSteps = placeholder?.steps ?? [];
      logger.info(
        { jid, bufferedCount: bufferedSteps.length },
        '[card] 合并缓冲步骤',
      );
      const mergedSteps = [...initialSteps, ...bufferedSteps];
      const mergedAllSteps = [...initialSteps, ...bufferedSteps];
      while (mergedSteps.length > 3) mergedSteps.shift();
      while (mergedAllSteps.length > 500) mergedAllSteps.shift();

      this.progressCards.set(jid, {
        messageId: msgId,
        sessionId,
        steps: mergedSteps,
        allSteps: mergedAllSteps,
        frame: 0,
        startTime: now,
      });

      // 缓冲期间有新步骤，立即 patch 卡片以显示最新状态
      if (bufferedSteps.length > 0) {
        upsertSession(sessionId, mergedAllSteps, now);
        this.client.im.message
          .patch({
            path: { message_id: msgId },
            data: {
              content: buildProgressCard(mergedSteps, 0, now, sessionId),
            },
          })
          .catch((err: any) =>
            logger.debug({ err, jid }, '缓冲步骤 patch 失败（非致命）'),
          );
      }

      // 启动 spinner 自动刷新定时器
      this.clearSpinnerTimer(jid);
      this.spinnerStopped.delete(jid);
      const spinnerStartTime = now;
      const scheduleSpinner = (): void => {
        const t = setTimeout(async () => {
          if (this.spinnerStopped.has(jid)) {
            this.spinnerTimers.delete(jid);
            return;
          }

          const entry = this.progressCards.get(jid);
          if (!entry) {
            this.spinnerTimers.delete(jid);
            return;
          }

          if (Date.now() - spinnerStartTime > SPINNER_MAX_DURATION_MS) {
            logger.warn({ jid }, 'Spinner timer 达到硬上限，自动停止');
            this.spinnerTimers.delete(jid);
            return;
          }

          entry.frame++;
          try {
            await this.client.im.message.patch({
              path: { message_id: entry.messageId },
              data: {
                content: buildProgressCard(
                  entry.steps,
                  entry.frame,
                  entry.startTime,
                  entry.sessionId,
                ),
              },
            });
          } catch (err) {
            logger.debug({ err, jid }, 'Spinner 自动刷新失败（非致命）');
          }

          if (!this.spinnerStopped.has(jid)) {
            scheduleSpinner();
          } else {
            this.spinnerTimers.delete(jid);
          }
        }, SPINNER_INTERVAL_MS);
        this.spinnerTimers.set(jid, t);
      };
      this.spinnerSchedulers.set(jid, scheduleSpinner);
      scheduleSpinner();
    } else {
      logger.warn(
        { jid },
        '[card] 飞书卡片创建失败（未返回 messageId），清理占位',
      );
      this.progressCards.delete(jid);
    }
  }

  async sendAuthCard(jid: string, authUrl: string): Promise<void> {
    const chatId = chatIdFromJid(jid);
    const card = JSON.stringify({
      elements: [
        {
          tag: 'markdown',
          content:
            '🔑 **需要飞书文档授权**\n\n要读取或创建飞书文档，需要你授权一次。\n授权后自动生效，无需重复操作。',
        },
        {
          tag: 'action',
          actions: [
            {
              tag: 'button',
              text: { tag: 'plain_text', content: '👉 点击授权' },
              type: 'primary',
              multi_url: { url: authUrl },
            },
          ],
        },
      ],
      header: {
        template: 'orange',
        title: { tag: 'plain_text', content: '飞书文档授权' },
      },
    });
    try {
      await this.client.im.message.create({
        data: { receive_id: chatId, msg_type: 'interactive', content: card },
        params: { receive_id_type: 'chat_id' },
      });
      logger.info({ jid }, '飞书授权卡片发送成功');
    } catch (err) {
      // schema 1.0 卡片失败时降级为纯文本链接
      logger.warn({ err }, '飞书授权卡片发送失败，降级为文本链接');
      try {
        await this.client.im.message.create({
          data: {
            receive_id: chatId,
            msg_type: 'text',
            content: JSON.stringify({
              text: `🔑 需要飞书文档授权\n\n请点击链接完成授权：${authUrl}\n\n授权后自动生效。`,
            }),
          },
          params: { receive_id_type: 'chat_id' },
        });
      } catch (fallbackErr) {
        logger.error({ fallbackErr }, '飞书授权文本链接也发送失败');
      }
    }
  }

  async syncGroups(): Promise<void> {
    try {
      let pageToken: string | undefined;
      do {
        const resp = await this.client.im.chat.list({
          params: {
            page_size: 100,
            ...(pageToken ? { page_token: pageToken } : {}),
          },
        });
        const items = resp?.data?.items ?? [];
        for (const item of items) {
          if (item.chat_id && item.name) {
            const jid = `${JID_PREFIX}${item.chat_id}`;
            this.opts.onChatMetadata(
              jid,
              new Date().toISOString(),
              item.name,
              'feishu',
              true,
            );
          }
        }
        pageToken = resp?.data?.page_token;
      } while (pageToken);
      logger.info('飞书群列表同步完成');
    } catch (err) {
      logger.error({ err }, '飞书群列表同步失败');
    }
  }

  // ---- 内部方法 ----

  // 最近消息 ID 缓存（按 chat jid），用于 typing indicator
  private lastMessageIds = new Map<string, string>();

  private getLastMessageId(jid: string): string | undefined {
    return this.lastMessageIds.get(jid);
  }

  private getGroupFolder(jid: string): string | null {
    const groups = this.opts.registeredGroups();
    return groups[jid]?.folder ?? null;
  }

  /** 获取 tenant_access_token（用于 REST API 调用） */
  private async getTenantAccessToken(): Promise<string | null> {
    try {
      const resp = await fetch(
        'https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            app_id: this.appId,
            app_secret: this.appSecret,
          }),
        },
      );
      const data = (await resp.json()) as { tenant_access_token?: string };
      return data.tenant_access_token ?? null;
    } catch (err) {
      logger.error({ err }, '获取 tenant_access_token 失败');
      return null;
    }
  }

  /**
   * 从群名提取缩略字（1-2 个字符），生成彩色头像 PNG，上传到飞书获取 image_key。
   * 使用 SVG + macOS qlmanage 渲染，无需额外依赖。
   */
  private async generateAndUploadAvatar(
    name: string,
  ): Promise<string | null> {
    try {
      // 提取缩略字：优先取开头英文大写/数字（最多 2 个），否则取前 2 个中文字
      const abbr = this.extractAbbreviation(name);
      if (!abbr) return null;

      // 基于名称 hash 选颜色和风格，保证同名群一致
      const colors = [
        '#4F46E5', '#7C3AED', '#2563EB', '#0891B2', '#059669',
        '#D97706', '#DC2626', '#DB2777', '#4338CA', '#0D9488',
      ];
      const hash = [...name].reduce((h, c) => h * 31 + c.charCodeAt(0), 0);
      const absHash = Math.abs(hash);
      const color = colors[absHash % colors.length];
      // 两种风格：0=纯色背景白字，1=白底彩色边框+彩色字
      const style = (absHash >> 4) % 2;
      const fillColor = style === 0 ? 'white' : color;
      const bgFill = style === 0 ? color : 'white';
      const borderSvg =
        style === 1
          ? `<circle cx="256" cy="256" r="248" fill="none" stroke="${color}" stroke-width="16"/>`
          : '';

      // 圆形头像，超过 2 个字竖排换行
      const size = 512;
      const r = size / 2;

      let textSvg: string;
      if (abbr.length <= 2) {
        const fontSize = abbr.length <= 1 ? 280 : 220;
        textSvg = `<text x="${r}" y="${r}" font-size="${fontSize}"
          font-family="PingFang SC,SF Pro Display,Helvetica Neue,sans-serif"
          fill="${fillColor}" text-anchor="middle" dominant-baseline="central"
          font-weight="bold">${this.escapeXml(abbr)}</text>`;
      } else {
        const line1 = abbr.slice(0, 2);
        const line2 = abbr.slice(2);
        const fontSize = 140;
        const gap = fontSize * 0.25;
        // 两行总高度 = 2字高 + 行间距，关于圆心垂直居中
        const totalH = 2 * fontSize + gap;
        const y1 = r - totalH / 2 + fontSize * 0.85;
        const y2 = y1 + fontSize + gap;
        textSvg = `<text font-size="${fontSize}"
          font-family="PingFang SC,SF Pro Display,Helvetica Neue,sans-serif"
          fill="${fillColor}" text-anchor="middle" font-weight="bold">
          <tspan x="${r}" y="${y1}">${this.escapeXml(line1)}</tspan>
          <tspan x="${r}" y="${y2}">${this.escapeXml(line2)}</tspan>
        </text>`;
      }

      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}">
  <circle cx="${r}" cy="${r}" r="${r}" fill="${bgFill}"/>
  ${borderSvg}
  ${textSvg}
</svg>`;

      const tmpDir = os.tmpdir();
      const svgPath = path.join(tmpDir, `avatar_${Date.now()}.svg`);
      fs.writeFileSync(svgPath, svg);

      // qlmanage 渲染 SVG → PNG（macOS 内置，512px 高清）
      execSync(`qlmanage -t -s 512 -o "${tmpDir}" "${svgPath}"`, {
        timeout: 5000,
        stdio: 'pipe',
      });
      const pngPath = svgPath + '.png';
      if (!fs.existsSync(pngPath)) {
        logger.warn('[avatar] qlmanage 未生成 PNG');
        return null;
      }

      // 上传到飞书
      const token = await this.getTenantAccessToken();
      if (!token) {
        logger.warn('[avatar] 无法获取 tenant_access_token');
        return null;
      }

      const formData = new FormData();
      formData.append('image_type', 'avatar');
      formData.append(
        'image',
        new Blob([fs.readFileSync(pngPath)]),
        'avatar.png',
      );

      const resp = await fetch(
        'https://open.feishu.cn/open-apis/im/v1/images',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}` },
          body: formData,
        },
      );
      const data = (await resp.json()) as {
        data?: { image_key?: string };
      };

      // 清理临时文件
      try {
        fs.unlinkSync(svgPath);
        fs.unlinkSync(pngPath);
      } catch {}

      const imageKey = data?.data?.image_key;
      if (!imageKey) {
        logger.warn({ data }, '[avatar] 上传失败，未返回 image_key');
        return null;
      }

      logger.info({ abbr, imageKey }, '[avatar] 头像生成并上传成功');
      return imageKey;
    } catch (err) {
      logger.warn({ err }, '[avatar] 头像生成失败，跳过');
      return null;
    }
  }

  /** 从群名提取缩略字（最多 4 个字符） */
  private extractAbbreviation(name: string): string {
    // 去掉 (完成) 等前缀标记
    const clean = name.replace(/^\(.*?\)\s*/, '').trim();

    // 优先取开头的英文大写字母+数字组合（如 "BI查询" → "BI"，"V2 Admin" → "V2"）
    const upper = clean.match(/^[A-Z0-9]+/)?.[0];
    if (upper && upper.length >= 1) return upper.slice(0, 4);

    // 否则取前 2-4 个中文字（短名取全，长名取 2 个）
    const cjk = clean.match(/[\u4e00-\u9fff]/g);
    if (cjk) {
      // 群名总中文字数 ≤ 4 就全取，否则取前 2 个
      return cjk.slice(0, cjk.length <= 4 ? 4 : 2).join('');
    }

    // fallback: 前 2 个字符
    return clean.slice(0, 2);
  }

  /** XML 转义 */
  private escapeXml(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /** 下载飞书图片到 group 目录，返回宿主机绝对路径 */
  private async downloadImage(
    messageId: string,
    imageKey: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantAccessToken();
      if (!token) return null;

      const groupDir = resolveGroupFolderPath(groupFolder);
      const imagesDir = path.join(groupDir, 'images');
      fs.mkdirSync(imagesDir, { recursive: true });

      const filename = `${messageId}_${imageKey}.jpg`;
      const filePath = path.join(imagesDir, filename);

      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${imageKey}?type=image`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok) {
        logger.warn(
          { messageId, imageKey, status: resp.status },
          '飞书图片下载 HTTP 错误',
        );
        return null;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      if (buf.length > MAX_IMAGE_SIZE) {
        logger.warn(
          { messageId, imageKey, size: buf.length },
          '图片超过 20MB 限制',
        );
        return null;
      }

      fs.writeFileSync(filePath, buf);
      logger.info(
        { messageId, imageKey, hostPath: filePath },
        '飞书图片下载成功',
      );
      return filePath;
    } catch (err) {
      logger.error({ err, messageId, imageKey }, '飞书图片下载失败');
      return null;
    }
  }

  /** 下载飞书文件到 group 目录，返回宿主机绝对路径 */
  private async downloadFile(
    messageId: string,
    fileKey: string,
    fileName: string,
    groupFolder: string,
  ): Promise<string | null> {
    try {
      const token = await this.getTenantAccessToken();
      if (!token) return null;

      const groupDir = resolveGroupFolderPath(groupFolder);
      const filesDir = path.join(groupDir, 'files');
      fs.mkdirSync(filesDir, { recursive: true });

      // 文件名加 messageId 前缀防重名
      const safeFileName = fileName.replace(/[/\\]/g, '_');
      const filePath = path.join(filesDir, `${messageId}_${safeFileName}`);

      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}/resources/${fileKey}?type=file`,
        { headers: { Authorization: `Bearer ${token}` } },
      );

      if (!resp.ok) {
        logger.warn(
          { messageId, fileKey, status: resp.status },
          '飞书文件下载 HTTP 错误',
        );
        return null;
      }

      const buf = Buffer.from(await resp.arrayBuffer());
      fs.writeFileSync(filePath, buf);
      logger.info(
        { messageId, fileKey, fileName, hostPath: filePath, size: buf.length },
        '飞书文件下载成功',
      );
      return filePath;
    } catch (err) {
      logger.error({ err, messageId, fileKey }, '飞书文件下载失败');
      return null;
    }
  }

  /** 从飞书 post（富文本）中提取文本和图片 key */
  extractPostContent(parsed: Record<string, unknown>): {
    text: string;
    imageKeys: string[];
  } {
    const parts: string[] = [];
    const imageKeys: string[] = [];

    const title = ((parsed.title as string) || '').trim();
    if (title) parts.push(title);

    const content = parsed.content as
      | Array<
          Array<{
            tag: string;
            text?: string;
            image_key?: string;
            user_id?: string;
          }>
        >
      | undefined;
    if (!content) return { text: parts.join('\n'), imageKeys };

    for (const line of content) {
      const lineTexts: string[] = [];
      for (const el of line) {
        if ((el.tag === 'text' || el.tag === 'a') && el.text) {
          lineTexts.push(el.text);
        } else if (el.tag === 'at' && el.user_id) {
          // 飞书 post 中 @mention 是独立 at 元素，输出占位符供下游替换
          lineTexts.push(`@_at_${el.user_id}`);
        } else if (el.tag === 'img' && el.image_key) {
          imageKeys.push(el.image_key);
        }
      }
      if (lineTexts.length > 0) parts.push(lineTexts.join(''));
    }

    return { text: parts.join('\n'), imageKeys };
  }

  /** 解析合并转发消息（参考 Nine adapter.py _parse_merge_forward） */
  private async parseMergeForward(
    messageId: string,
    groupFolder: string | null,
    depth: number = 0,
  ): Promise<{ text: string; imagePaths: string[] }> {
    if (depth > MAX_MERGE_DEPTH) {
      return { text: '[嵌套转发内容已省略]', imagePaths: [] };
    }

    const token = await this.getTenantAccessToken();
    if (!token) {
      return { text: '[合并转发消息，认证失败无法解析]', imagePaths: [] };
    }

    let items: Array<{
      message_id?: string;
      msg_type?: string;
      sender?: { id: string; sender_type: string };
      body?: { content: string };
    }>;
    try {
      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${messageId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await resp.json()) as {
        code?: number;
        data?: { items?: typeof items };
      };
      if (data.code !== 0) {
        logger.error(
          { messageId, code: data.code },
          '飞书合并转发 API 返回错误',
        );
        return { text: '[合并转发消息，API 返回错误]', imagePaths: [] };
      }
      items = data.data?.items ?? [];
    } catch (err) {
      logger.error({ err, messageId }, '飞书合并转发 API 调用失败');
      return { text: '[合并转发消息，API 调用失败]', imagePaths: [] };
    }

    if (items.length === 0) {
      return { text: '[合并转发消息，无子消息]', imagePaths: [] };
    }

    const texts: string[] = [];
    const imagePaths: string[] = [];
    let totalTextLen = 0;
    let skippedCount = 0;

    for (const item of items) {
      const itemMsgType = item.msg_type ?? '';

      // 合并转发类型：递归解析（跳过自身）
      if (itemMsgType === 'merge_forward') {
        if (depth < MAX_MERGE_DEPTH) {
          const nestedId = item.message_id ?? '';
          if (nestedId && nestedId !== messageId) {
            const nested = await this.parseMergeForward(
              nestedId,
              groupFolder,
              depth + 1,
            );
            if (nested.text) {
              texts.push(nested.text);
              totalTextLen += nested.text.length;
            }
            imagePaths.push(...nested.imagePaths);
          }
        } else {
          texts.push('[嵌套转发内容已省略]');
        }
        continue;
      }

      const subContent = item.body?.content ?? '{}';
      const senderLabel = item.sender?.sender_type || item.sender?.id || '未知';

      // 按类型解析子消息
      let subText = '';
      const subImageKeys: string[] = [];
      try {
        const parsed = JSON.parse(subContent);
        if (itemMsgType === 'text') {
          subText = parsed.text ?? '';
        } else if (itemMsgType === 'image') {
          if (parsed.image_key) subImageKeys.push(parsed.image_key);
        } else if (itemMsgType === 'post') {
          const postResult = this.extractPostContent(parsed);
          subText = postResult.text;
          subImageKeys.push(...postResult.imageKeys);
        }
      } catch {
        subText = subContent;
      }

      // 文本长度限制
      if (subText) {
        if (totalTextLen + subText.length > MAX_MERGE_TEXT_LEN) {
          skippedCount++;
          continue;
        }
        texts.push(`[${senderLabel}]: ${subText}`);
        totalTextLen += subText.length;
      }

      // 下载图片（受数量限制）
      if (subImageKeys.length > 0 && groupFolder) {
        const remaining = MAX_MERGE_IMAGES - imagePaths.length;
        for (const key of subImageKeys.slice(0, Math.max(0, remaining))) {
          const imgPath = await this.downloadImage(
            item.message_id ?? messageId,
            key,
            groupFolder,
          );
          if (imgPath) imagePaths.push(imgPath);
        }
      }
    }

    if (skippedCount > 0) {
      texts.push(`[...还有 ${skippedCount} 条消息已省略]`);
    }

    return {
      text: texts.length > 0 ? `[转发消息]\n${texts.join('\n')}` : '[转发消息]',
      imagePaths,
    };
  }

  /** 上传并发送图片消息 */
  private async sendImageMsg(
    chatId: string,
    containerPath: string,
    groupFolder: string,
  ): Promise<void> {
    const hostPath = this.resolveMediaPath(containerPath, groupFolder);

    if (!fs.existsSync(hostPath)) {
      throw new Error(`图片文件不存在: ${hostPath}`);
    }

    const token = await this.getTenantAccessToken();
    if (!token) throw new Error('获取 tenant_access_token 失败');

    // 上传图片
    const formData = new FormData();
    formData.append('image_type', 'message');
    formData.append(
      'image',
      new Blob([fs.readFileSync(hostPath)]),
      path.basename(hostPath),
    );

    const uploadResp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/images',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    const uploadData = (await uploadResp.json()) as {
      data?: { image_key?: string };
    };
    const imageKey = uploadData?.data?.image_key;
    if (!imageKey) throw new Error('图片上传失败：未返回 image_key');

    // 发送图片消息
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'image',
        content: JSON.stringify({ image_key: imageKey }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  /** 上传并发送文件消息 */
  private async sendFileMsg(
    chatId: string,
    inputPath: string,
    groupFolder: string,
  ): Promise<void> {
    const hostPath = this.resolveMediaPath(inputPath, groupFolder);

    if (!fs.existsSync(hostPath)) {
      throw new Error(`文件不存在: ${hostPath}`);
    }

    const token = await this.getTenantAccessToken();
    if (!token) throw new Error('获取 tenant_access_token 失败');

    const filename = path.basename(hostPath);
    const fileType = feishuFileType(filename);

    // 上传文件
    const formData = new FormData();
    formData.append('file_type', fileType);
    formData.append('file_name', filename);
    formData.append('file', new Blob([fs.readFileSync(hostPath)]), filename);

    const uploadResp = await fetch(
      'https://open.feishu.cn/open-apis/im/v1/files',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: formData,
      },
    );
    const uploadData = (await uploadResp.json()) as {
      data?: { file_key?: string };
    };
    const fileKey = uploadData?.data?.file_key;
    if (!fileKey)
      throw new Error(`文件上传失败：${JSON.stringify(uploadData)}`);

    // 发送文件消息
    await this.client.im.message.create({
      data: {
        receive_id: chatId,
        msg_type: 'file',
        content: JSON.stringify({ file_key: fileKey }),
      },
      params: { receive_id_type: 'chat_id' },
    });
  }

  /** 获取被回复消息的内容和发送者名称（DB 优先，miss 时 fallback 飞书 API） */
  private async fetchReplyContext(
    parentId: string,
  ): Promise<{ content: string; senderName: string } | null> {
    // 1. DB 优先查询 — bot 发的消息以飞书 message_id 为主键存储，直接命中
    try {
      const row = getMessageById(parentId);
      if (row?.content) {
        let content = row.content;
        if (content.length > 200) content = content.slice(0, 200) + '...';
        logger.debug({ parentId }, '[reply-ctx] DB 命中引用消息');
        return {
          content,
          senderName: row.sender_name || ASSISTANT_NAME,
        };
      }
    } catch (err) {
      logger.debug({ err, parentId }, '[reply-ctx] DB 查询引用消息失败，fallback API');
    }

    // 2. DB miss → 调飞书 API
    const token = await this.getTenantAccessToken();
    if (!token) return null;

    try {
      const resp = await fetch(
        `https://open.feishu.cn/open-apis/im/v1/messages/${parentId}`,
        { headers: { Authorization: `Bearer ${token}` } },
      );
      const data = (await resp.json()) as {
        code?: number;
        data?: {
          items?: Array<{
            msg_type?: string;
            sender?: { id: string; sender_type: string };
            body?: { content: string };
          }>;
        };
      };
      if (data.code !== 0 || !data.data?.items?.length) return null;

      const item = data.data.items[0];
      const msgType = item.msg_type ?? '';
      const rawContent = item.body?.content ?? '{}';
      const senderOpenId = item.sender?.id ?? '未知';

      // 提取文本内容
      let content = '';
      try {
        const parsed = JSON.parse(rawContent);
        if (msgType === 'text') {
          content = parsed.text ?? '';
        } else if (msgType === 'post') {
          // 富文本：提取纯文本部分
          const postResult = this.extractPostContent(parsed);
          content = postResult.text;
        } else if (msgType === 'image') {
          content = '[图片]';
        } else if (msgType === 'merge_forward') {
          content = '[合并转发消息]';
        } else if (msgType === 'interactive') {
          // 互动卡片：尝试提取标题或纯文本
          const header = parsed?.header?.title?.content;
          content = header ? `[卡片: ${header}]` : '[互动卡片]';
        } else {
          content = `[${msgType}]`;
        }
      } catch {
        content = '[无法解析]';
      }

      // 截断过长的引用内容
      if (content.length > 200) {
        content = content.slice(0, 200) + '...';
      }

      // 获取发送者名称
      let senderName = senderOpenId;
      const senderType = item.sender?.sender_type ?? '';
      if (senderType === 'app') {
        // bot 自己发的消息
        senderName = ASSISTANT_NAME;
      } else {
        // 尝试从 DB 获取发送者名称（比 open_id 更友好）
        try {
          const row = getMessageById(parentId);
          if (row?.sender_name) {
            senderName = row.sender_name;
          }
        } catch {
          // DB 查不到就用 open_id
        }
      }

      return { content, senderName };
    } catch (err) {
      logger.warn({ err, parentId }, '获取被回复消息失败');
      return null;
    }
  }

  /**
   * 根据 open_id 获取飞书用户姓名，带内存缓存。
   * 通过群成员 API 批量获取该群所有成员姓名并缓存。
   */
  private async getUserName(openId: string, chatId?: string): Promise<string> {
    if (!openId || openId === 'unknown') return openId;

    const cached = this.userNameCache.get(openId);
    if (cached) return cached;

    // 通过群成员 API 批量加载该群所有成员的姓名
    if (chatId) {
      try {
        const resp = await this.client.im.chatMembers.get({
          path: { chat_id: chatId },
          params: { member_id_type: 'open_id' },
        });
        const items = resp?.data?.items;
        if (items && items.length > 0) {
          for (const member of items) {
            if (member.member_id && member.name) {
              this.userNameCache.set(member.member_id, member.name);
            }
          }
          const name = this.userNameCache.get(openId);
          if (name) return name;
        }
      } catch (err) {
        logger.warn({ err, openId, chatId }, '获取群成员列表失败');
      }
    }

    // 群成员 API 也没拿到，缓存 open_id 避免反复调用
    this.userNameCache.set(openId, openId);
    return openId;
  }

  private async handleMessage(data: {
    sender: {
      sender_id?: { union_id?: string; user_id?: string; open_id?: string };
      sender_type: string;
    };
    message: {
      message_id: string;
      root_id?: string;
      parent_id?: string;
      chat_id: string;
      chat_type: string;
      message_type: string;
      content: string;
      mentions?: Array<{ key: string; id: { open_id?: string }; name: string }>;
    };
  }): Promise<void> {
    logger.info(
      {
        chatId: data.message.chat_id,
        msgType: data.message.message_type,
        senderType: data.sender.sender_type,
      },
      '飞书收到消息事件',
    );
    // 忽略机器人自己发的消息
    if (data.sender.sender_type === 'app') {
      logger.info(
        { chatId: data.message.chat_id },
        '忽略机器人消息 (sender_type=app)',
      );
      return;
    }

    const { message, sender } = data;
    const jid = `${JID_PREFIX}${message.chat_id}`;
    const senderId =
      sender.sender_id?.open_id ?? sender.sender_id?.user_id ?? 'unknown';

    // 记录最近消息 ID（用于 typing indicator）
    this.lastMessageIds.set(jid, message.message_id);

    // 获取 group folder（图片下载需要）
    const groupFolder = this.getGroupFolder(jid);

    logger.info(
      { jid, msgType: message.message_type, senderId },
      '飞书开始解析消息内容',
    );

    // 解析消息内容
    let text = '';
    try {
      if (message.message_type === 'image') {
        // 图片消息：下载图片并标记路径
        const parsed = JSON.parse(message.content);
        const imageKey = parsed.image_key;
        if (imageKey && groupFolder) {
          const imgPath = await this.downloadImage(
            message.message_id,
            imageKey,
            groupFolder,
          );
          text = imgPath ? `[图片: ${imgPath}]` : '[图片: 下载失败]';
        } else if (imageKey) {
          text = '[图片: 群未注册，无法下载]';
        } else {
          return;
        }
      } else if (message.message_type === 'file') {
        // 文件消息：下载文件并标记路径
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        const fileName = parsed.file_name || 'unknown';
        if (fileKey && groupFolder) {
          const filePath = await this.downloadFile(
            message.message_id,
            fileKey,
            fileName,
            groupFolder,
          );
          text = filePath
            ? `[文件: ${filePath}] (${fileName})`
            : `[文件: 下载失败] (${fileName})`;
        } else if (fileKey) {
          text = `[文件: 群未注册，无法下载] (${fileName})`;
        } else {
          return;
        }
      } else if (message.message_type === 'audio') {
        // 语音消息：下载并标记路径（转写由其他 skill 处理）
        const parsed = JSON.parse(message.content);
        const fileKey = parsed.file_key;
        if (fileKey && groupFolder) {
          const filePath = await this.downloadFile(
            message.message_id,
            fileKey,
            `voice_${message.message_id}.opus`,
            groupFolder,
          );
          text = filePath ? `[语音: ${filePath}]` : '[语音: 下载失败]';
        } else {
          return;
        }
      } else if (message.message_type === 'merge_forward') {
        // 合并转发：递归解析子消息
        const result = await this.parseMergeForward(
          message.message_id,
          groupFolder,
        );
        text = result.text;
        for (const imgPath of result.imagePaths) {
          text += `\n[图片: ${imgPath}]`;
        }
      } else {
        const parsed = JSON.parse(message.content);
        if (message.message_type === 'text') {
          text = parsed.text ?? '';
        } else if (message.message_type === 'post') {
          // 富文本：提取文本 + 图片
          const postResult = this.extractPostContent(parsed);
          text = postResult.text;
          if (postResult.imageKeys.length > 0 && groupFolder) {
            for (const imageKey of postResult.imageKeys) {
              const imgPath = await this.downloadImage(
                message.message_id,
                imageKey,
                groupFolder,
              );
              if (imgPath) text += `\n[图片: ${imgPath}]`;
            }
          }
        } else {
          // 其他消息类型暂不处理
          return;
        }
      }
    } catch (err) {
      logger.warn({ content: message.content, err }, '飞书消息内容解析失败');
      return;
    }

    if (!text.trim()) {
      logger.info({ jid }, '飞书消息内容为空，跳过');
      return;
    }

    // 替换 @mention 标记为名称；@机器人 → @ASSISTANT_NAME（匹配触发词）
    // text 消息用 m.key（如 @_user_1），post 消息用 @_at_{open_id} 占位符
    if (message.mentions) {
      for (const m of message.mentions) {
        const isBotMention = this.botOpenId && m.id.open_id === this.botOpenId;
        const replacement = isBotMention
          ? `@${ASSISTANT_NAME}`
          : `@${m.name}`;
        text = text.replace(m.key, replacement);
        // post 消息中 at 元素生成的占位符（extractPostContent 输出）
        if (m.id.open_id) {
          text = text.replace(`@_at_${m.id.open_id}`, replacement);
        }
      }
    }

    // 通知元数据
    this.opts.onChatMetadata(
      jid,
      new Date().toISOString(),
      undefined,
      'feishu',
      message.chat_type === 'group',
    );

    const senderName = await this.getUserName(senderId, message.chat_id);

    // 获取被回复消息的内容和发送者
    let replyContent: string | undefined;
    let replySenderName: string | undefined;
    if (message.parent_id) {
      const replyCtx = await this.fetchReplyContext(message.parent_id);
      if (replyCtx) {
        replyContent = replyCtx.content;
        replySenderName = replyCtx.senderName;
      }
    }

    const newMsg: NewMessage = {
      id: message.message_id,
      chat_jid: jid,
      sender: senderId,
      sender_name: senderName,
      content: text,
      timestamp: new Date().toISOString(),
      reply_to_message_id: message.parent_id,
      reply_to_message_content: replyContent,
      reply_to_sender_name: replySenderName,
      thread_id: message.root_id,
    };

    logger.info({ jid, text: text.slice(0, 80) }, '飞书消息分发到 onMessage');
    Promise.resolve(this.opts.onMessage(jid, newMsg)).catch((err) =>
      logger.error({ jid, err }, 'onMessage handler failed'),
    );
  }
}

// ---- 自注册 ----

registerChannel('feishu', (opts: ChannelOpts) => {
  const env = readEnvFile(['FEISHU_APP_ID', 'FEISHU_APP_SECRET']);
  const appId = process.env.FEISHU_APP_ID || env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET || env.FEISHU_APP_SECRET;

  if (!appId || !appSecret) {
    logger.debug('飞书凭证未配置，跳过 feishu channel');
    return null;
  }

  return new FeishuChannel(appId, appSecret, opts);
});
