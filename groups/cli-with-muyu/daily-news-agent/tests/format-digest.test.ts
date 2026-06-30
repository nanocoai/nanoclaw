import { describe, expect, it } from 'vitest';
import { formatDigestMessage } from '../lib/format-digest.js';

describe('format-digest', () => {
  it('formatDigestMessage renders N entries with rank and url', () => {
    const message = formatDigestMessage({
      dateLabel: '2026-06-30',
      qualifiedCount: 3,
      entries: [
        { rank: 1, title: 'A', summary: 's1', url: 'https://a.com' },
        { rank: 2, title: 'B', summary: 's2', url: 'https://b.com' },
        { rank: 3, title: 'C', summary: 's3', url: 'https://c.com' },
      ],
    });
    expect(message).toContain('1.');
    expect(message).toContain('2.');
    expect(message).toContain('3.');
    expect(message).toContain('https://a.com');
    expect(message).toContain('https://b.com');
    expect(message).toContain('https://c.com');
  });

  it('formatDigestMessage includes date header', () => {
    const message = formatDigestMessage({
      dateLabel: '2026-06-30',
      qualifiedCount: 1,
      entries: [{ rank: 1, title: 'A', summary: 's', url: 'https://a.com' }],
    });
    expect(message).toContain('2026-06-30');
    expect(message).toContain('---');
  });

  it('formatDigestMessage appends pool footer when N < 5', () => {
    const message = formatDigestMessage({
      dateLabel: '2026-06-30',
      qualifiedCount: 3,
      entries: [
        { rank: 1, title: 'A', summary: 's1', url: 'https://a.com' },
        { rank: 2, title: 'B', summary: 's2', url: 'https://b.com' },
        { rank: 3, title: 'C', summary: 's3', url: 'https://c.com' },
      ],
    });
    expect(message).toContain('今日仅 3 条合格条目 (候选池 < 5)');
  });

  it('formatDigestMessage omits pool footer when N = 5', () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      rank: i + 1,
      title: `T${i + 1}`,
      summary: `s${i + 1}`,
      url: `https://example.com/${i + 1}`,
    }));
    const message = formatDigestMessage({
      dateLabel: '2026-06-30',
      qualifiedCount: 5,
      entries,
    });
    expect(message).not.toContain('候选池 < 5');
  });

  it('formatDigestMessage appends footer with N=0', () => {
    const message = formatDigestMessage({
      dateLabel: '2026-06-30',
      qualifiedCount: 0,
      entries: [],
      emptyMessage: '今日无 notable AI 热点',
    });
    expect(message).toContain('今日无 notable AI 热点');
    expect(message).toContain('今日仅 0 条合格条目 (候选池 < 5)');
  });
});
