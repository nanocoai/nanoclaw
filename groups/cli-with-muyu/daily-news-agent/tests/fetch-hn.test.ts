import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { fetchHn } from '../lib/fetch-hn.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const topStories = JSON.parse(
  readFileSync(path.join(fixturesDir, 'hn-topstories.json'), 'utf8'),
) as number[];
const hnItem = JSON.parse(readFileSync(path.join(fixturesDir, 'hn-item.json'), 'utf8')) as {
  id: number;
  title: string;
  url: string;
  score: number;
  time: number;
};

function createMockFetch() {
  return vi.fn(async (url: string | URL | Request) => {
    const href = String(url);
    if (href.endsWith('/topstories.json')) {
      return {
        ok: true,
        json: async () => topStories,
      } as Response;
    }

    const itemMatch = href.match(/\/item\/(\d+)\.json$/);
    if (itemMatch) {
      const id = Number(itemMatch[1]);
      if (id === hnItem.id) {
        return { ok: true, json: async () => hnItem } as Response;
      }
      return {
        ok: true,
        json: async () => ({
          id,
          title: 'Ask HN without link',
          score: 10,
          time: 1719756000,
        }),
      } as Response;
    }

    throw new Error(`unexpected fetch url: ${href}`);
  });
}

describe('fetch-hn', () => {
  it('fetchHn returns items with source hn', async () => {
    const result = await fetchHn({ topStories: 2, fetchImpl: createMockFetch() });

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.items.every((item) => item.source === 'hn')).toBe(true);
    expect(result.items[0]!.title).toBe('Show HN: AI news tool');
    expect(result.items[0]!.url).toBe('https://example.com/ai-tool');
    expect(result.items[0]!.feedId).toBe('hn');
    expect(result.errors).toHaveLength(0);
  });

  it('fetchHn drops items without url', async () => {
    const result = await fetchHn({ topStories: 2, fetchImpl: createMockFetch() });

    expect(result.items).toHaveLength(1);
    expect(result.items.find((item) => item.id === '2')).toBeUndefined();
  });

  it('fetchHn respects topStories limit and batches item fetches', async () => {
    const ids = Array.from({ length: 12 }, (_, i) => i + 1);
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const href = String(url);
      if (href.endsWith('/topstories.json')) {
        return { ok: true, json: async () => ids } as Response;
      }
      const itemMatch = href.match(/\/item\/(\d+)\.json$/);
      if (itemMatch) {
        const id = Number(itemMatch[1]);
        return {
          ok: true,
          json: async () => ({
            id,
            title: `Story ${id}`,
            url: `https://example.com/${id}`,
            score: id,
            time: 1719756000,
          }),
        } as Response;
      }
      throw new Error(`unexpected: ${href}`);
    });

    const result = await fetchHn({ topStories: 10, concurrency: 5, fetchImpl });

    expect(result.items).toHaveLength(10);
    const itemCalls = fetchImpl.mock.calls.filter((c) =>
      String(c[0]).includes('/item/'),
    );
    expect(itemCalls.length).toBe(10);
  });
});
