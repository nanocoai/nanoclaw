/**
 * mapConcurrent: bounded in-flight count, input-order results, per-item
 * isolation (a rejection is a settled result, never a throw).
 */
import { describe, expect, it } from 'vitest';

import { mapConcurrent } from './parallel.js';

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('mapConcurrent', () => {
  it('returns settled results in input order', async () => {
    const results = await mapConcurrent([3, 1, 2], 2, async (n) => {
      for (let i = 0; i < n; i++) await tick();
      return n * 10;
    });
    expect(results).toEqual([
      { status: 'fulfilled', value: 30 },
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
    ]);
  });

  it('never has more than `limit` calls in flight', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapConcurrent(
      Array.from({ length: 20 }, (_, i) => i),
      4,
      async () => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await tick();
        inFlight--;
      },
    );
    expect(peak).toBe(4);
  });

  it('isolates rejections: the others still run and the failure is reported in place', async () => {
    const results = await mapConcurrent(['a', 'boom', 'c'], 8, async (item) => {
      await tick();
      if (item === 'boom') throw new Error('nope');
      return item.toUpperCase();
    });
    expect(results[0]).toEqual({ status: 'fulfilled', value: 'A' });
    expect(results[1].status).toBe('rejected');
    expect((results[1] as PromiseRejectedResult).reason).toBeInstanceOf(Error);
    expect(results[2]).toEqual({ status: 'fulfilled', value: 'C' });
  });

  it('handles an empty input and a limit below one', async () => {
    expect(await mapConcurrent([], 8, async () => 1)).toEqual([]);
    expect(await mapConcurrent([1], 0, async (n) => n)).toEqual([{ status: 'fulfilled', value: 1 }]);
  });
});
