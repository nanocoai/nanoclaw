import Parser from 'rss-parser';
import type { NewsItem } from './types.js';
import { normalizeItem } from './normalize.js';

export type RssFeedConfig = {
  id: string;
  url: string;
  maxItems: number;
};

export type FetchRssOptions = {
  fetchImpl?: typeof fetch;
  parser?: Parser;
  /** Test hook: parse fixture XML instead of network */
  xmlContent?: string;
};

function isHttpUrl(link: string): boolean {
  return link.startsWith('http://') || link.startsWith('https://');
}

export async function fetchRssFeed(
  feed: RssFeedConfig,
  options: FetchRssOptions = {},
): Promise<{ items: NewsItem[]; errors: Array<{ source: string; message: string }> }> {
  const errors: Array<{ source: string; message: string }> = [];
  const items: NewsItem[] = [];
  const parser = options.parser ?? new Parser();

  try {
    let parsed: Parser.Output;
    if (options.xmlContent !== undefined) {
      parsed = await parser.parseString(options.xmlContent);
    } else if (options.fetchImpl) {
      const res = await options.fetchImpl(feed.url);
      if (!res.ok) {
        throw new Error(`RSS HTTP ${res.status}`);
      }
      parsed = await parser.parseString(await res.text());
    } else {
      parsed = await parser.parseURL(feed.url);
    }

    for (const entry of (parsed.items ?? []).slice(0, feed.maxItems)) {
      const link = entry.link?.trim();
      if (!link || !isHttpUrl(link)) {
        errors.push({
          source: `rss:${feed.id}`,
          message: 'missing or invalid link',
        });
        continue;
      }

      const publishedAt = entry.pubDate
        ? new Date(entry.pubDate).toISOString()
        : undefined;

      items.push(
        normalizeItem({
          id: `${feed.id}:${link}`,
          source: 'rss',
          title: entry.title ?? '',
          url: link,
          publishedAt,
          score: 0,
          feedId: feed.id,
        }),
      );
    }
  } catch (error) {
    errors.push({
      source: `rss:${feed.id}`,
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { items, errors };
}

export async function fetchAllRss(
  feeds: RssFeedConfig[],
  options: FetchRssOptions = {},
): Promise<{ items: NewsItem[]; errors: Array<{ source: string; message: string }> }> {
  const items: NewsItem[] = [];
  const errors: Array<{ source: string; message: string }> = [];

  for (const feed of feeds) {
    const result = await fetchRssFeed(feed, options);
    items.push(...result.items);
    errors.push(...result.errors);
  }

  return { items, errors };
}
