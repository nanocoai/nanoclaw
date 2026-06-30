import { describe, expect, it } from 'vitest';
import { runFetch } from '../lib/run-fetch.js';
import type { NewsItem } from '../lib/types.js';

function item(id: string, hoursAgo: number, now: Date): NewsItem {
  const publishedAt = new Date(now.getTime() - hoursAgo * 60 * 60 * 1000).toISOString();
  return {
    id,
    source: 'hn',
    title: `Title ${id}`,
    url: `https://example.com/${id}`,
    publishedAt,
    score: 10,
    feedId: 'hn',
  };
}

describe('run-fetch', () => {
  const now = new Date('2026-06-30T12:00:00.000Z');

  it('runFetch merges hn and rss, filters window, outputs wakeAgent JSON', async () => {
    const line = await runFetch(now, {
      loadConfig: () => ({
        feeds: [{ id: 'openai-blog', type: 'rss', url: 'http://x', maxItems: 20 }],
        hn: { topStories: 50 },
        windowHours: 24,
      }),
      fetchHn: async () => ({
        items: [item('hn1', 2, now), item('hn-old', 48, now)],
        errors: [],
      }),
      fetchAllRss: async () => ({
        items: [
          {
            id: 'rss1',
            source: 'rss',
            title: 'RSS',
            url: 'https://openai.com/blog/x',
            publishedAt: item('x', 1, now).publishedAt,
            score: 0,
            feedId: 'openai-blog',
          },
        ],
        errors: [{ source: 'rss:techcrunch-ai', message: 'timeout' }],
      }),
    });

    const parsed = JSON.parse(line) as {
      wakeAgent: boolean;
      data: { items: NewsItem[]; errors: unknown[]; windowHours: number };
    };

    expect(parsed.wakeAgent).toBe(true);
    expect(parsed.data.windowHours).toBe(24);
    expect(parsed.data.items).toHaveLength(2);
    expect(parsed.data.items.some((i) => i.id === 'hn-old')).toBe(false);
    expect(parsed.data.errors).toHaveLength(1);
  });

  it('runFetch returns wakeAgent false when pipeline yields no items', async () => {
    const line = await runFetch(now, {
      loadConfig: () => ({
        feeds: [],
        hn: { topStories: 50 },
        windowHours: 24,
      }),
      fetchHn: async () => ({ items: [], errors: [{ source: 'hn', message: 'down' }] }),
      fetchAllRss: async () => ({ items: [], errors: [] }),
    });

    const parsed = JSON.parse(line) as { wakeAgent: boolean; data?: unknown };
    expect(parsed.wakeAgent).toBe(false);
    expect(parsed.data).toBeUndefined();
  });
});
