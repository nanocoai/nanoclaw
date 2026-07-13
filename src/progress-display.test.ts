import { describe, expect, it } from 'vitest';
import {
  classifyProgressAction,
  createProgressPresentationState,
  progressLogFields,
  progressTransitionLogFields,
  reduceProgressPresentation,
  redactProgressText,
  serializeProgressPayload,
  type StructuredProgress,
} from './progress-display.js';

describe('serializeProgressPayload', () => {
  it('完整保留结构化 progress，供主路径和重试路径复用', () => {
    const progress = started('Bash', { command: 'npm test' }, 'retry-1');
    expect(
      JSON.parse(
        serializeProgressPayload({
          result: '🔧 npm test',
          detail: '```bash\nnpm test\n```',
          progress,
        }),
      ),
    ).toEqual({
      title: '🔧 npm test',
      detail: '```bash\nnpm test\n```',
      progress,
    });
  });
});

describe('progressLogFields', () => {
  it('只输出关联字段，不记录 input 和结果正文', () => {
    const fields = progressLogFields(
      started(
        'Bash',
        { command: 'Authorization: Bearer log-canary-123456' },
        'log-1',
      ),
    );
    expect(fields).toEqual({
      provider: 'codex',
      lifecycle: 'started',
      toolName: 'Bash',
      toolCallId: 'log-1',
    });
    expect(JSON.stringify(fields)).not.toContain('log-canary');
  });
});

describe('progressTransitionLogFields', () => {
  it('只输出同卡状态对账字段', () => {
    expect(
      progressTransitionLogFields({
        cardMessageId: 'om_card_1',
        toolCallId: 'call-1',
        stepCount: 3,
        fromStatus: 'running',
        toStatus: 'completed',
      }),
    ).toEqual({
      cardMessageId: 'om_card_1',
      toolCallId: 'call-1',
      stepCount: 3,
      fromStatus: 'running',
      toStatus: 'completed',
    });
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
      '正在读取 config.ts',
    ],
    [
      '搜索模型配置',
      started('Grep', { pattern: 'opus-4.8' }),
      '正在搜索“opus-4.8”',
    ],
    [
      '修改文件',
      started('Edit', { file_path: '/tmp/config.ts' }),
      '正在修改 config.ts',
    ],
    ['运行测试', started('Bash', { command: 'npm test' }), '正在运行测试'],
    [
      'Node 原生测试',
      started('Bash', { command: 'node --test fixture.test.mjs' }),
      '正在运行 fixture.test.mjs 测试',
    ],
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
      '正在搜索“Claude Code docs”公开资料',
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
      '正在分析 sendMessage 的代码调用关系',
    ],
    [
      '派发协作任务',
      started('mcp__nanoclaw__delegate', { query: 'review' }),
      '正在派发协作任务',
    ],
    [
      '搜索过程卡片',
      started('Bash', { command: "rg -n 'progress card' src" }),
      '正在 src 中搜索“progress card”',
    ],
    [
      '搜索性能数据',
      started('Bash', { command: "grep -n 'latency_ms' trace.log" }),
      '正在 trace.log 中搜索“latency_ms”',
    ],
    [
      '检查代码历史',
      started('Bash', { command: 'git blame src/index.ts' }),
      '正在检查 index.ts 的代码历史',
    ],
  ];

  it.each(cases)('%s', (_name, progress, expected) => {
    expect(classifyProgressAction(progress).title).toBe(expected);
  });

  it.each([
    [
      'rg 跳过 glob 排除规则并保留真实搜索对象',
      `rg -n --glob '"'"'!**/node_modules/**'"'"' --glob '*.{ts,tsx}' '(admin|管理)' apps server | head -240`,
      '正在 apps 中搜索“(admin|管理)”',
    ],
    [
      'git log 不把后续管道参数当文件名',
      `/bin/zsh -lc "git log -1 --oneline; node query.mjs --last 300"`,
      '正在检查代码和历史',
    ],
    [
      'git blame 仍展示真实文件名',
      `git blame src/index.ts`,
      '正在检查 index.ts 的代码历史',
    ],
    [
      'git blame 跳过 -L 的行号范围',
      `git blame -L 10,20 src/index.ts`,
      '正在检查 index.ts 的代码历史',
    ],
    ['sed 不把 shell 引号当文件名', `sed -n '1,260p' "`, '正在读取相关内容'],
  ])('%s', (_name, command, expected) => {
    expect(classifyProgressAction(started('Bash', { command })).title).toBe(
      expected,
    );
  });

  it.each([
    [
      'Read 文件名',
      started('Read', { file_path: '/workspace/src/progress-display.ts' }),
      '正在读取 progress-display.ts',
      '读取 progress-display.ts',
    ],
    [
      'Grep 关键词和文件',
      started('Grep', {
        pattern: 'turn_end',
        path: '/workspace/src/progress-display.ts',
      }),
      '正在 progress-display.ts 中搜索“turn_end”',
      '在 progress-display.ts 中搜索“turn_end”',
    ],
    [
      'Edit 文件名',
      started('Edit', { file_path: '/workspace/src/progress-display.ts' }),
      '正在修改 progress-display.ts',
      '修改 progress-display.ts',
    ],
    [
      '测试文件',
      started('Bash', {
        command: 'node --test src/progress-display.test.ts',
      }),
      '正在运行 progress-display.test.ts 测试',
      '测试 progress-display.test.ts',
    ],
    [
      '聊天搜索词',
      started('mcp__nanoclaw__search_chat', { query: '过程卡片显示' }),
      '正在搜索包含“过程卡片显示”的聊天记录',
      '搜索包含“过程卡片显示”的聊天记录',
    ],
  ])('%s 展示安全对象', (_name, progress, title, actionSummary) => {
    expect(classifyProgressAction(progress)).toMatchObject({
      title,
      completedTitle: `已${actionSummary}`,
      actionSummary,
    });
  });

  it('对象只显示 basename 且敏感 query 安全降级', () => {
    const read = classifyProgressAction(
      started('Read', {
        file_path: '/Users/dajay/private/project/src/config.ts',
      }),
    );
    const search = classifyProgressAction(
      started('Grep', { pattern: 'Bearer secret-token-123456789' }),
    );
    expect(read.title).toBe('正在读取 config.ts');
    expect(read.title).not.toContain('/Users');
    expect(search.title).toBe('正在搜索相关内容');
    expect(search.title).not.toContain('secret-token');
    expect(
      classifyProgressAction(
        started('Read', { file_path: '/workspace/.env.production' }),
      ).title,
    ).toBe('正在读取 敏感配置文件');
  });

  it.each([
    [
      'Bash rg',
      "rg -n -C 2 'turn_end' src/progress-display.ts",
      '正在 progress-display.ts 中搜索“turn_end”',
    ],
    [
      'Bash sed',
      "sed -n '620,700p' src/progress-display.ts",
      '正在读取 progress-display.ts',
    ],
    [
      'Bash cat',
      'cat /workspace/package.json',
      '正在读取 package.json',
    ],
  ])('%s 从命令提取安全对象', (_name, command, expected) => {
    expect(
      classifyProgressAction(started('Bash', { command })).title,
    ).toBe(expected);
  });

  it.each([
    [
      'WebSearch 查询词',
      started('WebSearch', { query: 'Claude Code hooks' }),
      '正在搜索“Claude Code hooks”公开资料',
    ],
    [
      'GitNexus 符号',
      started('gitnexus_context', { query: 'sendMessage' }),
      '正在分析 sendMessage 的代码调用关系',
    ],
    [
      'Git 历史文件',
      started('Bash', { command: 'git blame src/progress-display.ts' }),
      '正在检查 progress-display.ts 的代码历史',
    ],
  ])('%s 保留业务对象', (_name, progress, expected) => {
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
      text: '检查 /Users/test/project/src/index.ts 和 oc_secret，再访问 10.0.0.8，Bearer phase-secret-123456。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: './unknown' }),
    });
    const visible = `${state.steps[0].phase} ${state.steps[0].title}`;
    expect(visible).not.toContain('/Users');
    expect(visible).not.toContain('oc_secret');
    expect(visible).not.toContain('10.0.0.8');
    expect(visible).not.toContain('phase-secret');
    expect(visible).toContain('[REDACTED]');
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
  function complete(
    state: ReturnType<typeof createProgressPresentationState>,
    toolCallId: string,
    options: Partial<StructuredProgress> = {},
  ) {
    return reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'claude',
        lifecycle: 'completed',
        toolName: 'tool_result',
        toolCallId,
        ...options,
      },
    });
  }

  it('同一阶段的读取搜索修改测试聚合为一条用户进度', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '核对进度展示链路。',
    });
    const calls: Array<[string, Record<string, unknown>, string, string?]> = [
      ['Read', { file_path: '/tmp/input.txt' }, 'read-1'],
      ['Grep', { pattern: 'needle' }, 'grep-1'],
      ['Write', { file_path: '/tmp/output.txt' }, 'write-1'],
      [
        'Bash',
        { command: 'node --test fixture.test.mjs' },
        'test-1',
        '1 test passed',
      ],
    ];
    for (const [toolName, input, toolCallId, resultSummary] of calls) {
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: started(toolName, input, toolCallId),
      });
      state = complete(state, toolCallId, { resultSummary });
    }

    expect((state as any).phases).toEqual([
      expect.objectContaining({
        goal: '核对进度展示链路。',
        status: 'completed',
        categories: ['read', 'search', 'change', 'test'],
        actionSummaries: [
          '读取 input.txt',
          '搜索“needle”',
          '修改 output.txt',
          '测试 fixture.test.mjs',
        ],
        outcome:
          '已读取 input.txt、搜索“needle”、修改 output.txt，并测试 fixture.test.mjs（1 项通过）',
      }),
    ]);
  });

  it('阶段说明晚于首个工具结果时合并刚产生的孤立阶段', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started('Read', { file_path: '/tmp/input.txt' }, 'late-read'),
    });
    state = complete(state, 'late-read');
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '核对进度展示链路。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Grep', { pattern: 'needle' }, 'late-grep'),
    });
    state = complete(state, 'late-grep');

    expect((state as any).phases).toEqual([
      expect.objectContaining({
        goal: '核对进度展示链路。',
        source: 'narration',
        categories: ['read', 'search'],
        toolCallIds: ['late-read', 'late-grep'],
        outcome: '已读取 input.txt，并搜索“needle”',
      }),
    ]);
    expect(state.steps.every((step) => step.phaseId === 'phase-1')).toBe(true);
  });

  it('聊天搜索完成后保留阶段目标并展示匹配数量', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '核对目标聊天记录。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'mcp__nanoclaw__search_chat',
        { query: 'RPC-seed' },
        'search-chat-1',
      ),
    });
    state = complete(state, 'search-chat-1', {
      resultSummary: '找到 1 条匹配消息',
    });

    expect((state as any).phases).toEqual([
      expect.objectContaining({
        goal: '核对目标聊天记录。',
        status: 'completed',
        outcome: '找到 1 条匹配消息',
      }),
    ]);
  });

  it('聊天搜索按原始 query 统计精确匹配且忽略 ToolSearch 准备动作', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started(
        'ToolSearch',
        { query: 'select:mcp__nanoclaw__search_chat' },
        'tool-search',
      ),
    });
    state = complete(state, 'tool-search');
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '核对目标聊天记录。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'mcp__nanoclaw__search_chat',
        { query: 'RPC-04-seed' },
        'search-chat-exact',
      ),
    });
    state = complete(state, 'search-chat-exact', {
      resultSummary:
        '{"results":[{"chunk_text":"RPC-04-seed"},{"chunk_text":"other fuzzy result"}]}',
    });

    expect((state as any).phases).toEqual([
      expect.objectContaining({
        goal: '核对目标聊天记录。',
        categories: ['communicate'],
        outcome: '找到 1 条匹配消息',
      }),
    ]);
    expect(state.steps).toHaveLength(2);
  });

  it('回合结束保留计划项的进行中状态', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started('TodoWrite', {
        todos: [
          { content: '核对 fixture', status: 'completed' },
          { content: '整理证据', status: 'in_progress' },
        ],
      }),
    });
    state = reduceProgressPresentation(state, { kind: 'turn_end' });

    expect(state.steps.at(-1)?.status).toBe('running');
    expect((state as any).phases.at(-1)).toMatchObject({
      goal: '整理证据',
      status: 'running',
    });
  });

  it('计时脚本只提取明确的数值数量，不猜测业务结论', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '汇总本地三次计时结果。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'Bash',
        { command: "python3 - <<'PY'\nprint('10,20,30')\nPY" },
        'timing-1',
      ),
    });
    state = complete(state, 'timing-1', {
      resultSummary: 'RPC-marker 10,20,30',
    });

    expect((state as any).phases[0]).toMatchObject({
      goal: '汇总本地三次计时结果。',
      outcome: '已获得 3 个计时值',
    });
  });

  it('阶段内后续普通动作不会覆盖已经取得的测试结果', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '验证完整执行链路。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'Bash',
        { command: 'node --test fixture.test.mjs' },
        'keep-test',
      ),
    });
    state = complete(state, 'keep-test', { resultSummary: '# pass 1' });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Grep', { pattern: 'evidence' }, 'after-test'),
    });
    state = complete(state, 'after-test');

    expect((state as any).phases[0].outcome).toBe(
      '已测试 fixture.test.mjs，并搜索“evidence”（1 项通过）',
    );
  });

  it('同一阶段重复类别只保留最新对象，不让默认卡无限增长', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '核对配置文件。',
    });
    for (const [id, file] of [
      ['read-a', '/tmp/a.ts'],
      ['read-b', '/tmp/b.ts'],
      ['read-c', '/tmp/c.ts'],
    ]) {
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: started('Read', { file_path: file }, id),
      });
      state = complete(state, id);
    }

    expect((state as any).phases[0].actionSummaries).toEqual(['读取 c.ts']);
    expect((state as any).phases[0].outcome).toBe('已读取 c.ts');
  });

  it('并行工具先完成一个时仍展示另一个运行中的动作', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '并行核对证据。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Read', { file_path: '/tmp/a' }, 'parallel-read'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Grep', { pattern: 'needle' }, 'parallel-search'),
    });
    state = complete(state, 'parallel-read');

    expect((state as any).phases[0]).toMatchObject({
      status: 'running',
      currentAction: '正在搜索“needle”',
    });
  });

  it('失败终态保留阶段目标和退出码', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '验证失败状态展示。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: "sh -c 'exit 7'" }, 'fail-7'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'codex',
        lifecycle: 'failed',
        toolName: 'command_execution',
        toolCallId: 'fail-7',
        exitCode: 7,
      },
    });

    expect((state as any).phases).toEqual([
      expect.objectContaining({
        goal: '验证失败状态展示。',
        status: 'failed',
        outcome: '命令执行失败（退出码 7）',
      }),
    ]);
  });

  it('阶段上下文持续生效且不会被四十个工具步骤挤掉', () => {
    let state = createProgressPresentationState();
    for (let phaseIndex = 1; phaseIndex <= 4; phaseIndex++) {
      state = reduceProgressPresentation(state, {
        kind: 'narration',
        text: `阶段 ${phaseIndex}。`,
      });
      for (let toolIndex = 0; toolIndex < 10; toolIndex++) {
        const toolCallId = `phase-${phaseIndex}-tool-${toolIndex}`;
        state = reduceProgressPresentation(state, {
          kind: 'tool',
          progress: started('Grep', { pattern: `p${toolIndex}` }, toolCallId),
        });
        state = complete(state, toolCallId);
      }
    }

    const phases = (state as any).phases;
    expect(phases).toHaveLength(4);
    expect(phases.slice(-3).map((phase: any) => phase.goal)).toEqual([
      '阶段 2。',
      '阶段 3。',
      '阶段 4。',
    ]);
    expect(phases.every((phase: any) => phase.toolCallIds.length === 10)).toBe(
      true,
    );
  });

  it.each([
    [
      '部署已确认生效：新 PID 62099，飞书 WebSocket 已连接。',
      '部署已确认生效：新 PID 62099，飞书 WebSocket 已连接。',
    ],
    [
      '真链路环境已确认：账号有效，测试群可用。',
      '真链路环境已确认：账号有效，测试群可用。',
    ],
    [
      'RPC-01 已真实跑通：四类工具状态全部闭环。',
      'RPC-01 已真实跑通：四类工具状态全部闭环。',
    ],
    [
      '继续。构建物已经完整复制并逐文件一致；我现在只核验重启是否生效。',
      '继续。构建物已经完整复制并逐文件一致；我现在只核验重启是否生效。',
    ],
    ['先看第一行。\n第二行不进标题。', '先看第一行。'],
  ])('标题保留 narration 原文首行不做智能摘要：%s', (narration, expectedGoal) => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: narration,
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'Bash',
        { command: 'git status' },
        `goal-${expectedGoal}`,
      ),
    });
    expect((state as any).phases[0].goal).toBe(expectedGoal);
  });

  it('narration 即时建 Phase，无需等待首个工具', () => {
    const state = reduceProgressPresentation(
      createProgressPresentationState(),
      { kind: 'narration', text: '我先梳理回调链路。\n细节：三处调用点。' },
    );
    expect((state as any).phases).toHaveLength(1);
    expect((state as any).phases[0]).toMatchObject({
      source: 'narration',
      goal: '我先梳理回调链路。',
      narrationText: '我先梳理回调链路。\n细节：三处调用点。',
      hasToolActivity: false,
    });
  });

  it('连续 narration 无工具活动时合并进同一 Phase，全文追加', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '第一段思路。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '第二段补充。',
    });
    expect((state as any).phases).toHaveLength(1);
    expect((state as any).phases[0].goal).toBe('第一段思路。');
    expect((state as any).phases[0].narrationText).toBe(
      '第一段思路。\n\n第二段补充。',
    );
  });

  it.each([
    [
      'ToolSearch 早退分支',
      () => started('ToolSearch', { query: 'select:Read' }, 'ts-1'),
    ],
    [
      'plan 控制工具 TaskCreate',
      () => started('TaskCreate', { subject: '新任务' }, 'tc-1'),
    ],
    ['无 toolCallId 的工具事件', () => started('Grep', { pattern: 'x' })],
    [
      'completion-only 事件（找不到 started）',
      () =>
        ({
          provider: 'claude',
          lifecycle: 'completed',
          toolName: 'tool_result',
          toolCallId: 'orphan-1',
        }) as StructuredProgress,
    ],
  ])('narration 被 %s 隔开后新 narration 不合并', (_label, makeProgress) => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '第一段思路。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: makeProgress(),
    });
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '第二段思路。',
    });
    const narrationPhases = (state as any).phases.filter(
      (phase: any) => phase.source === 'narration',
    );
    expect(narrationPhases).toHaveLength(2);
    expect(narrationPhases[0].narrationText).toBe('第一段思路。');
    expect(narrationPhases[1].narrationText).toBe('第二段思路。');
  });

  it.each([
    [
      'TodoWrite',
      () =>
        started(
          'TodoWrite',
          { todos: [{ content: '补齐单元测试', status: 'in_progress' }] },
          'plan-mid',
        ),
    ],
    ['TaskCreate', () => started('TaskCreate', { subject: '新任务' }, 'plan-mid')],
    [
      'TaskUpdate',
      () => started('TaskUpdate', { taskId: '9', status: 'in_progress' }, 'plan-mid'),
    ],
  ])('narration 之后的 %s 不清掉活跃 narration，后续工具仍归属 narration', (
    _label,
    makePlanControl,
  ) => {
    // 预置 planTaskId=9 的计划任务，确保 TaskUpdate 命中成功分支（真实覆盖）
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started('TaskCreate', { subject: '既有任务' }, 'tc-seed'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'claude',
        lifecycle: 'completed',
        toolName: 'tool_result',
        toolCallId: 'tc-seed',
        resultSummary: 'Task #9 created',
      },
    });
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '先修复回调重试。',
    });
    const narrationId = (state as any).phases.at(-1).id;
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: makePlanControl(),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Read', { file_path: '/tmp/a.txt' }, 'after-plan'),
    });
    expect(state.steps.at(-1)?.phaseId).toBe(narrationId);
    const narrationPhase = (state as any).phases.find(
      (phase: any) => phase.id === narrationId,
    );
    expect(narrationPhase.currentAction).toBe('正在读取 a.txt');
  });

  it('连续 narration 累加超过 4000 code point 时状态层截断存储', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'narration',
      text: '甲'.repeat(3000),
    });
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '乙'.repeat(3000),
    });
    const stored = (state as any).phases[0].narrationText as string;
    expect(Array.from(stored)).toHaveLength(4000); // 3999 正文 + …，硬上限 4000
    expect(stored.endsWith('…')).toBe(true);
  });

  it('活跃 narration Phase 存在时工具归属 narration 而非 running plan', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started(
        'TodoWrite',
        { todos: [{ content: '补齐单元测试', status: 'in_progress' }] },
        'todo-1',
      ),
    });
    state = reduceProgressPresentation(state, {
      kind: 'narration',
      text: '先修复回调重试。',
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Bash', { command: 'npm test' }, 'test-1'),
    });
    const narrationPhase = (state as any).phases.find(
      (phase: any) => phase.source === 'narration',
    );
    expect(narrationPhase.currentAction).toBe('正在运行测试');
    expect(state.steps.at(-1)?.phaseId).toBe(narrationPhase.id);
    const planPhase = (state as any).phases.find(
      (phase: any) => phase.source === 'plan',
    );
    expect(planPhase.currentAction).toBeUndefined();
  });

  it('开局 fallback 行的 goal 跟随最新动作（纯动作单行）', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started('Read', { file_path: '/tmp/a.py' }, 'read-1'),
    });
    state = complete(state, 'read-1');
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('Grep', { pattern: 'needle' }, 'grep-1'),
    });
    const fallback = (state as any).phases[0];
    expect(fallback.source).toBe('fallback');
    expect(fallback.goal).toBe('正在搜索“needle”');
    expect(fallback.currentAction).toBe('正在搜索“needle”');
  });

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
      progress: started(
        'TodoWrite',
        {
          todos: [{ content: '补齐单元测试', status: 'in_progress' }],
        },
        'todo-parent',
      ),
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
    expect(state.steps[0].phase).toBe(
      '我先核对模型配置为什么没有生效。后面还有说明。',
    );
    expect(state.steps[0].title).toBe('正在搜索“opus-4.8”');
  });

  describe('非零退出码的探测语义（退出码 1 ≠ 执行失败）', () => {
    function completeWithExit(
      state: ReturnType<typeof createProgressPresentationState>,
      toolCallId: string,
      exitCode: number,
    ) {
      return reduceProgressPresentation(state, {
        kind: 'tool',
        progress: {
          provider: 'claude',
          lifecycle: 'completed',
          toolName: 'tool_result',
          toolCallId,
          exitCode,
        },
      });
    }

    it.each([
      ['Grep 工具', started('Grep', { pattern: 'needle' }, 'probe-1')],
      [
        'Bash rg 命令',
        started('Bash', { command: "rg -n 'needle' src" }, 'probe-1'),
      ],
      [
        'Bash grep 命令',
        started('Bash', { command: "grep -r 'needle' ." }, 'probe-1'),
      ],
    ])('%s 退出码 1 渲染为"无匹配"而非失败', (_label, progress) => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        { kind: 'tool', progress },
      );
      state = completeWithExit(state, 'probe-1', 1);
      expect(state.steps[0].status).toBe('completed');
      expect(state.steps[0].title).toBe('已搜索，无匹配');
      expect((state as any).phases[0].status).toBe('completed');
    });

    it('git diff --check 退出码 1 渲染为"发现差异"', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started(
            'Bash',
            { command: 'git diff --check' },
            'diff-1',
          ),
        },
      );
      state = completeWithExit(state, 'diff-1', 1);
      expect(state.steps[0].status).toBe('completed');
      expect(state.steps[0].title).toBe('已检查，发现差异');
    });

    it('搜索命令退出码 2（真实错误）仍按失败处理，用中性文案', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Grep', { pattern: '[bad' }, 'err-1'),
        },
      );
      state = completeWithExit(state, 'err-1', 2);
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('命令返回非零（退出码 2）');
    });

    it('测试命令退出码非零渲染为"测试未通过"，阶段结果同步', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command: 'npm test' }, 'red-1'),
        },
      );
      state = completeWithExit(state, 'red-1', 1);
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('测试未通过');
      expect((state as any).phases[0].outcome).toBe('测试未通过');
    });

    it('curl 等检查命令退出码 1 不误标为发现差异，用中性失败文案', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started(
            'Bash',
            { command: 'curl -fsS http://service/health' },
            'curl-1',
          ),
        },
      );
      state = completeWithExit(state, 'curl-1', 1);
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('命令返回非零（退出码 1）');
    });

    it('lifecycle=failed（无退出码）维持原失败语义', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command: 'ls /tmp' }, 'hard-1'),
        },
      );
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: {
          provider: 'claude',
          lifecycle: 'failed',
          toolName: 'tool_result',
          toolCallId: 'hard-1',
        },
      });
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('执行失败');
    });

    it('探测无匹配的结果精确保留到 narration Phase 聚合', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        { kind: 'narration', text: '确认没有残留引用。' },
      );
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: started('Grep', { pattern: 'legacyFn' }, 'clean-1'),
      });
      state = completeWithExit(state, 'clean-1', 1);
      const narrationPhase = (state as any).phases.at(-1);
      expect(narrationPhase.status).toBe('completed');
      expect(narrationPhase.outcome).toBe('已搜索，无匹配');
    });

    it('探测无匹配的结果精确保留到 fallback Phase 聚合', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Grep', { pattern: 'legacyFn' }, 'fb-1'),
        },
      );
      state = completeWithExit(state, 'fb-1', 1);
      const phase = (state as any).phases[0];
      expect(phase.status).toBe('completed');
      expect(phase.outcome).toBe('已搜索，无匹配');
    });

    it.each([
      ['rg 后接 && false', 'rg -n needle src && false'],
      ['取反 ! rg', '! rg -n needle src'],
      ['rg 后接分号 false', 'rg -n needle src; false'],
      ['管道到 grep', 'curl -s http://x | grep ok'],
      ['命令替换', 'rg -n "$(cat pattern.txt)" src'],
    ])('复合命令（%s）退出码 1 不伪装成无匹配', (_label, command) => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command }, 'compound-1'),
        },
      );
      state = completeWithExit(state, 'compound-1', 1);
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('命令返回非零（退出码 1）');
    });

    it('引号内的正则控制符不影响探测判定（rg 竖线在引号里）', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command: "rg -n 'foo|bar' src" }, 'q-1'),
        },
      );
      state = completeWithExit(state, 'q-1', 1);
      expect(state.steps[0].status).toBe('completed');
      expect(state.steps[0].title).toBe('已搜索，无匹配');
    });

    it.each([
      ['bash -c 包装复合命令', "bash -c 'rg x src && false'"],
      ['zsh -c 双引号包装复合命令', 'zsh -c "rg x src && false"'],
      ['python -c 注释里出现 rg', 'python -c "raise SystemExit(1) # rg x src"'],
      ['eval 包装', "eval 'rg x src && false'"],
      ['node -e 包装', "node -e 'process.exit(1) // rg'"],
    ])('解释器包装（%s）退出码 1 不伪装成无匹配', (_label, command) => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command }, 'wrap-1'),
        },
      );
      state = completeWithExit(state, 'wrap-1', 1);
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('命令返回非零（退出码 1）');
    });

    it.each([
      ['codex 标准外壳', '/bin/zsh -lc "rg -n needle src"'],
      ['绝对路径 rg', '/usr/bin/rg -n needle src'],
      ['环境变量前缀', 'LC_ALL=C rg -n needle src'],
    ])('%s 的单一 rg 探测仍识别无匹配', (_label, command) => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command }, 'unwrap-1'),
        },
      );
      state = completeWithExit(state, 'unwrap-1', 1);
      expect(state.steps[0].status).toBe('completed');
      expect(state.steps[0].title).toBe('已搜索，无匹配');
    });

    it('外壳内层复合命令解包后照样拒绝', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started(
            'Bash',
            { command: '/bin/zsh -lc "rg x src && false"' },
            'unwrap-2',
          ),
        },
      );
      state = completeWithExit(state, 'unwrap-2', 1);
      expect(state.steps[0].status).toBe('failed');
    });

    it('并行工具场景 probe 事实不丢失：探测先完成，普通工具后完成', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        { kind: 'narration', text: '并行核查。' },
      );
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: started('Grep', { pattern: 'legacyFn' }, 'par-grep'),
      });
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: started('Read', { file_path: '/tmp/a.ts' }, 'par-read'),
      });
      state = completeWithExit(state, 'par-grep', 1);
      state = reduceProgressPresentation(state, {
        kind: 'tool',
        progress: {
          provider: 'claude',
          lifecycle: 'completed',
          toolName: 'tool_result',
          toolCallId: 'par-read',
        },
      });
      const phase = (state as any).phases.at(-1);
      expect(phase.status).toBe('completed');
      expect(phase.outcome).toContain('无匹配');
    });

    it('独立 diff 命令不再声明支持：退出码 1 走中性失败', () => {
      let state = reduceProgressPresentation(
        createProgressPresentationState(),
        {
          kind: 'tool',
          progress: started('Bash', { command: 'diff a.txt b.txt' }, 'd-1'),
        },
      );
      state = completeWithExit(state, 'd-1', 1);
      expect(state.steps[0].status).toBe('failed');
      expect(state.steps[0].title).toBe('命令返回非零（退出码 1）');
    });
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
    expect(state.steps[0].title).toBe('已运行测试');
    expect(state.steps[0].status).toBe('completed');
  });

  it('完成态保留动作对象，不退化成宽泛分类', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started(
        'mcp__nanoclaw__search_chat',
        { query: 'marker' },
        'search-chat-1',
      ),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'claude',
        lifecycle: 'completed',
        toolName: 'tool_result',
        toolCallId: 'search-chat-1',
      },
    });
    expect(state.steps[0].title).toBe('已搜索包含“marker”的聊天记录');
  });

  it('新版 TaskCreate/TaskUpdate 维护同一组真实计划', () => {
    let state = createProgressPresentationState();
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started('TaskCreate', { subject: '核对 fixture' }, 'create-1'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'claude',
        lifecycle: 'completed',
        toolName: 'tool_result',
        toolCallId: 'create-1',
        resultSummary: 'Task #1 created successfully: 核对 fixture',
      },
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'TaskUpdate',
        { taskId: '1', status: 'completed' },
        'update-1',
      ),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'claude',
        lifecycle: 'completed',
        toolName: 'tool_result',
        toolCallId: 'update-1',
        resultSummary: 'Updated task #1 status',
      },
    });

    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({
      title: '核对 fixture',
      status: 'completed',
      source: 'plan',
      planTaskId: '1',
    });
  });

  it('新版 Task 进行中计划成为后续工具的阶段标题', () => {
    let state = reduceProgressPresentation(createProgressPresentationState(), {
      kind: 'tool',
      progress: started('TaskCreate', { subject: '运行长测试' }, 'create-2'),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: {
        provider: 'claude',
        lifecycle: 'completed',
        toolName: 'tool_result',
        toolCallId: 'create-2',
        resultSummary: 'Task #2 created successfully: 运行长测试',
      },
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'TaskUpdate',
        { taskId: '2', status: 'in_progress' },
        'update-2',
      ),
    });
    state = reduceProgressPresentation(state, {
      kind: 'tool',
      progress: started(
        'Bash',
        { command: 'node --test fixture.test.mjs' },
        'bash-2',
      ),
    });

    expect(state.steps.at(-1)?.phase).toBe('运行长测试');
    expect(state.steps.at(-1)?.title).toBe(
      '正在运行 fixture.test.mjs 测试',
    );
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
