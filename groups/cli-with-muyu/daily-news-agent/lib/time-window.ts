import type { NewsItem } from './types.js';

export function filterWithinWindow(
  items: NewsItem[],
  windowHours: number,
  now: Date,
): NewsItem[] {
  const windowMs = windowHours * 60 * 60 * 1000;
  const start = now.getTime() - windowMs;
  const end = now.getTime();

  return items.filter((item) => {
    const ts = Date.parse(item.publishedAt);
    if (Number.isNaN(ts)) {
      return false;
    }
    return ts >= start && ts <= end;
  });
}
