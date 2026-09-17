import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../../db/index.js';
import { createAgentGroup } from '../../../db/agent-groups.js';
import { createMessagingGroup } from '../../../db/messaging-groups.js';
import { getDb } from '../../../db/connection.js';
import { createDestination, sweepDanglingDestinations } from './agent-destinations.js';

// DATA_DIR mock mirrors destinations.test.ts — the config module resolves
// DATA_DIR at import time.
function now(): string {
  return new Date().toISOString();
}

function dest(agentGroupId: string, localName: string, targetType: 'channel' | 'agent', targetId: string) {
  return {
    agent_group_id: agentGroupId,
    local_name: localName,
    target_type: targetType,
    target_id: targetId,
    created_at: now(),
  };
}

describe('sweepDanglingDestinations', () => {
  beforeEach(async () => {
    fs.rmSync('/tmp/nanoclaw-test-orphan-sweep', { recursive: true, force: true });
    await initTestDb();
    await runMigrations(getDb());
  });
  afterEach(() => {
    closeDb();
  });

  it('removes rows whose target no longer resolves and keeps the rest', async () => {
    await createAgentGroup({ id: 'ag-a', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: 'ag-b', name: 'B', folder: 'b', agent_provider: null, created_at: now() });
    await createMessagingGroup({
      id: 'mg-live',
      channel_type: 'telegram',
      platform_id: 'telegram:111',
      name: 'Live',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await createDestination(dest('ag-a', 'live-channel', 'channel', 'mg-live'));
    await createDestination(dest('ag-a', 'live-agent', 'agent', 'ag-b'));
    await createDestination(dest('ag-a', 'dead-channel', 'channel', 'mg-gone'));
    await createDestination(dest('ag-b', 'dead-agent', 'agent', 'ag-gone'));

    expect(await sweepDanglingDestinations()).toBe(2);

    const remaining = await getDb().all<{ local_name: string }>(
      'SELECT local_name FROM agent_destinations ORDER BY local_name',
    );
    expect(remaining.map((r) => r.local_name)).toEqual(['live-agent', 'live-channel']);
  });

  it('is idempotent', async () => {
    await createAgentGroup({ id: 'ag-a', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    await createDestination(dest('ag-a', 'dead-channel', 'channel', 'mg-gone'));

    expect(await sweepDanglingDestinations()).toBe(1);
    expect(await sweepDanglingDestinations()).toBe(0);
  });
});
