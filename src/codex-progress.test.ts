/**
 * codex file_change 进度格式化测试
 * mapCodexProgress 在 container/agent-runner,纯函数,跨目录 import 验证
 */
import { describe, it, expect } from 'vitest';
import {
  createCodexTextProgressState,
  mapCodexProgress,
  mapCodexTextProgress,
} from '../container/agent-runner/src/codex-runner.js';

function started(item: Record<string, unknown>) {
  return { type: 'item.started', item } as any;
}

function completed(item: Record<string, unknown>) {
  return { type: 'item.completed', item } as any;
}

describe('mapCodexProgress — file_change', () => {
  it('单文件:显示 kind + basename,detail 列出路径', () => {
    const out = mapCodexProgress(
      started({
        id: 'i1',
        type: 'file_change',
        changes: [{ path: '/tmp/a.txt', kind: 'add' }],
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].result).toBe('📝 新增 a.txt');
    expect(out[0].progressType).toBe('tool_use');
    expect(out[0].detail).toContain('新增  /tmp/a.txt');
  });

  it('多文件:显示数量,detail 逐行列出', () => {
    const out = mapCodexProgress(
      started({
        id: 'i2',
        type: 'file_change',
        changes: [
          { path: '/a/foo.ts', kind: 'modify' },
          { path: '/a/bar.ts', kind: 'add' },
          { path: '/a/baz.ts', kind: 'delete' },
        ],
      }),
    );
    expect(out[0].result).toBe('📝 改动 3 个文件');
    expect(out[0].detail).toContain('修改  /a/foo.ts');
    expect(out[0].detail).toContain('新增  /a/bar.ts');
    expect(out[0].detail).toContain('删除  /a/baz.ts');
  });

  it('未知 kind 原样保留', () => {
    const out = mapCodexProgress(
      started({
        id: 'i3',
        type: 'file_change',
        changes: [{ path: '/x', kind: 'rename' }],
      }),
    );
    expect(out[0].result).toBe('📝 rename x');
  });

  it('changes 为空时退化为通用分支(不崩)', () => {
    const out = mapCodexProgress(
      started({ id: 'i4', type: 'file_change', changes: [] }),
    );
    expect(out[0].result).toBe('🔧 file_change');
  });
});

describe('mapCodexProgress — 回归', () => {
  it('command_execution 仍显示命令 + bash detail', () => {
    const out = mapCodexProgress(
      started({ id: 'c1', type: 'command_execution', command: 'npm test' }),
    );
    expect(out[0].result).toBe('🔧 npm test');
    expect(out[0].detail).toContain('```bash');
    expect(out[0].detail).toContain('npm test');
    expect(out[0].progress).toEqual({
      provider: 'codex',
      lifecycle: 'started',
      toolName: 'command_execution',
      toolCallId: 'c1',
      input: { command: 'npm test' },
    });
  });

  it('command_execution completed 生成同 ID 的完成事件', () => {
    const out = mapCodexProgress(
      completed({
        id: 'c1',
        type: 'command_execution',
        command: 'npm test',
        exit_code: 0,
        status: 'completed',
        aggregated_output: '12 tests passed',
      }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].progressType).toBe('tool_result');
    expect(out[0].progress).toMatchObject({
      provider: 'codex',
      lifecycle: 'completed',
      toolCallId: 'c1',
      exitCode: 0,
      resultSummary: '12 tests passed',
    });
    expect(out[0].detail).toBe('12 tests passed');
  });

  it('completed 事件的 failed 状态不会误报成功', () => {
    const out = mapCodexProgress(
      completed({
        id: 'c-failed',
        type: 'mcp_tool_call',
        status: 'failed',
        server: 'gitnexus',
        tool: 'query',
      }),
    );
    expect(out[0].result).toBe('❌ 执行失败');
    expect(out[0].progress).toMatchObject({
      lifecycle: 'failed',
      toolCallId: 'c-failed',
      input: { server: 'gitnexus', tool: 'query' },
    });
  });

  it.each(['cancelled', 'canceled', 'interrupted'])('%s 状态映射为取消', (status) => {
    const out = mapCodexProgress(completed({
      id: `c-${status}`, type: 'command_execution', status,
    }));
    expect(out[0].progress?.lifecycle).toBe('cancelled');
    expect(out[0].result).toBe('⏹️ 已取消');
  });

  it('结构化输入限制长度且不保留 MCP arguments', () => {
    const out = mapCodexProgress(
      started({
        id: 'mcp-1',
        type: 'mcp_tool_call',
        server: 'gitnexus',
        tool: 'query',
        arguments: { api_key: 'secret', query: 'x'.repeat(3_000) },
      }),
    );
    expect(out[0].progress?.input).toEqual({
      server: 'gitnexus',
      tool: 'query',
    });
  });

  it('agent_message 返回空', () => {
    expect(
      mapCodexProgress(
        started({ id: 'm1', type: 'agent_message', text: 'hi' }),
      ),
    ).toEqual([]);
  });
});

describe('mapCodexTextProgress — Codex 中间文本', () => {
  it('工具事件不 flush pending 文本(避免最终回复被收尾工具误发💬)', () => {
    const state = createCodexTextProgressState();
    expect(
      mapCodexTextProgress(
        completed({
          id: 'm1',
          type: 'agent_message',
          text: '我先看一下代码。',
        }),
        state,
      ),
    ).toEqual([]);

    // 新行为：工具事件到达不再 flush，pending/last 保留（等下一条 agent_message 或 turn.completed 判定）
    const out = mapCodexTextProgress(
      started({ id: 'c1', type: 'command_execution', command: 'rg foo' }),
      state,
    );

    expect(out).toEqual([]);
    expect(state.pendingAgentMessage).toBe('我先看一下代码。');
    expect(state.lastAgentMessage).toBe('我先看一下代码。');
  });

  it('直接 turn.completed 时丢弃 pending 文本避免重复最终回复', () => {
    const state = createCodexTextProgressState();
    mapCodexTextProgress(
      completed({ id: 'm1', type: 'agent_message', text: '最终答案。' }),
      state,
    );

    expect(
      mapCodexTextProgress({ type: 'turn.completed' } as any, state),
    ).toEqual([]);
    expect(state.pendingAgentMessage).toBeUndefined();
    expect(state.lastAgentMessage).toBe('最终答案。');
  });

  it('连续 agent_message 时 flush 前一段,保留后一段等待判定', () => {
    const state = createCodexTextProgressState();
    mapCodexTextProgress(
      completed({ id: 'm1', type: 'agent_message', text: '第一段中间说明。' }),
      state,
    );

    const out = mapCodexTextProgress(
      completed({
        id: 'm2',
        type: 'agent_message',
        text: '第二段可能是最终回复。',
      }),
      state,
    );

    expect(out[0].result).toBe('💬 第一段中间说明。');
    expect(state.pendingAgentMessage).toBe('第二段可能是最终回复。');
    expect(state.lastAgentMessage).toBe('第二段可能是最终回复。');
  });

  it('internal-only 后续消息不复用旧文本当最终回复', () => {
    const state = createCodexTextProgressState();
    mapCodexTextProgress(
      completed({
        id: 'm1',
        type: 'agent_message',
        text: '这段后面还有处理。',
      }),
      state,
    );

    const out = mapCodexTextProgress(
      completed({
        id: 'm2',
        type: 'agent_message',
        text: '<internal>已写完总结</internal>',
      }),
      state,
    );

    expect(out[0].result).toBe('💬 这段后面还有处理。');
    expect(state.pendingAgentMessage).toBeUndefined();
    expect(state.lastAgentMessage).toBeUndefined();
  });

  it('completed 工具事件也不 flush pending 文本', () => {
    const state = createCodexTextProgressState();
    mapCodexTextProgress(
      completed({ id: 'm1', type: 'agent_message', text: '接下来读取文件。' }),
      state,
    );

    const out = mapCodexTextProgress(
      completed({
        id: 'c1',
        type: 'command_execution',
        command: 'sed -n 1,80p a.ts',
      }),
      state,
    );

    expect(out).toEqual([]);
    expect(state.pendingAgentMessage).toBe('接下来读取文件。');
    expect(state.lastAgentMessage).toBe('接下来读取文件。');
  });

  it('长中间文本被下条 agent_message flush 时 result 截断为预览,detail 保留全文', () => {
    const state = createCodexTextProgressState();
    const fullText = [
      '我先分析这段代码的结构。',
      '接下来会读取 package.json，确认项目名称和脚本配置。',
      '最后只返回需要的字段，避免把过程重复到最终回复里。',
      '这段文本故意超过预览长度，用来验证卡片明细里保留完整内容。',
    ].join('\n');
    mapCodexTextProgress(
      completed({ id: 'm1', type: 'agent_message', text: fullText }),
      state,
    );

    // 新行为：靠下一条 agent_message 触发 flush（而非工具事件）
    const out = mapCodexTextProgress(
      completed({ id: 'm2', type: 'agent_message', text: '下一段叙述' }),
      state,
    );

    expect(out[0].result).toMatch(/^💬 /);
    expect(out[0].result.length).toBeLessThan(fullText.length + 2);
    expect(out[0].detail).toBe(fullText);
  });
});

describe('mapCodexTextProgress — 中间叙述 vs 最终回复', () => {
  const ev = (type: string, itemType?: string, text?: string) =>
    ({
      type,
      item: itemType ? { id: 'x', type: itemType, text } : undefined,
    }) as any;
  function run(seq: any[]) {
    const s = createCodexTextProgressState();
    const progress: string[] = [];
    for (const e of seq)
      for (const o of mapCodexTextProgress(e, s))
        if (o.progressType === 'text') progress.push(o.detail!);
    return { progress, result: s.lastAgentMessage };
  }

  it('最终回复后跟 file_change 收尾，最终回复不被 flush 成💬、留作 result', () => {
    const { progress, result } = run([
      ev('item.completed', 'agent_message', '中间叙述A'),
      ev('item.started', 'command_execution'),
      ev('item.completed', 'command_execution'),
      ev('item.completed', 'agent_message', '最终回复B'),
      ev('item.started', 'file_change'),
      ev('item.completed', 'file_change'),
      ev('turn.completed'),
    ]);
    expect(progress).toEqual(['中间叙述A']);
    expect(result).toBe('最终回复B');
  });

  it('单条 agent_message(纯最终回复)不发💬，作 result', () => {
    const { progress, result } = run([
      ev('item.completed', 'agent_message', '直接答复'),
      ev('turn.completed'),
    ]);
    expect(progress).toEqual([]);
    expect(result).toBe('直接答复');
  });

  it('多条中间叙述各自发💬，最后一条作 result', () => {
    const { progress, result } = run([
      ev('item.completed', 'agent_message', '叙述1'),
      ev('item.started', 'command_execution'),
      ev('item.completed', 'agent_message', '叙述2'),
      ev('item.started', 'file_change'),
      ev('item.completed', 'agent_message', '最终3'),
      ev('turn.completed'),
    ]);
    expect(progress).toEqual(['叙述1', '叙述2']);
    expect(result).toBe('最终3');
  });

  it('<internal> 标签被剥离', () => {
    const { result } = run([
      ev('item.completed', 'agent_message', '正文<internal>思考</internal>'),
      ev('turn.completed'),
    ]);
    expect(result).toBe('正文');
  });
});
