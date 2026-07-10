import { describe, expect, it } from 'vitest';
import {
  boundProgressInput,
  buildClaudeToolResultProgress,
  redactProgressText,
} from './progress-types.js';

describe('boundProgressInput', () => {
  it('保留分类字段并限制长度', () => {
    const result = boundProgressInput({
      command: 'x'.repeat(3_000),
      query: 'model',
    });
    expect(result?.command).toHaveLength(2_000);
    expect(result?.query).toBe('model');
  });

  it('丢弃正文、凭证和环境变量', () => {
    expect(
      boundProgressInput({
        content: '完整文件正文',
        api_key: 'secret',
        env: { TOKEN: 'secret' },
        command: 'npm test',
      }),
    ).toEqual({ command: 'npm test' });
  });

  it('文件变更列表有界', () => {
    const changes = Array.from({ length: 30 }, (_, index) => ({
      path: `/tmp/${index}.ts`,
      kind: 'modify',
      content: 'secret',
    }));
    const result = boundProgressInput({ changes });
    expect(result?.changes).toHaveLength(20);
    expect((result?.changes as Array<Record<string, unknown>>)[0]).toEqual({
      path: '/tmp/0.ts',
      kind: 'modify',
    });
  });

  it('真实计划只保留有界内容和合法状态', () => {
    expect(
      boundProgressInput({
        todos: [
          {
            content: '核对实现',
            status: 'in_progress',
            activeForm: '正在核对',
          },
          { content: '运行测试', status: 'invalid' },
        ],
      }),
    ).toEqual({
      todos: [
        { content: '核对实现', status: 'in_progress' },
        { content: '运行测试', status: 'pending' },
      ],
    });
  });

  it('新版 Task 工具只透传计划展示所需字段', () => {
    expect(
      boundProgressInput({
        subject: '运行长测试',
        activeForm: '运行长测试中',
        taskId: '2',
        status: 'in_progress',
        description: '不要透传的内部说明',
      }),
    ).toEqual({
      subject: '运行长测试',
      activeForm: '运行长测试中',
      taskId: '2',
      status: 'in_progress',
    });
  });
});

describe('buildClaudeToolResultProgress', () => {
  it('空内容的显式失败仍产生 failed 终态', () => {
    expect(
      buildClaudeToolResultProgress({
        type: 'tool_result',
        tool_use_id: 'tool-failed',
        is_error: true,
      }),
    ).toMatchObject({
      result: '❌ 执行失败',
      progress: { lifecycle: 'failed', toolCallId: 'tool-failed' },
    });
  });

  it('空内容的显式成功仍产生 completed 终态', () => {
    expect(
      buildClaudeToolResultProgress({
        type: 'tool_result',
        tool_use_id: 'tool-ok',
        content: '',
      }),
    ).toMatchObject({
      result: '✅ 执行完成',
      progress: { lifecycle: 'completed', toolCallId: 'tool-ok' },
    });
  });
});

describe('redactProgressText', () => {
  it('脱敏常见凭证 canary，同时保留普通测试输出', () => {
    const input = [
      'Authorization: Bearer bearer-canary-123456',
      'OPENAI_API_KEY=sk-canary-1234567890',
      'https://user:pass@example.com/path?access_token=query-canary-123',
      '-----BEGIN PRIVATE KEY-----',
      'private-canary-body',
      '-----END PRIVATE KEY-----',
      '12 tests passed',
    ].join('\n');
    const output = redactProgressText(input);
    expect(output).not.toContain('bearer-canary');
    expect(output).not.toContain('sk-canary');
    expect(output).not.toContain('user:pass');
    expect(output).not.toContain('query-canary');
    expect(output).not.toContain('private-canary-body');
    expect(output).toContain('12 tests passed');
  });

  it('Claude tool result 在生成 detail 和 summary 前脱敏', () => {
    const result = buildClaudeToolResultProgress({
      type: 'tool_result',
      tool_use_id: 'secret-result',
      content: 'Authorization: Bearer tool-result-canary-123456',
    });
    expect(JSON.stringify(result)).not.toContain('tool-result-canary');
  });
});
