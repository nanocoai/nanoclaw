/**
 * SSE 解析器单元测试 — 纯函数，零 mock
 */
import { describe, it, expect } from 'vitest';
import {
  parseSseLines,
  parseSseEvent,
  accumulateSseEvent,
  createMessageAccumulator,
  mapSseEventToProgress,
  mapAccumulatorToResult,
  type SseEvent,
  type MessageStartData,
  type ContentBlockStartData,
  type ContentBlockDeltaData,
  type MessageDeltaData,
} from '../container/agent-runner/src/sse-parser.js';

// ---- parseSseLines ----

describe('parseSseLines', () => {
  it('解析标准 SSE 行', () => {
    const result = parseSseLines([
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_01","model":"claude-3-5-sonnet","usage":{"input_tokens":100,"output_tokens":0}}}',
    ]);
    expect(result).toEqual({
      event: 'message_start',
      data: '{"type":"message_start","message":{"id":"msg_01","model":"claude-3-5-sonnet","usage":{"input_tokens":100,"output_tokens":0}}}',
    });
  });

  it('空行数组返回 null', () => {
    expect(parseSseLines([])).toBeNull();
  });

  it('非 SSE 内容返回 null', () => {
    expect(parseSseLines(['just some text', 'another line'])).toBeNull();
  });

  it('多行 data 拼接', () => {
    const result = parseSseLines([
      'event: content_block_delta',
      'data: {"type":"content_block_delta",',
      'data: "index":0}',
    ]);
    expect(result?.data).toBe('{"type":"content_block_delta",\n"index":0}');
  });

  it('空 data: 行', () => {
    const result = parseSseLines(['event: ping', 'data:']);
    expect(result).toEqual({ event: 'ping', data: '' });
  });
});

// ---- parseSseEvent ----

describe('parseSseEvent', () => {
  it('解析 message_start 事件', () => {
    const data = '{"type":"message_start","message":{"id":"msg_01","model":"claude-3-5-sonnet","usage":{"input_tokens":100,"output_tokens":0}}}';
    const result = parseSseEvent('message_start', data);
    expect(result).toEqual({
      type: 'message_start',
      data: JSON.parse(data),
    });
  });

  it('解析 ping 事件（无 data）', () => {
    const result = parseSseEvent('ping', '');
    expect(result).toEqual({ type: 'ping', data: null });
  });

  it('解析 error 事件', () => {
    const result = parseSseEvent('error', '{"error":{"message":"rate limited"}}');
    expect(result).toEqual({
      type: 'error',
      data: { error: { message: 'rate limited' } },
    });
  });

  it('error 事件非 JSON 回退', () => {
    const result = parseSseEvent('error', 'some error text');
    expect(result).toEqual({
      type: 'error',
      data: { message: 'some error text' },
    });
  });

  it('畸形 JSON 返回 null', () => {
    expect(parseSseEvent('message_start', '{invalid json')).toBeNull();
  });

  it('空 data 返回 null', () => {
    expect(parseSseEvent('message_start', '')).toBeNull();
  });

  it('未知事件类型返回 null', () => {
    expect(parseSseEvent('unknown_event', '{"foo":"bar"}')).toBeNull();
  });
});

// ---- accumulateSseEvent ----

describe('accumulateSseEvent', () => {
  it('message_start 提取 model 和 usage', () => {
    const acc = createMessageAccumulator();
    const event: SseEvent = {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: {
          id: 'msg_01',
          model: 'claude-3-5-sonnet',
          usage: {
            input_tokens: 100,
            output_tokens: 5,
            cache_read_input_tokens: 50,
            cache_creation_input_tokens: 20,
          },
        },
      } as MessageStartData,
    };

    const next = accumulateSseEvent(acc, event);
    expect(next.model).toBe('claude-3-5-sonnet');
    expect(next.messageId).toBe('msg_01');
    expect(next.usage.inputTokens).toBe(100);
    expect(next.usage.outputTokens).toBe(5);
    expect(next.usage.cacheReadInputTokens).toBe(50);
    expect(next.usage.cacheCreationInputTokens).toBe(20);
    expect(next.done).toBe(false);
  });

  it('content_block_start text 类型', () => {
    const acc = createMessageAccumulator();
    const event: SseEvent = {
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      } as ContentBlockStartData,
    };

    const next = accumulateSseEvent(acc, event);
    expect(next.blocks.get(0)).toEqual({ type: 'text', text: '' });
  });

  it('content_block_start tool_use 类型', () => {
    const acc = createMessageAccumulator();
    const event: SseEvent = {
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash', input: {} },
      } as ContentBlockStartData,
    };

    const next = accumulateSseEvent(acc, event);
    const block = next.blocks.get(1);
    expect(block).toEqual({ type: 'tool_use', id: 'toolu_01', name: 'Bash', inputJson: '' });
  });

  it('content_block_delta 累积文本', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } } as ContentBlockDeltaData,
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ' World' } } as ContentBlockDeltaData,
    });

    const block = acc.blocks.get(0);
    expect(block?.type).toBe('text');
    if (block?.type === 'text') {
      expect(block.text).toBe('Hello World');
    }
  });

  it('content_block_delta 累积 tool input JSON', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: {
        type: 'content_block_start', index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash' },
      },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"com' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'mand":"ls"}' } },
    });

    const block = acc.blocks.get(0);
    expect(block?.type).toBe('tool_use');
    if (block?.type === 'tool_use') {
      expect(block.inputJson).toBe('{"command":"ls"}');
      expect(block.name).toBe('Bash');
    }
  });

  it('message_delta 提取 stop_reason 和 output_tokens', () => {
    const acc = createMessageAccumulator();
    const next = accumulateSseEvent(acc, {
      type: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 42 },
      } as MessageDeltaData,
    });

    expect(next.stopReason).toBe('end_turn');
    expect(next.usage.outputTokens).toBe(42);
  });

  it('message_stop 标记 done', () => {
    const acc = createMessageAccumulator();
    const next = accumulateSseEvent(acc, {
      type: 'message_stop',
      data: { type: 'message_stop' },
    });
    expect(next.done).toBe(true);
  });

  it('error 事件标记 done + error', () => {
    const acc = createMessageAccumulator();
    const next = accumulateSseEvent(acc, {
      type: 'error',
      data: { error: { message: 'rate limited' } },
    });
    expect(next.done).toBe(true);
    expect(next.error).toBe('rate limited');
  });

  it('ping 事件不修改状态', () => {
    const acc = createMessageAccumulator();
    const next = accumulateSseEvent(acc, { type: 'ping', data: null });
    expect(next).toEqual(acc);
  });

  it('不修改原始累积器（immutable）', () => {
    const acc = createMessageAccumulator();
    const next = accumulateSseEvent(acc, {
      type: 'message_start',
      data: {
        type: 'message_start',
        message: { id: 'msg_01', model: 'sonnet', usage: { input_tokens: 100, output_tokens: 0 } },
      },
    });
    expect(acc.model).toBe('');
    expect(next.model).toBe('sonnet');
  });

  it('delta 到不存在的 block index 不报错', () => {
    const acc = createMessageAccumulator();
    const next = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 99, delta: { type: 'text_delta', text: 'orphan' } },
    });
    expect(next.blocks.size).toBe(0); // 不创建新 block
  });

  it('多轮 usage 累积', () => {
    let acc = createMessageAccumulator();
    // 第一轮 message_start
    acc = accumulateSseEvent(acc, {
      type: 'message_start',
      data: { type: 'message_start', message: { id: 'msg_01', model: 'sonnet', usage: { input_tokens: 100, output_tokens: 0 } } },
    });
    // 第一轮 message_delta
    acc = accumulateSseEvent(acc, {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 50 } },
    });
    // 第二轮 message_start（tool_use 后的新请求）
    acc = accumulateSseEvent(acc, {
      type: 'message_start',
      data: { type: 'message_start', message: { id: 'msg_02', model: 'sonnet', usage: { input_tokens: 200, output_tokens: 0 } } },
    });
    // 第二轮 message_delta
    acc = accumulateSseEvent(acc, {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 30 } },
    });

    expect(acc.usage.inputTokens).toBe(300);   // 100 + 200
    expect(acc.usage.outputTokens).toBe(80);    // 50 + 30
  });
});

// ---- mapSseEventToProgress ----

describe('mapSseEventToProgress', () => {
  it('tool_use block_start 生成进度', () => {
    const result = mapSseEventToProgress({
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'Bash' },
      },
    });
    expect(result).toEqual({
      status: 'progress',
      result: '🔧 Bash',
      progressType: 'tool_use',
    });
  });

  it('Read 工具用 📖 emoji', () => {
    const result = mapSseEventToProgress({
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'Read' },
      },
    });
    expect(result?.result).toBe('📖 Read');
  });

  it('text block_start 不生成进度', () => {
    const result = mapSseEventToProgress({
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      },
    });
    expect(result).toBeNull();
  });

  it('非 content_block_start 事件返回 null', () => {
    expect(mapSseEventToProgress({ type: 'message_start', data: {} })).toBeNull();
    expect(mapSseEventToProgress({ type: 'content_block_delta', data: {} })).toBeNull();
    expect(mapSseEventToProgress({ type: 'message_stop', data: {} })).toBeNull();
  });

  it('未知工具用 ⚙️ emoji', () => {
    const result = mapSseEventToProgress({
      type: 'content_block_start',
      data: {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_01', name: 'CustomTool' },
      },
    });
    expect(result?.result).toBe('⚙️ CustomTool');
  });
});

// ---- mapAccumulatorToResult ----

describe('mapAccumulatorToResult', () => {
  it('正常完成 → success', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'message_start',
      data: { type: 'message_start', message: { id: 'msg_01', model: 'sonnet', usage: { input_tokens: 100, output_tokens: 0 } } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '好' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'message_delta',
      data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 1 } },
    });
    acc = accumulateSseEvent(acc, { type: 'message_stop', data: {} });

    const result = mapAccumulatorToResult(acc, 'session_123', 1, 5000);
    expect(result.status).toBe('success');
    expect(result.result).toBe('好');
    expect(result.newSessionId).toBe('session_123');
    expect(result.usage?.inputTokens).toBe(100);
    expect(result.usage?.outputTokens).toBe(1);
    expect(result.usage?.model).toBe('sonnet');
    expect(result.usage?.numTurns).toBe(1);
    expect(result.usage?.durationMs).toBe(5000);
  });

  it('error → error status', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'error',
      data: { error: { message: 'overloaded' } },
    });

    const result = mapAccumulatorToResult(acc, 'session_123');
    expect(result.status).toBe('error');
    expect(result.error).toBe('overloaded');
    expect(result.newSessionId).toBe('session_123');
  });

  it('无文本 block → result 为 null', () => {
    const acc = createMessageAccumulator();
    const result = mapAccumulatorToResult(acc);
    expect(result.status).toBe('success');
    expect(result.result).toBeNull();
  });

  it('多个文本 block 拼接', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 2, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { type: 'content_block_delta', index: 2, delta: { type: 'text_delta', text: ' World' } },
    });

    const result = mapAccumulatorToResult(acc);
    expect(result.result).toBe('Hello World');
  });
});
