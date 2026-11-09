/** Expired gateway cards are edited through the exact adapter instance that posted them. */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  editExpiredGatewayApprovalCard,
  GATEWAY_APPROVAL_ACTION,
  startGatewayApprovalCoordinator,
  stopGatewayApprovalCoordinator,
} from '../../gateway-approval-coordinator.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import type { GatewayProviderDefinition } from '../../gateway-providers/index.js';
import type { PendingApproval } from '../../types.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-expired-card-instance' };
});

const TEST_DIR = '/tmp/nanoclaw-test-expired-card-instance';
const delivered: Array<{ platformId: string; instance: string | undefined }> = [];
const captureAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, platformId, _threadId, _kind, _content, _files, instance) {
    delivered.push({ platformId, instance });
    return 'pm-edited';
  },
};
const provider: GatewayProviderDefinition = {
  kind: 'fixture',
  agentSkills: [],
  sessions: {
    async ensure() {
      return { contribution: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } } };
    },
  },
  approvals: {
    async subscribe(_decide, signal) {
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
    },
  },
};

function now(): string {
  return new Date().toISOString();
}

async function seedPending(overrides: Partial<PendingApproval> = {}): Promise<PendingApproval> {
  const row: PendingApproval = {
    approval_id: 'ga-test0001',
    session_id: null,
    request_id: 'req-1',
    action: GATEWAY_APPROVAL_ACTION,
    payload: '{}',
    created_at: now(),
    agent_group_id: 'ag-b',
    channel_type: 'slack',
    platform_id: 'D-B-admin-1',
    instance: 'slack-b',
    platform_message_id: 'pm-1',
    expires_at: now(),
    status: 'pending',
    title: 'Credentials Request',
    question: 'Allow this request?',
    options_json: '[]',
    approver_user_id: null,
    ...overrides,
  };
  await createPendingApproval(row);
  return row;
}

beforeEach(async () => {
  delivered.length = 0;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: 'ag-b', name: 'Agent B', folder: 'agent-b', agent_provider: null, created_at: now() });
  await startGatewayApprovalCoordinator(provider, captureAdapter, vi.fn());
});

afterEach(async () => {
  await stopGatewayApprovalCoordinator();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('expired gateway card instance routing', () => {
  it.each([
    ['named instance', 'slack-b', 'slack-b'],
    ['default fallback', null, 'slack'],
    ['default instance', 'slack', 'slack'],
  ])('%s', async (_name, stored, expected) => {
    const row = await seedPending({ instance: stored });
    await editExpiredGatewayApprovalCard(row, 'no response');
    expect(delivered[0]).toEqual({ platformId: 'D-B-admin-1', instance: expected });
  });

  it('round-trips the posting instance through persistence', async () => {
    await seedPending({ instance: 'slack-mickey' });
    const persisted = await getPendingApproval('ga-test0001');
    await editExpiredGatewayApprovalCard(persisted!, 'host restarted');
    expect(delivered[0].instance).toBe('slack-mickey');
  });
});
