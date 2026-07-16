import { describe, expect, it } from 'bun:test';

import { MockProvider } from './mock.js';
import type { MockFailMode } from './mock.js';
import type { ProviderEvent } from './types.js';

/**
 * Collect only the initial events from a MockProvider query (before the
 * wait-for-push loop).  After the first error or result event we call
 * query.end() so the while-loop exits.
 */
async function collectInitialEvents(query: ReturnType<MockProvider['query']>): Promise<ProviderEvent[]> {
  const events: ProviderEvent[] = [];
  for await (const ev of query.events) {
    events.push(ev);
    if (ev.type === 'result' || ev.type === 'error') {
      query.end();
    }
  }
  return events;
}

describe('MockProvider — fail simulation', () => {
  it('emits normal result when no failMode is set', async () => {
    const provider = new MockProvider({}, undefined, null);
    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    const events = await collectInitialEvents(query);

    const results = events.filter((e) => e.type === 'result');
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].isError).toBeUndefined();
  });

  it('emits quota error event when failMode=quota', async () => {
    const provider = new MockProvider({}, undefined, 'quota');
    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    const events = await collectInitialEvents(query);

    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].classification).toBe('quota');
    expect(errors[0].retryable).toBe(false);
    expect(errors[0].message).toContain('limit');

    const results = events.filter((e) => e.type === 'result' && !e.isError);
    expect(results.length).toBe(0);
  });

  it('emits billing result when failMode=billing', async () => {
    const provider = new MockProvider({}, undefined, 'billing');
    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    const events = await collectInitialEvents(query);

    const results = events.filter((e) => e.type === 'result' && e.isError === true);
    expect(results.length).toBe(1);
    expect(results[0].text).toContain('credit balance');
  });

  it('emits overload error event when failMode=overload', async () => {
    const provider = new MockProvider({}, undefined, 'overload');
    const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
    const events = await collectInitialEvents(query);

    const errors = events.filter((e) => e.type === 'error');
    expect(errors.length).toBe(1);
    expect(errors[0].classification).toBe('overload');
    expect(errors[0].message).toContain('overload');
  });

  it('includes resetAt when MOCK_RESET_AT env is set with failMode=quota', async () => {
    process.env.MOCK_RESET_AT = '1700000000';
    try {
      const provider = new MockProvider({}, undefined, 'quota');
      const query = provider.query({ prompt: 'hello', cwd: '/tmp' });
      const events = await collectInitialEvents(query);

      const errors = events.filter((e) => e.type === 'error');
      expect(errors[0].resetAt).toBe(1_700_000_000 * 1000);
      expect(errors[0].message).toContain('2023');
    } finally {
      delete process.env.MOCK_RESET_AT;
    }
  });

  it('reverts to normal response on second query (fail only first turn)', async () => {
    const provider = new MockProvider({}, undefined, 'quota');

    const q1 = provider.query({ prompt: 'first', cwd: '/tmp' });
    const e1 = await collectInitialEvents(q1);
    expect(e1.filter((e) => e.type === 'error').length).toBe(1);

    const q2 = provider.query({ prompt: 'second', cwd: '/tmp' });
    const e2 = await collectInitialEvents(q2);
    const results = e2.filter((e) => e.type === 'result' && !e.isError);
    expect(results.length).toBe(1);
    expect(results[0].text).toContain('second');
  });
});
