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

describe('classifyContent 内容分类器', () => {
  it('短纯文本 → concise', () => {
    expect(classifyContent('搞定了，已经合并并部署到 dev 环境。')).toBe(
      'concise',
    );
    expect(classifyContent('我'.repeat(100))).toBe('concise');
  });

  it('有代码块 → skip_code（不管长度）', () => {
    expect(classifyContent('改好了\n```js\nconst a = 1;\n```\n测试通过')).toBe(
      'skip_code',
    );
    // 哪怕很短也走 skip_code
    expect(classifyContent('```x\na\n```')).toBe('skip_code');
  });

  it('有表格 → skip_table', () => {
    expect(
      classifyContent('对比如下：\n| 方案 | 优势 |\n|---|---|\n| A | 快 |'),
    ).toBe('skip_table');
  });

  it('代码块优先于表格', () => {
    const text = '```js\ncode\n```\n\n| a | b |\n|---|---|';
    expect(classifyContent(text)).toBe('skip_code');
  });

  it('有 ## 标题且 >=300 字 → navigate', () => {
    const text = '## 总结\n' + '内容'.repeat(200) + '\n## 下一步\n继续';
    expect(classifyContent(text)).toBe('navigate');
  });

  it('有 ## 标题但 <300 字 → concise（短文档不需要导航）', () => {
    expect(classifyContent('## 结论\n搞定了。')).toBe('concise');
  });

  it('>=300 字纯文本无结构 → digest', () => {
    const text = '分析'.repeat(200);
    expect(classifyContent(text)).toBe('digest');
  });

  it('>=300 字有列表但无标题 → digest', () => {
    const text =
      '操作步骤：\n' +
      Array.from({ length: 50 }, (_, i) => `- 第${i + 1}步`).join('\n');
    expect(classifyContent(text)).toBe('digest');
  });

  it('v2 灰度：summaryV2=true 时 notifyVoice 走分流日志', async () => {
    // 需要给 dashscope key 才能走到分流逻辑（否则提前 fallback 跳过摘要）
    mockDashscopeKey = 'test-key';
    const longText = '## 方案\n' + '详细内容'.repeat(200) + '\n## 结论\n完成';
    notifyVoice({
      groupFolder: 'feishu_some_group',
      text: longText,
      chatJid: 'fs:oc_group',
      containerConfig: { voiceNotify: { push: true, summaryV2: true } },
    });
    await flushAsync();
    // v2 分流日志应该被记录（LLM 调用会失败，但分流日志在 LLM 调用前）
    const v2Log = loggerCalls.info.find((c) => /v2 摘要分流/.test(c[1] ?? ''));
    expect(v2Log).toBeTruthy();
    expect(v2Log[0].category).toBe('navigate');
  });
});
