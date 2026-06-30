import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchAllRss } from '../lib/fetch-rss.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const openaiXml = readFileSync(path.join(fixturesDir, 'rss-openai-sample.xml'), 'utf8');
const techcrunchXml = readFileSync(
  path.join(fixturesDir, 'rss-techcrunch-ai-sample.xml'),
  'utf8',
);

describe('fetchAllRss', () => {
  it('fetchAllRss merges multiple feeds', async () => {
    const result = await fetchAllRss(
      [
        { id: 'openai-blog', url: 'https://openai.com/blog/rss.xml', maxItems: 20 },
        { id: 'techcrunch-ai', url: 'https://techcrunch.com/ai/feed/', maxItems: 20 },
      ],
      {
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes('openai')) {
            return { ok: true, text: async () => openaiXml } as Response;
          }
          if (href.includes('techcrunch')) {
            return { ok: true, text: async () => techcrunchXml } as Response;
          }
          throw new Error(`unexpected: ${href}`);
        },
      },
    );

    expect(result.items.length).toBeGreaterThanOrEqual(2);
    expect(result.items.some((i) => i.feedId === 'openai-blog')).toBe(true);
    expect(result.items.some((i) => i.feedId === 'techcrunch-ai')).toBe(true);
  });

  it('fetchAllRss continues when one feed fails', async () => {
    const result = await fetchAllRss(
      [
        { id: 'openai-blog', url: 'https://openai.com/blog/rss.xml', maxItems: 20 },
        { id: 'techcrunch-ai', url: 'https://techcrunch.com/ai/feed/', maxItems: 20 },
      ],
      {
        fetchImpl: async (url) => {
          const href = String(url);
          if (href.includes('openai')) {
            return { ok: true, text: async () => openaiXml } as Response;
          }
          return { ok: false, status: 503, text: async () => '' } as Response;
        },
      },
    );

    expect(result.items.length).toBeGreaterThanOrEqual(1);
    expect(result.errors.some((e) => e.source === 'rss:techcrunch-ai')).toBe(true);
  });
});
