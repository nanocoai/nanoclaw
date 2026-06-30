import { describe, expect, it } from 'vitest';
import { dedupeByUrl, normalizeItem } from '../lib/normalize.js';
import type { NewsItem } from '../lib/types.js';

function item(overrides: Partial<NewsItem>): NewsItem {
  return {
    id: '1',
    source: 'hn',
    title: 't',
    url: 'https://example.com/a',
    publishedAt: '2026-06-30T00:00:00.000Z',
    score: 1,
    feedId: 'hn',
    ...overrides,
  };
}

describe('normalize', () => {
  it('dedupeByUrl removes duplicate URLs keeping higher score', () => {
    const items = [
      item({ url: 'https://example.com/dup', score: 10 }),
      item({ id: '2', url: 'https://example.com/dup', score: 25 }),
    ];
    const result = dedupeByUrl(items);
    expect(result).toHaveLength(1);
    expect(result[0]!.score).toBe(25);
  });

  it('dedupeByUrl treats http and https same host as duplicate', () => {
    const items = [
      item({ url: 'http://x/a', score: 5 }),
      item({ id: '2', url: 'https://x/a', score: 3 }),
    ];
    expect(dedupeByUrl(items)).toHaveLength(1);
  });

  it('normalizeItem trims title and fills publishedAt when missing', () => {
    const result = normalizeItem({
      id: 'n1',
      source: 'rss',
      title: '  spaced title  ',
      url: 'https://example.com/post',
      score: 0,
      feedId: 'openai-blog',
    });
    expect(result.title).toBe('spaced title');
    expect(() => new Date(result.publishedAt)).not.toThrow();
    expect(Number.isNaN(Date.parse(result.publishedAt))).toBe(false);
  });

  it('dedupeByUrl keeps distinct URLs', () => {
    const items = [
      item({ url: 'https://example.com/1' }),
      item({ id: '2', url: 'https://example.com/2' }),
      item({ id: '3', url: 'https://example.com/3' }),
    ];
    expect(dedupeByUrl(items)).toHaveLength(3);
  });
});
