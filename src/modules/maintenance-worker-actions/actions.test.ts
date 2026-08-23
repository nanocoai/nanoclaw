/**
 * Integration coverage for Maintenance Coordinator's routine worker-facing
 * actions and Pepper's status query: guard identity, record_time_event,
 * report_worker_status (self-report, on-behalf-of-coworker, destination
 * resolution + Trello-suggestion dedup), get_worker_activity (timezone-safe
 * "today" + the conditional-day freshness gate), get_worker_info,
 * query_maintenance_status, and key-binder status/custody.
 *
 * Not a line-for-line port of old commit 824318ff's 730-line actions.test.ts
 * -- this is a curated re-derivation covering the same load-bearing
 * behaviors (guard boundaries, dedup correctness, timezone safety,
 * cross-worker isolation) with the current async DbDriver and delivery
 * adapter, rather than every combination the original exercised.
 * schedule-config.test.ts / workday-status.test.ts / properties.test.ts /
 * trello-suggestion-log.test.ts cover their own areas separately and are
 * not duplicated here.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { writeSessionMessage } from '../../session-manager.js';
import { guard } from '../../guard/index.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID, PEPPER_AGENT_GROUP_ID } from './config.js';
import { maintenanceStatusQuery, maintenanceWorkerAction } from './guard.js';
import { applyRecordTimeEvent } from './record-time-event.js';
import { applyReportWorkerStatus } from './report-worker-status.js';
import { applyGetWorkerInfo } from './get-worker-info.js';
import { applyQueryMaintenanceStatus } from './query-maintenance-status.js';
import { applyGetKeyBinderStatus } from './get-key-binder-status.js';
import { applyRecordKeyBinderCustody } from './record-key-binder-custody.js';
import { applyGetWorkerActivity } from './get-worker-activity.js';
import type { MaintenanceScheduleConfig } from './schedule-config.js';
// Side-effect: registers this module's own migrations (workers,
// worker_state, worker_time_events, reported_issues, ...).
import './index.js';
// Side-effect: registers the properties/key-binders migrations this file's
// destination-resolution and key-binder tests need.
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
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-maintenance-actions' };
});

let mockedConfig: MaintenanceScheduleConfig | null = null;
vi.mock('./schedule-config.js', async () => {
  const actual = await vi.importActual<typeof import('./schedule-config.js')>('./schedule-config.js');
  return { ...actual, readScheduleConfig: () => mockedConfig };
});

const TEST_DIR = '/tmp/nanoclaw-test-maintenance-actions';
const IVAN = 'telegram:900000002';
const ELEHAZAR = 'telegram:900000001';

// notifyAgent writes into the session's own outbound mailbox (for the
// container to read on next poll) via writeSessionMessage -- it never
// touches the host's channel-delivery adapter, so mock writeSessionMessage
// directly rather than setDeliveryAdapter (same pattern as
// workday-status.test.ts).
function lastText(): string {
  const call = vi.mocked(writeSessionMessage).mock.calls.at(-1)!;
  return (JSON.parse(call[2].content) as { text: string }).text;
}

function now(): string {
  return new Date().toISOString();
}

async function createWorkerSession(id: string, sessionId: string, platformId: string) {
  await createMessagingGroup({
    id: `mg-${id}`,
    channel_type: 'telegram',
    platform_id: platformId,
    name: `SYNTHETIC ${id}`,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createSession({
    id: sessionId,
    agent_group_id: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID,
    messaging_group_id: `mg-${id}`,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });
  return getDb().get('SELECT * FROM sessions WHERE id = ?', sessionId);
}

async function insertWorker(userId: string, name: string, canDrive: 0 | 1 = 1, transportProviderId: string | null = null) {
  await getDb().run(
    `INSERT INTO workers (user_id, name, preferred_language, role, can_drive_independently, usual_transport_provider, created_at)
     VALUES (?, ?, 'en', 'worker', ?, ?, ?)`,
    userId,
    name,
    canDrive,
    transportProviderId,
    now(),
  );
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
  await createAgentGroup({
    id: PEPPER_AGENT_GROUP_ID,
    name: 'Pepper',
    folder: 'pepper',
    agent_provider: null,
    created_at: now(),
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('guard identity', () => {
  it('maintenanceWorkerAction allows only Maintenance Coordinator', async () => {
    const allow = await guard(maintenanceWorkerAction, {
      actor: { kind: 'agent', agentGroupId: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID },
      payload: {},
      grant: null,
    });
    expect(allow.effect).toBe('allow');
    const deny = await guard(maintenanceWorkerAction, {
      actor: { kind: 'agent', agentGroupId: PEPPER_AGENT_GROUP_ID },
      payload: {},
      grant: null,
    });
    expect(deny.effect).toBe('deny');
  });

  it('maintenanceStatusQuery allows only Pepper', async () => {
    const allow = await guard(maintenanceStatusQuery, {
      actor: { kind: 'agent', agentGroupId: PEPPER_AGENT_GROUP_ID },
      payload: {},
      grant: null,
    });
    expect(allow.effect).toBe('allow');
    const deny = await guard(maintenanceStatusQuery, {
      actor: { kind: 'agent', agentGroupId: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID },
      payload: {},
      grant: null,
    });
    expect(deny.effect).toBe('deny');
  });
});

describe('record_time_event', () => {
  it('clocking in writes an append-only event and refreshes worker_state.clocked_in', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await applyRecordTimeEvent({ event: { event_type: 'clock_in' } }, session as never);

    const events = await getDb().all('SELECT * FROM worker_time_events WHERE worker_user_id = ?', ELEHAZAR);
    expect(events).toHaveLength(1);
    const state = await getDb().get<{ clocked_in: number }>(
      'SELECT clocked_in FROM worker_state WHERE worker_user_id = ?',
      ELEHAZAR,
    );
    expect(state!.clocked_in).toBe(1);
    expect(lastText()).toContain('clocked in');
  });

  it('clocking out a second time appends a new row rather than mutating the first', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await applyRecordTimeEvent({ event: { event_type: 'clock_in' } }, session as never);
    await applyRecordTimeEvent({ event: { event_type: 'clock_out' } }, session as never);

    const events = await getDb().all('SELECT * FROM worker_time_events WHERE worker_user_id = ?', ELEHAZAR);
    expect(events).toHaveLength(2);
    const state = await getDb().get<{ clocked_in: number }>(
      'SELECT clocked_in FROM worker_state WHERE worker_user_id = ?',
      ELEHAZAR,
    );
    expect(state!.clocked_in).toBe(0);
  });
});

describe('report_worker_status', () => {
  it('records a self-report and resolves a known property destination', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await getDb().run(
      `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at)
       VALUES ('p1', '115 Edgewood', '115 Edgewood Ave', NULL, 'lease-manager-sync', ?, ?)`,
      now(),
      now(),
    );

    await applyReportWorkerStatus({ status: { location: '115 Edgewood Ave' } }, session as never);

    const state = await getDb().get<{ current_location_reported: string }>(
      'SELECT current_location_reported FROM worker_state WHERE worker_user_id = ?',
      ELEHAZAR,
    );
    expect(state!.current_location_reported).toBe('115 Edgewood Ave');
    expect(lastText()).toContain('Property match: 115 Edgewood Ave');
    expect(lastText()).toContain('destination_key "property:p1"');
  });

  it('reports on behalf of a transported co-worker without touching the reporter\'s own state', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await insertWorker(IVAN, 'Ivan');
    await insertWorker(ELEHAZAR, 'Elehazar');

    await applyReportWorkerStatus(
      { status: { about_worker: 'Ivan', location: 'Cecil Street', transport_mode: 'transported', transported_by: 'Elehazar' } },
      session as never,
    );

    const ivanState = await getDb().get<{ current_location_reported: string; transported_by: string }>(
      'SELECT current_location_reported, transported_by FROM worker_state WHERE worker_user_id = ?',
      IVAN,
    );
    expect(ivanState!.current_location_reported).toBe('Cecil Street');
    expect(ivanState!.transported_by).toBe(ELEHAZAR);
    const elehazarState = await getDb().get(
      'SELECT * FROM worker_state WHERE worker_user_id = ?',
      ELEHAZAR,
    );
    expect(elehazarState).toBeUndefined();
  });

  it('flags an ambiguous destination match instead of guessing', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await getDb().run(
      `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at)
       VALUES ('p1', 'North', '115 North Commerce Street', NULL, 'lease-manager-sync', ?, ?)`,
      now(),
      now(),
    );
    await getDb().run(
      `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at)
       VALUES ('p2', 'South', '200 South Commerce Street', NULL, 'lease-manager-sync', ?, ?)`,
      now(),
      now(),
    );

    await applyReportWorkerStatus({ status: { location: 'Commerce Street' } }, session as never);
    expect(lastText()).toContain('ambiguous between');
  });

  it('trello_suggestion_shown is recorded and dedup suppresses an unchanged repeat next time', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await getDb().run(
      `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at)
       VALUES ('p1', '115 Edgewood', '115 Edgewood Ave', NULL, 'lease-manager-sync', ?, ?)`,
      now(),
      now(),
    );

    await applyReportWorkerStatus({ status: { location: '115 Edgewood Ave' } }, session as never);
    await applyReportWorkerStatus(
      { status: { trello_suggestion_shown: { destination_key: 'property:p1', property_id: 'p1', card_ids: ['card-1'] } } },
      session as never,
    );
    expect(lastText()).toContain('Trello suggestion recorded (1 card(s))');

    // Reporting the same location again (no real change) should surface the
    // "already shown, only mention if changed" note rather than a fresh
    // "no prior suggestion" note.
    await getDb().run('UPDATE worker_state SET current_location_reported = NULL WHERE worker_user_id = ?', ELEHAZAR);
    await applyReportWorkerStatus({ status: { location: '115 Edgewood Ave' } }, session as never);
    expect(lastText()).toContain('Last Trello suggestion already shown for this property: card(s) card-1');
  });
});

describe('get_worker_info', () => {
  it('defaults to the reporting worker when no worker is specified', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await insertWorker(IVAN, 'Ivan');
    await insertWorker(ELEHAZAR, 'Elehazar', 0, IVAN);
    await applyGetWorkerInfo({ info: {} }, session as never);
    expect(lastText()).toContain('Elehazar');
    expect(lastText()).toContain(`usually transported by ${IVAN}`);
  });

  it('looks up a named co-worker', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await insertWorker(ELEHAZAR, 'Elehazar');
    await insertWorker(IVAN, 'Ivan', 0, ELEHAZAR);
    await applyGetWorkerInfo({ info: { worker: 'Ivan' } }, session as never);
    expect(lastText()).toContain('Ivan');
    expect(lastText()).toContain('does not drive independently');
  });
});

describe('query_maintenance_status', () => {
  it('summarizes worker state and open issues for Pepper', async () => {
    const pepperSession = await createSession({
      id: 'sess-pepper',
      agent_group_id: PEPPER_AGENT_GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: now(),
      created_at: now(),
    });
    await insertWorker(ELEHAZAR, 'Elehazar');
    await getDb().run(
      `INSERT INTO worker_state (worker_user_id, clocked_in, last_activity_at) VALUES (?, 1, ?)`,
      ELEHAZAR,
      now(),
    );
    await getDb().run(
      `INSERT INTO reported_issues (id, worker_user_id, property_reference, description, urgency, reported_at, status)
       VALUES ('issue-1', ?, 'SYNTHETIC Property', 'SYNTHETIC leak', 'urgent', ?, 'new')`,
      ELEHAZAR,
      now(),
    );

    await applyQueryMaintenanceStatus({}, (await getDb().get('SELECT * FROM sessions WHERE id = ?', 'sess-pepper')) as never);
    void pepperSession;
    const text = lastText();
    expect(text).toContain('Elehazar: clocked in');
    expect(text).toContain('[URGENT] SYNTHETIC Property');
  });
});

describe('key binders', () => {
  it('records custody and reflects it in a subsequent status lookup', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await getDb().run(
      `INSERT INTO key_binders (id, label, home_location, created_at) VALUES ('kb1', 'Binder A', '140 Richard Road, Lexington, NC 27292', ?)`,
      now(),
    );

    await applyRecordKeyBinderCustody(
      { custody: { binder: 'Binder A', holder_type: 'kirk' } },
      session as never,
    );
    expect(lastText()).toContain('Binder A is now with kirk');

    await applyGetKeyBinderStatus({ info: { binder: 'Binder A' } }, session as never);
    expect(lastText()).toContain('currently with kirk');
  });

  it('resolves a property\'s mapped binder and reports its custody', async () => {
    const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
    await getDb().run(
      `INSERT INTO properties (id, canonical_name, address, unit, source, synced_at, created_at)
       VALUES ('p1', '115 Edgewood', '115 Edgewood Ave', NULL, 'lease-manager-sync', ?, ?)`,
      now(),
      now(),
    );
    await getDb().run(
      `INSERT INTO key_binders (id, label, home_location, created_at) VALUES ('kb1', 'Binder A', '140 Richard Road, Lexington, NC 27292', ?)`,
      now(),
    );
    await getDb().run(
      `INSERT INTO property_operational_info (property_id, key_binder_id, updated_at) VALUES ('p1', 'kb1', ?)`,
      now(),
    );

    await applyGetKeyBinderStatus({ info: { property: '115 Edgewood Ave' } }, session as never);
    expect(lastText()).toContain('Binder A');
    expect(lastText()).toContain('currently with unknown');
  });
});

describe('get_worker_activity', () => {
  it('reports no data ever recorded distinctly from no data today', async () => {
    // Fixed weekday (Tuesday) -- avoids the conditional-day freshness gate,
    // which is exercised on its own in the next test.
    const RealDate = Date;
    // @ts-expect-error test override
    global.Date = class extends RealDate {
      constructor() {
        super('2026-08-18T14:00:00Z');
      }
      static now() {
        return new RealDate('2026-08-18T14:00:00Z').getTime();
      }
    };
    try {
      const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
      await insertWorker(ELEHAZAR, 'Elehazar');
      await applyGetWorkerActivity({ query: { worker: 'Elehazar' } }, session as never);
    } finally {
      global.Date = RealDate;
    }
    expect(lastText()).toContain('no activity ever recorded');
  });

  it('refuses to answer on an unconfirmed conditional day until the session has freshly checked get_workday_status', async () => {
    mockedConfig!.conditional_workdays = { '6': { enabled: true } };
    const RealDate = Date;
    // Saturday in America/New_York.
    // @ts-expect-error test override
    global.Date = class extends RealDate {
      constructor() {
        super('2026-08-22T14:00:00Z');
      }
      static now() {
        return new RealDate('2026-08-22T14:00:00Z').getTime();
      }
    };
    try {
      const session = await createWorkerSession('elehazar', 'sess-elehazar', ELEHAZAR);
      await insertWorker(ELEHAZAR, 'Elehazar');
      await applyGetWorkerActivity({ query: { worker: 'Elehazar' } }, session as never);
    } finally {
      global.Date = RealDate;
    }
    expect(lastText()).toContain("hasn't freshly checked get_workday_status");
  });
});
