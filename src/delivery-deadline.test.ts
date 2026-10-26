/**
 * Delivery deadline: a channel send that never settles must not hold its
 * session (or the poll tick) forever, and a send that settles late must not
 * be posted twice.
 *
 * Same on-disk mailbox fixture as delivery.test.ts, under fake timers.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-deadline',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-deadline/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-deadline';
const DEADLINE_MS = 60_000; // DELIVERY_DEADLINE_MS in delivery.ts
const GIVE_UP_MS = 60 * 60_000; // OVERDUE_GIVE_UP_MS in delivery.ts
const TICK_WAIT_MS = 5_000; // TICK_DRAIN_WAIT_MS in delivery.ts
const MAX_PARKED = 3; // MAX_PARKED_PER_SESSION in delivery.ts

import { getDb } from './db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import {
  _resetDeliveryStateForTesting,
  deliverSessionMessages,
  deliverToSessions,
  registerDeliveryAction,
  registerPostDeliveryHook,
  setDeliveryAdapter,
} from './delivery.js';
import { unguarded } from './guard/index.js';
import { log } from './log.js';
import { inboundDbPath, outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import type { Session } from './types.js';

function now(): string {
  return new Date().toISOString();
}

function insertOutbound(session: Session, msgId: string, kind = 'chat', content?: unknown): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, ?, 'telegram:123', 'telegram', ?)`,
  ).run(msgId, now(), kind, JSON.stringify(content ?? { text: msgId }));
  db.close();
}

function deliveredRow(
  session: Session,
  msgId: string,
): { status: string; platform_message_id: string | null } | undefined {
  const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const row = db.prepare('SELECT status, platform_message_id FROM delivered WHERE message_out_id = ?').get(msgId) as
    | { status: string; platform_message_id: string | null }
    | undefined;
  db.close();
  return row;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Adapter that records every send by message text and answers from `plan`:
 * a promise to hold the send on, or nothing for an immediate success.
 */
function recordingAdapter(plan: (text: string, call: number) => Promise<string> | undefined) {
  const calls: string[] = [];
  setDeliveryAdapter({
    async deliver(_ct, _pid, _tid, _kind, content) {
      const text = JSON.parse(content).text as string;
      calls.push(text);
      return (await plan(text, calls.filter((t) => t === text).length)) ?? `pm-${text}`;
    },
  });
  return calls;
}

/** Start a drain and report whether it finished, without awaiting it. */
function track(p: Promise<void>): { done: () => boolean; promise: Promise<void> } {
  let finished = false;
  const promise = p.then(() => {
    finished = true;
  });
  return { done: () => finished, promise };
}

let session: Session;

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-1',
    name: 'Test Agent',
    folder: 'test-agent',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  ({ session } = await resolveSession('ag-1', 'mg-1', null, 'shared'));
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  _resetDeliveryStateForTesting();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('delivery deadline', () => {
  it('a send that never settles stops holding the session at the deadline, with a warn log', async () => {
    insertOutbound(session, 'out-hung');
    const calls = recordingAdapter((text) => (text === 'out-hung' ? new Promise<string>(() => {}) : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(drain.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.done()).toBe(true);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deadline'),
      expect.objectContaining({ messageId: 'out-hung', sessionId: session.id, deadlineMs: DEADLINE_MS }),
    );
    expect(deliveredRow(session, 'out-hung')).toBeUndefined();

    // The session is not dark: a newer reply goes out on the next tick, and
    // the parked row is not sent a second time while its send is pending.
    insertOutbound(session, 'out-next');
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-hung', 'out-next']);
    expect(deliveredRow(session, 'out-next')?.status).toBe('delivered');
  });

  it('one hung session no longer holds the whole poll tick', async () => {
    const { session: other } = await resolveSession('ag-1', 'mg-1', 'thread-other', 'per-thread');
    insertOutbound(session, 'out-hung');
    insertOutbound(other, 'out-other');
    recordingAdapter((text) => (text === 'out-hung' ? new Promise<string>(() => {}) : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const tick = track(deliverToSessions([session, other]));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    expect(tick.done()).toBe(true);
    expect(deliveredRow(other, 'out-other')?.status).toBe('delivered');
  });

  it('stops the drain at the overdue row; later rows go out on the next tick', async () => {
    insertOutbound(session, 'out-a');
    insertOutbound(session, 'out-b');
    const calls = recordingAdapter((text) => (text === 'out-a' ? new Promise<string>(() => {}) : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;
    expect(calls).toEqual(['out-a']);

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-a', 'out-b']);
  });

  it('a late success marks the row delivered with its platform id and is never re-sent', async () => {
    insertOutbound(session, 'out-slow');
    const slow = deferred<string>();
    const calls = recordingAdapter((text) => (text === 'out-slow' ? slow.promise : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    // Polls keep running while the send is still in flight.
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-slow']);

    slow.resolve('pm-late');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-slow')).toBeDefined());
    expect(deliveredRow(session, 'out-slow')).toEqual({ status: 'delivered', platform_message_id: 'pm-late' });

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-slow']);
  });

  it("a late success of the session's first reply still carries firstDelivery to post-delivery hooks", async () => {
    insertOutbound(session, 'out-first');
    const slow = deferred<string>();
    recordingAdapter((text) => (text === 'out-first' ? slow.promise : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    slow.resolve('pm-first');
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'out-first', firstDelivery: true }]));

    insertOutbound(session, 'out-second');
    await deliverSessionMessages(session);
    expect(seen).toEqual([
      { id: 'out-first', firstDelivery: true },
      { id: 'out-second', firstDelivery: false },
    ]);
  });

  it('firstDelivery stays exactly-once when a parked first reply lands while a later drain is mid-send', async () => {
    insertOutbound(session, 'out-a');
    const slowA = deferred<string>();
    const slowB = deferred<string>();
    recordingAdapter((text) => (text === 'out-a' ? slowA.promise : text === 'out-b' ? slowB.promise : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const first = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await first.promise;

    // B's drain reads the queue while nothing is delivered yet, then A lands.
    insertOutbound(session, 'out-b');
    const second = track(deliverSessionMessages(session));
    slowA.resolve('pm-a');
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'out-a', firstDelivery: true }]));
    slowB.resolve('pm-b');
    await second.promise;

    expect(seen).toEqual([
      { id: 'out-a', firstDelivery: true },
      { id: 'out-b', firstDelivery: false },
    ]);
  });

  it('firstDelivery stays exactly-once when a send given up on lands while a later drain is mid-send', async () => {
    insertOutbound(session, 'out-a');
    const firstA = deferred<string>();
    const slowB = deferred<string>();
    const calls = recordingAdapter((text, call) => {
      if (text === 'out-a') return call === 1 ? firstA.promise : Promise.reject(new Error('still down'));
      return slowB.promise;
    });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const first = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await first.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    // This drain retries A (fails again) and waits on B; then A's first send lands.
    insertOutbound(session, 'out-b');
    const second = track(deliverSessionMessages(session));
    await vi.waitFor(() => expect(calls).toEqual(['out-a', 'out-a', 'out-b']));
    firstA.resolve('pm-a');
    await vi.waitFor(() => expect(seen).toEqual([{ id: 'out-a', firstDelivery: true }]));
    slowB.resolve('pm-b');
    await second.promise;

    expect(seen).toEqual([
      { id: 'out-a', firstDelivery: true },
      { id: 'out-b', firstDelivery: false },
    ]);
  });

  it('a late failure counts an attempt and the next tick retries the row', async () => {
    insertOutbound(session, 'out-flaky');
    const slow = deferred<string>();
    const calls = recordingAdapter((text, call) => (text === 'out-flaky' && call === 1 ? slow.promise : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    slow.reject(new Error('socket hang up'));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Message delivery failed, will retry',
        expect.objectContaining({ messageId: 'out-flaky', attempt: 1 }),
      ),
    );

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-flaky', 'out-flaky']);
    expect(deliveredRow(session, 'out-flaky')?.status).toBe('delivered');
  });

  it('a send still unsettled after the give-up window counts as a failed attempt and is retried', async () => {
    insertOutbound(session, 'out-wedged');
    const calls = recordingAdapter((text, call) =>
      text === 'out-wedged' && call === 1 ? new Promise<string>(() => {}) : undefined,
    );
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    await vi.advanceTimersByTimeAsync(GIVE_UP_MS - DEADLINE_MS - 1);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-wedged']);

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(
        expect.stringContaining('never settled'),
        expect.objectContaining({ messageId: 'out-wedged', sessionId: session.id }),
      ),
    );

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-wedged', 'out-wedged']);
    expect(deliveredRow(session, 'out-wedged')?.status).toBe('delivered');
  });

  it('a send that lands after the give-up still marks the row delivered, so no later retry posts again', async () => {
    insertOutbound(session, 'out-very-late');
    const first = deferred<string>();
    const calls = recordingAdapter((text, call) => {
      if (text !== 'out-very-late') return undefined;
      if (call === 1) return first.promise;
      return Promise.reject(new Error('channel still down'));
    });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    // The retry fails too, so the row is still undelivered when the first
    // send finally lands.
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-very-late', 'out-very-late']);
    expect(warn).toHaveBeenCalledWith(
      'Message delivery failed, will retry',
      expect.objectContaining({ messageId: 'out-very-late', attempt: 2 }),
    );

    first.resolve('pm-very-late');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-very-late')?.status).toBe('delivered'));
    await deliverSessionMessages(session);
    expect(calls).toHaveLength(2);
  });

  it('a hung system action is not run a second time while it is still pending', async () => {
    let runs = 0;
    registerDeliveryAction(
      'test_hang',
      async () => {
        runs++;
        await new Promise(() => {});
      },
      unguarded('test fixture'),
    );
    insertOutbound(session, 'out-action', 'system', { action: 'test_hang' });
    setDeliveryAdapter({ deliver: async () => 'pm' });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;
    await deliverSessionMessages(session);
    await deliverSessionMessages(session);
    expect(runs).toBe(1);
  });

  it('a slow system action (an image rebuild) is parked without a stuck-send warning and runs once', async () => {
    let runs = 0;
    registerDeliveryAction(
      'test_slow_build',
      async () => {
        runs++;
        await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
      },
      unguarded('test fixture'),
    );
    insertOutbound(session, 'out-build', 'system', { action: 'test_slow_build' });
    setDeliveryAdapter({ deliver: async () => 'pm' });
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;
    expect(info).toHaveBeenCalledWith(
      expect.stringContaining('still running'),
      expect.objectContaining({ messageId: 'out-build', sessionId: session.id }),
    );

    await deliverSessionMessages(session);
    await vi.advanceTimersByTimeAsync(5 * 60_000 - DEADLINE_MS);
    await vi.waitFor(() => expect(deliveredRow(session, 'out-build')?.status).toBe('delivered'));
    expect(runs).toBe(1);
    expect(warn).not.toHaveBeenCalledWith(expect.stringContaining('deadline'), expect.anything());
  });

  it('a hung channel does not hold the poll tick: other sessions keep their cadence', async () => {
    const { session: hungB } = await resolveSession('ag-1', 'mg-1', 'thread-hung-b', 'per-thread');
    const { session: healthy } = await resolveSession('ag-1', 'mg-1', 'thread-ok', 'per-thread');
    insertOutbound(session, 'out-hung-a');
    insertOutbound(hungB, 'out-hung-b');
    insertOutbound(healthy, 'out-ok-1');
    const calls = recordingAdapter((text) => (text.startsWith('out-hung') ? new Promise<string>(() => {}) : undefined));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    const tick = track(deliverToSessions([session, hungB, healthy]));
    await vi.advanceTimersByTimeAsync(TICK_WAIT_MS);
    expect(tick.done()).toBe(true);
    expect(deliveredRow(healthy, 'out-ok-1')?.status).toBe('delivered');

    // The hung drains still run and still own their sessions, so the next
    // tick skips them instead of sending again, and the healthy reply goes out.
    insertOutbound(healthy, 'out-ok-2');
    await deliverToSessions([session, hungB, healthy]);
    expect(deliveredRow(healthy, 'out-ok-2')?.status).toBe('delivered');
    expect(calls.filter((text) => text.startsWith('out-hung')).sort()).toEqual(['out-hung-a', 'out-hung-b']);
  });

  it('drains handed to the background are capped, so sends in flight stay bounded', async () => {
    const sessions = [session];
    for (let i = 1; i < 17; i++) {
      sessions.push((await resolveSession('ag-1', 'mg-1', `thread-slow-${i}`, 'per-thread')).session);
    }
    sessions.forEach((s, i) => insertOutbound(s, `out-slow-${i}`));
    let inFlight = 0;
    let peak = 0;
    setDeliveryAdapter({
      async deliver() {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 30_000));
        inFlight--;
        return 'pm';
      },
    });

    const tick = track(deliverToSessions(sessions));
    await vi.advanceTimersByTimeAsync(40_000);
    expect(tick.done()).toBe(true);
    // Eight awaited by the tick plus eight in the background (CONCURRENCY each).
    expect(peak).toBe(16);
  });

  it('after a give-up, the retry and the original landing follow through once (retry first)', async () => {
    insertOutbound(session, 'out-x');
    const original = deferred<string>();
    recordingAdapter((text, call) => (text === 'out-x' && call === 1 ? original.promise : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    registerPostDeliveryHook((msg, hookSession) => {
      if (hookSession.id === session.id) seen.push(msg.id);
    });

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    await deliverSessionMessages(session);
    expect(deliveredRow(session, 'out-x')).toEqual({ status: 'delivered', platform_message_id: 'pm-out-x' });
    expect(seen).toEqual(['out-x']);

    original.resolve('pm-original');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('already recorded'),
        expect.objectContaining({ messageId: 'out-x' }),
      ),
    );
    expect(seen).toEqual(['out-x']);
    expect(deliveredRow(session, 'out-x')).toEqual({ status: 'delivered', platform_message_id: 'pm-out-x' });
  });

  it('after a give-up, the retry and the original landing follow through once (original first)', async () => {
    insertOutbound(session, 'out-y');
    const original = deferred<string>();
    const retry = deferred<string>();
    const calls = recordingAdapter((text, call) => {
      if (text !== 'out-y') return undefined;
      return call === 1 ? original.promise : retry.promise;
    });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    registerPostDeliveryHook((msg, hookSession) => {
      if (hookSession.id === session.id) seen.push(msg.id);
    });

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    const second = track(deliverSessionMessages(session));
    await vi.waitFor(() => expect(calls).toEqual(['out-y', 'out-y']));
    original.resolve('pm-original');
    await vi.waitFor(() => expect(seen).toEqual(['out-y']));
    retry.resolve('pm-retry');
    await second.promise;

    expect(seen).toEqual(['out-y']);
    expect(deliveredRow(session, 'out-y')).toEqual({ status: 'delivered', platform_message_id: 'pm-original' });
  });
  it('a session stops sending once it has MAX_PARKED_PER_SESSION sends parked', async () => {
    for (let i = 0; i < MAX_PARKED + 2; i++) insertOutbound(session, `out-dead-${i}`);
    const calls = recordingAdapter(() => new Promise<string>(() => {}));
    vi.spyOn(log, 'warn').mockImplementation(() => {});

    for (let tick = 0; tick < MAX_PARKED + 2; tick++) {
      const drain = track(deliverSessionMessages(session));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      await drain.promise;
    }
    expect(calls).toEqual(['out-dead-0', 'out-dead-1', 'out-dead-2']);
  });

  it('a drain stops starting new rows after one deadline, so a tick at the cap waits about two at most', async () => {
    insertOutbound(session, 'out-s1');
    insertOutbound(session, 'out-s2');
    insertOutbound(session, 'out-s3');
    const calls = recordingAdapter(
      () => new Promise<string>((resolve) => setTimeout(() => resolve('pm'), DEADLINE_MS - 1_000)),
    );

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(2 * DEADLINE_MS);
    expect(drain.done()).toBe(true);
    expect(calls).toEqual(['out-s1', 'out-s2']);

    const next = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await next.promise;
    expect(calls).toEqual(['out-s1', 'out-s2', 'out-s3']);
  });

  it('a retry that fails after the original landed leaves no attempt row behind', async () => {
    insertOutbound(session, 'out-z');
    const original = deferred<string>();
    const retry = deferred<string>();
    const calls = recordingAdapter((text, call) => (call === 1 ? original.promise : retry.promise));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    const second = track(deliverSessionMessages(session));
    await vi.waitFor(() => expect(calls).toEqual(['out-z', 'out-z']));
    original.resolve('pm-original');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-z')?.status).toBe('delivered'));
    retry.reject(new Error('retry failed'));
    await second.promise;

    expect(await getDb().get('SELECT 1 FROM delivery_attempts WHERE message_id = ?', 'out-z')).toBeUndefined();
  });
  it('a parked retry that fails after the original landed leaves no attempt row behind', async () => {
    insertOutbound(session, 'out-w');
    const original = deferred<string>();
    const retry = deferred<string>();
    recordingAdapter((text, call) => (call === 1 ? original.promise : retry.promise));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const info = vi.spyOn(log, 'info').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() =>
      expect(error).toHaveBeenCalledWith(expect.stringContaining('never settled'), expect.anything()),
    );

    // The retry is parked too; then the original lands and the retry fails.
    const second = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await second.promise;
    original.resolve('pm-original');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-w')?.status).toBe('delivered'));
    retry.reject(new Error('retry failed'));
    await vi.waitFor(() =>
      expect(info).toHaveBeenCalledWith(
        expect.stringContaining('already recorded'),
        expect.objectContaining({ messageId: 'out-w' }),
      ),
    );

    expect(await getDb().get('SELECT 1 FROM delivery_attempts WHERE message_id = ?', 'out-w')).toBeUndefined();
  });
  it("a parked retry's give-up after the original landed leaves no attempt row behind", async () => {
    insertOutbound(session, 'out-v');
    const original = deferred<string>();
    recordingAdapter((text, call) => (call === 1 ? original.promise : new Promise<string>(() => {})));
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(1));

    const second = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await second.promise;
    original.resolve('pm-original');
    await vi.waitFor(() => expect(deliveredRow(session, 'out-v')?.status).toBe('delivered'));

    // The parked retry never settles, so its own give-up fires later.
    await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
    await vi.waitFor(() => expect(error).toHaveBeenCalledTimes(2));
    await vi.waitFor(async () =>
      expect(await getDb().get('SELECT 1 FROM delivery_attempts WHERE message_id = ?', 'out-v')).toBeUndefined(),
    );
    expect(deliveredRow(session, 'out-v')).toEqual({ status: 'delivered', platform_message_id: 'pm-original' });
  });
  it('a late landing frees its parked slot even when a post-delivery hook never returns', async () => {
    for (let i = 0; i < MAX_PARKED; i++) insertOutbound(session, `out-p${i}`);
    const sends = Array.from({ length: MAX_PARKED }, () => deferred<string>());
    const calls = recordingAdapter((text) =>
      text.startsWith('out-p') ? sends[Number(text.slice(5))].promise : undefined,
    );
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'info').mockImplementation(() => {});
    registerPostDeliveryHook((_msg, hookSession) =>
      hookSession.id === session.id ? new Promise<void>(() => {}) : undefined,
    );

    for (let i = 0; i < MAX_PARKED; i++) {
      const drain = track(deliverSessionMessages(session));
      await vi.advanceTimersByTimeAsync(DEADLINE_MS);
      await drain.promise;
    }
    sends.forEach((send, i) => send.resolve(`pm-${i}`));
    await vi.waitFor(() => expect(deliveredRow(session, `out-p${MAX_PARKED - 1}`)?.status).toBe('delivered'));

    insertOutbound(session, 'out-after');
    void deliverSessionMessages(session);
    await vi.waitFor(() => expect(calls).toContain('out-after'));
  });
});
