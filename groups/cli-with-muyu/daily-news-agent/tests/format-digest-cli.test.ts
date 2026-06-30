import { describe, expect, it } from 'vitest';
import {
  formatDigestFromCliInput,
  parseDigestCliInput,
} from '../lib/format-digest-cli.js';

describe('format-digest-cli', () => {
  it('parseDigestCliInput and formatDigestFromCliInput produce contract output', () => {
    const input = parseDigestCliInput(
      JSON.stringify({
        dateLabel: '2026-06-30',
        qualifiedCount: 2,
        entries: [
          { rank: 1, title: 'A', summary: 's1', url: 'https://a.com' },
          { rank: 2, title: 'B', summary: 's2', url: 'https://b.com' },
        ],
      }),
    );

    const text = formatDigestFromCliInput(input);
    expect(text).toContain('📰 AI 技术日报 · 2026-06-30');
    expect(text).toContain('---');
    expect(text).toContain('今日仅 2 条合格条目 (候选池 < 5)');
  });
});
