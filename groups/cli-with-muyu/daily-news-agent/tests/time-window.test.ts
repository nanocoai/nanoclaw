import { describe, expect, it } from 'vitest';
import { filterWithinWindow } from '../lib/time-window.js';
import type { NewsItem } from '../lib/types.js';

function item(publishedAt: string): NewsItem {
  return {
    id: '1',
    source: 'hn',
    title: 't',
    url: 'https://example.com/a',
    publishedAt,
    score: 1,
    feedId: 'hn',
  };
}

describe('time-window', () => {
  const now = new Date('2026-06-30T12:00:00.000Z');

  it('filterWithinWindow keeps items within 24h', () => {
    const items = [
      item('2026-06-30T06:00:00.000Z'),
      item('2026-06-30T00:00:00.000Z'),
      item('2026-06-28T11:00:00.000Z'),
    ];
    expect(filterWithinWindow(items, 24, now)).toHaveLength(2);
  });

  it('filterWithinWindow excludes future items', () => {
    const items = [item('2026-06-30T13:00:00.000Z')];
    expect(filterWithinWindow(items, 24, now)).toHaveLength(0);
  });

  it('filterWithinWindow includes item at exactly 24h boundary', () => {
    const items = [item('2026-06-29T12:00:00.000Z')];
    expect(filterWithinWindow(items, 24, now)).toHaveLength(1);
  });

  it('filterWithinWindow empty input returns empty', () => {
    expect(filterWithinWindow([], 24, now)).toEqual([]);
  });
});
