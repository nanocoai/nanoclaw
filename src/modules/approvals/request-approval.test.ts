/**
 * Regression test for requestApproval() persisting agent_group_id on the
 * pending_approvals row.
 *
 * The bug: the row was created without agent_group_id (defaulting to NULL).
 * The response handler's approve-path gate is
 *   authorized = clicker && approval.agent_group_id !== null && hasAdminPrivilege(...)
 * so a NULL agent_group_id makes EVERY clicked Approve fail closed as
 * "unauthorized" — the card delivers but can never be resolved. Stamping the
 * originating group is what lets a legitimate admin/owner actually approve.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';

import {
  initChannelAdapters,
  registerChannelAdapter,
  teardownChannelAdapters,
} from '../../channels/channel-registry.js';
import type { ChannelAdapter } from '../../channels/adapter.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { createUser } from '../permissions/db/users.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { requestApproval } from './primitive.js';
import type { Session } from '../../types.js';

function now(): string {
  return new Date().toISOString();
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
});

async function mountMockAdapter(channelType: string): Promise<void> {
  const adapter: ChannelAdapter = {
    name: channelType,
    channelType,
    supportsThreads: false,
    async setup() {},
    async teardown() {},
    isConnected() {
      return true;
    },
    async deliver() {
      return undefined;
    },
    async setTyping() {},
  };
  registerChannelAdapter(channelType, { factory: () => adapter });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

describe('requestApproval', () => {
  it('stamps agent_group_id (the session group) onto the pending_approvals row', async () => {
    await mountMockAdapter('telegram');
    createAgentGroup({ id: 'ag-1', name: 'AG-1', folder: 'ag-1', agent_provider: null, created_at: now() });
    // A reachable owner so pickApprovalDelivery returns a target and the row is created.
    createUser({ id: 'telegram:111', kind: 'telegram', display_name: null, created_at: now() });
    grantRole({ user_id: 'telegram:111', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });

    const session: Session = {
      id: 'sess-1',
      agent_group_id: 'ag-1',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'running',
      last_active: now(),
      created_at: now(),
    };
    createSession(session);

    await requestApproval({
      session,
      agentName: 'AG-1',
      action: 'cli_command',
      payload: { frame: { id: 'cli-1', command: 'members-add', args: {} } },
      title: 'CLI: members-add',
      question: 'approve?',
    });

    const rows = getPendingApprovalsByAction('cli_command');
    expect(rows).toHaveLength(1);
    expect(rows[0].agent_group_id).toBe('ag-1');
  });
});
