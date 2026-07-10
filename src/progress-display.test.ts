import { describe, expect, it } from 'vitest';
import {
  classifyProgressAction,
  createProgressPresentationState,
  progressLogFields,
  reduceProgressPresentation,
  redactProgressText,
  serializeProgressPayload,
  type StructuredProgress,
} from './progress-display.js';

describe('serializeProgressPayload', () => {
  it('完整保留结构化 progress，供主路径和重试路径复用', () => {
    const progress = started('Bash', { command: 'npm test' }, 'retry-1');
    expect(JSON.parse(serializeProgressPayload({
      result: '🔧 npm test',
      detail: '```bash\nnpm test\n```',
      progress,
    }))).toEqual({
      title: '🔧 npm test',
      detail: '```bash\nnpm test\n```',
      progress,
    });
  });
});

describe('progressLogFields', () => {
  it('只输出关联字段，不记录 input 和结果正文', () => {
    const fields = progressLogFields(started(
      'Bash',
      { command: 'Authorization: Bearer log-canary-123456' },
      'log-1',
    ));
    expect(fields).toEqual({
      provider: 'codex',
      lifecycle: 'started',
      toolName: 'Bash',
      toolCallId: 'log-1',
    });
    expect(JSON.stringify(fields)).not.toContain('log-canary');
  });
});

describe('redactProgressText', () => {
  it('host 持久化前再次脱敏 synthetic canary', () => {
    const output = redactProgressText(
      'token=host-canary-123456 https://u:p@example.com?a=1',
    );
    expect(output).not.toContain('host-canary');
    expect(output).not.toContain('u:p@');
  });
});

function started(
  toolName: string,
  input: Record<string, unknown>,
  toolCallId = 'call-1',
): StructuredProgress {
  return {
    provider: 'codex',
    lifecycle: 'started',
    toolName,
    toolCallId,
    input,
  };
}

describe('classifyProgressAction', () => {
  const cases: Array<[string, StructuredProgress, string]> = [
    [
      '读取文件',
      started('Read', { file_path: '/tmp/config.ts' }),
      '正在读取文件',
    ],
    [
      '搜索模型配置',
      started('Grep', { pattern: 'opus-4.8' }),
      '正在搜索模型配置相关位置',
    ],
    [
      '修改文件',
      started('Edit', { file_path: '/tmp/config.ts' }),
      '正在修改文件',
    ],
    ['运行测试', started('Bash', { command: 'npm test' }), '正在运行测试'],
    [
      '编译项目',
      started('command_execution', { command: '/bin/zsh -lc "npm run build"' }),
      '正在编译项目',
    ],
    [
      '检查改动',
      started('Bash', { command: 'git diff --check' }),
      '正在检查代码改动',
    ],
    [
      '查询日志',
      started('Bash', {
        command: 'ssh dev "curl $GRAFANA_URL/loki/api/v1/query_range"',
      }),
      '正在查询 DEV 链路日志',
    ],
    [
      '检查流水线',
      started('Bash', { command: 'gh run view 123 --log-failed' }),
      '正在检查流水线失败原因',
    ],
    [
      '读取飞书消息',
      started('Bash', {
        command: 'lark-cli im +chat-messages-list --chat-id oc_xxx',
      }),
      '正在读取飞书消息',
    ],
    [
      '搜索网页',
      started('web_search', { query: 'Claude Code docs' }),
      '正在搜索公开资料',
    ],
    [
      '上传文档',
      started('Bash', {
        command: 'feishu-docs.mjs upload plan.md --folder nanoclaw',
      }),
      '正在上传文档',
    ],
    [
      '删除远程分支',
      started('Bash', { command: 'git push origin --delete old-branch' }),
      '正在删除远程分支',
    ],
    [
      '校验 OpenSpec',
      started('Bash', {
        command: 'openspec validate readable-progress --strict',
      }),
      '正在校验变更规范',
    ],
    [
      '应用补丁',
      started('Bash', { command: 'apply_patch < change.diff' }),
      '正在修改文件',
    ],
    [
      '检查流水线状态',
      started('Bash', { command: 'gh run view 123' }),
      '正在检查交付流水线',
    ],
    [
      '检查服务',
      started('Bash', { command: 'curl -fsS http://service/health' }),
      '正在检查服务响应',
    ],
    [
      '检查远程环境',
      started('Bash', { command: 'ssh dev uname -a' }),
      '正在检查远程环境',
    ],
    [
      '分析调用关系',
      started('gitnexus_context', { query: 'sendMessage' }),
      '正在分析代码调用关系',
    ],
    [
      '派发协作任务',
      started('mcp__nanoclaw__delegate', { query: 'review' }),
      '正在派发协作任务',
    ],
    [
      '搜索过程卡片',
      started('Bash', { command: "rg -n 'progress card' src" }),
      '正在搜索过程卡片相关位置',
    ],
    [
      '搜索性能数据',
      started('Bash', { command: "grep -n 'latency_ms' trace.log" }),
      '正在搜索性能数据相关位置',
    ],
    [
      '检查代码历史',
      started('Bash', { command: 'git blame src/index.ts' }),
      '正在检查代码和历史',
    ],
  ];

  it.each(cases)('%s', (_name, progress, expected) => {
    expect(classifyProgressAction(progress).title).toBe(expected);
  });

  it('复杂脚本继承当前阶段，不猜脚本结论', () => {
    const action = classifyProgressAction(
      started('Bash', { command: "python3 - <<'PY'\nprint('x')\nPY" }),
      '正在汇总五次请求耗时',
    );
    expect(action.title).toBe('正在运行分析脚本');
    expect(action.phase).toBe('正在汇总五次请求耗时');
    expect(action.confidence).toBe('fallback');
  });

  it('未知命令无阶段时使用中性文案且不泄露命令', () => {
    const action = classifyProgressAction(
      started('Bash', { command: './foo --bar secret' }),
    );
    expect(action.title).toBe('正在执行系统检查');
    expect(action.title).not.toContain('foo');
    expect(action.title).not.toContain('secret');
  });

  it('阶段和真实计划不泄露路径、消息 ID 与内部地址', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '检查 /Users/test/project/src/index.ts 和 oc_secret，再访问 10.0.0.8。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: './unknown' }),
    });
    const visible = `${state.steps[0].phase} ${state.steps[0].title}`;
    expect(visible).not.toContain('/Users');
    expect(visible).not.toContain('oc_secret');
    expect(visible).not.toContain('10.0.0.8');
  });

  it('MCP 工具名恢复为业务动作', () => {
    const action = classifyProgressAction(
      started('mcp_tool_call', {
        server: 'nanoclaw',
        tool: 'search_chat',
        arguments: { query: '过程卡片' },
      }),
    );
    expect(action.title).toBe('正在搜索聊天记录');
  });
});

describe('reduceProgressPresentation', () => {
  it('真实 TodoWrite 计划优先保留原状态，不从命令猜未来步骤', () => {
    const state = reduceProgressPresentation(
      createProgressPresentationState(),
      {
        kind: 'tool',
        progress: started(
          'TodoWrite',
          {
            todos: [
              { content: '核对实现范围', status: 'completed' },
              { content: '补齐单元测试', status: 'in_progress' },
              { content: '执行真实 E2E', status: 'pending' },
            ],
          },
          'todo-1',
        ),
      },
    );
    expect(
      state.steps.map((step) => [step.title, step.status, step.source]),
    ).toEqual([
      ['核对实现范围', 'completed', 'plan'],
      ['补齐单元测试', 'running', 'plan'],
      ['执行真实 E2E', 'pending', 'plan'],
    ]);
  });

  it('后续工具动作归入当前进行中的真实计划', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started('TodoWrite', {
        todos: [{ content: '补齐单元测试', status: 'in_progress' }],
      }, 'todo-parent'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: 'npm test' }, 'test-child'),
    });
    expect(state.steps.at(-1)?.phase).toBe('补齐单元测试');
  });

  it('中间叙述成为下一次工具调用的阶段锚点', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '我先核对模型配置为什么没有生效。后面还有说明。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Grep', { pattern: 'opus-4.8' }),
    });
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].phase).toBe('我先核对模型配置为什么没有生效。');
    expect(state.steps[0].title).toBe('正在搜索模型配置相关位置');
  });

  it('完成事件按 toolCallId 原地更新，不追加结果行', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: 'npm test' }, 'test-1'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'codex',
        lifecycle: 'completed',
        toolName: 'command_execution',
        toolCallId: 'test-1',
        input: { command: 'npm test' },
        exitCode: 0,
      },
    });
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].title).toBe('已完成测试');
    expect(state.steps[0].status).toBe('completed');
  });

  it('同一 toolCallId 的 started 更新原步骤，不重复追加', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', {}, 'same-1'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: 'npm test' }, 'same-1'),
    });
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0].title).toBe('正在运行测试');
  });

  it('失败、取消和缺失结果不误报成功', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: 'npm test' }, 'failed'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'codex',
        lifecycle: 'failed',
        toolName: 'command_execution',
        toolCallId: 'failed',
        exitCode: 1,
      },
    });
    expect(state.steps[0].title).toBe('测试失败');
    expect(state.steps[0].status).toBe('failed');

    const unresolved = reduceProgressPresentation(state, { kind: 'turn_end' });
    expect(unresolved.steps.every((step) => step.status !== 'running')).toBe(
      true,
    );
  });

  it('turn 结束时缺少完成事件显示结果未知', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: 'npm test' }, 'missing-result'),
    });
    state = reduceProgressPresentation(state, { kind: 'turn_end' });
    expect(state.steps[0].title).toBe('已执行测试，结果未知');
    expect(state.steps[0].status).toBe('unknown');
  });
});
