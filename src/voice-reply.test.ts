/**
 * voice-reply 测试 — 核心验证 handleGatewayMessage 的注入/丢弃逻辑：
 * - reply + 已注册 group_id → 注入 + 飞书回显
 * - group_id 缺失/未注册 → 丢弃且记日志（spec：防误注入别的群）
 * - 非 reply / 空文本 / 坏 JSON → 忽略
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const loggerCalls = { warn: [] as any[], info: [] as any[] };
vi.mock('./logger.js', () => ({
  logger: {
    warn: (...a: any[]) => loggerCalls.warn.push(a),
    info: (...a: any[]) => loggerCalls.info.push(a),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));
vi.mock('./env.js', () => ({ readEnvFile: () => ({}) }));

import {
  handleGatewayMessage,
  buildEchoText,
  type VoiceReplyDeps,
} from './voice-reply.js';

function makeDeps(registered = ['fs:oc_group']): {
  deps: VoiceReplyDeps;
  injected: Array<[string, string]>;
  echoed: Array<[string, string]>;
} {
  const injected: Array<[string, string]> = [];
  const echoed: Array<[string, string]> = [];
  return {
    injected,
    echoed,
    deps: {
      isRegisteredGroup: (jid) => registered.includes(jid),
      injectMessage: (jid, text) => injected.push([jid, text]),
      echoToFeishu: async (jid, text) => {
        echoed.push([jid, text]);
      },
    },
  };
}

describe('voice-reply 网关消息处理', () => {
  beforeEach(() => {
    loggerCalls.warn = [];
    loggerCalls.info = [];
  });

  it('reply + 已注册 group_id → 注入并回显', async () => {
    const { deps, injected, echoed } = makeDeps();
    const result = handleGatewayMessage(
      JSON.stringify({
        type: 'reply',
        group_id: 'fs:oc_group',
        group_name: '3号群',
        text: '帮我看下部署状态',
      }),
      deps,
    );
    expect(result).toBe('injected');
    expect(injected).toEqual([['fs:oc_group', '帮我看下部署状态']]);
    // 回显是异步 fire-and-forget
    await Promise.resolve();
    expect(echoed).toEqual([
      ['fs:oc_group', '🎤 大杰（语音）：帮我看下部署状态'],
    ]);
  });

  it('group_id 未注册 → 丢弃且 warn，不注入', () => {
    const { deps, injected, echoed } = makeDeps();
    const result = handleGatewayMessage(
      JSON.stringify({
        type: 'reply',
        group_id: 'fs:oc_unknown',
        text: '随便说点什么',
      }),
      deps,
    );
    expect(result).toBe('dropped');
    expect(injected).toEqual([]);
    expect(echoed).toEqual([]);
    expect(
      loggerCalls.warn.some((c) => /不是已注册群/.test(c[1] ?? '')),
    ).toBe(true);
  });

  it('group_id 缺失（null）→ 丢弃', () => {
    const { deps, injected } = makeDeps();
    const result = handleGatewayMessage(
      JSON.stringify({ type: 'reply', group_id: null, text: '没有群上下文' }),
      deps,
    );
    expect(result).toBe('dropped');
    expect(injected).toEqual([]);
  });

  it('非 reply 类型（hello/dispatched/done）→ 忽略', () => {
    const { deps, injected } = makeDeps();
    for (const type of ['hello', 'dispatched', 'done', 'device_online']) {
      expect(
        handleGatewayMessage(JSON.stringify({ type }), deps),
      ).toBe('ignored');
    }
    expect(injected).toEqual([]);
    expect(loggerCalls.warn).toEqual([]);
  });

  it('空文本 / 纯空白 → 忽略', () => {
    const { deps, injected } = makeDeps();
    expect(
      handleGatewayMessage(
        JSON.stringify({ type: 'reply', group_id: 'fs:oc_group', text: '  ' }),
        deps,
      ),
    ).toBe('ignored');
    expect(injected).toEqual([]);
  });

  it('坏 JSON → 忽略不抛', () => {
    const { deps } = makeDeps();
    expect(handleGatewayMessage('not json{{', deps)).toBe('ignored');
  });

  it('回显失败不影响注入结果', async () => {
    const { deps, injected } = makeDeps();
    deps.echoToFeishu = async () => {
      throw new Error('feishu down');
    };
    const result = handleGatewayMessage(
      JSON.stringify({
        type: 'reply',
        group_id: 'fs:oc_group',
        text: '回显挂了也要注入',
      }),
      deps,
    );
    expect(result).toBe('injected');
    expect(injected.length).toBe(1);
    await new Promise((r) => setImmediate(r));
    expect(
      loggerCalls.warn.some((c) => /飞书回显失败/.test(c[1] ?? '')),
    ).toBe(true);
  });

  it('buildEchoText 格式符合 spec', () => {
    expect(buildEchoText('你好')).toBe('🎤 大杰（语音）：你好');
  });
});
