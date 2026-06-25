import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { runPollLoop } from './poll-loop.js';
import {
  registerTurnInterceptor,
  registerPostTaskInterceptor,
  registerPostReconcile,
  registerRunStart,
  registerResultDispatch,
  __resetTurnInterceptorForTest,
  __resetPostTaskInterceptorForTest,
  __resetPostReconcileForTest,
  __resetRunStartForTest,
  __resetResultDispatchForTest,
  type RunStartConfig,
} from './poll-loop-extensions.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';

// WHY: poll-loop-extensions.test.ts pins the applyTurnInterceptor FOLD in isolation.
// These pin the MAIN-LOOP CALL SITE — the part the fold can't prove on its own:
//   - `handled` must markCompleted the owned rows AND skip the provider query
//     (model-bypass, security invariant 1/3) — never fall through to a normal turn.
//   - `defer` must un-mark the row back to PENDING (deferProcessing) AND keep it out
//     of the turn's completion set, so it is re-read on a later poll, never lost
//     (security invariant 2). A miswire that left the query reachable would hang the loop
//     past the timeout → these go red.
// They register inline + reset in afterEach (self-contained — applyTurnInterceptor's
// only caller is the loop), so no overlay-registrant import pollutes sibling files.

beforeEach(() => {
  initTestSessionDb();
  __resetTurnInterceptorForTest();
  __resetPostTaskInterceptorForTest();
  __resetPostReconcileForTest();
  __resetRunStartForTest();
  __resetResultDispatchForTest();
});

afterEach(() => {
  __resetTurnInterceptorForTest();
  __resetPostTaskInterceptorForTest();
  __resetPostReconcileForTest();
  __resetRunStartForTest();
  __resetResultDispatchForTest();
  closeSessionDb();
});

function insertChat(id: string) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, trigger, on_wake, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 1, 0, ?)`,
    )
    .run(id, JSON.stringify({ sender: 'User', text: 'hi' }));
}

/** Read the row's processing_ack status directly. getPendingMessages() can't tell
 *  'processing' from 'completed' (it filters out ANY acked id), so assert the ack:
 *  'completed' = drained, undefined = un-marked (deferred → re-read), 'processing' = ORPHAN. */
function ackStatus(id: string): string | undefined {
  const row = getOutboundDb()
    .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
    .get(id) as { status: string } | undefined;
  return row?.status;
}

/** A provider that records whether query() was ever entered. A correctly-wired
 *  `handled`/`defer` decision must short-circuit BEFORE the query. */
class QuerySpyProvider extends MockProvider {
  queryCalled = false;
  query(opts: Parameters<MockProvider['query']>[0]) {
    this.queryCalled = true;
    return super.query(opts);
  }
}

async function runOnce(provider: MockProvider, signal: AbortSignal): Promise<void> {
  // Own an internal stop signal so the loop ALWAYS exits — on caller abort AND on timeout —
  // instead of being left to poll forever and steal later tests' messages (see
  // PollLoopConfig.signal; MockProvider's stream stays open).
  const stop = new AbortController();
  if (signal.aborted) stop.abort();
  else signal.addEventListener('abort', () => stop.abort());
  await Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal: stop.signal }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        stop.abort();
        reject(new Error('timeout'));
      }, 2000),
    ),
  ]).catch(() => {});
}

describe('poll-loop main-loop interceptor call site', () => {
  it('handled: marks the owned rows completed and skips the provider query', async () => {
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    // Abort inside the interceptor so the iteration finishes (markCompleted+continue)
    // and the NEXT top-of-loop check exits — a single deterministic iteration.
    registerTurnInterceptor((ctx) => {
      controller.abort();
      return { kind: 'handled', completedIds: ctx.keep.map((m) => m.id) };
    });

    await runOnce(provider, controller.signal);

    expect(provider.queryCalled).toBe(false); // model bypass — no normal turn
    expect(ackStatus('m1')).toBe('completed'); // markCompleted ran — NOT left in 'processing'
    expect(getUndeliveredMessages()).toHaveLength(0); // nothing dispatched by the loop
  });

  it('defer: un-marks the row back to pending and skips the provider query', async () => {
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    registerTurnInterceptor((ctx) => {
      controller.abort();
      return { kind: 'defer', deferIds: ctx.keep.map((m) => m.id) };
    });

    await runOnce(provider, controller.signal);

    expect(provider.queryCalled).toBe(false); // deferred batch never queried
    // deferProcessing DELETEd the processing_ack → no ack row → genuinely pending
    // again (re-read next poll), NOT 'processing' (orphan) and NOT 'completed' (drop).
    expect(ackStatus('m1')).toBeUndefined();
    expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
  });

  it('defer-then-handled: deferred rows go back to pending while handled rows complete', async () => {
    // The fold accumulates a defer (interceptor A) before a terminal handled
    // (interceptor B). The call site must drain BOTH — markCompleted the handled
    // rows AND un-mark the deferred ones — or the deferred row orphans in 'processing'.
    insertChat('m1');
    insertChat('m2');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    registerTurnInterceptor(() => ({ kind: 'defer', deferIds: ['m2'] }));
    registerTurnInterceptor((ctx) => {
      controller.abort();
      return { kind: 'handled', completedIds: ctx.keep.map((m) => m.id) }; // keep = [m1] post-defer
    });

    await runOnce(provider, controller.signal);

    expect(provider.queryCalled).toBe(false);
    // m1 handled → completed; m2 deferred → un-marked (no ack), NOT orphaned in 'processing'.
    expect(ackStatus('m1')).toBe('completed');
    expect(ackStatus('m2')).toBeUndefined();
    expect(getPendingMessages().map((m) => m.id)).toEqual(['m2']);
  });

  it('rewrite that drops rows without deferring: the dropped rows are auto-deferred, not orphaned', async () => {
    // SECURITY: a registrant that narrows keep via rewrite but forgets to defer the dropped
    // rows must NOT leave them stuck in 'processing'. The call-site reconcile auto-defers
    // them. Dropping ALL rows → empty working batch → the loop short-circuits before any
    // query (deterministic single iteration).
    insertChat('m1');
    insertChat('m2');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    registerTurnInterceptor(() => {
      controller.abort();
      return { kind: 'rewrite', keep: [] }; // drop both, without deferring either
    });

    await runOnce(provider, controller.signal);

    expect(provider.queryCalled).toBe(false);
    // Both were owned (marked processing) then silently dropped → auto-deferred (ack DELETEd),
    // re-readable next poll, never orphaned in 'processing'.
    expect(ackStatus('m1')).toBeUndefined();
    expect(ackStatus('m2')).toBeUndefined();
    expect(getPendingMessages().map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });
});

describe('poll-loop SITE 2 — post-pre-task interceptor call site', () => {
  it('handled: marks owned rows completed and skips the query (model-bypass, post-pre-task)', async () => {
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    // SITE 2 runs after the command loop + pre-task gating, on the surviving keep.
    registerPostTaskInterceptor((ctx) => {
      controller.abort();
      return { kind: 'handled', completedIds: ctx.keep.map((m) => m.id) };
    });

    await runOnce(provider, controller.signal);

    expect(provider.queryCalled).toBe(false); // model bypass — no normal turn
    expect(ackStatus('m1')).toBe('completed');
  });

  it('defer: un-marks the row to pending and skips the query (post-pre-task)', async () => {
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    registerPostTaskInterceptor((ctx) => {
      controller.abort();
      return { kind: 'defer', deferIds: ctx.keep.map((m) => m.id) };
    });

    await runOnce(provider, controller.signal);

    expect(provider.queryCalled).toBe(false); // deferred-all → keep empty → skip query
    expect(ackStatus('m1')).toBeUndefined(); // deferProcessing removed the ack → pending
    expect(getPendingMessages().map((m) => m.id)).toEqual(['m1']);
  });

  it('SITE separation: a Site-1 registrant does NOT fire at Site 2 and vice versa', async () => {
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    let site1Saw = 0;
    let site2Saw = 0;
    // Site-1 interceptor: counts + proceeds (does not end the turn).
    registerTurnInterceptor(() => {
      site1Saw++;
      return { kind: 'proceed' };
    });
    // Site-2 interceptor: counts, then handled+abort so the loop exits deterministically.
    registerPostTaskInterceptor((ctx) => {
      site2Saw++;
      controller.abort();
      return { kind: 'handled', completedIds: ctx.keep.map((m) => m.id) };
    });

    await runOnce(provider, controller.signal);

    // Each registrant fired exactly once, at its OWN site — neither leaked into the other.
    expect(site1Saw).toBe(1);
    expect(site2Saw).toBe(1);
    expect(provider.queryCalled).toBe(false);
  });

  it('partial defer: the deferred row is excluded from processingIds while the rest queries+completes', async () => {
    // Unlike the whole-batch defer above (which exits before processingIds is computed),
    // this defers ONLY m2 so m1 still reaches the query. It pins the security line
    // `processingIds = ids.filter(... && !postTaskDeferred.has(id))`: m1 must complete and
    // m2 must stay pending (un-marked). Removing the exclusion would markCompleted m2 too.
    insertChat('m1');
    insertChat('m2');
    const provider = new QuerySpyProvider({}, () => 'unused'); // bare text → m1 completes on its result event
    const controller = new AbortController();
    registerPostTaskInterceptor((ctx) =>
      ctx.keep.some((m) => m.id === 'm2') ? { kind: 'defer', deferIds: ['m2'] } : { kind: 'proceed' },
    );

    const loop = runOnce(provider, controller.signal);
    // Let m1's turn run to its result (markCompleted) before aborting.
    const start = Date.now();
    while (ackStatus('m1') !== 'completed' && Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 25));
    }
    controller.abort();
    await loop;

    expect(provider.queryCalled).toBe(true); // m1 DID reach the query (not bypassed)
    expect(ackStatus('m1')).toBe('completed'); // m1 completed by the turn
    expect(ackStatus('m2')).toBeUndefined(); // m2 deferred → un-marked, excluded from processingIds
    expect(getPendingMessages().map((m) => m.id)).toEqual(['m2']); // m2 re-readable next poll
  });
});

describe('poll-loop post-reconcile hook call site', () => {
  it('runs with the FINAL keep — narrowed by a Site-2 defer — before the query', async () => {
    // The hook must see the batch that actually reaches the provider, NOT a wider
    // pre-reconcile keep. A Site-2 interceptor defers m2; the post-reconcile hook must
    // then be handed [m1] only. This pins the ordering the post-reconcile hook needs: an
    // overlay re-derives its per-turn routing key off recon.keep HERE, so a later narrowing
    // can't desync it. If the call
    // moved before the Site-2 reconcile, captured would still contain m2 → red.
    insertChat('m1');
    insertChat('m2');
    const provider = new QuerySpyProvider({}, () => 'unused'); // bare text → m1 completes on its result
    const controller = new AbortController();
    let captured: string[] | undefined;
    registerPostTaskInterceptor((ctx) =>
      ctx.keep.some((m) => m.id === 'm2') ? { kind: 'defer', deferIds: ['m2'] } : { kind: 'proceed' },
    );
    registerPostReconcile((keep: MessageInRow[]) => {
      captured = keep.map((m) => m.id);
    });

    const loop = runOnce(provider, controller.signal);
    const start = Date.now();
    while (ackStatus('m1') !== 'completed' && Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 25));
    }
    controller.abort();
    await loop;

    expect(captured).toEqual(['m1']); // FINAL keep — m2 was deferred at Site 2, never reaches the hook
    expect(provider.queryCalled).toBe(true); // m1 still queried
  });

  it('receives the reconcileTurn-CLAMPED keep, not the raw fold keep (a rewrite adding a foreign row)', async () => {
    // Pins the boundary specifically AFTER reconcileTurn, not merely after the fold:
    // a Site-2 rewrite injects a row that was never markProcessing'd (un-owned). The fold
    // returns it in keep, but reconcileTurn clamps `result.keep.filter(owned.has)` → drops it.
    // The hook must see the CLAMPED [m1], never the foreign row. If the call moved before
    // reconcileTurn and were fed ptInterception.keep, captured would include the foreign id → red.
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused');
    const controller = new AbortController();
    let captured: string[] | undefined;
    registerPostTaskInterceptor((ctx) =>
      ctx.keep.some((m) => m.id === 'm1')
        ? {
            kind: 'rewrite',
            keep: [...ctx.keep, { ...ctx.keep[0], id: 'foreign-not-owned' } as MessageInRow],
          }
        : { kind: 'proceed' },
    );
    registerPostReconcile((keep: MessageInRow[]) => {
      captured = keep.map((m) => m.id);
    });

    const loop = runOnce(provider, controller.signal);
    const start = Date.now();
    while (ackStatus('m1') !== 'completed' && Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 25));
    }
    controller.abort();
    await loop;

    expect(captured).toEqual(['m1']); // reconcileTurn clamped the un-owned foreign row out
    expect(provider.queryCalled).toBe(true);
  });
});

describe('poll-loop run-start hook call site', () => {
  it('fires exactly once per runPollLoop (before the poll loop), across multiple iterations', async () => {
    // The run-start hook is the per-run registration keystone: it must run ONCE per
    // runPollLoop invocation, before the while loop — not per poll iteration — so an
    // overlay rebinds its config-bound registrants cleanly. We force a SECOND iteration
    // by processing m1 to completion (iteration 1 does real work, then the loop re-enters
    // the while body for iteration 2). If applyRunStart were misplaced INSIDE the loop,
    // count would be 2 here; before the loop it stays 1. (A wait-then-abort with no rows
    // never reaches a 2nd iteration — the empty-poll sleep is 1000ms — so it can't pin this.)
    insertChat('m1');
    const provider = new QuerySpyProvider({}, () => 'unused'); // bare text → m1 completes on its result
    const controller = new AbortController();
    let count = 0;
    const seen: RunStartConfig[] = [];
    registerRunStart((cfg) => {
      count++;
      seen.push(cfg);
    });

    const loop = runOnce(provider, controller.signal);
    // Wait for m1 to complete (iteration 1 fully ran) so the loop has re-entered the
    // while body for iteration 2, then give that 2nd top a beat to execute before abort.
    const start = Date.now();
    while (ackStatus('m1') !== 'completed' && Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 25));
    }
    await new Promise((r) => setTimeout(r, 100)); // let iteration 2's top run
    controller.abort();
    await loop;

    expect(ackStatus('m1')).toBe('completed'); // iteration 1 did process m1 (≥2 iterations ran)
    expect(count).toBe(1); // once per RUN despite ≥2 poll iterations
    expect(seen[0].providerName).toBe('mock'); // received THIS run's config
  });
});

// Records whether the loop pushed a re-wrap nudge into the active query — the observable that
// distinguishes "overlay dispatcher ran (hasUnwrapped:false → no nudge)" from "base dispatch ran
// (bare text, no destination → hasUnwrapped:true → pushes the nudge)".
class PushSpyProvider extends MockProvider {
  pushCount = 0;
  query(opts: Parameters<MockProvider['query']>[0]) {
    const q = super.query(opts);
    const origPush = q.push.bind(q);
    q.push = (m: string) => {
      this.pushCount++;
      return origPush(m);
    };
    return q;
  }
}

describe('poll-loop result-dispatch seam call site', () => {
  it('a registered dispatcher REPLACES the base dispatch (the ?? short-circuits it)', async () => {
    // Base call site: `applyResultDispatch(text, routing) ?? dispatchResultText(...)`. The overlay
    // dispatcher must run AND its {sent, hasUnwrapped} must be the one used. It returns
    // {sent:0, hasUnwrapped:false} (a handled/suppressed turn) on BARE text. If the base dispatch
    // had ALSO run on that bare text (no <message>, no destinations), it would return
    // hasUnwrapped:true → the loop pushes the re-wrap nudge. Asserting pushCount===0 proves the
    // base dispatch was bypassed, not merely that the overlay also ran.
    insertChat('m1');
    const provider = new PushSpyProvider({}, () => 'AGENT REPLY TEXT'); // bare, unwrapped result
    const controller = new AbortController();
    let captured: string | undefined;
    registerResultDispatch((text) => {
      captured = text;
      return { sent: 0, hasUnwrapped: false };
    });

    const loop = runOnce(provider, controller.signal);
    const start = Date.now();
    while (ackStatus('m1') !== 'completed' && Date.now() - start < 1500) {
      await new Promise((r) => setTimeout(r, 25));
    }
    controller.abort();
    await loop;

    expect(captured).toBe('AGENT REPLY TEXT'); // overlay dispatcher ran on the agent's final text
    expect(provider.pushCount).toBe(0); // NO re-wrap nudge → base dispatch did NOT run (would be hasUnwrapped:true)
    expect(ackStatus('m1')).toBe('completed');
  });
});
