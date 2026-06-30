import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fetchRssFeed } from '../lib/fetch-rss.js';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const openaiXml = readFileSync(path.join(fixturesDir, 'rss-openai-sample.xml'), 'utf8');

const feed = {
  id: 'openai-blog',
  url: 'https://openai.com/blog/rss.xml',
  maxItems: 10,
};

describe('fetch-rss', () => {
  it('fetchRssFeed returns rss items from fixture xml', async () => {
    const result = await fetchRssFeed(feed, { xmlContent: openaiXml });

    expect(result.items).toHaveLength(1);
    expect(result.items[0]!.source).toBe('rss');
    expect(result.items[0]!.title).toBe('GPT update');
    expect(result.items[0]!.url).toBe('https://openai.com/blog/gpt-update');
    expect(result.items[0]!.feedId).toBe('openai-blog');
  });

  it('fetchRssFeed records error for missing link', async () => {
    const result = await fetchRssFeed(feed, { xmlContent: openaiXml });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]!.source).toBe('rss:openai-blog');
    expect(result.errors[0]!.message).toBe('missing or invalid link');
  });
});
