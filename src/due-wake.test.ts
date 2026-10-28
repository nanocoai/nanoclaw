import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueue = vi.fn();
vi.mock('./reconcile-feeds.js', () => ({ enqueueSessionReconcile: (id: string) => enqueue(id) }));

import { DUE_WAKE_HORIZON_MS, _armedDueWakeForTesting, clearDueWakes, scheduleDueWake } from './due-wake.js';

const NOW = Date.parse('2026-01-01T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  enqueue.mockClear();
});

afterEach(() => {
  clearDueWakes();
  vi.useRealTimers();
});

describe('scheduleDueWake', () => {
  it('reconciles the session just after its due time, not before', () => {
    scheduleDueWake('sess-1', iso(10_000), NOW);
    vi.advanceTimersByTime(10_000);
    expect(enqueue).not.toHaveBeenCalled();
    vi.advanceTimersByTime(500);
    expect(enqueue).toHaveBeenCalledWith('sess-1');
    expect(_armedDueWakeForTesting('sess-1')).toBeUndefined();
  });

  it('ignores null, past and beyond-horizon due times', () => {
    scheduleDueWake('sess-1', null, NOW);
    scheduleDueWake('sess-1', iso(-1_000), NOW);
    scheduleDueWake('sess-1', iso(DUE_WAKE_HORIZON_MS + 1), NOW);
    expect(_armedDueWakeForTesting('sess-1')).toBeUndefined();
  });

  it('keeps one timer per session and moves it to the reported time', () => {
    scheduleDueWake('sess-1', iso(30_000), NOW);
    scheduleDueWake('sess-1', iso(30_000), NOW);
    scheduleDueWake('sess-1', iso(5_000), NOW);
    expect(_armedDueWakeForTesting('sess-1')).toBe(NOW + 5_000);
    vi.advanceTimersByTime(60_000);
    expect(enqueue).toHaveBeenCalledTimes(1);
  });

  it('clearDueWakes drops pending timers', () => {
    scheduleDueWake('sess-1', iso(5_000), NOW);
    clearDueWakes();
    vi.advanceTimersByTime(60_000);
    expect(enqueue).not.toHaveBeenCalled();
  });
});
