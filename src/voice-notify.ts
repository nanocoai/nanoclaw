/**
 * 语音通知：飞书消息发给大杰时，并行推送一份 LLM 摘要到公网语音网关，
 * 网关排队下发给 iOS app（大狗播报），app 本地 TTS 一条条念。
 *
 * 触发条件：当前群显式开启 voiceNotify.push（兼容旧 voiceNotify.mac）
 * 链路：飞书文字 → 本模块 → LLM 压口语版 → 网关 /voice/api/push → WS → iOS app TTS
 * （2026-06-10 从 Pushover 切到自建网关：排队顺序播放、不被通知中心折叠）
 *
 * 设计原则：
 * - 纯 fire-and-forget，失败不影响飞书主流程
 * - 超时有界（15s 摘要 + 3s 推送），挂了就放过
 * - 空 token / 未开启群 → 跳过，无副作用
 */
import OpenAI from 'openai';

import { logger } from './logger.js';
import { getMemoryConfig } from './memory/config.js';
import { readEnvFile } from './env.js';
import type { RegisteredGroup } from './types.js';

const VOICE_GATEWAY_API =
  process.env.VOICE_GATEWAY_URL || 'https://api.saltapp.cn/voice/api/push';
const VOICE_GATEWAY_CLIENT_ID =
  process.env.VOICE_GATEWAY_CLIENT_ID || 'ios-main';
const MAX_SPEAK_CHARS = 1024; // 单条播报上限，太长 TTS 念不动也没人听
// qwen3.7-max 默认开思考时摘要要 23-32s（必超时降级），关思考后 1.5s 出结果、质量更好。
// 超时给足 15s 兜底偶发慢。
const SUMMARIZE_TIMEOUT_MS = 15000;
// 摘要专用模型（可 env 覆盖）。默认 qwen3.7-max 并关闭思考（enable_thinking=false）：
// 实测非流式 1.7s、流式首字 0.5s，文案比 qwen-turbo 更准更干净、无残留符号。
// 关思考是关键——开思考会慢到 20s+ 必超时降级发原文。
const VOICE_SUMMARY_MODEL = process.env.VOICE_SUMMARY_MODEL || 'qwen3.7-max';
const PUSH_TIMEOUT_MS = 3000;
// 灰度/回滚开关：VOICE_SUMMARY_VERSION=off 跳过 LLM 直接播原文截断，默认 v3
// 运行时读 env 而非模块级 const，方便热切换和测试
function getVoiceSummaryVersion(): string {
  return process.env.VOICE_SUMMARY_VERSION || 'v3';
}

// ────────────── v3 意图分流摘要 ──────────────
// v1（120 字一刀切）和 v2（内容类型分流但 prompt 差异太小导致输出趋同）均已废弃。
// v3 核心思路：按"用户听完要做什么"分流，每个 mode 有强结构约束（固定句式模板），
// 模型对结构差异比字数差异敏感得多。

/** 意图类型（确定性分类，零 LLM 开销） */
export type IntentCategory =
  | 'action' // 需要用户拍板/确认/选择
  | 'navigate' // 长文/方案/复盘，播章节地图
  | 'silent' // 代码/表格/日志为主体，不适合语音
  | 'tech_status' // 技术排查/代码修改汇报
  | 'notify'; // 纯结果通知（默认）

// 极短公共前缀，只保留 TTS 必须规则
const V3_COMMON = `你把 AI 回复改写成 iOS 语音播报。用户在听，不能跳读。只输出播报文本。第一句话直接给结论。口语自然，不读代码、表格、日志、命令原文。不使用 Markdown。符号转自然语言：PR#数字说"几号PR"，commit 哈希略去，链接不念 URL。严禁编造。如有 [对话上下文]，在第一句自然融入话题。`;

const V3_PROMPTS: Record<IntentCategory, string> = {
  notify: `${V3_COMMON}
模式：纯通知。让用户 5 秒内知道结果。1-2 句，最多 80 字。只说发生了什么、完没完成。不展开过程，不列点。`,

  action: `${V3_COMMON}
模式：需要用户拍板。第一句用"需要你确认"开头，说清楚要确认什么。忠实转述原文的决策内容，严禁自己编造选项或方案。如果原文只是 yes/no 确认就直接说要确认什么；原文本身列了选项才逐项简述。最多 100 字。`,

  tech_status: `${V3_COMMON}
模式：技术进展汇报。先说结论（做了什么、结果如何），再说关键证据或验证数据，最后提遗留问题或下一步。自然叙述，不要用序号或分块框架。最多 140 字。跳过代码、日志、堆栈。`,

  navigate: `${V3_COMMON}
模式：长文导航。第一句说总体结论和最终状态。然后挑出最重要的 2-3 个关键信息，每个直接说结论（不要用"第一块/第二块"这种序号框架）。如果有需要用户拍板的事项，放最后明确说出。禁止出现"这段主要分几块"类导航语。最多 180 字。`,

  silent: `${V3_COMMON}
模式：内容主要是代码、表格、日志或测试输出，不适合语音完整播报。只输出 1-2 句：先说结论（做了什么、结果如何），不要描述代码/表格内容。最多 70 字。`,
};

// ────── 决策/拍板信号检测 ──────
// 优先级最高：用户需要做决定时，不管内容有没有代码/表格，都走 action
const ACTION_PATTERNS = [
  /你.{0,6}(决定|拍板|确认|选|批|定)/,
  /需要你.{0,4}(看|定|选|批|确认)/,
  /要.{0,2}(你|大杰).{0,4}(拍|定|选|确认|批准)/,
  /(方案|选项|选择).{0,6}(一|二|三|四|A|B|C)/,
  /你(想|要|觉得|看).{0,6}(先|哪|怎|还是)/,
  /(合不合|行不行|要不要|批不批|搞不搞|改不改)/,
  /二选一|三选一/,
];

// ────── 长文/导航信号检测 ──────
// v2 的 navigate 从未触发（条件太窄：>=300 且有 ##）。放宽条件：
// 满足任一即可：>=500 字、含 3+ 小标题、含 3+ 列表段、或出现方案/复盘等关键词
const NAVIGATE_KEYWORDS =
  /方案|复盘|总结|设计|PRD|OpenSpec|architecture|retrospective/i;

// ────── 噪音内容检测（代码/表格/日志占主体） ──────
function calcNoiseRatio(text: string): number {
  const total = text.length;
  if (total === 0) return 0;
  // 代码块
  let noiseChars = 0;
  for (const m of text.matchAll(/```[\s\S]*?```/g)) noiseChars += m[0].length;
  // 表格行（含 | 的行）
  for (const m of text.matchAll(/^.*\|.*$/gm)) noiseChars += m[0].length;
  return noiseChars / total;
}

/**
 * 意图分类器：按"用户听完要做什么"分流，零 LLM 开销。
 * 优先级：action > silent > navigate > tech_status > notify
 * （silent 必须在 navigate 前：1000 字纯代码不该走"长文导航"）
 */
export function classifyIntent(text: string): IntentCategory {
  const len = text.length;

  // 1. 最高优先：需要用户拍板/决策
  if (ACTION_PATTERNS.some((p) => p.test(text))) return 'action';

  // 2. 噪音检测（代码/表格/日志占主体）—— 必须在 navigate 前，
  //    否则 len>=500 的长代码块会被误判成 navigate
  const hasCodeBlock = /```[\s\S]*?```/.test(text);
  const hasTable = /\|[\s]*---/.test(text);
  if (hasCodeBlock || hasTable) {
    if (calcNoiseRatio(text) > 0.4) return 'silent';
  }

  // 3. 长文导航：多种信号放宽触发
  const headingCount = (text.match(/(?:^|\n)#{1,3}\s+\S/g) || []).length;
  const listSegments = (text.match(/(?:^|\n)(?:[-*+]\s|\d+\.\s)/g) || []).length;
  if (
    len >= 500 ||
    headingCount >= 3 ||
    (listSegments >= 3 && len >= 300) ||
    (NAVIGATE_KEYWORDS.test(text) && len >= 300)
  ) {
    return 'navigate';
  }

  // 4. 中等长度技术内容（含技术信号词）
  const techSignals =
    /修复|bug|PR|commit|deploy|测试|报错|异常|日志|E2E|worktree|合并|分支|回滚/i;
  if (len >= 20 && techSignals.test(text)) return 'tech_status';

  // 5. 默认：短通知
  return 'notify';
}

// 保留旧名字的导出，兼容可能的外部引用（v2 classifyContent → v3 classifyIntent）
/** @deprecated 使用 classifyIntent 代替 */
export const classifyContent = classifyIntent;

export interface VoiceNotifyContext {
  groupFolder: string | null;
  text: string;
  chatJid?: string;
  groupName?: string;
  containerConfig?: RegisteredGroup['containerConfig'];
  aliases?: Record<string, string>;
  /** 对话上下文：群名 + 最近几轮用户消息，供摘要 LLM 生成"关于 xxx"前缀 */
  conversationContext?: string;
}

/**
 * 判断文本是否值得播报
 */
export function isVoiceTextEligible(text: string): boolean {
  if (!text || !text.trim()) return false;
  // 纯 emoji / 纯符号 / 极短系统消息不播
  if (text.trim().length < 4) return false;
  // 媒体标记占位文本不播
  if (/^\s*\[(图片|文件|语音):/.test(text)) return false;
  return true;
}

/**
 * 判断是否应该推送 Pushover 语音通知
 */
export function shouldNotifyPushover(context: VoiceNotifyContext): boolean {
  return (
    (context.containerConfig?.voiceNotify?.push === true ||
      context.containerConfig?.voiceNotify?.mac === true) &&
    isVoiceTextEligible(context.text)
  );
}

/**
 * 解析播报里的群名：alias 优先，其次群名，最后短 JID。
 */
export function resolveVoiceGroupLabel(
  context: Pick<VoiceNotifyContext, 'aliases' | 'chatJid' | 'groupName'>,
): string {
  if (context.chatJid && context.aliases) {
    // 同一个群常有多个别名（"7"/"7号"/"7号群"），选最长的：
    // TTS 念"7号群"能听清，念单字"7"一闪而过等于没报
    const alias = Object.entries(context.aliases)
      .filter(([, jid]) => jid === context.chatJid)
      .map(([name]) => name)
      .sort((a, b) => b.length - a.length)[0];
    if (alias) return alias;
  }
  if (context.groupName?.trim()) return context.groupName.trim();
  if (context.chatJid) return context.chatJid.replace(/^fs:/, '').slice(0, 12);
  return '当前群';
}

/**
 * 结构化推送后 text 为纯播报内容，群名由 app 端用 group_name 渲染/念出。
 * （voice-dialog-loop spec：播报文本不再拼接群名前缀）
 */
export function buildSpokenText(summary: string): string {
  return summary.slice(0, MAX_SPEAK_CHARS);
}

/**
 * TTS 前的确定性清洗：剥 Markdown 符号和 URL。
 * 为什么不靠 LLM prompt：摘要超时/失败会 fallback 发原文（带 Markdown），
 * 且 LLM 偶尔不听话保留 # 和链接 —— TTS 念"井号"念 URL 全是噪音（大杰 2026-06-10 实听反馈）。
 */
export function sanitizeForSpeech(text: string): string {
  let t = text;
  // 代码块整块去掉（prompt 已要求 LLM 概括，这里兜 fallback 原文）
  t = t.replace(/```[\s\S]*?```/g, ' ');
  // 行内代码保留内容
  t = t.replace(/`([^`]*)`/g, '$1');
  // 图片 ![alt](url) / 链接 [text](url) → 只留文字
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1');
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  // 裸 URL 整个删掉，念出来全是字母噪音
  t = t.replace(/https?:\/\/[^\s）)\]」】，。；,;]+/g, '');
  // 粗体/斜体星号
  t = t.replace(/(\*\*|\*)([^*]*)\1/g, '$2');
  // 行首列表符号 / 引用符号
  t = t.replace(/^\s*[-*+>]\s+/gm, '');
  // 表格竖线换空格（表格内容顺序念出来勉强能听）
  t = t.replace(/\|/g, ' ');
  // 所有井号删掉：标题 #、PR#123、#话题 —— TTS 念"井号"纯噪音
  t = t.replace(/#/g, ' ');
  // 折叠空白：换行当句号断句，连续句号合一
  t = t
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '。')
    .replace(/。{2,}/g, '。');
  return t.trim();
}

// 短于此长度的文本不走 LLM 摘要：没东西可总结时模型会拿 prompt 里的
// 示例现编内容（2026-06-11 实锤："在，听到了。"被播成"3812号PR的问题我解决了"）
export const SUMMARY_MIN_CHARS = 40;

/** 是否需要 LLM 摘要：短文本直接念，又快又杜绝示例泄漏 */
export function needsSummarization(text: string): boolean {
  return text.length >= SUMMARY_MIN_CHARS;
}

/**
 * 调 LLM 做语音摘要。失败时 fallback 原文截断到 1024 字符。
 * v3：按意图分流 prompt，每个 mode 有强结构约束。
 * conversationContext 有值时，LLM 会在摘要开头自然融入话题背景。
 */
async function summarizeForSpeech(
  text: string,
  conversationContext?: string,
): Promise<string> {
  if (!needsSummarization(text)) {
    logger.debug(
      { chars: text.length },
      '[voice-notify] 文本过短跳过摘要，直接播原文',
    );
    return text;
  }
  const config = getMemoryConfig();
  if (!config.dashscopeApiKey) {
    logger.debug('[voice-notify] 无 dashscope key，跳过摘要，发原文');
    return text.slice(0, MAX_SPEAK_CHARS);
  }

  // 灰度回滚：VOICE_SUMMARY_VERSION=off 时跳过 LLM，直接截断原文
  if (getVoiceSummaryVersion() === 'off') {
    logger.info('[voice-notify] 摘要已关闭（VOICE_SUMMARY_VERSION=off）');
    return sanitizeForSpeech(text).slice(0, MAX_SPEAK_CHARS);
  }

  // v3 意图分流：确定性分类 → 对应 prompt
  const intent = classifyIntent(text);
  const prompt = V3_PROMPTS[intent];
  logger.info({ intent, chars: text.length }, '[voice-notify] v3 意图分流');

  const client = new OpenAI({
    apiKey: config.dashscopeApiKey,
    baseURL: config.dashscopeBaseUrl,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

  try {
    // 有对话上下文时，拼在正文前面，让 LLM 能在摘要开头加"关于 xxx"定位话题
    const userContent = conversationContext
      ? `${conversationContext}\n\n---\n[回复正文]\n${text}`
      : text;
    const response = await client.chat.completions.create(
      {
        model: VOICE_SUMMARY_MODEL,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: userContent },
        ],
        temperature: 0.3,
        // 关闭思考链：qwen3.7-max 默认开思考会慢到 20s+ 必超时，关掉后 1.5s 出结果。
        // enable_thinking 是 DashScope 扩展参数，不在 OpenAI 类型里，故整体断言一次。
        enable_thinking: false,
      } as OpenAI.Chat.Completions.ChatCompletionCreateParamsNonStreaming,
      { signal: controller.signal },
    );
    const summary = response.choices[0]?.message?.content?.trim() || '';
    if (!summary) return text.slice(0, MAX_SPEAK_CHARS);
    logger.info(
      {
        intent,
        origChars: text.length,
        summaryChars: summary.length,
        hasContext: !!conversationContext,
        summary: summary.slice(0, 300),
      },
      '[voice-notify] 摘要结果',
    );
    return summary.slice(0, MAX_SPEAK_CHARS);
  } catch (err) {
    logger.warn({ err }, '[voice-notify] 摘要失败，fallback 原文');
    return text.slice(0, MAX_SPEAK_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 推送到公网语音网关（网关排队下发 iOS app，app 播完回执才发下一条）
 */
async function pushToVoiceGateway(
  message: string,
  groupId: string | null,
  groupName: string | null,
): Promise<void> {
  // token 优先从 .env 文件读(readEnvFile），fallback process.env。
  // 原因：主进程不把 .env 注入 process.env（见 env.ts 注释「Does NOT load into process.env」），
  // launchd plist 也没配这些变量，直接读 process.env 会拿到 undefined（Pushover 时代踩过的坑）。
  const envFile = readEnvFile(['VOICE_GATEWAY_TOKEN']);
  const token = envFile.VOICE_GATEWAY_TOKEN || process.env.VOICE_GATEWAY_TOKEN;
  if (!token) {
    // 用 warn 而非 debug：静默跳过查不到日志的事故踩过一次，不再犯。只打布尔不打密钥。
    logger.warn(
      { hasToken: false },
      '[voice-notify] 缺 VOICE_GATEWAY_TOKEN，跳过推送（检查 .env）',
    );
    return;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const resp = await fetch(VOICE_GATEWAY_API, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Voice-Token': token,
      },
      body: JSON.stringify({
        client_id: VOICE_GATEWAY_CLIENT_ID,
        text: message,
        // 群上下文：app 按 group_id 聚合会话、回复时带回；无群上下文时网关收 null 走"未分组"
        group_id: groupId,
        group_name: groupName,
      }),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const respText = await resp.text().catch(() => '');
      logger.warn(
        { status: resp.status, body: respText.slice(0, 200) },
        '[voice-notify] 语音网关返回非 2xx',
      );
    } else {
      logger.info(
        { chars: message.length, clientId: VOICE_GATEWAY_CLIENT_ID },
        '[voice-notify] 语音网关推送成功',
      );
    }
  } catch (err) {
    logger.warn({ err }, '[voice-notify] 语音网关推送异常');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 入口：fire-and-forget，外层 await 也只等 setImmediate 这一下。
 */
export function notifyVoice(groupFolder: string | null, text: string): void;
export function notifyVoice(context: VoiceNotifyContext): void;
export function notifyVoice(
  groupFolderOrContext: string | null | VoiceNotifyContext,
  maybeText?: string,
): void {
  const context: VoiceNotifyContext =
    typeof groupFolderOrContext === 'object' && groupFolderOrContext !== null
      ? groupFolderOrContext
      : { groupFolder: groupFolderOrContext, text: maybeText ?? '' };

  if (!shouldNotifyPushover(context)) return;

  // 异步 IIFE，异常全吃掉，不影响主链路
  void (async () => {
    try {
      const summary = await summarizeForSpeech(
        context.text,
        context.conversationContext,
      );
      const label = resolveVoiceGroupLabel(context);
      await pushToVoiceGateway(
        buildSpokenText(sanitizeForSpeech(summary)),
        context.chatJid ?? null,
        label,
      );
    } catch (err) {
      logger.warn({ err }, '[voice-notify] 未捕获异常');
    }
  })();
}
