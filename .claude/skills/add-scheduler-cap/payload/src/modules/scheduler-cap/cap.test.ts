import { describe, expect, it, vi } from 'vitest';

import type { DueSessionCandidate } from '../scheduling/admission.js';
import type { Session } from '../../types.js';
import { createSchedulerCap, RESERVATION_TTL_MS } from './cap.js';

function session(id: string): Session {
  return { id } as Session;
}

function candidate(id: string): DueSessionCandidate {
  return { session: session(id), dueCount: 1, isTaskSession: false, dueTasks: [] };
}

function setup(limit: number) {
  const running = new Set<string>();
  let clock = 1_000;
  const stop = vi.fn((id: string) => running.delete(id));
  const cap = createSchedulerCap({
    limit,
    activeCount: () => running.size,
    isRunning: (id) => running.has(id),
    stop,
    now: () => clock,
  });
  return { cap, running, stop, advance: (ms: number) => (clock += ms) };
}

describe('scheduler cap', () => {
  it('admits wakes below the limit and defers at it', async () => {
    const { cap, running } = setup(2);
    running.add('a');
    expect(await cap.shouldWake(candidate('b'))).toBe(true);
    expect(await cap.shouldWake(candidate('c'))).toBe(false);
  });

  it('counts admitted wakes that have not spawned yet', async () => {
    const { cap } = setup(1);
    expect(await cap.shouldWake(candidate('a'))).toBe(true);
    expect(await cap.shouldWake(candidate('b'))).toBe(false);
  });

  it('keeps admitting a session it already admitted', async () => {
    const { cap } = setup(1);
    expect(await cap.shouldWake(candidate('a'))).toBe(true);
    expect(await cap.shouldWake(candidate('a'))).toBe(true);
  });

  it('releases a reservation that never became a container', async () => {
    const { cap, advance } = setup(1);
    expect(await cap.shouldWake(candidate('a'))).toBe(true);
    advance(RESERVATION_TTL_MS + 1);
    expect(await cap.shouldWake(candidate('b'))).toBe(true);
  });

  it('does not double count a reservation once its container runs', async () => {
    const { cap, running } = setup(2);
    expect(await cap.shouldWake(candidate('a'))).toBe(true);
    running.add('a');
    expect(await cap.shouldWake(candidate('b'))).toBe(true);
  });

  it('stops an idle container only when the cap is full and a session waits', async () => {
    const { cap, running, stop } = setup(1);
    running.add('a');
    await cap.onSessionIdle?.(session('a'));
    expect(stop).not.toHaveBeenCalled();

    expect(await cap.shouldWake(candidate('b'))).toBe(false);
    await cap.onSessionIdle?.(session('a'));
    expect(stop).toHaveBeenCalledWith('a', 'scheduler-cap-idle');

    expect(await cap.shouldWake(candidate('b'))).toBe(true);
  });

  it('keeps an idle container when below the limit', async () => {
    const { cap, running, stop } = setup(3);
    running.add('a');
    expect(await cap.shouldWake(candidate('b'))).toBe(true);
    await cap.onSessionIdle?.(session('a'));
    expect(stop).not.toHaveBeenCalled();
  });
});
