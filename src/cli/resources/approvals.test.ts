/**
 * `ncl approvals list` folds the separate unknown-sender holds
 * (pending_sender_approvals) into its output as action:'sender_admit', so an
 * operator — and the e2e sender-admit scenarios — can discover and resolve
 * them through the one approvals surface. Regression guard for that fold-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createPendingApproval } from '../../db/sessions.js';
import { createPendingSenderApproval } from '../../modules/permissions/db/pending-sender-approvals.js';
import { dispatch } from '../dispatch.js';
import type { CallerContext } from '../frame.js';
import './approvals.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-approvals-list' };
});

const HOST: CallerContext = { caller: 'host' };
const now = () => new Date().toISOString();

async function listApprovals(args: Record<string, unknown> = {}): Promise<Array<Record<string, unknown>>> {
  const resp = await dispatch({ id: 'l', command: 'approvals-list', args }, HOST);
  if (!resp.ok) throw new Error(`approvals-list failed: ${resp.error.message}`);
  return resp.data as Array<Record<string, unknown>>;
}

function seedSenderApproval(id: string, sender: string): void {
  createPendingSenderApproval({
    id,
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    sender_identity: sender,
    sender_name: null,
    original_message: '{"kind":"chat"}',
    approver_user_id: 'e2e-control:owner',
    created_at: now(),
    title: 'Unknown sender wants in',
    options_json: '[]',
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'e2e-control',
    platform_id: 'chat-1',
    instance: 'e2e-control',
    name: 'Chat',
    is_group: 0,
    unknown_sender_policy: 'request_approval',
    created_at: now(),
  });
});

afterEach(() => closeDb());

describe('approvals list — sender-admit fold-in', () => {
  it('folds pending_sender_approvals in as action:sender_admit, alongside pending_approvals rows', async () => {
    createPendingApproval({
      approval_id: 'appr-1',
      request_id: 'appr-1',
      action: 'onecli_credential',
      payload: '{}',
      created_at: now(),
      title: 'cred',
      options_json: '[]',
    });
    seedSenderApproval('nsa-1', 'cli:local');

    const rows = await listApprovals();

    const sender = rows.find((r) => r.approval_id === 'nsa-1');
    expect(sender).toMatchObject({ approval_id: 'nsa-1', action: 'sender_admit', status: 'pending' });
    // union, not replacement — the ordinary pending_approvals row is still there
    expect(rows.some((r) => r.approval_id === 'appr-1' && r.action === 'onecli_credential')).toBe(true);
  });

  it('honors --action sender_admit (only folded rows) and excludes them under a non-pending --status', async () => {
    createPendingApproval({
      approval_id: 'appr-2',
      request_id: 'appr-2',
      action: 'install_packages',
      payload: '{}',
      created_at: now(),
      title: 'pkg',
      options_json: '[]',
    });
    seedSenderApproval('nsa-2', 'cli:bob');

    expect((await listApprovals({ action: 'sender_admit' })).map((r) => r.approval_id)).toEqual(['nsa-2']);
    expect((await listApprovals({ status: 'rejected' })).some((r) => r.approval_id === 'nsa-2')).toBe(false);
  });
});
