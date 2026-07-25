/**
 * Tests for migration 020 — normalize-whatsapp-handles.
 *
 * Verifies that:
 *   - JID-form user rows are renamed to canonical bare-digit form.
 *   - All FK child rows in user_roles, agent_group_members, and user_dms
 *     are re-pointed to the new canonical id.
 *   - If a canonical row already exists (Cloud path arrived first), the JID
 *     row is merged into it (roles + membership are unioned) and the JID row
 *     is deleted.
 *   - Non-WhatsApp users and already-canonical WhatsApp users are untouched.
 */
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import type Database from 'better-sqlite3';

import { migration020 } from './020-normalize-whatsapp-handles.js';
import { migrations, runMigrations } from './index.js';
import { closeDb, initTestDb } from '../../db/index.js';

function now(): string {
  return new Date().toISOString();
}

/**
 * Run all baseline migrations (everything except 020) on the in-memory DB
 * so the schema is fully in place before we seed stale data.
 */
function applyBaseline(db: Database.Database): void {
  const baseline = migrations.filter((m) => m.name !== migration020.name);
  runMigrations(db, baseline);
}

let db: Database.Database;

beforeEach(() => {
  db = initTestDb();
  applyBaseline(db);
});

afterEach(() => {
  closeDb();
});

describe('migration 020 — normalize-whatsapp-handles', () => {
  it('renames a JID-form user id to bare-digit form and carries roles', () => {
    // Seed a WhatsApp user stored in stale JID form.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('whatsapp:15551234567@s.whatsapp.net', 'whatsapp', 'Alice', now());

    // Grant owner role on the JID-form user.
    db.prepare(
      `INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, NULL, ?)`,
    ).run('whatsapp:15551234567@s.whatsapp.net', now());

    // Run migration 020.
    runMigrations(db, [migration020]);

    // Old row must be gone.
    const oldRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get('whatsapp:15551234567@s.whatsapp.net');
    expect(oldRow).toBeUndefined();

    // Canonical row must exist.
    const newRow = db.prepare(`SELECT * FROM users WHERE id = ?`).get('whatsapp:15551234567') as
      | { display_name: string }
      | undefined;
    expect(newRow).toBeDefined();
    expect(newRow?.display_name).toBe('Alice');

    // Role must be re-pointed.
    const role = db
      .prepare(`SELECT * FROM user_roles WHERE user_id = ?`)
      .get('whatsapp:15551234567') as { role: string } | undefined;
    expect(role?.role).toBe('owner');

    // No orphaned role on the old id.
    const orphan = db.prepare(`SELECT * FROM user_roles WHERE user_id = ?`).get('whatsapp:15551234567@s.whatsapp.net');
    expect(orphan).toBeUndefined();
  });

  it('strips the :device suffix from a multi-device JID', () => {
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('whatsapp:15551234567:12@s.whatsapp.net', 'whatsapp', 'Bob', now());

    runMigrations(db, [migration020]);

    expect(db.prepare(`SELECT id FROM users WHERE id = ?`).get('whatsapp:15551234567:12@s.whatsapp.net')).toBeUndefined();
    const canonical = db.prepare(`SELECT id FROM users WHERE id = ?`).get('whatsapp:15551234567') as
      | { id: string }
      | undefined;
    expect(canonical?.id).toBe('whatsapp:15551234567');
  });

  it('merges into an existing canonical row when Cloud path already created it', () => {
    // Canonical row already exists (Cloud path arrived first).
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('whatsapp:15551234567', 'whatsapp', 'Carol (Cloud)', now());

    // Agent group for membership.
    db.prepare(`INSERT INTO agent_groups (id, name, folder, agent_provider, created_at) VALUES (?, ?, ?, NULL, ?)`)
      .run('ag-1', 'AG1', 'ag1', now());

    // Stale JID row with membership in ag-1.
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('whatsapp:15551234567@s.whatsapp.net', 'whatsapp', 'Carol (Baileys)', now());
    db.prepare(
      `INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)`,
    ).run('whatsapp:15551234567@s.whatsapp.net', 'ag-1', now());

    runMigrations(db, [migration020]);

    // Stale JID row gone.
    expect(db.prepare(`SELECT id FROM users WHERE id = ?`).get('whatsapp:15551234567@s.whatsapp.net')).toBeUndefined();

    // Canonical row survives.
    expect(db.prepare(`SELECT id FROM users WHERE id = ?`).get('whatsapp:15551234567')).toBeDefined();

    // Membership re-pointed to canonical id.
    const member = db
      .prepare(`SELECT user_id FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?`)
      .get('whatsapp:15551234567', 'ag-1') as { user_id: string } | undefined;
    expect(member?.user_id).toBe('whatsapp:15551234567');

    // No orphan on the stale id.
    expect(
      db.prepare(`SELECT 1 FROM agent_group_members WHERE user_id = ?`).get('whatsapp:15551234567@s.whatsapp.net'),
    ).toBeUndefined();
  });

  it('does not touch non-WhatsApp users', () => {
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('telegram:123456789', 'telegram', 'Dave', now());

    runMigrations(db, [migration020]);

    // Telegram user must be completely untouched.
    const row = db.prepare(`SELECT id FROM users WHERE id = ?`).get('telegram:123456789') as
      | { id: string }
      | undefined;
    expect(row?.id).toBe('telegram:123456789');
  });

  it('is a no-op when run a second time (idempotent)', () => {
    db.prepare(`INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)`)
      .run('whatsapp:15551234567@s.whatsapp.net', 'whatsapp', 'Eve', now());

    // First run.
    runMigrations(db, [migration020]);
    // Second run — migration is already in schema_version, so it's skipped.
    runMigrations(db, [migration020]);

    // Exactly one canonical WhatsApp row.
    const rows = db.prepare(`SELECT id FROM users WHERE id LIKE 'whatsapp:%'`).all() as { id: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('whatsapp:15551234567');
  });
});
