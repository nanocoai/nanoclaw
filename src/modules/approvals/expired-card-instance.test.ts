/**
 * Expired-card edits address the bot instance that posted the card.
 *
 * Delivery dispatch is exact-key (`getChannelAdapterExact(instance ??
 * channelType)`), so an install whose Slack bots are all NAMED instances has
 * nothing registered under the bare `slack` key. An edit sent with no
 * instance resolves no adapter at all — the card is never marked expired and
 * keeps showing live buttons after its row is deleted.
 *
 * `pending_approvals.instance` (migration `approvals-instance`) carries the
 * identity the card went out as; these cover the round trip and the NULL
 * fallback.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval, getPendingApproval } from '../../db/sessions.js';
import type { ChannelDeliveryAdapter } from '../../delivery.js';
import type { PendingApproval } from '../../types.js';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-expired-card-instance' };
});

// The module builds a OneCLI client at import time; the sweep/expiry path
// under test never touches it.
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    configureManualApproval() {
      return { stop() {} };
    }
  },
}));

const { editCardExpired, startOneCLIApprovalHandler, stopOneCLIApprovalHandler, ONECLI_ACTION } =
  await import('./onecli-approvals.js');

const TEST_DIR = '/tmp/nanoclaw-test-expired-card-instance';

function now(): string {
  return new Date().toISOString();
}

interface DeliveredEdit {
  channelType: string;
  platformId: string;
  instance: string | undefined;
}

const delivered: DeliveredEdit[] = [];

const captureAdapter: ChannelDeliveryAdapter = {
  async deliver(channelType, platformId, _threadId, _kind, _content, _files, instance) {
    delivered.push({ channelType, platformId, instance });
    return 'pm-edited';
  },
};

async function seedPending(overrides: Partial<PendingApproval> = {}): Promise<PendingApproval> {
  const row: PendingApproval = {
    approval_id: 'oa-test0001',
    session_id: null,
    request_id: 'req-1',
    action: ONECLI_ACTION,
    payload: JSON.stringify({ approver: 'slack:admin-1' }),
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
  vi.clearAllMocks();
  delivered.length = 0;
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);

  await createAgentGroup({ id: 'ag-b', name: 'Agent B', folder: 'agent-b', agent_provider: null, created_at: now() });

  startOneCLIApprovalHandler(captureAdapter);
});

afterEach(async () => {
  stopOneCLIApprovalHandler();
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('expired OneCLI card edits carry the posting instance', () => {
  it('addresses the named instance the card went out as', async () => {
    const row = await seedPending();

    await editCardExpired(row, 'no response');

    expect(delivered).toHaveLength(1);
    expect(delivered[0].instance).toBe('slack-b');
    expect(delivered[0].platformId).toBe('D-B-admin-1');
  });

  it('round-trips the instance through the row — a swept card resolves the same identity', async () => {
    await seedPending({ instance: 'slack-mickey' });

    // What sweepStaleApprovals does: re-read the persisted row, then edit.
    const persisted = await getPendingApproval('oa-test0001');
    expect(persisted?.instance).toBe('slack-mickey');
    await editCardExpired(persisted!, 'host restarted');

    expect(delivered[0].instance).toBe('slack-mickey');
  });

  it('a NULL instance falls back to the channel type', async () => {
    const row = await seedPending({ instance: null });

    await editCardExpired(row, 'no response');

    expect(delivered[0].instance).toBe('slack');
  });

  it('a default-instance install is unchanged — the edit still addresses the default key', async () => {
    const row = await seedPending({ instance: 'slack', platform_id: 'D-DEFAULT-admin-1' });

    await editCardExpired(row, 'no response');

    expect(delivered[0].instance).toBe('slack');
    expect(delivered[0].platformId).toBe('D-DEFAULT-admin-1');
  });
});
