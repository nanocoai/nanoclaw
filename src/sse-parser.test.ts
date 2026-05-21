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
});
