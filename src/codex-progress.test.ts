/**
 * codex file_change 进度格式化测试
 * mapCodexProgress 在 container/agent-runner,纯函数,跨目录 import 验证
 */
import { describe, it, expect } from 'vitest';
import { mapCodexProgress } from '../container/agent-runner/src/codex-runner.js';

function started(item: Record<string, unknown>) {
  return { type: 'item.started', item } as any;
}

describe('mapCodexProgress — file_change', () => {
  it('单文件:显示 kind + basename,detail 列出路径', () => {
    const out = mapCodexProgress(
      started({ id: 'i1', type: 'file_change', changes: [{ path: '/tmp/a.txt', kind: 'add' }] }),
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
      started({ id: 'i3', type: 'file_change', changes: [{ path: '/x', kind: 'rename' }] }),
    );
    expect(out[0].result).toBe('📝 rename x');
  });

  it('changes 为空时退化为通用分支(不崩)', () => {
    const out = mapCodexProgress(started({ id: 'i4', type: 'file_change', changes: [] }));
    expect(out[0].result).toBe('🔧 file_change');
  });
});

describe('mapCodexProgress — 回归', () => {
  it('command_execution 仍显示命令 + bash detail', () => {
    const out = mapCodexProgress(started({ id: 'c1', type: 'command_execution', command: 'npm test' }));
    expect(out[0].result).toBe('🔧 npm test');
    expect(out[0].detail).toContain('```bash');
    expect(out[0].detail).toContain('npm test');
  });

  it('agent_message 返回空', () => {
    expect(mapCodexProgress(started({ id: 'm1', type: 'agent_message', text: 'hi' }))).toEqual([]);
  });
});
