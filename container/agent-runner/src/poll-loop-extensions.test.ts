import { describe, it, expect, afterEach } from 'bun:test';

import type { MessageInRow } from './db/messages-in.js';
import type { RoutingContext } from './formatter.js';
import {
  applyTurnInterceptor,
  registerTurnInterceptor,
  __resetTurnInterceptorForTest,
  type TurnInterceptorCtx,
} from './poll-loop-extensions.js';

// WHY: the M4 turn-interceptor seam carries CONTROL-FLOW AUTHORITY (it can defer
// rows, rewrite the batch, or model-bypass via `handled`). The fold semantics are
// SEC-load-bearing — a wrong fold could leak a deferred row, skip a fail-closed
// drain, or run later interceptors after a terminal handled. These pin the
// contract before any overlay registers onto it (and the inert-on-pristine case).

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
