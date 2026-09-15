/**
 * The status mapper as a table: observation → status, coalescing and the
 * send interval, the stopped gate and what resumes it, and the diff trigger
 * on a completed turn.
 */
import { describe, expect, it } from 'vitest';

import { decide, mapStatus, markStopped, type MirrorState, type TurnStamp } from './mapper.js';

const T0 = Date.parse('2026-09-11T10:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const stamp = (state: 'idle' | 'busy', seq: number, atMs: number): TurnStamp => ({ state, seq, at: iso(atMs) });

const fresh = (over: Partial<MirrorState> = {}): MirrorState => ({
  lastStatus: null,
  lastSentAt: 0,
  stoppedAt: null,
  lastTurnSeq: 0,
  ...over,
});

describe('mapStatus', () => {
  it.each([
    [{ running: false, turn: null }, 'suspended'],
    [{ running: false, turn: stamp('busy', 3, T0) }, 'suspended'],
    [{ running: true, turn: null }, 'active'],
    [{ running: true, turn: stamp('idle', 1, T0) }, 'active'],
    [{ running: true, turn: stamp('busy', 2, T0) }, 'processing'],
  ] as const)('%j → %s', (observation, expected) => {
    expect(mapStatus(observation)).toBe(expected);
  });
});

describe('sends and coalescing', () => {
  it('the first observation sends; an unchanged status never re-sends', () => {
    const first = decide(fresh(), { running: true, turn: null }, T0);
    expect(first.send).toEqual({ status: 'active', resume: false });
    expect(first.next.lastStatus).toBe('active');
    const again = decide(first.next, { running: true, turn: stamp('idle', 1, T0) }, T0 + 10_000);
    expect(again.send).toBeUndefined();
  });

  it('a change inside the send interval waits; the latest value wins when the interval passes', () => {
    const sent = decide(fresh(), { running: true, turn: null }, T0).next;
    const tooSoon = decide(sent, { running: true, turn: stamp('busy', 1, T0 + 100) }, T0 + 500);
    expect(tooSoon.send).toBeUndefined();
    expect(tooSoon.next.lastStatus).toBe('active');
    // Flapped back to idle before the interval — only the current state goes out.
    const later = decide(tooSoon.next, { running: true, turn: stamp('idle', 2, T0 + 900) }, T0 + 2_000);
    expect(later.send).toBeUndefined(); // active → active: nothing to say
    const busy = decide(later.next, { running: true, turn: stamp('busy', 3, T0 + 2_100) }, T0 + 4_000);
    expect(busy.send).toEqual({ status: 'processing', resume: false });
  });

  it('a reaped container is suspended; waking it goes back to active', () => {
    const processing = fresh({ lastStatus: 'processing', lastSentAt: T0 });
    const down = decide(processing, { running: false, turn: stamp('busy', 4, T0) }, T0 + 5_000);
    expect(down.send).toEqual({ status: 'suspended', resume: false });
    const up = decide(down.next, { running: true, turn: stamp('busy', 4, T0) }, T0 + 10_000);
    // The stale busy stamp from before the reap still reads as processing.
    expect(up.send).toEqual({ status: 'processing', resume: false });
  });
});

describe('diff after a completed turn', () => {
  it('a stamp that moved to idle with a new seq asks for the diff, once', () => {
    const state = fresh({ lastStatus: 'processing', lastSentAt: T0, lastTurnSeq: 2 });
    const done = decide(state, { running: true, turn: stamp('idle', 3, T0 + 100) }, T0 + 2_000);
    expect(done.renderDiff).toEqual({ turnSeq: 3 });
    expect(done.next.lastTurnSeq).toBe(3);
    const same = decide(done.next, { running: true, turn: stamp('idle', 3, T0 + 100) }, T0 + 4_000);
    expect(same.renderDiff).toBeUndefined();
  });

  it('a busy stamp advances the seq without a diff; an idle stamp while suspended renders nothing', () => {
    const busy = decide(fresh({ lastTurnSeq: 1 }), { running: true, turn: stamp('busy', 2, T0) }, T0);
    expect(busy.renderDiff).toBeUndefined();
    expect(busy.next.lastTurnSeq).toBe(2);
    const cold = decide(busy.next, { running: false, turn: stamp('idle', 3, T0) }, T0 + 2_000);
    expect(cold.renderDiff).toBeUndefined();
    expect(cold.next.lastTurnSeq).toBe(3);
  });
});

describe('stopped gate', () => {
  const stoppedAt = T0 + 10_000;

  it('while stopped nothing is sent, whatever the observation', () => {
    const stopped = markStopped(fresh({ lastStatus: 'processing', lastSentAt: T0 }), iso(stoppedAt));
    for (const observation of [
      { running: true, turn: stamp('busy', 5, T0 + 9_000) }, // the interrupted turn's stamp (older than the stop)
      { running: true, turn: stamp('idle', 6, T0 + 9_500) },
      { running: false, turn: null },
      { running: true, turn: null },
    ]) {
      const d = decide(stopped, observation, stoppedAt + 30_000);
      expect(d.send).toBeUndefined();
      expect(d.renderDiff).toBeUndefined();
      expect(d.next.stoppedAt).toBe(iso(stoppedAt));
    }
  });

  it('a new busy turn after the stop resumes: processing with resume:true, gate cleared', () => {
    const stopped = markStopped(fresh({ lastStatus: 'processing', lastSentAt: T0 }), iso(stoppedAt));
    const d = decide(stopped, { running: true, turn: stamp('busy', 7, stoppedAt + 2_000) }, stoppedAt + 2_500);
    expect(d.send).toEqual({ status: 'processing', resume: true });
    expect(d.next.stoppedAt).toBeNull();
    expect(d.next.lastStatus).toBe('processing');
    // The turn that resumed completes → diff, ordinary sends again.
    const done = decide(d.next, { running: true, turn: stamp('idle', 8, stoppedAt + 9_000) }, stoppedAt + 10_000);
    expect(done.renderDiff).toEqual({ turnSeq: 8 });
    expect(done.send).toEqual({ status: 'active', resume: false });
  });

  it('a busy stamp newer than the stop on a container that is not running does not resume', () => {
    const stopped = markStopped(fresh(), iso(stoppedAt));
    const d = decide(stopped, { running: false, turn: stamp('busy', 7, stoppedAt + 2_000) }, stoppedAt + 2_500);
    expect(d.send).toBeUndefined();
    expect(d.next.stoppedAt).toBe(iso(stoppedAt));
  });

  it('resume ignores the send interval — the next human turn is never held back', () => {
    const stopped = markStopped(fresh({ lastStatus: 'active', lastSentAt: stoppedAt }), iso(stoppedAt));
    const d = decide(stopped, { running: true, turn: stamp('busy', 9, stoppedAt + 100) }, stoppedAt + 200);
    expect(d.send).toEqual({ status: 'processing', resume: true });
  });
});
