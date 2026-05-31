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
  buildTextProgress,
  buildToolUseProgress,
  decideTextBlockAction,
  isCompactSummary,
  type SseEvent,
  type MessageStartData,
  type ContentBlockStartData,
  type ContentBlockDeltaData,
  type MessageDeltaData,
  type TextBlock,
  type ToolUseBlock,
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

// ---- buildTextProgress（assistant 中间叙述 → 💬 progress）----

describe('buildTextProgress', () => {
  it('普通文本生成 💬 progress，progressType=text', () => {
    const block: TextBlock = { type: 'text', text: '让我看下这块代码' };
    const result = buildTextProgress(block);
    expect(result).not.toBeNull();
    expect(result!.status).toBe('progress');
    expect(result!.progressType).toBe('text');
    expect(result!.result).toBe('💬 让我看下这块代码');
  });

  it('空文本返回 null', () => {
    expect(buildTextProgress({ type: 'text', text: '' })).toBeNull();
  });

  it('剥掉 <internal> 标签后长度 ≤ 5 返回 null（视为无可见内容）', () => {
    expect(buildTextProgress({ type: 'text', text: '<internal>大段内部独白文本</internal>' })).toBeNull();
    expect(buildTextProgress({ type: 'text', text: '<internal>x</internal>hi' })).toBeNull();
    expect(buildTextProgress({ type: 'text', text: '12345' })).toBeNull();
  });

  it('剥掉 <internal> 标签后还有可见文本 → emit', () => {
    const block: TextBlock = { type: 'text', text: '<internal>thinking</internal>这是用户可见的回复内容' };
    const result = buildTextProgress(block);
    expect(result).not.toBeNull();
    expect(result!.result).toBe('💬 这是用户可见的回复内容');
  });

  it('超长文本截断 short 到 80 字符 + 完整 text 进 detail', () => {
    const longText = 'A'.repeat(200);
    const result = buildTextProgress({ type: 'text', text: longText });
    expect(result).not.toBeNull();
    expect(result!.result).toBe('💬 ' + 'A'.repeat(80) + '...');
    expect(result!.detail).toBe(longText);
  });

  it('短文本（>5 且 ≤80 字符）detail 为 undefined', () => {
    const result = buildTextProgress({ type: 'text', text: '这是一段短回复' });
    expect(result).not.toBeNull();
    expect(result!.detail).toBeUndefined();
  });

  it('progressType MUST 为 text（不是 thinking）— 防止被 shouldFilterProgress 误杀', () => {
    // 回归测试：曾经的 bug 是用 'thinking'，被主进程 shouldFilterProgress 过滤
    const result = buildTextProgress({ type: 'text', text: '正常的中间叙述文本' });
    expect(result!.progressType).toBe('text');
    expect(result!.progressType).not.toBe('thinking');
  });

  it('💬 emoji 前缀 — 飞书 channel 通过此 emoji 识别独立消息路径', () => {
    const result = buildTextProgress({ type: 'text', text: '一些回复内容' });
    expect(result!.result?.startsWith('💬 ')).toBe(true);
  });
});

// ---- buildToolUseProgress ----

describe('buildToolUseProgress', () => {
  it('Bash 工具 + command → 富进度含 ```bash``` 块', () => {
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'Bash',
      inputJson: JSON.stringify({ command: 'ls -la' }),
    };
    const result = buildToolUseProgress(block);
    expect(result).not.toBeNull();
    expect(result!.progressType).toBe('tool_use');
    expect(result!.result).toContain('Bash');
    expect(result!.detail).toContain('```bash');
    expect(result!.detail).toContain('ls -la');
  });

  it('Edit 工具 + old/new_string → diff 风格 detail', () => {
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_02',
      name: 'Edit',
      inputJson: JSON.stringify({
        file_path: '/a/b/c.ts',
        old_string: 'foo',
        new_string: 'bar',
      }),
    };
    const result = buildToolUseProgress(block);
    expect(result!.detail).toContain('**c.ts**');
    expect(result!.detail).toContain('- foo');
    expect(result!.detail).toContain('+ bar');
  });

  it('inputJson 解析失败 → 仅工具名（不抛错）', () => {
    const block: ToolUseBlock = {
      type: 'tool_use',
      id: 'toolu_03',
      name: 'Bash',
      inputJson: 'not-valid-json{',
    };
    const result = buildToolUseProgress(block);
    expect(result).not.toBeNull();
    expect(result!.progressType).toBe('tool_use');
    expect(result!.result).toContain('Bash');
  });
});

// ---- decideTextBlockAction ----
//
// 这组测试锁定 interactive 模式 stop_reason 决断分支 — Agent Review #6 提的"集成层零覆盖"缺口
// 任何对 stop_reason 处理逻辑的改动都会被这些断言拦截，防止再次悄无声息回归

describe('decideTextBlockAction', () => {
  it('stop_reason=tool_use, 非 haiku → flush（中间叙述应发给用户）', () => {
    const action = decideTextBlockAction({ stopReason: 'tool_use', isHaikuPreheat: false });
    expect(action).toBe('flush');
  });

  it('stop_reason=end_turn, 非 haiku → drop（已含在最终 result，不重复发）', () => {
    const action = decideTextBlockAction({ stopReason: 'end_turn', isHaikuPreheat: false });
    expect(action).toBe('drop');
  });

  it('stop_reason=max_tokens → drop（被截断的最终回复也会走 result 路径）', () => {
    const action = decideTextBlockAction({ stopReason: 'max_tokens', isHaikuPreheat: false });
    expect(action).toBe('drop');
  });

  it('stop_reason=stop_sequence → drop', () => {
    const action = decideTextBlockAction({ stopReason: 'stop_sequence', isHaikuPreheat: false });
    expect(action).toBe('drop');
  });

  it('haiku 预热流 + stop_reason=tool_use → drop（haiku 优先级高，预热噪音不展示）', () => {
    const action = decideTextBlockAction({ stopReason: 'tool_use', isHaikuPreheat: true });
    expect(action).toBe('drop');
  });

  it('haiku 预热流 + stop_reason=end_turn → drop', () => {
    const action = decideTextBlockAction({ stopReason: 'end_turn', isHaikuPreheat: true });
    expect(action).toBe('drop');
  });

  it('空 stop_reason → drop（防御默认值，不应该误 flush）', () => {
    const action = decideTextBlockAction({ stopReason: '', isHaikuPreheat: false });
    expect(action).toBe('drop');
  });
});

// ---- interactive SSE 事件流端到端集成 ----
//
// 喂完整 SSE 事件序列给 accumulateSseEvent，验证 acc 状态 + 应用 decideTextBlockAction
// 端到端验证："text block → tool_use → text block → message_stop(stop_reason=tool_use)"
// 这种典型多块场景下 flush/drop 决策正确

describe('interactive SSE 事件流集成', () => {
  function feedEvents(events: SseEvent[]) {
    let acc = createMessageAccumulator();
    for (const ev of events) {
      acc = accumulateSseEvent(acc, ev);
    }
    return acc;
  }

  it('text → tool_use → message_stop(stop_reason=tool_use) → flush 决策', () => {
    const acc = feedEvents([
      { type: 'message_start', data: { type: 'message_start', message: { id: 'msg_1', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 0 } } } },
      { type: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '让我看下这块代码' } } },
      { type: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { type: 'content_block_start', data: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_01', name: 'Read', input: {} } } },
      { type: 'content_block_stop', data: { type: 'content_block_stop', index: 1 } },
      { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 20 } } },
      { type: 'message_stop', data: { type: 'message_stop' } },
    ]);

    expect(acc.done).toBe(true);
    expect(acc.stopReason).toBe('tool_use');
    expect(acc.blocks.get(0)?.type).toBe('text');
    expect((acc.blocks.get(0) as TextBlock).text).toBe('让我看下这块代码');
    expect(acc.blocks.get(1)?.type).toBe('tool_use');

    // 应用决策：tool_use → flush
    const action = decideTextBlockAction({
      stopReason: acc.stopReason,
      isHaikuPreheat: false,
    });
    expect(action).toBe('flush');
  });

  it('text → message_stop(stop_reason=end_turn) → drop 决策', () => {
    const acc = feedEvents([
      { type: 'message_start', data: { type: 'message_start', message: { id: 'msg_2', model: 'claude-sonnet-4-6', usage: { input_tokens: 100, output_tokens: 0 } } } },
      { type: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '搞定了' } } },
      { type: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } } },
      { type: 'message_stop', data: { type: 'message_stop' } },
    ]);

    expect(acc.done).toBe(true);
    expect(acc.stopReason).toBe('end_turn');

    const action = decideTextBlockAction({
      stopReason: acc.stopReason,
      isHaikuPreheat: false,
    });
    expect(action).toBe('drop');
  });

  it('haiku 预热流 + text + stop_reason=end_turn → drop 决策（haiku 优先级覆盖）', () => {
    const acc = feedEvents([
      { type: 'message_start', data: { type: 'message_start', message: { id: 'msg_3', model: 'claude-haiku-4-5-20251001', usage: { input_tokens: 50, output_tokens: 0 } } } },
      { type: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
      { type: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '预热缓存的副产物文本' } } },
      { type: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
      { type: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 10 } } },
      { type: 'message_stop', data: { type: 'message_stop' } },
    ]);

    expect(acc.model).toContain('haiku');

    const action = decideTextBlockAction({
      stopReason: acc.stopReason,
      isHaikuPreheat: acc.model.includes('haiku'),
    });
    expect(action).toBe('drop');
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

  it('auto-compact summary（<analysis> 开头）→ isCompactSummary=true，result=null', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '<analysis>\nThe user wants me to...\n</analysis>\n\n摘要内容' },
      },
    });
    const result = mapAccumulatorToResult(acc, 'session_x');
    expect(result.status).toBe('success');
    expect(result.isCompactSummary).toBe(true);
    expect(result.result).toBeNull();
    expect(result.newSessionId).toBe('session_x');
  });

  it('auto-compact summary（chronologically analyze 关键词）→ isCompactSummary=true', () => {
    let acc = createMessageAccumulator();
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Let me chronologically analyze each message in detail...' },
      },
    });
    const result = mapAccumulatorToResult(acc);
    expect(result.isCompactSummary).toBe(true);
    expect(result.result).toBeNull();
  });
});

// ---- isCompactSummary ----

describe('isCompactSummary', () => {
  it('<analysis> 开头 → true', () => {
    expect(isCompactSummary('<analysis>\n...\n</analysis>\n\nsummary')).toBe(true);
  });

  it('前置空白后仍以 <analysis> 开头 → true', () => {
    expect(isCompactSummary('   \n<analysis>x</analysis>')).toBe(true);
  });

  it('包含 chronologically analyze each message → true', () => {
    expect(isCompactSummary('I will chronologically analyze each message below.')).toBe(true);
  });

  it('null / undefined / 空字符串 → false', () => {
    expect(isCompactSummary(null)).toBe(false);
    expect(isCompactSummary(undefined)).toBe(false);
    expect(isCompactSummary('')).toBe(false);
  });

  it('普通文本 → false', () => {
    expect(isCompactSummary('这是一段正常的助手回复')).toBe(false);
    expect(isCompactSummary('Hello World')).toBe(false);
  });

  it('文本中间出现 <analysis>（不在开头）→ false（避免误杀）', () => {
    expect(isCompactSummary('我们讨论的 <analysis> 标签其实是 Claude 内部用的')).toBe(false);
  });
});

// ---- buildTextProgress + 补充 compact case ----

describe('buildTextProgress compact-summary 过滤', () => {
  it('text 以 <analysis> 开头 → 返回 null（不让 raw 摘要泄漏到飞书）', () => {
    const block: TextBlock = {
      type: 'text',
      text: '<analysis>\nThe primary intent was to...\n</analysis>\n\n[summary]',
    };
    expect(buildTextProgress(block)).toBeNull();
  });

  it('text 含 chronologically analyze 关键词 → 返回 null', () => {
    const block: TextBlock = {
      type: 'text',
      text: 'I will chronologically analyze each message below to ensure...',
    };
    expect(buildTextProgress(block)).toBeNull();
  });

  it('普通文本不受影响 → 正常 emit', () => {
    const block: TextBlock = { type: 'text', text: '这是一段正常的助手回复内容' };
    const result = buildTextProgress(block);
    expect(result).not.toBeNull();
    expect(result!.result?.startsWith('💬 ')).toBe(true);
  });
});

// ---- 并发 SSE 流竞态场景 ----

describe('并发 SSE 流共享 accumulator 竞态', () => {
  // 复现线上 bug：haiku 预热流和 opus 主流几乎同时到达，
  // 共享一个 acc 累积器。第二个流的 message_start 重置 blocks，
  // 导致第一个流累积的 text block 丢失。
  //
  // 预期：两个流交错时，message_start 会清空已有 blocks，
  // 这是 accumulateSseEvent 的正确行为（message_start 代表新消息开始）。
  // bug 在调用侧没有为每个流维护独立 accumulator。

  // 辅助函数：构造完整的 SSE 事件序列
  function makeTextStream(model: string, text: string): SseEvent[] {
    return [
      {
        type: 'message_start',
        data: {
          message: {
            id: `msg_${model}`,
            model,
            usage: { input_tokens: 10, output_tokens: 0 },
          },
        },
      },
      {
        type: 'content_block_start',
        data: { index: 0, content_block: { type: 'text', text: '' } },
      },
      {
        type: 'content_block_delta',
        data: { index: 0, delta: { type: 'text_delta', text } },
      },
      { type: 'content_block_stop', data: { index: 0 } },
      {
        type: 'message_delta',
        data: { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 50 } },
      },
      { type: 'message_stop', data: {} },
    ];
  }

  it('单流完整事件序列 → mapAccumulatorToResult 有文本', () => {
    let acc = createMessageAccumulator();
    for (const event of makeTextStream('claude-opus-4-8', '你好世界')) {
      acc = accumulateSseEvent(acc, event);
    }
    const result = mapAccumulatorToResult(acc, 'session-1');
    expect(result.status).toBe('success');
    expect(result.result).toBe('你好世界');
    expect(acc.blocks.size).toBe(1);
  });

  it('两个流顺序执行（先 haiku 后 opus）→ 第二个流的文本保留', () => {
    let acc = createMessageAccumulator();

    // 第一个流（haiku 预热）完整跑完
    for (const event of makeTextStream('claude-3-5-haiku', '预热文本')) {
      acc = accumulateSseEvent(acc, event);
    }
    expect(acc.done).toBe(true);
    expect(acc.model).toBe('claude-3-5-haiku');

    // 第二个流开始 → message_start 重置 blocks
    for (const event of makeTextStream('claude-opus-4-8', '正式回复')) {
      acc = accumulateSseEvent(acc, event);
    }
    const result = mapAccumulatorToResult(acc, 'session-1');
    expect(result.result).toBe('正式回复');
    expect(acc.model).toBe('claude-opus-4-8');
  });

  it('两个流交错（复现竞态 bug）→ message_start 清空已有 blocks', () => {
    let acc = createMessageAccumulator();

    const haikuEvents = makeTextStream('claude-3-5-haiku', '预热');
    const opusEvents = makeTextStream('claude-opus-4-8', '正式回复');

    // 模拟交错：haiku 先收到 message_start 和 content_block_start
    acc = accumulateSseEvent(acc, haikuEvents[0]); // haiku message_start
    acc = accumulateSseEvent(acc, haikuEvents[1]); // haiku content_block_start
    acc = accumulateSseEvent(acc, haikuEvents[2]); // haiku content_block_delta（text="预热"）
    expect(acc.blocks.size).toBe(1);

    // opus message_start 到达 → 重置 blocks（haiku 的 text 丢了）
    acc = accumulateSseEvent(acc, opusEvents[0]); // opus message_start
    expect(acc.blocks.size).toBe(0); // ← 这就是 bug 的根源
    expect(acc.model).toBe('claude-opus-4-8');

    // haiku 的 content_block_stop 到达 → acc.blocks 里没有 index=0
    acc = accumulateSseEvent(acc, haikuEvents[3]); // haiku content_block_stop
    // content_block_stop 不做任何事，不会报错

    // haiku 的 message_delta + message_stop
    acc = accumulateSseEvent(acc, haikuEvents[4]); // haiku message_delta (end_turn)
    acc = accumulateSseEvent(acc, haikuEvents[5]); // haiku message_stop → done=true
    expect(acc.done).toBe(true);
    expect(acc.stopReason).toBe('end_turn');

    // 此时 mapAccumulatorToResult → blocks=0, result=null
    const earlyResult = mapAccumulatorToResult(acc, 'session-1');
    expect(earlyResult.result).toBeNull(); // ← 竞态导致空回复

    // opus 后续事件到达
    acc = accumulateSseEvent(acc, opusEvents[1]); // opus content_block_start
    acc = accumulateSseEvent(acc, opusEvents[2]); // opus delta
    acc = accumulateSseEvent(acc, opusEvents[3]); // opus block_stop
    acc = accumulateSseEvent(acc, opusEvents[4]); // opus message_delta
    acc = accumulateSseEvent(acc, opusEvents[5]); // opus message_stop

    // 但 done 已经在 haiku 的 message_stop 时置为 true，
    // opus 的 message_start 把它重置为 false，
    // opus 的 message_stop 再次置为 true。
    // 如果调用侧在 haiku 的 done=true 时就取了结果，opus 的文本永远看不到
    const lateResult = mapAccumulatorToResult(acc, 'session-1');
    expect(lateResult.result).toBe('正式回复'); // opus 的文本在后面的事件里
  });

  it('并发流中 content_block_delta 到已被清空的 index → 不报错不累积', () => {
    let acc = createMessageAccumulator();

    // 流 A：创建 block index=0
    acc = accumulateSseEvent(acc, {
      type: 'content_block_start',
      data: { index: 0, content_block: { type: 'text', text: '' } },
    });
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { index: 0, delta: { type: 'text_delta', text: '部分' } },
    });
    expect(acc.blocks.get(0)!.type).toBe('text');
    expect((acc.blocks.get(0) as TextBlock).text).toBe('部分');

    // 流 B 的 message_start 清空 blocks
    acc = accumulateSseEvent(acc, {
      type: 'message_start',
      data: { message: { id: 'msg_b', model: 'opus', usage: { input_tokens: 5, output_tokens: 0 } } },
    });
    expect(acc.blocks.size).toBe(0);

    // 流 A 的后续 delta 到达 → index=0 不存在，静默跳过
    acc = accumulateSseEvent(acc, {
      type: 'content_block_delta',
      data: { index: 0, delta: { type: 'text_delta', text: '文本' } },
    });
    expect(acc.blocks.size).toBe(0); // 不应创建新 block
  });

  it('interactive-cli-runner 调用侧模拟：pendingTextBlocks 被 drop + mapResult 空 = 空回复', () => {
    // 模拟 interactive-cli-runner.ts 的事件处理逻辑
    let acc = createMessageAccumulator();
    const pendingTextBlocks: TextBlock[] = [];

    const haikuEvents = makeTextStream('claude-3-5-haiku', '预热文本');
    const opusEvents = makeTextStream('claude-opus-4-8', '正式回复');

    // 按实际交错顺序处理
    acc = accumulateSseEvent(acc, haikuEvents[0]); // haiku message_start
    acc = accumulateSseEvent(acc, opusEvents[0]);  // opus message_start（清空 blocks）
    acc = accumulateSseEvent(acc, haikuEvents[1]);  // haiku block_start
    acc = accumulateSseEvent(acc, haikuEvents[2]);  // haiku delta

    // haiku block_stop → 调用侧取 acc.blocks.get(0)
    acc = accumulateSseEvent(acc, haikuEvents[3]);
    const haikuBlock = acc.blocks.get(0); // 这里取到的是 haiku 的 block
    if (haikuBlock?.type === 'text') {
      pendingTextBlocks.push(haikuBlock);
    }

    // haiku message_delta + message_stop → done=true
    acc = accumulateSseEvent(acc, haikuEvents[4]);
    acc = accumulateSseEvent(acc, haikuEvents[5]);

    // 调用侧检查 acc.done → true
    expect(acc.done).toBe(true);

    // decideTextBlockAction(end_turn, false) → drop
    const action = decideTextBlockAction({
      stopReason: acc.stopReason,
      isHaikuPreheat: acc.model.includes('haiku'),
    });
    // 注意：此时 acc.model 已被 opus message_start 覆盖为 'claude-opus-4-8'
    // 所以 isHaikuPreheat=false，action=drop
    expect(acc.model).toBe('claude-opus-4-8'); // ← 模型已被覆盖
    expect(action).toBe('drop');

    // drop pendingTextBlocks
    pendingTextBlocks.length = 0;

    // mapAccumulatorToResult → blocks 里只有 haiku 写的 block
    const result = mapAccumulatorToResult(acc, 'session-1');

    // blocks 里有 haiku 的 text（因为 haiku block_start 在 opus message_start 之后）
    // 但 acc.model 是 opus → 不会被识别为 haiku 预热
    // 如果 block 刚好存在，result 可能不为空
    // 关键是 pendingTextBlocks 已被 drop 了，中间文本丢失

    // 这是竞态的另一种表现：haiku 的 text 被当成 opus 的回复
    // 真正的 opus 文本还没到，用户看到的是 haiku 预热文本或空
  });
});
