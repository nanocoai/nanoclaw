import { describe, expect, it } from 'vitest';
import { boundProgressInput } from './progress-types.js';

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
    expect(boundProgressInput({
      todos: [
        { content: '核对实现', status: 'in_progress', activeForm: '正在核对' },
        { content: '运行测试', status: 'invalid' },
      ],
    })).toEqual({
      todos: [
        { content: '核对实现', status: 'in_progress' },
        { content: '运行测试', status: 'pending' },
      ],
    });
  });
});
