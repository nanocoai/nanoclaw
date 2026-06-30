import type { NewsItem } from './types.js';
import { normalizeItem } from './normalize.js';

const HN_API = 'https://hacker-news.firebaseio.com/v0';
const DEFAULT_CONCURRENCY = 5;

type HnItemResponse = {
  id: number;
  title?: string;
  url?: string;
  score?: number;
  time?: number;
};

export type FetchHnOptions = {
  topStories?: number;
  concurrency?: number;
  fetchImpl?: typeof fetch;
};

export async function fetchHn(
  options: FetchHnOptions = {},
): Promise<{ items: NewsItem[]; errors: Array<{ source: string; message: string }> }> {
  const topStories = options.topStories ?? 50;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const fetchImpl = options.fetchImpl ?? fetch;
  const errors: Array<{ source: string; message: string }> = [];
  const items: NewsItem[] = [];

  try {
    const topRes = await fetchImpl(`${HN_API}/topstories.json`);
    if (!topRes.ok) {
      throw new Error(`HN topstories HTTP ${topRes.status}`);
    }
    const ids = (await topRes.json()) as number[];
    const selected = ids.slice(0, topStories);

    for (let i = 0; i < selected.length; i += concurrency) {
      const batch = selected.slice(i, i + concurrency);
      const batchItems = await Promise.all(
        batch.map(async (id) => {
          try {
            const itemRes = await fetchImpl(`${HN_API}/item/${id}.json`);
            if (!itemRes.ok) {
              throw new Error(`HN item ${id} HTTP ${itemRes.status}`);
            }
            return (await itemRes.json()) as HnItemResponse;
          } catch (error) {
            errors.push({
              source: `hn:item:${id}`,
              message: error instanceof Error ? error.message : String(error),
            });
            return null;
          }
        }),
      );

      for (const raw of batchItems) {
        if (!raw?.url) {
          continue;
        }
        items.push(
          normalizeItem({
            id: String(raw.id),
            source: 'hn',
            title: raw.title ?? '',
            url: raw.url,
            publishedAt: raw.time
              ? new Date(raw.time * 1000).toISOString()
              : undefined,
            score: raw.score ?? 0,
            feedId: 'hn',
          }),
        );
      }
    }
  } catch (error) {
    errors.push({
      source: 'hn',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  return { items, errors };
}
