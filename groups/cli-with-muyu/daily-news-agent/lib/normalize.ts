import type { NewsItem } from './types.js';

function canonicalUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.toLowerCase();
    const path = parsed.pathname.replace(/\/$/, '') || '/';
    return `${host}${path}${parsed.search}`;
  } catch {
    return url.trim().toLowerCase();
  }
}

export function normalizeItem(raw: Partial<NewsItem>): NewsItem {
  const publishedAt =
    raw.publishedAt && !Number.isNaN(Date.parse(raw.publishedAt))
      ? raw.publishedAt
      : new Date().toISOString();

  return {
    id: raw.id ?? '',
    source: raw.source ?? 'rss',
    title: (raw.title ?? '').trim(),
    url: raw.url ?? '',
    publishedAt,
    score: raw.score ?? 0,
    feedId: raw.feedId ?? '',
  };
}

export function dedupeByUrl(items: NewsItem[]): NewsItem[] {
  const byUrl = new Map<string, NewsItem>();

  for (const item of items) {
    const key = canonicalUrl(item.url);
    const existing = byUrl.get(key);
    if (!existing || item.score > existing.score) {
      byUrl.set(key, item);
    }
  }

  return [...byUrl.values()];
}
