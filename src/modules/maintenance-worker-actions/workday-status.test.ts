/**
 * get_workday_status / mark_workday_active -- the conditional-day (e.g.
 * Saturday) evidence gate. schedule-config.js is mocked so tests are
 * deterministic and never depend on the real schedule-config.json file
 * or the real current date.
 *
 * Ported from old commit 824318ff, adapted from sync
 * createAgentGroup/createMessagingGroup/createSession/getDb().prepare(...)
 * to their current async equivalents. writeSessionMessage stays mocked
 * with a plain `vi.fn()` (now called with `await` inside notifyAgent, but
 * a mocked sync return still resolves fine as an awaited value).
 *
 * withRealDateNow's whole point is capturing a fixed Date synchronously,
 * before the function under test's first `await` -- resolveTodayInfo(config,
 * new Date()) runs before any await inside apply*. So the session lookup
 * (now itself an async DB call) must resolve BEFORE entering
 * withRealDateNow, never inside its callback -- otherwise the callback's
 * own first `await` would be the session lookup, the fixed Date would
 * already be reverted by the time apply* actually reads `new Date()`, and
 * every timezone/day-type assertion below would silently use the real
 * clock instead of the fixed one.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { writeSessionMessage } from '../../session-manager.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { applyGetWorkdayStatus } from './get-workday-status.js';
import { applyMarkWorkdayActive } from './mark-workday-active.js';
import type { MaintenanceScheduleConfig } from './schedule-config.js';
// Side-effect: registers maintenance_confirmed_workdays' migration
// (owned by maintenance-properties, not this module).
import '../maintenance-properties/index.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-workday-status' };
});

let mockedConfig: MaintenanceScheduleConfig | null = null;
vi.mock('./schedule-config.js', async () => {
  const actual = await vi.importActual<typeof import('./schedule-config.js')>('./schedule-config.js');
  return { ...actual, readScheduleConfig: () => mockedConfig };
});

const TEST_DIR = '/tmp/nanoclaw-test-workday-status';
const ELEHAZAR = 'telegram:900000001';

function now(): string {
  return new Date().toISOString();
}

function lastNotifiedText(): string | undefined {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1);
  if (!call) return undefined;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  mockedConfig = {
    timezone: 'America/New_York',
    fixed_workdays: [1, 2, 3, 4, 5],
    conditional_workdays: { '6': { enabled: true }, '7': { enabled: false } },
    work_start_hour: 8,
    work_end_hour: 17,
  };

  await createAgentGroup({
    id: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID,
    name: 'Maintenance Coordinator',
    folder: 'maintenance-coordinator',
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-elehazar',
    channel_type: 'telegram',
    platform_id: ELEHAZAR,
    name: 'SYNTHETIC Elehazar',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createSession({
    id: 'sess-elehazar',
    agent_group_id: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID,
    messaging_group_id: 'mg-elehazar',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function elehazarSession() {
  return getDb().get('SELECT * FROM sessions WHERE id = ?', 'sess-elehazar');
}

function withRealDateNow<T>(iso: string, fn: () => T): T {
  const RealDate = Date;
  class FixedDate extends RealDate {
    constructor(...args: unknown[]) {
      if (args.length === 0) {
        super(iso);
      } else {
        // @ts-expect-error -- forwarding varargs to the real Date constructor
        super(...args);
      }
    }
    static now() {
      return new RealDate(iso).getTime();
    }
  }
  // @ts-expect-error -- test-only global override
  global.Date = FixedDate;
  try {
    return fn();
  } finally {
    global.Date = RealDate;
  }
}

describe('get_workday_status', () => {
  it('reports a fixed weekday as a normal workday', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-18T14:00:00Z', () => applyGetWorkdayStatus({}, session as never));
    expect(lastNotifiedText()).toContain('normal scheduled workday');
  });

  it('reports Sunday (disabled conditional) as off, not a workday', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-23T14:00:00Z', () => applyGetWorkdayStatus({}, session as never));
    const text = lastNotifiedText()!;
    expect(text).toContain('not a scheduled workday');
    expect(text).toContain('has not been marked active');
  });

  it('reports an unconfirmed Saturday as unconfirmed -- explicitly says do not ask about attendance', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-22T14:00:00Z', () => applyGetWorkdayStatus({}, session as never));
    const text = lastNotifiedText()!;
    expect(text).toContain('has NOT been confirmed active');
    expect(text).toContain('Do not proactively ask');
  });

  it('reports a confirmed Saturday as active for the rest of the day', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-22T09:00:00Z', () =>
      applyMarkWorkdayActive({ confirmation: { reason: 'Kirk said the crew is working today' } }, session as never),
    );
    await withRealDateNow('2026-08-22T18:00:00Z', () => applyGetWorkdayStatus({}, session as never));
    const text = lastNotifiedText()!;
    expect(text).toContain('HAS been confirmed active');
    expect(text).toContain('Kirk said the crew is working today');
  });

  // Regression: 2026-08-15/16 live test -- the agent narrated a confirmed
  // day as "still unconfirmed" despite receiving this exact text. The text
  // itself was never ambiguous; this locks that down so a future wording
  // change can't accidentally introduce a hedge that makes the mistake
  // more understandable. The agent-side half of this regression (does the
  // model actually read and trust this text) is covered by the ack-text
  // fix in container/agent-runner's maintenance-coordinator.test.ts plus a
  // live re-test -- this test cannot exercise that half.
  it('regression: a confirmed-active answer contains no hedge/negation language that could be misread as unconfirmed', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-22T09:00:00Z', () =>
      applyMarkWorkdayActive({ confirmation: { reason: 'evidence' } }, session as never),
    );
    await withRealDateNow('2026-08-22T10:00:00Z', () => applyGetWorkdayStatus({}, session as never));
    const text = lastNotifiedText()!.toLowerCase();
    expect(text).not.toContain('unconfirmed');
    expect(text).not.toContain('has not');
    expect(text).not.toContain('no evidence');
  });
});

describe('mark_workday_active', () => {
  it('is idempotent -- calling it twice for the same day updates, not duplicates', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-22T09:00:00Z', () =>
      applyMarkWorkdayActive({ confirmation: { reason: 'Ivan clocked in' } }, session as never),
    );
    await withRealDateNow('2026-08-22T09:05:00Z', () =>
      applyMarkWorkdayActive({ confirmation: { reason: 'Kirk also confirmed' } }, session as never),
    );

    const rows = await getDb().all<{ work_date: string; reason: string }>(
      'SELECT * FROM maintenance_confirmed_workdays',
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].work_date).toBe('2026-08-22');
    expect(rows[0].reason).toBe('Kirk also confirmed');
  });

  it('resolves the date from real time in the configured timezone, never from agent input', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-22T09:00:00Z', () =>
      applyMarkWorkdayActive({ confirmation: { reason: 'test' } }, session as never),
    );
    const row = await getDb().get<{ work_date: string }>('SELECT work_date FROM maintenance_confirmed_workdays');
    expect(row!.work_date).toBe('2026-08-22');
  });

  it('records the resolved sender as confirmed_by', async () => {
    const session = await elehazarSession();
    await withRealDateNow('2026-08-22T09:00:00Z', () =>
      applyMarkWorkdayActive({ confirmation: { reason: 'Elehazar checked in' } }, session as never),
    );
    const row = await getDb().get<{ confirmed_by: string }>('SELECT confirmed_by FROM maintenance_confirmed_workdays');
    expect(row!.confirmed_by).toBe(ELEHAZAR);
  });
});
