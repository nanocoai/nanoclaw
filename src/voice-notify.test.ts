/**
 * voice-notify 测试 — 核心验证：process.env 没有 VOICE_GATEWAY_TOKEN 但 .env 可读时，
 * 仍能通过 readEnvFile 拿到 token 完成推送（Pushover 时代踩过的 launchd 环境坑）。
 * 推送出口为公网语音网关（POST /voice/api/push，JSON + X-Voice-Token header）。
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// --- mock .env 读取：模拟 process.env 空但 .env 有 token ---
const mockEnvFile: Record<string, string> = {};
vi.mock('./env.js', () => ({
  readEnvFile: (keys: string[]) => {
    const out: Record<string, string> = {};
    for (const k of keys) if (mockEnvFile[k]) out[k] = mockEnvFile[k];
    return out;
  },
}));

// --- mock logger，捕获 warn 调用做断言 ---
const loggerCalls = {
  warn: [] as any[],
  info: [] as any[],
  debug: [] as any[],
};
vi.mock('./logger.js', () => ({
  logger: {
    warn: (...a: any[]) => loggerCalls.warn.push(a),
    info: (...a: any[]) => loggerCalls.info.push(a),
    debug: (...a: any[]) => loggerCalls.debug.push(a),
    error: vi.fn(),
  },
}));

// --- mock 记忆配置：默认不给 dashscope key，让摘要走 fallback 原文（不调 LLM）---
let mockDashscopeKey = '';
vi.mock('./memory/config.js', () => ({
  getMemoryConfig: () => ({
    dashscopeApiKey: mockDashscopeKey,
    dashscopeBaseUrl: 'https://example.com',
  }),
}));

import {
  buildSpokenText,
  classifyIntent,
  classifyContent,
  needsSummarization,
  notifyVoice,
  sanitizeForSpeech,
  resolveVoiceGroupLabel,
  shouldNotifyPushover,
  SUMMARY_MIN_CHARS,
} from './voice-notify.js';

/** 等 fire-and-forget 的异步 IIFE 跑完 */
async function flushAsync() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

const FAKE_TOKEN = 't'.repeat(64);

describe('voice-notify 网关推送', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let savedToken: string | undefined;

  beforeEach(() => {
    loggerCalls.warn = [];
    loggerCalls.info = [];
    loggerCalls.debug = [];
    mockDashscopeKey = '';
    // 备份并清空 process.env，模拟 launchd 环境（.env 不进 process.env）
    savedToken = process.env.VOICE_GATEWAY_TOKEN;
    delete process.env.VOICE_GATEWAY_TOKEN;
    // .env 里有 token
    mockEnvFile.VOICE_GATEWAY_TOKEN = FAKE_TOKEN;

    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 202,
      text: async () => '{"ok":true}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedToken !== undefined) process.env.VOICE_GATEWAY_TOKEN = savedToken;
    delete mockEnvFile.VOICE_GATEWAY_TOKEN;
  });

  it('群开关开启且 .env 可读时，用 .env 的 token 推送到网关', async () => {
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: '这是一条足够长的测试回复内容',
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
      aliases: { '3号群': 'fs:oc_group' },
    });
    await flushAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('/voice/api/push');
    // token 走 header，不进 URL（query 会进 nginx 日志）
    expect(url).not.toContain(FAKE_TOKEN);
    expect(opts.headers['X-Voice-Token']).toBe(FAKE_TOKEN);
    const body = JSON.parse(opts.body as string);
    expect(body.client_id).toBe('ios-main');
    // 结构化推送：text 纯内容不带群名前缀，群上下文走独立字段
    expect(body.text).toContain('这是一条足够长的测试回复内容');
    expect(body.text).not.toContain('3号群：');
    expect(body.group_id).toBe('fs:oc_group');
    expect(body.group_name).toBe('3号群');
    // 没有走「缺 token 跳过」分支
    expect(
      loggerCalls.warn.some((c) => /缺 VOICE_GATEWAY_TOKEN/.test(c[1] ?? '')),
    ).toBe(false);
  });

  it('process.env 和 .env 都没有 token 时，warn 跳过且只打布尔不打密钥', async () => {
    delete mockEnvFile.VOICE_GATEWAY_TOKEN;

    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: '这是一条足够长的测试回复内容',
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
    });
    await flushAsync();

    expect(fetchSpy).not.toHaveBeenCalled();
    const warnCall = loggerCalls.warn.find((c) =>
      /缺 VOICE_GATEWAY_TOKEN/.test(c[1] ?? ''),
    );
    expect(warnCall).toBeTruthy();
    // 第一个参数是结构化对象，只含布尔，不含密钥字符串
    expect(warnCall[0]).toEqual({ hasToken: false });
    expect(JSON.stringify(warnCall[0])).not.toContain(FAKE_TOKEN);
  });

  it('网关返回非 2xx 时打 warn 不抛异常', async () => {
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 429,
      text: async () => '{"ok":false,"error":"device queue is full"}',
    });

    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: '这是一条足够长的测试回复内容',
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
    });
    await flushAsync();

    const warnCall = loggerCalls.warn.find((c) =>
      /语音网关返回非 2xx/.test(c[1] ?? ''),
    );
    expect(warnCall).toBeTruthy();
    expect(warnCall[0].status).toBe(429);
  });

  it('主群未开启开关也不再默认推送', async () => {
    notifyVoice('feishu_main', '这是一条足够长的测试回复内容');
    await flushAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('旧 mac 开关仍兼容为推送开关', async () => {
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: '这是一条足够长的测试回复内容',
      chatJid: 'fs:oc_group',
      groupName: '真实群名',
      containerConfig: { voiceNotify: { mac: true } },
      aliases: { '3号群': 'fs:oc_group' },
    });
    await flushAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const body = JSON.parse(fetchSpy.mock.calls[0][1].body as string);
    expect(body.text).toContain('这是一条足够长的测试回复内容');
    expect(body.group_id).toBe('fs:oc_group');
    expect(body.group_name).toBe('3号群');
  });

  it('群开关关闭时不推送', async () => {
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: '这是一条足够长的测试回复内容',
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { mac: false } },
      aliases: { '3号群': 'fs:oc_group' },
    });
    await flushAsync();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('群标识解析顺序：别名优先，其次群名，最后短 JID', () => {
    expect(
      resolveVoiceGroupLabel({
        chatJid: 'fs:oc_group',
        groupName: '真实群名',
        aliases: { '3号群': 'fs:oc_group' },
      }),
    ).toBe('3号群');
    expect(
      resolveVoiceGroupLabel({
        chatJid: 'fs:oc_group',
        groupName: '真实群名',
        aliases: {},
      }),
    ).toBe('真实群名');
    expect(resolveVoiceGroupLabel({ chatJid: 'fs:oc_abcdef1234567890' })).toBe(
      'oc_abcdef123',
    );
  });

  it('多别名时选最长的（TTS 念"7号群"比单字"7"听得清）', () => {
    expect(
      resolveVoiceGroupLabel({
        chatJid: 'fs:oc_group7',
        groupName: '真实群名',
        aliases: {
          '7': 'fs:oc_group7',
          '7号': 'fs:oc_group7',
          '7号群': 'fs:oc_group7',
          '3号群': 'fs:oc_group3',
        },
      }),
    ).toBe('7号群');
  });

  it('推送判断必须同时满足开关和有效文本', () => {
    expect(
      shouldNotifyPushover({
        groupFolder: 'feishu_a',
        text: '足够长的',
        containerConfig: { voiceNotify: { push: true } },
      }),
    ).toBe(true);
    expect(
      shouldNotifyPushover({
        groupFolder: 'feishu_a',
        text: '[图片: /tmp/a.png]',
        containerConfig: { voiceNotify: { push: true } },
      }),
    ).toBe(false);
    expect(
      shouldNotifyPushover({
        groupFolder: 'feishu_a',
        text: '足够长的',
        containerConfig: { voiceNotify: { push: false } },
      }),
    ).toBe(false);
  });

  it('播报文本带群标识且按长度截断', () => {
    expect(buildSpokenText('搞定了')).toBe('搞定了');
    expect(buildSpokenText('a'.repeat(2000)).length).toBe(1024);
  });

  it('conversationContext 传到 LLM：user message 包含对话上下文', async () => {
    mockDashscopeKey = 'test-key';
    // OpenAI client 内部用 fetch，fetchSpy 会截获 LLM 调用
    // mock 一个有效的 LLM 响应，这样能走完整条链路到网关推送
    fetchSpy.mockImplementation(async (url: string) => {
      if (String(url).includes('example.com')) {
        // LLM 调用：返回有效的 OpenAI chat completion 格式
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () =>
            JSON.stringify({
              choices: [
                { message: { content: '关于修复登录超时，已完成三处修改。' } },
              ],
            }),
          json: async () => ({
            choices: [
              { message: { content: '关于修复登录超时，已完成三处修改。' } },
            ],
          }),
        };
      }
      // 网关推送
      return { ok: true, status: 202, text: async () => '{"ok":true}' };
    });

    const longText = '修复完成，' + '详细步骤说明'.repeat(30);
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: longText,
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
      conversationContext:
        '[对话上下文]\n[当前任务] 修复登录超时\n[用户消息]\nPR#3257 的 review 意见你看下',
    });
    await flushAsync();

    // 找到发往 LLM 的 fetch 调用（URL 含 example.com）
    const llmCall = fetchSpy.mock.calls.find((c: any[]) =>
      String(c[0]).includes('example.com'),
    );
    expect(llmCall).toBeTruthy();
    const body = JSON.parse(llmCall[1].body as string);
    const userMsg = body.messages?.find(
      (m: { role: string }) => m.role === 'user',
    );
    expect(userMsg).toBeTruthy();
    expect(userMsg.content).toContain('[对话上下文]');
    expect(userMsg.content).toContain('修复登录超时');
    expect(userMsg.content).toContain('PR#3257');
    // 正文也在
    expect(userMsg.content).toContain('修复完成');
  });
});

describe('sanitizeForSpeech TTS 清洗', () => {
  it('剥掉标题井号和 PR 编号里的井号', () => {
    expect(sanitizeForSpeech('## 修复完成')).toBe('修复完成');
    expect(sanitizeForSpeech('已合并 PR#3149')).toBe('已合并 PR 3149');
  });

  it('Markdown 链接只留文字，裸 URL 整个删掉', () => {
    expect(sanitizeForSpeech('详见[复盘文档](https://example.com/a/b)')).toBe(
      '详见复盘文档',
    );
    expect(
      sanitizeForSpeech('地址 https://api.saltapp.cn/voice/api/push 已部署'),
    ).toBe('地址 已部署');
  });

  it('代码块整块去掉，行内代码留内容', () => {
    expect(sanitizeForSpeech('运行 `npm test` 即可')).toBe(
      '运行 npm test 即可',
    );
    expect(
      sanitizeForSpeech('改动如下\n```js\nconst a = 1;\n```\n测试通过'),
    ).toBe('改动如下。测试通过');
  });

  it('粗体星号、列表符号、表格竖线清掉', () => {
    expect(sanitizeForSpeech('**重要**：先备份')).toBe('重要：先备份');
    expect(sanitizeForSpeech('- 第一项\n- 第二项')).toBe('第一项。第二项');
    expect(sanitizeForSpeech('| 名称 | 状态 |')).toBe('名称 状态');
  });

  it('正常中文不受影响', () => {
    expect(sanitizeForSpeech('搞定了，测试全过。')).toBe('搞定了，测试全过。');
  });
});

describe('needsSummarization 短文本跳过 LLM', () => {
  it('短回复不走摘要（防 prompt 示例泄漏：2026-06-11"在，听到了。"被播成 3812号PR）', () => {
    expect(needsSummarization('在，听到了。')).toBe(false);
    expect(needsSummarization('搞定了。')).toBe(false);
  });

  it('长文本走摘要', () => {
    expect(needsSummarization('我'.repeat(SUMMARY_MIN_CHARS))).toBe(true);
    expect(
      needsSummarization(
        '修复完成了，根因是网关重启后 undici 只触发 error 不触发 close，重连逻辑挂在 close 上永远不会执行，现在两个事件都挂了。',
      ),
    ).toBe(true);
  });

  it('阈值边界：恰好少一字不摘要', () => {
    expect(needsSummarization('字'.repeat(SUMMARY_MIN_CHARS - 1))).toBe(false);
  });
});

describe('classifyIntent 意图分类器（v3）', () => {
  // ── action：需要用户拍板 ──
  it('含"你决定/确认/拍板" → action', () => {
    expect(classifyIntent('两个方案你决定用哪个？方案A快但风险高，方案B稳。')).toBe('action');
    expect(classifyIntent('需要你确认一下这个PR是否可以合并。')).toBe('action');
    expect(classifyIntent('你看先搞哪个？A是修bug，B是加功能。')).toBe('action');
    expect(classifyIntent('批不批？批了我就开worktree搞。')).toBe('action');
  });

  it('含选项结构 → action', () => {
    expect(classifyIntent('有两个方案：方案一是重构，方案二是打补丁。你选哪个？')).toBe('action');
  });

  // ── navigate：长文导航 ──
  it('>=500 字 → navigate', () => {
    const text = '分析结果如下，' + '详细内容'.repeat(200);
    expect(classifyIntent(text)).toBe('navigate');
  });

  it('>=300 字含方案/复盘关键词 → navigate', () => {
    const text = '这个方案的核心思路是' + '详细分析'.repeat(100);
    expect(classifyIntent(text)).toBe('navigate');
  });

  it('3+ 个标题 → navigate', () => {
    const text = '## 背景\n内容\n## 方案\n内容\n## 风险\n内容\n## 结论\n完成';
    expect(classifyIntent(text)).toBe('navigate');
  });

  it('3+ 列表段且 >=300 字 → navigate', () => {
    const text =
      '操作步骤：\n' +
      Array.from({ length: 50 }, (_, i) => `- 第${i + 1}步详细说明`).join('\n');
    expect(classifyIntent(text)).toBe('navigate');
  });

  // ── silent：代码/表格噪音占主体 ──
  it('代码块占比 >40% → silent', () => {
    const code = '```js\n' + 'const a = 1;\n'.repeat(20) + '```';
    const text = '改好了\n' + code;
    expect(classifyIntent(text)).toBe('silent');
  });

  it('长代码块（>500字）→ silent 不是 navigate（P1 修复）', () => {
    const code = '```python\n' + 'result = process(data)\n'.repeat(50) + '```';
    const text = '执行结果：\n' + code;
    expect(text.length).toBeGreaterThan(500);
    expect(classifyIntent(text)).toBe('silent');
  });

  it('长表格（>500字）→ silent 不是 navigate', () => {
    const header = '| 名称 | 状态 | 耗时 |\n|---|---|---|\n';
    const rows = '| task_001 | success | 12ms |\n'.repeat(30);
    const text = '测试报告：\n' + header + rows;
    expect(text.length).toBeGreaterThan(500);
    expect(classifyIntent(text)).toBe('silent');
  });

  it('代码块占比 <40%（短代码+长说明）→ tech_status', () => {
    const text = '修复完成，根因是网关重启后连接丢失。\n```js\nfix()\n```\n测试已通过，部署到dev环境没有报错。';
    expect(classifyIntent(text)).toBe('tech_status');
  });

  // ── tech_status：技术汇报 ──
  it('中等长度含技术信号 → tech_status', () => {
    expect(
      classifyIntent(
        '修复完成了，根因是网关重启后 undici 只触发 error 不触发 close，重连逻辑挂在 close 上永远不会执行，现在两个事件都挂了。',
      ),
    ).toBe('tech_status');
  });

  it('含 PR/deploy/测试 → tech_status', () => {
    expect(
      classifyIntent('已合并PR并部署到dev环境，E2E测试全部通过，没有遗留问题。'),
    ).toBe('tech_status');
  });

  // ── notify：短通知（默认） ──
  it('短纯文本 → notify', () => {
    expect(classifyIntent('搞定了。')).toBe('notify');
    expect(classifyIntent('好的，收到。')).toBe('notify');
    expect(classifyIntent('在，听到了。')).toBe('notify');
  });

  // ── 优先级：action > silent > navigate ──
  it('带表格的决策方案 → action（不是 silent）', () => {
    const text = '对比如下：\n| 方案 | 优势 |\n|---|---|\n| A | 快 |\n| B | 稳 |\n你决定用哪个？';
    expect(classifyIntent(text)).toBe('action');
  });

  it('带代码的决策 → action（不是 silent）', () => {
    const text = '两种修法：\n```js\nfixA()\n```\n```js\nfixB()\n```\n你选哪个？';
    expect(classifyIntent(text)).toBe('action');
  });

  // ── classifyContent 兼容别名 ──
  it('classifyContent 是 classifyIntent 的别名', () => {
    expect(classifyContent).toBe(classifyIntent);
  });

  // ── v3 意图分流日志 ──
  it('notifyVoice 走 v3 意图分流日志（不需要 summaryV2 开关）', async () => {
    mockDashscopeKey = 'test-key';
    const longText = '## 方案\n' + '详细内容'.repeat(200) + '\n## 结论\n完成';
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: longText,
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
    });
    await flushAsync();
    const v3Log = loggerCalls.info.find(
      (c) => /v3 意图分流/.test(c[1] ?? '') && c[0].chars === longText.length,
    );
    expect(v3Log).toBeTruthy();
    expect(v3Log[0].intent).toBe('navigate');
  });
});

// ── VOICE_SUMMARY_VERSION=off kill-switch 测试 ──
// getVoiceSummaryVersion() 运行时读 env，无需 resetModules
describe('VOICE_SUMMARY_VERSION=off kill-switch', () => {
  let savedVersion: string | undefined;
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    savedVersion = process.env.VOICE_SUMMARY_VERSION;
    loggerCalls.warn = [];
    loggerCalls.info = [];
    loggerCalls.debug = [];
    mockDashscopeKey = 'test-key'; // 有 key 才会走到 version 判断

    delete process.env.VOICE_GATEWAY_TOKEN;
    mockEnvFile.VOICE_GATEWAY_TOKEN = 'test-token';

    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 202,
      text: async () => '{"ok":true}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedVersion !== undefined) process.env.VOICE_SUMMARY_VERSION = savedVersion;
    else delete process.env.VOICE_SUMMARY_VERSION;
    delete mockEnvFile.VOICE_GATEWAY_TOKEN;
  });

  it('off 模式跳过 LLM，不产生 v3 意图分流日志', async () => {
    process.env.VOICE_SUMMARY_VERSION = 'off';

    const longText = '这是一段需要摘要的较长文本，' + '详细内容说明'.repeat(20);
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: longText,
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
    });
    await flushAsync();

    // 不应有 v3 意图分流日志
    const v3Log = loggerCalls.info.find((c) =>
      c.some((arg: any) => /v3 意图分流/.test(String(arg))),
    );
    expect(v3Log).toBeFalsy();

    // 应有 off 模式日志
    const offLog = loggerCalls.info.find((c) =>
      c.some((arg: any) => /摘要已关闭/.test(String(arg))),
    );
    expect(offLog).toBeTruthy();

    // fetch 只有网关推送，无 LLM 调用（URL 不含 example.com）
    const llmCall = fetchSpy.mock.calls.find((c: any[]) =>
      String(c[0]).includes('example.com'),
    );
    expect(llmCall).toBeFalsy();
  });

  it('默认 v3 模式正常走 LLM 摘要', async () => {
    delete process.env.VOICE_SUMMARY_VERSION; // 默认 v3

    // mock LLM 响应
    fetchSpy.mockImplementation(async (url: any) => {
      if (String(url).includes('example.com')) {
        return {
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: async () => JSON.stringify({ choices: [{ message: { content: '测试摘要' } }] }),
          json: async () => ({ choices: [{ message: { content: '测试摘要' } }] }),
        };
      }
      return { ok: true, status: 202, text: async () => '{"ok":true}' };
    });

    const longText = '这是一段需要摘要的较长文本，' + '详细内容说明'.repeat(20);
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: longText,
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true } },
    });
    await flushAsync();

    // 应有 v3 意图分流日志
    const v3Log = loggerCalls.info.find((c) => /v3 意图分流/.test(c[1] ?? ''));
    expect(v3Log).toBeTruthy();
  });
});
