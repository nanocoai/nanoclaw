import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';

const skillPath = path.join(process.cwd(), 'container/skills/code-graph/SKILL.md');

describe('code-graph skill GitNexus indexing guidance', () => {
  it('未索引仓库不再指示无确认自动执行 embeddings 建索引', () => {
    const content = fs.readFileSync(skillPath, 'utf-8');

    expect(content).toContain('必须先询问用户确认');
    expect(content).toContain('快速静态索引');
    expect(content).toContain('完整语义索引');
    expect(content).toContain('with_gitnexus_timeout 120');
    expect(content).toContain('command -v timeout');
    expect(content).toContain('command -v gtimeout');
    expect(content).not.toContain(
      'cd <项目路径> && source ~/.gitnexus/env && gitnexus analyze . --name <项目名> --embeddings',
    );
    expect(content).not.toMatch(/(^|[;&]\s*)timeout 120 gitnexus/m);
    expect(content).not.toContain('首次使用时自动建索引');
  });

  it('CLI fallback 文案对 ~/.gitnexus/env 缺失是容错的', () => {
    const content = fs.readFileSync(skillPath, 'utf-8');

    expect(content).toContain('if [ -f "$HOME/.gitnexus/env" ]; then');
    expect(content).not.toContain('source ~/.gitnexus/env && gitnexus <command>');
  });
});
