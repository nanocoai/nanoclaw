import { describe, expect, it } from 'vitest';
import {
  buildScriptOutput,
  serializeScriptLine,
} from '../lib/build-script-output.js';
import type { NewsItem } from '../lib/types.js';

function sampleItem(): NewsItem {
  return {
    id: '1',
    source: 'hn',
    title: 't',
    url: 'https://example.com/a',
    publishedAt: '2026-06-30T00:00:00.000Z',
    score: 1,
    feedId: 'hn',
  };
}

describe('build-script-output', () => {
  const now = new Date('2026-06-30T09:00:00.000Z');

  it('buildScriptOutput wakeAgent true when items present', () => {
    const result = buildScriptOutput(
      [sampleItem(), sampleItem(), sampleItem()],
      [],
      'Asia/Shanghai',
      24,
      now,
    );
    expect(result.wakeAgent).toBe(true);
  });

  it('buildScriptOutput wakeAgent false when no items and errors', () => {
    const result = buildScriptOutput(
      [],
      [{ source: 'hn', message: 'failed' }],
      'Asia/Shanghai',
      24,
      now,
    );
    expect(result.wakeAgent).toBe(false);
  });

  it('buildScriptOutput wakeAgent true when partial errors', () => {
    const result = buildScriptOutput(
      [sampleItem()],
      [{ source: 'rss:openai-blog', message: 'timeout' }],
      'Asia/Shanghai',
      24,
      now,
    );
    expect(result.wakeAgent).toBe(true);
  });

  it('serializeScriptLine outputs parseable JSON', () => {
    const result = buildScriptOutput(
      [sampleItem()],
      [],
      'Asia/Shanghai',
      24,
      now,
    );
    expect(() => JSON.parse(serializeScriptLine(result))).not.toThrow();
  });

  it('buildScriptOutput sets fetchedAt and timezone', () => {
    const result = buildScriptOutput(
      [sampleItem()],
      [],
      'Asia/Shanghai',
      24,
      now,
    );
    expect(result.data?.timezone).toBe('Asia/Shanghai');
    expect(result.data?.fetchedAt).toBe(now.toISOString());
    expect(result.data?.windowHours).toBe(24);
  });
});
