import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import os from 'os';

import {
  mapCodexUsage,
  readCodexModelInfo,
  parseCodexEventLine,
  buildCodexArgs,
  extractCodexError,
  type CodexModelInfo,
  type CodexEvent,
} from './codex-runner.js';

describe('parseCodexEventLine', () => {
  it('解析合法 JSON 行', () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":100}}';
    const result = parseCodexEventLine(line);
    expect(result).toEqual({ type: 'turn.completed', usage: { input_tokens: 100 } });
  });

  it('空行返回 null', () => {
    expect(parseCodexEventLine('')).toBeNull();
    expect(parseCodexEventLine('   ')).toBeNull();
  });

  it('非 JSON 返回 null', () => {
    expect(parseCodexEventLine('not json')).toBeNull();
  });

  it('无 type 字段返回 null', () => {
    expect(parseCodexEventLine('{"foo":"bar"}')).toBeNull();
  });
});

describe('mapCodexUsage', () => {
  it('usage 为 undefined 返回 undefined', () => {
    expect(mapCodexUsage(undefined)).toBeUndefined();
  });

  it('无 modelInfo 时使用 event.usage（累计值 fallback）', () => {
    const usage: CodexEvent['usage'] = {
      input_tokens: 383000000,
      cached_input_tokens: 359000000,
      output_tokens: 869000,
    };
    const result = mapCodexUsage(usage);
    expect(result!.inputTokens).toBe(383000000);
    expect(result!.cacheReadInputTokens).toBe(359000000);
    expect(result!.outputTokens).toBe(869000);
    expect(result!.lastTurnContext).toBe(383000000 + 359000000);
  });

  it('有 lastTurnUsage 时优先使用单轮值', () => {
    const eventUsage: CodexEvent['usage'] = {
      input_tokens: 383000000,
      cached_input_tokens: 359000000,
      output_tokens: 869000,
    };
    const modelInfo: CodexModelInfo = {
      model: 'gpt-5.6-sol',
      modelContextWindow: 353400,
      lastTurnContext: 13128,
      lastTurnUsage: {
        input_tokens: 13128,
        cached_input_tokens: 9984,
        output_tokens: 18,
      },
    };
    const result = mapCodexUsage(eventUsage, modelInfo);
    expect(result!.inputTokens).toBe(13128);
    expect(result!.cacheReadInputTokens).toBe(9984);
    expect(result!.outputTokens).toBe(18);
    expect(result!.lastTurnContext).toBe(13128);
    expect(result!.model).toBe('gpt-5.6-sol');
    expect(result!.modelContextWindows).toEqual({ 'gpt-5.6-sol': 353400 });
  });

  it('modelInfo 无 lastTurnUsage 时 fallback 到 event.usage', () => {
    const eventUsage: CodexEvent['usage'] = {
      input_tokens: 5000,
      cached_input_tokens: 3000,
      output_tokens: 200,
    };
    const modelInfo: CodexModelInfo = {
      model: 'gpt-5.6-sol',
      lastTurnContext: 4500,
    };
    const result = mapCodexUsage(eventUsage, modelInfo);
    expect(result!.inputTokens).toBe(5000);
    expect(result!.outputTokens).toBe(200);
    expect(result!.lastTurnContext).toBe(4500);
  });

  it('effort 写入结果', () => {
    const result = mapCodexUsage({ input_tokens: 100 }, undefined, 'ultra');
    expect(result!.effort).toBe('ultra');
  });

  it('无 effort 时不设置字段', () => {
    const result = mapCodexUsage({ input_tokens: 100 });
    expect(result!.effort).toBeUndefined();
  });
});

describe('readCodexModelInfo', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('sessions 目录不存在返回空', () => {
    const result = readCodexModelInfo(tmpDir, 'thread-123');
    expect(result).toEqual({});
  });

  it('无匹配 rollout 返回空', () => {
    fs.mkdirSync(path.join(tmpDir, 'sessions', '2026', '07', '10'), { recursive: true });
    const result = readCodexModelInfo(tmpDir, 'nonexistent-thread');
    expect(result).toEqual({});
  });

  it('首轮单次调用：turnUsage = total 本身', () => {
    const threadId = '019f4aab-d3cd-7143-b579-f447faaea015';
    const sessDir = path.join(tmpDir, 'sessions', '2026', '07', '10');
    fs.mkdirSync(sessDir, { recursive: true });

    const rolloutLines = [
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol', model_context_window: 353400 },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 13128, cached_input_tokens: 9984, output_tokens: 18 },
            last_token_usage: { input_tokens: 13128, cached_input_tokens: 9984, output_tokens: 18 },
            model_context_window: 353400,
          },
        },
      }),
    ];
    fs.writeFileSync(
      path.join(sessDir, `rollout-2026-07-10T14-16-42-${threadId}.jsonl`),
      rolloutLines.join('\n'),
    );

    const result = readCodexModelInfo(tmpDir, threadId);
    expect(result.model).toBe('gpt-5.6-sol');
    expect(result.modelContextWindow).toBe(353400);
    expect(result.lastTurnContext).toBe(13128);
    expect(result.lastTurnUsage).toEqual({
      input_tokens: 13128,
      cached_input_tokens: 9984,
      output_tokens: 18,
    });
  });

  it('多次调用同一 turn：turnUsage = 增量（total_end - baseline）', () => {
    const threadId = 'test-multi-call';
    const sessDir = path.join(tmpDir, 'sessions', '2026', '07', '10');
    fs.mkdirSync(sessDir, { recursive: true });

    // 模拟一个 turn 中 3 次模型调用：初始推理 → 工具 → 再推理
    const rolloutLines = [
      JSON.stringify({
        type: 'turn_context',
        payload: { model: 'gpt-5.6-sol' },
      }),
      // 第 1 次调用
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500 },
            last_token_usage: { input_tokens: 10000, cached_input_tokens: 8000, output_tokens: 500 },
          },
        },
      }),
      // 第 2 次调用（工具后再推理）
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 22000, cached_input_tokens: 16000, output_tokens: 1200 },
            last_token_usage: { input_tokens: 12000, cached_input_tokens: 8000, output_tokens: 700 },
          },
        },
      }),
      // 第 3 次调用（最终回复）
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 35000, cached_input_tokens: 25000, output_tokens: 1800 },
            last_token_usage: { input_tokens: 13000, cached_input_tokens: 9000, output_tokens: 600 },
          },
        },
      }),
    ];
    fs.writeFileSync(
      path.join(sessDir, `rollout-2026-07-10T00-00-00-${threadId}.jsonl`),
      rolloutLines.join('\n'),
    );

    const result = readCodexModelInfo(tmpDir, threadId);
    // baseline = first_total - first_last = (10000-10000, 8000-8000, 500-500) = (0, 0, 0)
    // turnUsage = latest_total - baseline = (35000, 25000, 1800)
    expect(result.lastTurnUsage).toEqual({
      input_tokens: 35000,
      cached_input_tokens: 25000,
      output_tokens: 1800,
    });
    // lastTurnContext = 最后一次调用的 input（context 占用大小）
    expect(result.lastTurnContext).toBe(13000);
  });

  it('同一 rollout 多个 task（真实 resume）：只算最后一个 task 段增量', () => {
    const threadId = 'test-multi-task-resume';
    const sessDir = path.join(tmpDir, 'sessions', '2026', '07', '10');
    fs.mkdirSync(sessDir, { recursive: true });

    // 同一 rollout 文件包含 2 个完整 task 段（真实 resume 场景）
    const rolloutLines = [
      // === 第 1 轮 task ===
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', model_context_window: 353400 } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 13000, cached_input_tokens: 10000, output_tokens: 500 },
            last_token_usage: { input_tokens: 13000, cached_input_tokens: 10000, output_tokens: 500 },
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 34579, cached_input_tokens: 25000, output_tokens: 1200 },
            last_token_usage: { input_tokens: 21579, cached_input_tokens: 15000, output_tokens: 700 },
          },
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),

      // === 第 2 轮 task（resume） ===
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_started', model_context_window: 353400 } }),
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.6-sol' } }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 47579, cached_input_tokens: 35000, output_tokens: 1800 },
            last_token_usage: { input_tokens: 13000, cached_input_tokens: 10000, output_tokens: 600 },
          },
        },
      }),
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            total_token_usage: { input_tokens: 55630, cached_input_tokens: 42000, output_tokens: 2500 },
            last_token_usage: { input_tokens: 8051, cached_input_tokens: 7000, output_tokens: 700 },
          },
        },
      }),
      JSON.stringify({ type: 'event_msg', payload: { type: 'task_complete' } }),
    ];
    fs.writeFileSync(
      path.join(sessDir, `rollout-2026-07-10T00-00-00-${threadId}.jsonl`),
      rolloutLines.join('\n'),
    );

    const result = readCodexModelInfo(tmpDir, threadId);
    // 第 2 轮 task_started 重置 snapshot
    // first_total = (47579, 35000, 1800), first_last = (13000, 10000, 600)
    // baseline = (47579-13000, 35000-10000, 1800-600) = (34579, 25000, 1200)
    // latest_total = (55630, 42000, 2500)
    // turnUsage = (55630-34579, 42000-25000, 2500-1200) = (21051, 17000, 1300)
    expect(result.lastTurnUsage).toEqual({
      input_tokens: 21051,
      cached_input_tokens: 17000,
      output_tokens: 1300,
    });
    expect(result.lastTurnContext).toBe(8051);
    expect(result.model).toBe('gpt-5.6-sol');
    expect(result.modelContextWindow).toBe(353400);
  });

  it('缺少 total_token_usage 但有 last_token_usage 时无 turnUsage', () => {
    const threadId = 'test-thread-no-total';
    const sessDir = path.join(tmpDir, 'sessions', '2026', '07', '10');
    fs.mkdirSync(sessDir, { recursive: true });

    const rolloutLines = [
      JSON.stringify({
        type: 'event_msg',
        payload: {
          type: 'token_count',
          info: {
            last_token_usage: { input_tokens: 5000 },
          },
        },
      }),
    ];
    fs.writeFileSync(
      path.join(sessDir, `rollout-2026-07-10T00-00-00-${threadId}.jsonl`),
      rolloutLines.join('\n'),
    );

    const result = readCodexModelInfo(tmpDir, threadId);
    expect(result.lastTurnUsage).toBeUndefined();
    expect(result.lastTurnContext).toBe(5000);
  });

  it('畸形 JSON 行被跳过不崩溃', () => {
    const threadId = 'test-malformed';
    const sessDir = path.join(tmpDir, 'sessions', '2026', '07', '10');
    fs.mkdirSync(sessDir, { recursive: true });

    const rolloutLines = [
      'not valid json {{{',
      '',
      JSON.stringify({ type: 'turn_context', payload: { model: 'gpt-5.5' } }),
    ];
    fs.writeFileSync(
      path.join(sessDir, `rollout-2026-07-10T00-00-00-${threadId}.jsonl`),
      rolloutLines.join('\n'),
    );

    const result = readCodexModelInfo(tmpDir, threadId);
    expect(result.model).toBe('gpt-5.5');
  });
});

describe('buildCodexArgs', () => {
  it('包含 effort 时输出 -c model_reasoning_effort', () => {
    const args = buildCodexArgs({
      model: 'gpt-5.6-sol',
      effort: 'ultra',
      mcpConfigPath: '/tmp/config.toml',
    });
    expect(args).toContain('-c');
    const cIdx = args.indexOf('-c');
    expect(args[cIdx + 1]).toBe('model_reasoning_effort="ultra"');
  });

  it('无 effort 时不输出 -c', () => {
    const args = buildCodexArgs({
      model: 'gpt-5.6-sol',
      mcpConfigPath: '/tmp/config.toml',
    });
    expect(args).not.toContain('model_reasoning_effort="undefined"');
  });
});

describe('extractCodexError', () => {
  it('提取 turn.failed 错误', () => {
    const event: CodexEvent = {
      type: 'turn.failed',
      error: { message: 'rate limit exceeded' },
    };
    const err = extractCodexError(event);
    expect(err).toBe('rate limit exceeded');
  });

  it('非错误事件返回 undefined', () => {
    const event: CodexEvent = { type: 'turn.completed' };
    expect(extractCodexError(event)).toBeUndefined();
  });
});
