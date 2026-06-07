/**
 * voice-notify 测试 — 核心验证：process.env 没有 PUSHOVER token 但 .env 可读时，
 * 仍能通过 readEnvFile 拿到 token 完成推送。这正是「自动播报收不到」的真根因复现。
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
const loggerCalls = { warn: [] as any[], info: [] as any[], debug: [] as any[] };
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

import { notifyVoice } from './voice-notify.js';

/** 等 fire-and-forget 的异步 IIFE 跑完 */
async function flushAsync() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setImmediate(r));
}

describe('voice-notify 推送 token 来源', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let savedUserKey: string | undefined;
  let savedAppToken: string | undefined;

  beforeEach(() => {
    loggerCalls.warn = [];
    loggerCalls.info = [];
    loggerCalls.debug = [];
    mockDashscopeKey = '';
    // 备份并清空 process.env 里的 PUSHOVER token，模拟 launchd 环境
    savedUserKey = process.env.PUSHOVER_USER_KEY;
    savedAppToken = process.env.PUSHOVER_APP_TOKEN;
    delete process.env.PUSHOVER_USER_KEY;
    delete process.env.PUSHOVER_APP_TOKEN;
    // .env 里有 token
    mockEnvFile.PUSHOVER_USER_KEY = 'u'.repeat(30);
    mockEnvFile.PUSHOVER_APP_TOKEN = 'a'.repeat(30);

    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => '{"status":1}',
    }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (savedUserKey !== undefined) process.env.PUSHOVER_USER_KEY = savedUserKey;
    if (savedAppToken !== undefined) process.env.PUSHOVER_APP_TOKEN = savedAppToken;
    delete mockEnvFile.PUSHOVER_USER_KEY;
    delete mockEnvFile.PUSHOVER_APP_TOKEN;
  });

  it('process.env 无 token 但 .env 可读时，仍用 .env 的 token 推送', async () => {
    notifyVoice('feishu_main', '这是一条足够长的测试回复内容');
    await flushAsync();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0];
    expect(url).toContain('pushover.net');
    const body = (opts.body as URLSearchParams).toString();
    expect(body).toContain('token=' + 'a'.repeat(30));
    expect(body).toContain('user=' + 'u'.repeat(30));
    // 没有走「缺 token 跳过」分支
    expect(loggerCalls.warn.some((c) => /缺 PUSHOVER token/.test(c[1] ?? ''))).toBe(false);
  });

  it('process.env 和 .env 都没有 token 时，warn 跳过且只打布尔不打密钥', async () => {
    delete mockEnvFile.PUSHOVER_USER_KEY;
    delete mockEnvFile.PUSHOVER_APP_TOKEN;

    notifyVoice('feishu_main', '这是一条足够长的测试回复内容');
    await flushAsync();

    expect(fetchSpy).not.toHaveBeenCalled();
    const warnCall = loggerCalls.warn.find((c) => /缺 PUSHOVER token/.test(c[1] ?? ''));
    expect(warnCall).toBeTruthy();
    // 第一个参数是结构化对象，只含布尔，不含密钥字符串
    expect(warnCall[0]).toEqual({ hasUserKey: false, hasAppToken: false });
    expect(JSON.stringify(warnCall[0])).not.toContain('u'.repeat(30));
  });

  it('非主会话不推送', async () => {
    notifyVoice('some_other_group', '这是一条足够长的测试回复内容');
    await flushAsync();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
