/**
 * Unit tests for whatsapp-cloud startup adoption (#2913 upgrade path).
 *
 * The adoption code targets the runtime schema on installs (trunk / main),
 * where migration 016 added the instance column and relaxed the messaging_groups
 * uniqueness to UNIQUE(channel_type, platform_id, instance). This channels-branch
 * core predates 016, so after runMigrations() the test recreates the table with
 * 016's exact DDL to reproduce the installed schema.
 *
 * getChannelRegistration is mocked so the Baileys guard is exercised without
 * importing the channel barrel (which pulls uninstalled @chat-adapter packages).
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, getDb, runMigrations } from '../db/index.js';

const registryState = vi.hoisted(() => ({ baileysRegistered: false }));

vi.mock('./channel-registry.js', () => ({
  getChannelRegistration: (name: string) =>
    name === 'whatsapp' && registryState.baileysRegistered ? { factory: () => null } : undefined,
}));

import { adoptStrandedWhatsAppCloudGroups } from './whatsapp-cloud-adoption.js';

/**
 * Recreate messaging_groups with migration 016's schema (instance column,
 * relaxed UNIQUE). Foreign keys are toggled off around the recreate because
 * five child tables reference messaging_groups(id).
 */
function addInstanceColumn(db: Database.Database): void {
  db.pragma('foreign_keys = OFF');
  db.exec(`
    CREATE TABLE messaging_groups_new (
      id                    TEXT PRIMARY KEY,
      channel_type          TEXT NOT NULL,
      platform_id           TEXT NOT NULL,
      instance              TEXT NOT NULL,
      name                  TEXT,
      is_group              INTEGER DEFAULT 0,
      unknown_sender_policy TEXT NOT NULL DEFAULT 'strict',
      created_at            TEXT NOT NULL,
      denied_at             TEXT,
      UNIQUE(channel_type, platform_id, instance)
    );
    INSERT INTO messaging_groups_new
      (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at, denied_at)
      SELECT id, channel_type, platform_id, channel_type, name, is_group, unknown_sender_policy, created_at, denied_at
        FROM messaging_groups;
    DROP TABLE messaging_groups;
    ALTER TABLE messaging_groups_new RENAME TO messaging_groups;
  `);
  db.pragma('foreign_keys = ON');
}

function seedAgentGroup(id = 'ag-1'): void {
  getDb()
    .prepare(`INSERT INTO agent_groups (id, name, folder, created_at) VALUES (?, ?, ?, ?)`)
    .run(id, id, `folder-${id}`, '2026-01-01T00:00:00.000Z');
}

function seedGroup(id: string, platformId: string, instance: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, 'whatsapp', ?, ?, ?, 0, 'request_approval', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, platformId, instance, id);
}

function seedWiring(mgId: string, agId: string): void {
  getDb()
    .prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, created_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(`mga-${mgId}`, mgId, agId);
}

function seedApproval(mgId: string, agId: string): void {
  getDb()
    .prepare(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', 'u-1', '2026-01-01T00:00:00.000Z')`,
    )
    .run(mgId, agId);
}

function seedUserDm(mgId: string, userId = 'user-1'): void {
  const db = getDb();
  db.prepare(`INSERT INTO users (id, kind, created_at) VALUES (?, 'human', '2026-01-01T00:00:00.000Z')`).run(userId);
  db.prepare(
    `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at)
     VALUES (?, 'whatsapp', ?, '2026-01-01T00:00:00.000Z')`,
  ).run(userId, mgId);
}

function instanceOf(id: string): string | undefined {
  return (getDb().prepare('SELECT instance FROM messaging_groups WHERE id = ?').get(id) as { instance: string } | undefined)
    ?.instance;
}

const CLOUD_PID = 'whatsapp:100000000000000:34600000000';

beforeEach(() => {
  registryState.baileysRegistered = false;
  initTestDb();
  runMigrations(getDb());
  addInstanceColumn(getDb());
  seedAgentGroup();
});

afterEach(() => {
  closeDb();
});

describe('adoptStrandedWhatsAppCloudGroups', () => {
  it('re-keys a stranded row and preserves its id', () => {
    seedGroup('orig', CLOUD_PID, 'whatsapp');

    adoptStrandedWhatsAppCloudGroups();

    expect(instanceOf('orig')).toBe('whatsapp-cloud');
  });

  it('deletes an unwired duplicate and its approval, then re-keys the original', () => {
    seedGroup('orig', CLOUD_PID, 'whatsapp');
    seedGroup('dup', CLOUD_PID, 'whatsapp-cloud');
    seedApproval('dup', 'ag-1');

    adoptStrandedWhatsAppCloudGroups();

    expect(instanceOf('dup')).toBeUndefined();
    expect(instanceOf('orig')).toBe('whatsapp-cloud');
    const approval = getDb().prepare('SELECT 1 FROM pending_channel_approvals WHERE messaging_group_id = ?').get('dup');
    expect(approval).toBeUndefined();
  });

  it('leaves both rows untouched when the duplicate is wired', () => {
    seedGroup('orig', CLOUD_PID, 'whatsapp');
    seedGroup('dup', CLOUD_PID, 'whatsapp-cloud');
    seedWiring('dup', 'ag-1');

    adoptStrandedWhatsAppCloudGroups();

    expect(instanceOf('orig')).toBe('whatsapp');
    expect(instanceOf('dup')).toBe('whatsapp-cloud');
  });

  it('skips adoption when a native whatsapp adapter is registered', () => {
    registryState.baileysRegistered = true;
    seedGroup('orig', CLOUD_PID, 'whatsapp');

    adoptStrandedWhatsAppCloudGroups();

    expect(instanceOf('orig')).toBe('whatsapp');
  });

  it('is a no-op on an empty database', () => {
    expect(() => adoptStrandedWhatsAppCloudGroups()).not.toThrow();
  });

  it('ignores native Baileys rows sharing the default instance (platform_id filter)', () => {
    seedGroup('baileys', '34600000000@s.whatsapp.net', 'whatsapp');

    adoptStrandedWhatsAppCloudGroups();

    expect(instanceOf('baileys')).toBe('whatsapp');
  });

  it('leaves both rows untouched when the duplicate has a user_dms row (zero agents)', () => {
    seedGroup('orig', CLOUD_PID, 'whatsapp');
    seedGroup('dup', CLOUD_PID, 'whatsapp-cloud');
    seedUserDm('dup');

    adoptStrandedWhatsAppCloudGroups();

    expect(instanceOf('orig')).toBe('whatsapp');
    expect(instanceOf('dup')).toBe('whatsapp-cloud');
    const dm = getDb().prepare('SELECT 1 FROM user_dms WHERE messaging_group_id = ?').get('dup');
    expect(dm).toBeDefined();
  });

  it('is a silent no-op on a pre-016 core with no instance column', () => {
    // Rebuild the schema from the branch-native migrations only (no migration
    // 016 recreate), so messaging_groups has no instance column.
    closeDb();
    initTestDb();
    runMigrations(getDb());

    expect(() => adoptStrandedWhatsAppCloudGroups()).not.toThrow();
  });
});
