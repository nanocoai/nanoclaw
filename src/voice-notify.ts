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

const SYSTEM_PROMPT = `你把一段给用户的 AI 回复改写成口语化的语音播报版本，供 TTS 朗读。语音是线性的，用户只能听、不能跳读，所以要让他第一耳朵就抓住重点。

规则：
- 第一句话必须是结论或最重要的信息，不要先讲背景再下结论
- 简短优先，控制在 120 字以内（极简单的一句话就够，别硬凑）
- 口语化，流畅连贯，像当面对用户说话；用"我"指代你自己、"你"指代用户
- 代码块、表格、命令行、长路径全部略去，换成"我写了代码"、"我查了日志"这种概括
- 大段技术细节只保留结论
- 所有符号编号按语义转成自然语言：「PR#数字」说成"几号PR"，「issue#数字」说成"几号issue"，commit 哈希绝不念出来、直接略去或说"那个提交"，「v数字」说成"几点几版本"，「#话题」直接说话题名——绝不能留下井号、星号等任何让 TTS 干念的符号
- 链接绝不念 URL 本身，按语义转成一句话：GitHub PR 链接说成"某某仓库的几号PR"，文档链接说成"某某文档"，普通网页说成"一个关于某某的链接"；上下文里看不出指向的就说"详情有链接，看文字版"
- 不要保留任何 Markdown 格式符号（* _ # \` [ ] 等）
- 不要说"以下是摘要"、"总结一下"这种元语言，直接说内容
- 待用户决策的选项要明确编号说清楚，比如"有两个选择：第一……第二……"
- 严禁编造：输出里的每个事实、编号、数字都必须来自原文；原文里没有的信息一个字都不能加。原文本身已经很短很口语时，原样输出即可

只输出改写后的文本，不要任何前缀后缀。`;

export interface VoiceNotifyContext {
  groupFolder: string | null;
  text: string;
  chatJid?: string;
  groupName?: string;
  containerConfig?: RegisteredGroup['containerConfig'];
  aliases?: Record<string, string>;
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
 */
async function summarizeForSpeech(text: string): Promise<string> {
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

  const client = new OpenAI({
    apiKey: config.dashscopeApiKey,
    baseURL: config.dashscopeBaseUrl,
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), SUMMARIZE_TIMEOUT_MS);

  try {
    const response = await client.chat.completions.create(
      {
        model: VOICE_SUMMARY_MODEL,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: text },
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
      const summary = await summarizeForSpeech(context.text);
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
