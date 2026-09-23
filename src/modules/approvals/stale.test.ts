/**
 * Stale approval cleanup: the host-sweep expiry of unanswered module-initiated
 * cards, and the by-id reject behind `ncl approvals reject`.
 *
 * writeSessionMessage is mocked so the agent-facing notes can be read back.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createSession, createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { APPROVAL_TTL_MS, rejectPendingApproval, sweepStaleApprovals } from './stale.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-stale-approvals' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

const TEST_DIR = '/tmp/nanoclaw-test-stale-approvals';
const DAY = 24 * 60 * 60 * 1000;

async function seed(approvalId: string, opts: { ageMs?: number; action?: string; sessionId?: string | null } = {}) {
  await createPendingApproval({
    approval_id: approvalId,
    session_id: opts.sessionId === undefined ? 'sess-1' : opts.sessionId,
    request_id: approvalId,
    action: opts.action ?? 'install_packages',
    payload: JSON.stringify({}),
    created_at: new Date(Date.now() - (opts.ageMs ?? 0)).toISOString(),
    title: 'Install Packages Request',
    options_json: JSON.stringify([]),
  });
}

function notes(): Array<{ text: string; trigger?: boolean }> {
  return vi.mocked(writeSessionMessage).mock.calls.map((c) => ({
    text: (JSON.parse(c[2].content) as { text: string }).text,
    trigger: c[2].trigger,
  }));
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  const now = new Date().toISOString();
  await createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now });
  await createSession({
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now,
    created_at: now,
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('sweepStaleApprovals', () => {
  it('expires cards unanswered past the TTL and tells the agent without waking it', async () => {
    await seed('appr-old', { ageMs: APPROVAL_TTL_MS + DAY });
    await seed('appr-fresh', { ageMs: DAY });

    expect(await sweepStaleApprovals()).toBe(1);

    expect(await getPendingApproval('appr-old')).toBeUndefined();
    expect(await getPendingApproval('appr-fresh')).toBeDefined();
    expect(notes()).toHaveLength(1);
    expect(notes()[0].text).toContain('expired without an admin response');
    expect(notes()[0].trigger).toBe(false);
  });

  it('drops a stale card with no session to tell', async () => {
    await seed('appr-orphan', { ageMs: APPROVAL_TTL_MS + DAY, sessionId: null });
    expect(await sweepStaleApprovals()).toBe(1);
    expect(await getPendingApproval('appr-orphan')).toBeUndefined();
    expect(notes()).toHaveLength(0);
  });

  it('leaves OneCLI credential approvals to their own gateway TTL', async () => {
    await seed('appr-onecli', { ageMs: APPROVAL_TTL_MS + DAY, action: 'onecli_credential', sessionId: null });
    expect(await sweepStaleApprovals()).toBe(0);
    expect(await getPendingApproval('appr-onecli')).toBeDefined();
  });
});

describe('rejectPendingApproval', () => {
  it('rejects a pending card and relays the reason to the agent', async () => {
    await seed('appr-1');
    expect(await rejectPendingApproval('appr-1', 'host', 'No longer needed')).toBe('rejected');
    expect(await getPendingApproval('appr-1')).toBeUndefined();
    expect(notes()[0].text).toBe('Your install_packages request was rejected by admin: "No longer needed"');
  });

  it('removes a card with no session without notifying anyone', async () => {
    await seed('appr-2', { sessionId: null });
    expect(await rejectPendingApproval('appr-2', 'host')).toBe('removed');
    expect(await getPendingApproval('appr-2')).toBeUndefined();
    expect(notes()).toHaveLength(0);
  });

  it('refuses an unknown id', async () => {
    await expect(rejectPendingApproval('appr-nope', 'host')).rejects.toThrow('No pending approval');
  });
});
