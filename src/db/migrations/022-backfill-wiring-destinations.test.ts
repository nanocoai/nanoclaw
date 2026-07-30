import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { AgentDestination } from '../../types.js';
import { createAgentGroup } from '../agent-groups.js';
import { closeDb, getDb, initTestDb } from '../connection.js';
import { createMessagingGroup } from '../messaging-groups.js';
import { migration022 } from './022-backfill-wiring-destinations.js';
import { migrations, runMigrations } from './index.js';

const CREATED_AT = '2026-04-12T10:00:00.000Z';
const legacyMigrations = migrations.filter((migration) => migration.name !== migration022.name);

function seedAgent(id: string): void {
  createAgentGroup({
    id,
    name: id,
    folder: id,
    agent_provider: null,
    created_at: CREATED_AT,
  });
}

function seedMessagingGroup(id: string, name: string | null): void {
  createMessagingGroup({
    id,
    channel_type: 'whatsapp',
    platform_id: `chat-${id}`,
    name,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: CREATED_AT,
  });
}

function seedLegacyWiring(id: string, messagingGroupId: string, agentGroupId = 'agent-main'): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id,
         engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, created_at
       )
       VALUES (?, ?, ?, 'pattern', '.', 'all', 'drop', 'shared', 0, ?)`,
    )
    .run(id, messagingGroupId, agentGroupId, CREATED_AT);
}

function destinations(): AgentDestination[] {
  return getDb()
    .prepare(
      `SELECT agent_group_id, local_name, target_type, target_id, created_at
       FROM agent_destinations
       ORDER BY local_name`,
    )
    .all() as AgentDestination[];
}

describe('migration 022 — backfill wiring destinations', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db, legacyMigrations);
    seedAgent('agent-main');
  });

  afterEach(() => {
    closeDb();
  });

  it('backfills a destination for a wiring created after migration 004 ran', () => {
    seedMessagingGroup('mg-family', 'Family Chat');
    seedLegacyWiring('wiring-family', 'mg-family');
    expect(destinations()).toEqual([]);

    runMigrations(getDb());

    expect(destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'family-chat',
        target_type: 'channel',
        target_id: 'mg-family',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('preserves existing targets and avoids local-name collisions', () => {
    seedAgent('agent-peer');
    seedMessagingGroup('mg-existing', 'Family Chat');
    seedMessagingGroup('mg-missing', 'Family Chat');
    seedLegacyWiring('wiring-existing', 'mg-existing');
    seedLegacyWiring('wiring-missing', 'mg-missing');

    const db = getDb();
    const insert = db.prepare(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    insert.run('agent-main', 'custom-chat', 'channel', 'mg-existing', CREATED_AT);
    insert.run('agent-main', 'family-chat', 'agent', 'agent-peer', CREATED_AT);

    runMigrations(db);
    migration022.up(db);

    expect(destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'custom-chat',
        target_type: 'channel',
        target_id: 'mg-existing',
        created_at: CREATED_AT,
      },
      {
        agent_group_id: 'agent-main',
        local_name: 'family-chat',
        target_type: 'agent',
        target_id: 'agent-peer',
        created_at: CREATED_AT,
      },
      {
        agent_group_id: 'agent-main',
        local_name: 'family-chat-2',
        target_type: 'channel',
        target_id: 'mg-missing',
        created_at: CREATED_AT,
      },
    ]);
  });
});
