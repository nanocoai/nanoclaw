import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initSqliteTestDb } from '../connection.js';
import type { DbDriver } from '../driver.js';
import { migration024 } from './024-backfill-wiring-destinations.js';
import { migrations, runMigrations } from './index.js';

/** When `agent-destinations` ran. Pinned so the cutoff is deterministic —
 *  the real stamp is the wall clock of whenever the suite happens to run. */
const BACKFILL_APPLIED = '2026-04-01T00:00:00.000Z';
/** After the cutoff, so wirings stamped with it are eligible for repair. */
const CREATED_AT = '2026-04-12T10:00:00.000Z';
/** Before the cutoff — `agent-destinations` already covered these. */
const BEFORE_BACKFILL = '2026-03-01T00:00:00.000Z';

/** The barrel minus the migration under test — every other migration, not
 *  only the ones ahead of it — so each case can seed the pre-repair state and
 *  then run it deliberately. The name is spelled out because it is a
 *  permanent applied identity: renaming it must fail here, not silently
 *  re-run the migration on installs that already have it. */
const before024 = migrations.filter((migration) => migration.name !== 'backfill-wiring-destinations');

let db: DbDriver;

async function seedAgent(id: string): Promise<void> {
  await db.run(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`, id, id, id, CREATED_AT);
}

async function seedMessagingGroup(id: string, name: string | null): Promise<void> {
  await db.run(
    `INSERT INTO messaging_groups (id, channel_type, instance, platform_id, name, is_group, created_at)
     VALUES (?, 'whatsapp', 'whatsapp', ?, ?, 1, ?)`,
    id,
    `chat-${id}`,
    name,
    CREATED_AT,
  );
}

/** Insert straight into the table: the helper that normally creates a wiring
 *  provisions the destination too, which is the exact state we must not have. */
async function seedWiringWithoutDestination(
  id: string,
  messagingGroupId: string,
  agentGroupId = 'agent-main',
  createdAt = CREATED_AT,
): Promise<void> {
  await db.run(
    `INSERT INTO messaging_group_agents (
       id, messaging_group_id, agent_group_id,
       engage_mode, sender_scope, session_mode, priority, created_at
     ) VALUES (?, ?, ?, 'mention', 'all', 'shared', 0, ?)`,
    id,
    messagingGroupId,
    agentGroupId,
    createdAt,
  );
}

async function addDestination(
  agentGroupId: string,
  localName: string,
  targetType: 'channel' | 'agent',
  targetId: string,
): Promise<void> {
  await db.run(
    `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
     VALUES (?, ?, ?, ?, ?)`,
    agentGroupId,
    localName,
    targetType,
    targetId,
    CREATED_AT,
  );
}

function destinations(): Promise<Array<Record<string, unknown>>> {
  return db.all(
    `SELECT agent_group_id, local_name, target_type, target_id, created_at
       FROM agent_destinations ORDER BY agent_group_id, local_name`,
  );
}

describe('migration 024 — backfill wiring destinations', () => {
  beforeEach(async () => {
    db = await initSqliteTestDb();
    await runMigrations(db, before024, { mode: 'migrate' });
    await db.run('UPDATE schema_version SET applied = ? WHERE name = ?', BACKFILL_APPLIED, 'agent-destinations');
    await seedAgent('agent-main');
  });

  afterEach(async () => {
    await closeDb();
  });

  it('gives a wiring that has no destination one named after its chat', async () => {
    await seedMessagingGroup('mg-family', 'Family Chat');
    await seedWiringWithoutDestination('wiring-family', 'mg-family');
    expect(await destinations()).toEqual([]);

    await migration024.up(db);

    expect(await destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'family-chat',
        target_type: 'channel',
        target_id: 'mg-family',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('leaves an existing destination alone, including a custom local name', async () => {
    await seedMessagingGroup('mg-wired', 'Family Chat');
    await seedWiringWithoutDestination('wiring-wired', 'mg-wired');
    await addDestination('agent-main', 'custom-name', 'channel', 'mg-wired');

    await migration024.up(db);

    expect(await destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'custom-name',
        target_type: 'channel',
        target_id: 'mg-wired',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('suffixes around a name already taken by an agent destination', async () => {
    await seedAgent('agent-peer');
    await seedMessagingGroup('mg-family', 'Family Chat');
    await seedWiringWithoutDestination('wiring-family', 'mg-family');
    await addDestination('agent-main', 'family-chat', 'agent', 'agent-peer');

    await migration024.up(db);

    expect(await destinations()).toEqual([
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
        target_id: 'mg-family',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('keeps each agent in its own namespace', async () => {
    await seedAgent('agent-other');
    await seedMessagingGroup('mg-shared', 'Family Chat');
    await seedWiringWithoutDestination('wiring-main', 'mg-shared', 'agent-main');
    await seedWiringWithoutDestination('wiring-other', 'mg-shared', 'agent-other');

    await migration024.up(db);

    expect(await destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'family-chat',
        target_type: 'channel',
        target_id: 'mg-shared',
        created_at: CREATED_AT,
      },
      {
        agent_group_id: 'agent-other',
        local_name: 'family-chat',
        target_type: 'channel',
        target_id: 'mg-shared',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('falls back to channel and id when the chat has no name', async () => {
    await seedMessagingGroup('mg-12345678-tail', null);
    await seedWiringWithoutDestination('wiring-unnamed', 'mg-12345678-tail');

    await migration024.up(db);

    expect(await destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'whatsapp-mg-12345',
        target_type: 'channel',
        target_id: 'mg-12345678-tail',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('names a chat whose title has no ascii left rather than skipping it', async () => {
    await seedMessagingGroup('mg-jp', 'ディストピアトーキョー');
    await seedWiringWithoutDestination('wiring-jp', 'mg-jp');

    await migration024.up(db);

    expect(await destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'unnamed',
        target_type: 'channel',
        target_id: 'mg-jp',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('leaves a wiring that predates the backfill alone, so a revoked destination stays revoked', async () => {
    await seedMessagingGroup('mg-revoked', 'Secret Ops');
    await seedWiringWithoutDestination('wiring-revoked', 'mg-revoked', 'agent-main', BEFORE_BACKFILL);

    await migration024.up(db);

    expect(await destinations()).toEqual([]);
  });

  it('repairs a post-backfill wiring while leaving a pre-backfill one revoked', async () => {
    await seedMessagingGroup('mg-revoked', 'Secret Ops');
    await seedMessagingGroup('mg-gap', 'Family Chat');
    await seedWiringWithoutDestination('wiring-revoked', 'mg-revoked', 'agent-main', BEFORE_BACKFILL);
    await seedWiringWithoutDestination('wiring-gap', 'mg-gap', 'agent-main', CREATED_AT);

    await migration024.up(db);

    expect(await destinations()).toEqual([
      {
        agent_group_id: 'agent-main',
        local_name: 'family-chat',
        target_type: 'channel',
        target_id: 'mg-gap',
        created_at: CREATED_AT,
      },
    ]);
  });

  it('does nothing when the backfill was never stamped', async () => {
    await db.run('DELETE FROM schema_version WHERE name = ?', 'agent-destinations');
    await seedMessagingGroup('mg-family', 'Family Chat');
    await seedWiringWithoutDestination('wiring-family', 'mg-family');

    await migration024.up(db);

    expect(await destinations()).toEqual([]);
  });

  it('changes nothing when run again', async () => {
    await seedMessagingGroup('mg-family', 'Family Chat');
    await seedWiringWithoutDestination('wiring-family', 'mg-family');

    await migration024.up(db);
    const afterFirst = await destinations();
    await migration024.up(db);

    expect(await destinations()).toEqual(afterFirst);
  });

  it('dates each destination from its own wiring', async () => {
    const later = '2026-07-04T11:14:18.092Z';
    await seedMessagingGroup('mg-early', 'Early Chat');
    await seedMessagingGroup('mg-late', 'Late Chat');
    await seedWiringWithoutDestination('wiring-early', 'mg-early', 'agent-main', CREATED_AT);
    await seedWiringWithoutDestination('wiring-late', 'mg-late', 'agent-main', later);

    await migration024.up(db);

    const rows = await destinations();
    expect(rows.map((row) => [row.local_name, row.created_at])).toEqual([
      ['early-chat', CREATED_AT],
      ['late-chat', later],
    ]);
  });
});
