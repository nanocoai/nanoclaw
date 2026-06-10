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
  notifyVoice,
  resolveVoiceGroupLabel,
  shouldNotifyPushover,
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
    if (savedToken !== undefined)
      process.env.VOICE_GATEWAY_TOKEN = savedToken;
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
});
