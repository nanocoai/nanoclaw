/**
 * report_maintenance_issue: guard identity checks, worker resolution from
 * the session's own messaging group, reported_issues row creation, and
 * that it immediately routes Kirk's decision through the real
 * maintenance_decision card -- never authorizing anything by itself.
 *
 * Ported from old commit 824318ff, adapted from the pre-async central DB
 * and sync createAgentGroup/createSession/createMessagingGroup/upsertUser/
 * grantRole/upsertUserDm to their current async equivalents; guard() is
 * now async too. No behavior change.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession } from '../../db/sessions.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { guard } from '../../guard/index.js';
import { KIRK_APPROVER_USER_ID, PEPPER_AGENT_GROUP_ID } from '../maintenance-decisions/config.js';
import { MAINTENANCE_COORDINATOR_AGENT_GROUP_ID } from './config.js';
import { reportMaintenanceIssue } from './guard.js';
import { applyReportMaintenanceIssue } from './apply.js';
// Side-effect: registers maintenance-decisions' resolved-observer, and
// (via maintenance-worker-actions, imported by that module's own
// side-effect chain) the reported_issues/workers migrations this test needs.
import '../maintenance-decisions/resolve.js';
import '../maintenance-worker-actions/index.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-maintenance-issue-report' };
});

const TEST_DIR = '/tmp/nanoclaw-test-maintenance-issue-report';
const DM_CHANNEL = 'telegram';
const DM_PLATFORM = KIRK_APPROVER_USER_ID.split(':')[1];
const WORKER_MG_PLATFORM = 'telegram:900000001';

let delivered: Array<{ channelType: string; platformId: string; content: string }>;

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, content) {
    delivered.push({ channelType, platformId, content });
    return 'pm-1';
  },
};

function now(): string {
  return new Date().toISOString();
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  delivered = [];

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
  await createSession({
    id: 'sess-pepper-1',
    agent_group_id: PEPPER_AGENT_GROUP_ID,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  await createMessagingGroup({
    id: 'mg-worker-elehazar',
    channel_type: 'telegram',
    platform_id: WORKER_MG_PLATFORM,
    name: 'SYNTHETIC Elehazar',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await createSession({
    id: 'sess-worker-elehazar',
    agent_group_id: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID,
    messaging_group_id: 'mg-worker-elehazar',
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  });

  await upsertUser({ id: KIRK_APPROVER_USER_ID, kind: 'telegram', display_name: 'Kirk', created_at: now() });
  await grantRole({
    user_id: KIRK_APPROVER_USER_ID,
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now(),
  });
  await createMessagingGroup({
    id: 'mg-kirk-dm',
    channel_type: DM_CHANNEL,
    platform_id: DM_PLATFORM,
    name: 'Kirk DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  await upsertUserDm({
    user_id: KIRK_APPROVER_USER_ID,
    channel_type: DM_CHANNEL,
    messaging_group_id: 'mg-kirk-dm',
    resolved_at: now(),
  });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

async function workerSession() {
  return getDb().get<{
    id: string;
    agent_group_id: string;
    messaging_group_id: string | null;
    thread_id: string | null;
  }>('SELECT * FROM sessions WHERE id = ?', 'sess-worker-elehazar');
}

describe('guard identity', () => {
  it('allows Maintenance Coordinator, denies everyone else', async () => {
    const allow = await guard(reportMaintenanceIssue, {
      actor: { kind: 'agent', agentGroupId: MAINTENANCE_COORDINATOR_AGENT_GROUP_ID },
      payload: {},
      grant: null,
    });
    expect(allow.effect).toBe('allow');

    const deny = await guard(reportMaintenanceIssue, {
      actor: { kind: 'agent', agentGroupId: PEPPER_AGENT_GROUP_ID },
      payload: {},
      grant: null,
    });
    expect(deny.effect).toBe('deny');
  });
});

describe('applyReportMaintenanceIssue', () => {
  it('resolves the reporting worker from the session, records the issue, and creates a real decision card', async () => {
    await applyReportMaintenanceIssue(
      {
        report: {
          property_reference: 'SYNTHETIC Test Property',
          unit: 'A',
          description: 'SYNTHETIC leaking faucet',
          urgency: 'normal',
        },
      },
      (await workerSession()) as never,
    );

    const row = await getDb().get<{
      worker_user_id: string;
      property_reference: string;
      urgency: string;
      status: string;
    }>('SELECT * FROM reported_issues');
    expect(row!.worker_user_id).toBe(WORKER_MG_PLATFORM);
    expect(row!.property_reference).toBe('SYNTHETIC Test Property');
    expect(row!.urgency).toBe('normal');
    expect(row!.status).toBe('kirk_notified');

    expect(delivered).toHaveLength(1);
    const content = JSON.parse(delivered[0].content) as { title: string; question: string };
    expect(content.title).toBe('Maintenance Coordinator — New Issue Reported');
    expect(content.question).toContain('SYNTHETIC leaking faucet');
    expect(content.question).toContain("hasn't authorized anything");
  });

  it('uses the urgent title and wording for an urgent report', async () => {
    await applyReportMaintenanceIssue(
      {
        report: {
          property_reference: 'SYNTHETIC Test Property',
          description: 'SYNTHETIC active water leak',
          urgency: 'urgent',
        },
      },
      (await workerSession()) as never,
    );

    const content = JSON.parse(delivered[0].content) as { title: string; question: string };
    expect(content.title).toBe('Maintenance Coordinator — URGENT Issue Reported');
    expect(content.question.toUpperCase()).toContain('URGENT');
  });

  it('rejects a call from a non-Maintenance-Coordinator session at apply time', async () => {
    const foreignSession = {
      id: 'sess-pepper-1',
      agent_group_id: PEPPER_AGENT_GROUP_ID,
      messaging_group_id: null,
      thread_id: null,
    };
    await applyReportMaintenanceIssue(
      { report: { property_reference: 'x', description: 'x' } },
      foreignSession as never,
    );

    expect(await getDb().get<{ c: number }>('SELECT COUNT(*) as c FROM reported_issues')).toEqual({ c: 0 });
    expect(delivered).toHaveLength(0);
  });
});
