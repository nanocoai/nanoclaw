/**
 * 语音通知：飞书消息发给大杰时，并行推送一份 LLM 摘要到 Pushover，
 * iOS 端借 "朗读通知" 功能自动经 AirPods 念出来。
 *
 * 触发条件：group folder === 'feishu_main'（主会话）
 * 链路：飞书文字 → 本模块 → LLM 压口语版 → Pushover API → APNs → iOS TTS
 *
 * 设计原则：
 * - 纯 fire-and-forget，失败不影响飞书主流程
 * - 超时短（5s 摘要 + 3s 推送），挂了就放过
 * - 空 token / 非主会话 → 跳过，无副作用
 */
import OpenAI from 'openai';

import { logger } from './logger.js';
import { getMemoryConfig } from './memory/config.js';

const PUSHOVER_API = 'https://api.pushover.net/1/messages.json';
const PUSHOVER_MAX_CHARS = 1024; // Pushover 单条限制
const SUMMARIZE_TIMEOUT_MS = 5000;
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

/**
 * 判断是否应该推送语音通知
 */
function shouldNotify(groupFolder: string | null, text: string): boolean {
  if (groupFolder !== 'feishu_main') return false;
  if (!text || !text.trim()) return false;
  // 纯 emoji / 纯符号 / 极短系统消息不播
  if (text.trim().length < 4) return false;
  // 媒体标记占位文本不播
  if (/^\s*\[(图片|文件|语音):/.test(text)) return false;
  return true;
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
        model: config.llmModel,
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
async function pushToPushover(summary: string): Promise<void> {
  const userKey = process.env.PUSHOVER_USER_KEY;
  const appToken = process.env.PUSHOVER_APP_TOKEN;
  if (!userKey || !appToken) {
    logger.debug('[voice-notify] 缺 PUSHOVER_USER_KEY/APP_TOKEN，跳过推送');
    return;
  }

  const body = new URLSearchParams({
    token: appToken,
    user: userKey,
    message: summary,
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
        { chars: summary.length },
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
export function notifyVoice(groupFolder: string | null, text: string): void {
  if (!shouldNotify(groupFolder, text)) return;
  // 异步 IIFE，异常全吃掉，不影响主链路
  void (async () => {
    try {
      const summary = await summarizeForSpeech(text);
      await pushToPushover(summary);
    } catch (err) {
      logger.warn({ err }, '[voice-notify] 未捕获异常');
    }
  })();
}
