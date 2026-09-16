/**
 * Delivery poll loops: bounded concurrency across sessions, per-session
 * failure isolation, and fixed-rate re-arming.
 *
 * Drives `deliverToSessions` against real session mailboxes on disk (the
 * same fixture shape as delivery.test.ts) and the exported poll starters
 * under fake timers.
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
    DATA_DIR: '/tmp/nanoclaw-test-delivery-poll',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-poll/groups',
  };
});

vi.mock('./db/agent-groups.js', async () => {
  const actual = await vi.importActual<typeof import('./db/agent-groups.js')>('./db/agent-groups.js');
  return {
    ...actual,
    getAgentGroup: vi.fn((id: string) => {
      if (id === 'ag-broken') return Promise.reject(new Error('central lookup failed'));
      return actual.getAgentGroup(id);
    }),
  };
});

vi.mock('./db/sessions.js', async () => {
  const actual = await vi.importActual<typeof import('./db/sessions.js')>('./db/sessions.js');
  return { ...actual, getRunningSessions: vi.fn(actual.getRunningSessions) };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-poll';

import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from './db/index.js';
import { getRunningSessions } from './db/sessions.js';
import { deliverToSessions, setDeliveryAdapter, startActiveDeliveryPoll, stopDeliveryPolls } from './delivery.js';
import { log } from './log.js';
import { outboundDbPath } from './mailbox/sqlite/paths.js';
import { resolveSession } from './session-manager.js';
import type { Session } from './types.js';

const CONCURRENCY = 8; // DELIVERY_CONCURRENCY in delivery.ts

function now(): string {
  return new Date().toISOString();
}

function insertOutbound(session: Session, msgId: string): void {
  const db = new Database(outboundDbPath(session.agent_group_id, session.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat', 'telegram:123', 'telegram', ?)`,
  ).run(msgId, now(), JSON.stringify({ text: `hello from ${session.id}` }));
  db.close();
}

async function seedSessions(count: number, agentGroupId = 'ag-1'): Promise<Session[]> {
  const sessions: Session[] = [];
  for (let i = 0; i < count; i++) {
    const { session } = await resolveSession(agentGroupId, 'mg-1', `thread-${agentGroupId}-${i}`, 'per-thread');
    insertOutbound(session, `out-${agentGroupId}-${i}`);
    sessions.push(session);
  }
  return sessions;
}

beforeEach(async () => {
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  for (const id of ['ag-1', 'ag-broken']) {
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now() });
  }
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:123',
    name: 'Test Chat',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
});

afterEach(async () => {
  stopDeliveryPolls();
  vi.useRealTimers();
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('deliverToSessions', () => {
  it('drains up to DELIVERY_CONCURRENCY sessions at once, all of them exactly once', async () => {
    const sessions = await seedSessions(20);
    let inFlight = 0;
    let peak = 0;
    const delivered: string[] = [];
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _kind, content) => {
        inFlight++;
        peak = Math.max(peak, inFlight);
        await gate;
        inFlight--;
        delivered.push(JSON.parse(content).text);
        return 'pm';
      },
    });

    const done = deliverToSessions(sessions);
    // Let the first wave read its queues and reach the adapter.
    await vi.waitFor(() => expect(inFlight).toBe(CONCURRENCY));
    release();
    await done;

    expect(peak).toBe(CONCURRENCY);
    expect(delivered).toHaveLength(20);
    expect(new Set(delivered).size).toBe(20);
  });

  it('a session whose drain throws is logged and skipped; the rest still deliver this tick', async () => {
    const good = await seedSessions(3);
    const [broken] = await seedSessions(1, 'ag-broken');
    const delivered: string[] = [];
    setDeliveryAdapter({
      deliver: async (_ct, _pid, _tid, _kind, content) => {
        delivered.push(JSON.parse(content).text);
        return 'pm';
      },
    });
    const errors = vi.spyOn(log, 'error').mockImplementation(() => {});

    await deliverToSessions([good[0], broken, good[1], good[2]]);

    expect(delivered.sort()).toEqual(good.map((s) => `hello from ${s.id}`).sort());
    expect(errors).toHaveBeenCalledWith(
      'Session delivery failed',
      expect.objectContaining({ sessionId: broken.id, err: expect.any(Error) }),
    );
  });
});

describe('active poll cadence', () => {
  it('re-arms at a fixed rate from each tick start, not after the tick plus a full interval', async () => {
    vi.useFakeTimers();
    const startedAt: number[] = [];
    vi.mocked(getRunningSessions).mockImplementation(async () => {
      startedAt.push(Date.now());
      // A slow tick: 300 ms of mailbox latency.
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [];
    });

    startActiveDeliveryPoll();
    await vi.advanceTimersByTimeAsync(2_050);

    // Ticks at t=0, 1000, 2000 — the 300 ms tick duration is absorbed. The
    // old cadence (interval after completion) would have given 0, 1300, 2600.
    expect(startedAt.map((t) => t - startedAt[0])).toEqual([0, 1000, 2000]);
  });

  it('a tick that overruns its interval re-arms after a short breather instead of spinning', async () => {
    vi.useFakeTimers();
    const startedAt: number[] = [];
    vi.mocked(getRunningSessions).mockImplementation(async () => {
      startedAt.push(Date.now());
      await new Promise((resolve) => setTimeout(resolve, 1_500));
      return [];
    });

    startActiveDeliveryPoll();
    await vi.advanceTimersByTimeAsync(3_300);

    // t=0 (runs until 1500) → breather 100 ms → t=1600 (until 3100) → t=3200.
    expect(startedAt.map((t) => t - startedAt[0])).toEqual([0, 1600, 3200]);
  });
});
