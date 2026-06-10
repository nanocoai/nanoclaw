/**
 * 语音通知：飞书消息发给大杰时，并行推送一份 LLM 摘要到 Pushover，
 * iOS 端借 "朗读通知" 功能自动经 AirPods 念出来。
 *
 * 触发条件：当前群显式开启 voiceNotify.push（兼容旧 voiceNotify.mac）
 * 链路：飞书文字 → 本模块 → LLM 压口语版 → Pushover API → APNs → iOS TTS
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
import { broadcastVoiceSpeech } from './voice-ws.js';
import type { RegisteredGroup } from './types.js';

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_MAX_CHARS = 1024; // Pushover 单条限制
// qwen3.7-max 摘要长回复实测要 13.9s，原 5s 必超时降级发原文；turbo 实测 0.9s 质量够用。
// 摘要是简单口语化任务，不需要 max 模型。超时给足 15s 兜底偶发慢。
const SUMMARIZE_TIMEOUT_MS = 15000;
// 摘要专用模型（可 env 覆盖）。默认 qwen-turbo：快（~1s）且口语化质量足够，
// 不复用记忆系统的 llmModel（qwen3.7-max 太慢，长输入必超时）。
const VOICE_SUMMARY_MODEL = process.env.VOICE_SUMMARY_MODEL || 'qwen-turbo';
const PUSH_TIMEOUT_MS = 3000;

const SYSTEM_PROMPT = `你把一段给用户的 AI 回复改写成口语化的语音播报版本，供 TTS 朗读。语音是线性的，用户只能听、不能跳读，所以要让他第一耳朵就抓住重点。

规则：
- 第一句话必须是结论或最重要的信息，不要先讲背景再下结论
- 简短优先，控制在 120 字以内（极简单的一句话就够，别硬凑）
- 口语化，流畅连贯，像当面对用户说话；用"我"指代你自己、"你"指代用户
- 代码块、表格、命令行、长路径、长 URL 全部略去，换成"我写了代码"、"我查了日志"这种概括
- 大段技术细节只保留结论
- 英文缩写、编号、版本号（如 PR#2779、v1.3）用中文自然说法或直接略去，别让 TTS 念一串符号
- 不要念 Markdown 格式（不念 * _ # 等符号）
- 不要说"以下是摘要"、"总结一下"这种元语言，直接说内容
- 待用户决策的选项要明确编号说清楚，比如"有两个选择：第一……第二……"

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
    const alias = Object.entries(context.aliases).find(
      ([, jid]) => jid === context.chatJid,
    )?.[0];
    if (alias) return alias;
  }
  if (context.groupName?.trim()) return context.groupName.trim();
  if (context.chatJid) return context.chatJid.replace(/^fs:/, '').slice(0, 12);
  return '当前群';
}

export function buildSpokenText(label: string, summary: string): string {
  return `${label}：${summary}`.slice(0, PUSHOVER_MAX_CHARS);
}

/**
 * 调 LLM 做语音摘要。失败时 fallback 原文截断到 1024 字符。
 */
async function summarizeForSpeech(text: string): Promise<string> {
  const config = getMemoryConfig();
  if (!config.dashscopeApiKey) {
    logger.debug('[voice-notify] 无 dashscope key，跳过摘要，发原文');
    return text.slice(0, PUSHOVER_MAX_CHARS);
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
      },
      { signal: controller.signal },
    );
    const summary = response.choices[0]?.message?.content?.trim() || '';
    if (!summary) return text.slice(0, PUSHOVER_MAX_CHARS);
    return summary.slice(0, PUSHOVER_MAX_CHARS);
  } catch (err) {
    logger.warn({ err }, '[voice-notify] 摘要失败，fallback 原文');
    return text.slice(0, PUSHOVER_MAX_CHARS);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 推送到 Pushover
 */
async function pushToPushover(message: string): Promise<void> {
  // token 优先从 .env 文件读(readEnvFile），fallback process.env。
  // 根因：主进程不把 .env 注入 process.env（见 env.ts 注释「Does NOT load into process.env」），
  // launchd plist 也没配 PUSHOVER，之前直接读 process.env 拿到 undefined → 推送被 debug 静默跳过，
  // 这才是「自动播报收不到」的真根因（摘要侧走 config 读 .env 文件所以能跑，推送侧读 process.env 拿空）。
  const envFile = readEnvFile([
    'PUSHOVER_USER_KEY',
    'PUSHOVER_APP_TOKEN',
    'APP_TOKEN',
  ]);
  const userKey = envFile.PUSHOVER_USER_KEY || process.env.PUSHOVER_USER_KEY;
  const appToken =
    envFile.PUSHOVER_APP_TOKEN ||
    envFile.APP_TOKEN ||
    process.env.PUSHOVER_APP_TOKEN ||
    process.env.APP_TOKEN;
  if (!userKey || !appToken) {
    // 用 warn 而非 debug：这次事故就是被 debug 静默跳过坑了（debug<info 不写日志，
    // 推送悄无声息没了还查不到）。只打布尔，绝不打密钥本身。
    logger.warn(
      { hasUserKey: !!userKey, hasAppToken: !!appToken },
      '[voice-notify] 缺 PUSHOVER token，跳过推送（检查 .env 的 PUSHOVER_USER_KEY/PUSHOVER_APP_TOKEN，或兼容名 APP_TOKEN）',
    );
    return;
  }

  const body = new URLSearchParams({
    token: appToken,
    user: userKey,
    message,
    priority: '1', // Time Sensitive，锁屏/勿扰也能响
    title: '大狗', // iOS 朗读会带上，改空能省一句
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PUSH_TIMEOUT_MS);

  try {
    const resp = await fetch(PUSHOVER_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
    if (!resp.ok) {
      const respText = await resp.text().catch(() => '');
      logger.warn(
        { status: resp.status, body: respText.slice(0, 200) },
        '[voice-notify] Pushover 返回非 2xx',
      );
    } else {
      logger.info(
        { chars: message.length },
        '[voice-notify] Pushover 推送成功',
      );
    }
  } catch (err) {
    logger.warn({ err }, '[voice-notify] Pushover 推送异常');
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
      // WS 广播给自研 app（本地 TTS 队列），与 Pushover 并行双出口
      broadcastVoiceSpeech(label, summary);
      await pushToPushover(buildSpokenText(label, summary));
    } catch (err) {
      logger.warn({ err }, '[voice-notify] 未捕获异常');
    }
  })();
}
