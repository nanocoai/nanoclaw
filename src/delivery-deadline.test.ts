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
    insertOutbound(session, 'out-next');
    const calls = recordingAdapter((text) => (text === 'out-hung' ? new Promise<string>(() => {}) : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS - 1);
    expect(drain.done()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(drain.done()).toBe(true);
    expect(calls).toEqual(['out-hung']);

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('deadline'),
      expect.objectContaining({ messageId: 'out-hung', sessionId: session.id, deadlineMs: DEADLINE_MS }),
    );
    expect(deliveredRow(session, 'out-hung')).toBeUndefined();

    // The session is not dark: the next reply goes out on the next tick, and
    // the parked row is not sent a second time while its send is pending.
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-hung', 'out-next']);
    expect(deliveredRow(session, 'out-next')?.status).toBe('delivered');
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

  it('a parked first reply that then fails still leaves a row with firstDelivery', async () => {
    insertOutbound(session, 'out-a');
    const slowA = deferred<string>();
    recordingAdapter((text, call) => (text === 'out-a' && call === 1 ? slowA.promise : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    const seen: Array<{ id: string; firstDelivery: boolean }> = [];
    registerPostDeliveryHook((msg, hookSession, { firstDelivery }) => {
      if (hookSession.id === session.id) seen.push({ id: msg.id, firstDelivery });
    });

    const first = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await first.promise;

    // B goes out while A is parked; then A fails and its retry lands.
    insertOutbound(session, 'out-b');
    await deliverSessionMessages(session);
    slowA.reject(new Error('socket hang up'));
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        'Message delivery failed, will retry',
        expect.objectContaining({ messageId: 'out-a' }),
      ),
    );
    await deliverSessionMessages(session);

    expect(seen).toEqual([
      { id: 'out-b', firstDelivery: true },
      { id: 'out-a', firstDelivery: false },
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

  it('a send still unsettled after the give-up window marks the row failed and is never sent again', async () => {
    insertOutbound(session, 'out-wedged');
    // The first try fails at once, so the row has an attempt count; the retry hangs.
    const calls = recordingAdapter((text, call) => {
      if (text !== 'out-wedged') return undefined;
      return call === 1 ? Promise.reject(new Error('socket hang up')) : new Promise<string>(() => {});
    });
    vi.spyOn(log, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(log, 'error').mockImplementation(() => {});

    await deliverSessionMessages(session);
    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS);
    await drain.promise;

    await vi.advanceTimersByTimeAsync(GIVE_UP_MS - DEADLINE_MS - 1);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-wedged', 'out-wedged']);
    expect(deliveredRow(session, 'out-wedged')).toBeUndefined();

    await vi.advanceTimersByTimeAsync(DEADLINE_MS + 1);
    await vi.waitFor(() => expect(deliveredRow(session, 'out-wedged')?.status).toBe('failed'));
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('never settled'),
      expect.objectContaining({ messageId: 'out-wedged', sessionId: session.id }),
    );
    expect(await getDb().get('SELECT 1 FROM delivery_attempts WHERE message_id = ?', 'out-wedged')).toBeUndefined();

    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-wedged', 'out-wedged']);
  });

  it('a send that lands after the give-up leaves the row failed and runs no follow-through', async () => {
    insertOutbound(session, 'out-very-late');
    const first = deferred<string>();
    const calls = recordingAdapter((text) => (text === 'out-very-late' ? first.promise : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});
    const seen: string[] = [];
    registerPostDeliveryHook((msg, hookSession) => {
      if (hookSession.id === session.id) seen.push(msg.id);
    });

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() => expect(deliveredRow(session, 'out-very-late')?.status).toBe('failed'));

    first.resolve('pm-very-late');
    await vi.waitFor(() =>
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('after the give-up'),
        expect.objectContaining({ messageId: 'out-very-late', platformMsgId: 'pm-very-late' }),
      ),
    );
    expect(deliveredRow(session, 'out-very-late')).toEqual({ status: 'failed', platform_message_id: null });
    expect(seen).toEqual([]);
    await deliverSessionMessages(session);
    expect(calls).toEqual(['out-very-late']);
  });

  it('a send that fails after the give-up counts no attempt', async () => {
    insertOutbound(session, 'out-late-fail');
    const first = deferred<string>();
    recordingAdapter((text) => (text === 'out-late-fail' ? first.promise : undefined));
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {});
    vi.spyOn(log, 'error').mockImplementation(() => {});

    const drain = track(deliverSessionMessages(session));
    await vi.advanceTimersByTimeAsync(DEADLINE_MS + GIVE_UP_MS);
    await drain.promise;
    await vi.waitFor(() => expect(deliveredRow(session, 'out-late-fail')?.status).toBe('failed'));

    first.reject(new Error('socket hang up'));
    await vi.advanceTimersByTimeAsync(0);
    expect(await getDb().get('SELECT 1 FROM delivery_attempts WHERE message_id = ?', 'out-late-fail')).toBeUndefined();
    expect(warn).not.toHaveBeenCalledWith('Message delivery failed, will retry', expect.anything());
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

  it.each([
    { where: 'the same session', afterGiveUp: false, sent: false },
    { where: 'the same session', afterGiveUp: true, sent: true },
    { where: 'another session', afterGiveUp: false, sent: true },
  ])(
    'with MAX_PARKED_PER_SESSION sends parked, a new row in $where (after the give-up: $afterGiveUp) is sent: $sent',
    async ({ where, afterGiveUp, sent }) => {
      const { session: other } = await resolveSession('ag-1', 'mg-1', 'thread-other', 'per-thread');
      for (let i = 0; i < MAX_PARKED; i++) insertOutbound(session, `out-dead-${i}`);
      const calls = recordingAdapter((text) =>
        text.startsWith('out-dead') ? new Promise<string>(() => {}) : undefined,
      );
      vi.spyOn(log, 'warn').mockImplementation(() => {});
      vi.spyOn(log, 'error').mockImplementation(() => {});

      for (let tick = 0; tick < MAX_PARKED; tick++) {
        const drain = track(deliverSessionMessages(session));
        await vi.advanceTimersByTimeAsync(DEADLINE_MS);
        await drain.promise;
      }
      const target = where === 'another session' ? other : session;
      insertOutbound(target, 'out-new');
      await deliverSessionMessages(target);
      if (afterGiveUp) {
        await vi.advanceTimersByTimeAsync(GIVE_UP_MS);
        await vi.waitFor(() => expect(deliveredRow(session, `out-dead-${MAX_PARKED - 1}`)?.status).toBe('failed'));
        await deliverSessionMessages(target);
      }

      expect(calls).toEqual(['out-dead-0', 'out-dead-1', 'out-dead-2', ...(sent ? ['out-new'] : [])]);
      expect(deliveredRow(target, 'out-new')?.status).toBe(sent ? 'delivered' : undefined);
    },
  );
});
