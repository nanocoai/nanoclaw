import { describe, it, expect, afterEach } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';
import {
  applyTurnInterceptor,
  registerTurnInterceptor,
  reconcileTurn,
  registerFollowupDrop,
  registerFollowupEndStream,
  applyFollowupDrop,
  applyFollowupEndStream,
  __resetFollowupHooksForTest,
  __resetTurnInterceptorForTest,
  type TurnInterceptorCtx,
  type TurnInterceptorResult,
  type FollowupCtx,
} from './poll-loop-extensions.js';

// WHY: the turn-interceptor seam carries CONTROL-FLOW AUTHORITY (it can defer
// rows, rewrite the batch, or model-bypass via `handled`). The fold semantics are
// security-load-bearing — a wrong fold could leak a deferred row, skip a fail-closed
// drain, or run later interceptors after a terminal handled. These pin the
// contract before any overlay registers onto it (and the inert-by-default case).

const row = (id: string, kind = 'chat'): MessageInRow => ({ id, kind }) as MessageInRow;
const routing = (tag: string): RoutingContext => ({ platformId: tag }) as unknown as RoutingContext;

function ctx(keep: MessageInRow[], r: RoutingContext): TurnInterceptorCtx {
  return { keep, allPending: keep, routing: r, isFirstPoll: true };
}

afterEach(() => __resetTurnInterceptorForTest());

describe('applyTurnInterceptor fold semantics', () => {
  it('is INERT with no registrant — returns the input keep/routing, no handled, no defers', async () => {
    const r = routing('r0');
    const keep = [row('a'), row('b')];
    const out = await applyTurnInterceptor(ctx(keep, r));
    expect(out.handled).toBeUndefined();
    expect(out.keep).toEqual(keep);
    expect(out.routing).toBe(r);
    expect(out.deferIds).toEqual([]);
  });

  it('proceed leaves state unchanged', async () => {
    registerTurnInterceptor(() => ({ kind: 'proceed' }));
    const keep = [row('a')];
    const out = await applyTurnInterceptor(ctx(keep, routing('r')));
    expect(out.handled).toBeUndefined();
    expect(out.keep).toEqual(keep);
    expect(out.deferIds).toEqual([]);
  });

  it('handled is TERMINAL — later interceptors do NOT run (ordering invariant)', async () => {
    let secondRan = false;
    registerTurnInterceptor(() => ({ kind: 'handled', completedIds: ['a', 'b'] }));
    registerTurnInterceptor(() => {
      secondRan = true;
      return { kind: 'proceed' };
    });
    const out = await applyTurnInterceptor(ctx([row('a'), row('b')], routing('r')));
    expect(out.handled).toEqual({ completedIds: ['a', 'b'] });
    expect(secondRan).toBe(false);
  });

  it('rewrite threads the new keep/routing into the NEXT interceptor', async () => {
    const r2 = routing('r2');
    let sawKeep: string[] | null = null;
    registerTurnInterceptor(() => ({ kind: 'rewrite', keep: [row('b')], routing: r2 }));
    registerTurnInterceptor((c) => {
      sawKeep = c.keep.map((m) => m.id);
      expect(c.routing).toBe(r2);
      return { kind: 'proceed' };
    });
    const out = await applyTurnInterceptor(ctx([row('a'), row('b')], routing('r1')));
    expect(sawKeep).toEqual(['b']);
    expect(out.keep.map((m) => m.id)).toEqual(['b']);
    expect(out.routing).toBe(r2);
  });

  it('defer accumulates deferIds and narrows keep (the row stays out of the turn)', async () => {
    registerTurnInterceptor(() => ({ kind: 'defer', deferIds: ['sys1'] }));
    const out = await applyTurnInterceptor(ctx([row('chat1'), row('sys1', 'system')], routing('r')));
    expect(out.handled).toBeUndefined();
    expect(out.deferIds).toEqual(['sys1']);
    expect(out.keep.map((m) => m.id)).toEqual(['chat1']); // sys1 removed from the surviving batch
  });

  it('a handled AFTER a defer still returns — but the earlier defer is not lost mid-fold', async () => {
    // defer then handled: handled is terminal and returns the accumulated deferIds.
    registerTurnInterceptor(() => ({ kind: 'defer', deferIds: ['x'] }));
    registerTurnInterceptor(() => ({ kind: 'handled', completedIds: ['y'] }));
    const out = await applyTurnInterceptor(ctx([row('x'), row('y')], routing('r')));
    expect(out.handled).toEqual({ completedIds: ['y'] });
    expect(out.deferIds).toEqual(['x']);
  });
});

// WHY: the fold accepts whatever a registrant returns; reconcileTurn is the security
// chokepoint that bounds it to the OWNED (marked-processing) id set so a registrant
// — buggy or hostile — cannot orphan a row in 'processing', resurrect a completed
// row by deferring an out-of-set id, or complete-while-deferring the same row.
describe('reconcileTurn — owned-set accounting (no row leaks)', () => {
  const res = (over: Partial<TurnInterceptorResult>): TurnInterceptorResult => ({
    handled: undefined,
    keep: [],
    routing: routing('r'),
    deferIds: [],
    ...over,
  });

  it('inert: keeps all owned rows, nothing deferred/completed/unaccounted', () => {
    const out = reconcileTurn(['a', 'b'], res({ keep: [row('a'), row('b')] }));
    expect(out.handled).toBe(false);
    expect(out.keep.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out.deferIds).toEqual([]);
    expect(out.completedIds).toEqual([]);
    expect(out.unaccounted).toEqual([]);
  });

  it('rewrite that DROPS a row without deferring it auto-defers it (never orphaned)', () => {
    const out = reconcileTurn(['a', 'b'], res({ keep: [row('a')] })); // b silently dropped
    expect(out.keep.map((m) => m.id)).toEqual(['a']);
    expect(out.deferIds).toEqual(['b']); // auto-deferred → re-read next poll
    expect(out.unaccounted).toEqual(['b']); // flagged so the caller can fail-loud
  });

  it('an out-of-set defer id is dropped (cannot DELETE a foreign / already-completed ack)', () => {
    const out = reconcileTurn(['a'], res({ keep: [row('a')], deferIds: ['ZZZ'] }));
    expect(out.deferIds).toEqual([]);
    expect(out.keep.map((m) => m.id)).toEqual(['a']);
    expect(out.unaccounted).toEqual([]);
  });

  it('defer loses to keep: a row in BOTH keep and deferIds stays kept (not un-marked mid-batch)', () => {
    const out = reconcileTurn(['a', 'b'], res({ keep: [row('a'), row('b')], deferIds: ['b'] }));
    expect(out.keep.map((m) => m.id)).toEqual(['a', 'b']);
    expect(out.deferIds).toEqual([]);
  });

  it('handled: completed wins over a conflicting defer; leftover keep + unaccounted rows auto-defer', () => {
    const out = reconcileTurn(
      ['a', 'b', 'c'],
      res({ handled: { completedIds: ['a'] }, keep: [row('a'), row('b')], deferIds: ['a'] }),
    );
    expect(out.handled).toBe(true);
    expect(out.keep).toEqual([]); // handled ⇒ no working batch
    expect(out.completedIds).toEqual(['a']); // a completed (defer for a dropped)
    expect([...out.deferIds].sort()).toEqual(['b', 'c']); // leftover keep b + unaccounted c
    expect([...out.unaccounted].sort()).toEqual(['b', 'c']);
  });

  it('handled: an out-of-set completed id is dropped', () => {
    const out = reconcileTurn(['a'], res({ handled: { completedIds: ['a', 'ZZZ'] } }));
    expect(out.completedIds).toEqual(['a']);
    expect(out.unaccounted).toEqual([]);
  });
});

// WHY: the follow-up seam is the cross-turn partner of the main interceptor. DROP and
// END-STREAM are independent inert hooks the poll consults at two ORDERED points; both
// must be no-ops with zero registrants (byte-identical follow-up poll) and compose
// correctly (drop = union, end-stream = OR) when an overlay registers.
describe('follow-up poll seam (applyFollowupDrop / applyFollowupEndStream)', () => {
  const fctx = (ids: string[]): FollowupCtx => ({
    pending: ids.map((id) => row(id)),
    routing: routing('r'),
  });

  afterEach(() => __resetFollowupHooksForTest());

  it('inert: drop returns [] and end-stream returns false with no registrant', () => {
    expect(applyFollowupDrop(fctx(['a', 'b']))).toEqual([]);
    expect(applyFollowupEndStream(fctx(['a', 'b']))).toBe(false);
  });

  it('drop is the deduped UNION of all registrants', () => {
    registerFollowupDrop(() => ['a', 'b']);
    registerFollowupDrop(() => ['b', 'c']);
    expect(applyFollowupDrop(fctx(['a', 'b', 'c'])).sort()).toEqual(['a', 'b', 'c']);
  });

  it('end-stream is an OR-fold — any true ⇒ true', () => {
    registerFollowupEndStream(() => false);
    registerFollowupEndStream(() => true);
    expect(applyFollowupEndStream(fctx(['a']))).toBe(true);
  });

  it('end-stream stays false when every registrant declines', () => {
    registerFollowupEndStream(() => false);
    registerFollowupEndStream(() => false);
    expect(applyFollowupEndStream(fctx(['a']))).toBe(false);
  });
});
