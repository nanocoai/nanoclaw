import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../connection.js';
import type { DbDriver } from '../driver.js';
import { sqliteRaw } from '../drivers/sqlite.js';
import { migrations, runMigrations } from './index.js';
import { migration022 } from './022-nanoco-gateway-approval-presentations.js';

let db: DbDriver;

beforeEach(async () => {
  db = await initTestDb();
});

afterEach(async () => closeDb());

describe('Gateway approval presentation migration', () => {
  it('is a no-op for a fresh protocol-v2 database', async () => {
    await runMigrations(db);

    expect(columns()).toContain('presentation_json');
    expect(columns()).not.toContain('summary_body_preview');
    expect(await applied()).toContain(migration022.name);
  });

  it('discards only stale v1 approval bridge state and preserves approver bindings', async () => {
    await runMigrations(
      db,
      migrations.filter((migration) => migration.name !== migration022.name),
    );
    await db.run(
      'INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)',
      'slack:approver-1',
      'slack',
      'Approver',
      new Date().toISOString(),
    );
    await db.run(
      `INSERT INTO nanoco_approver_bindings (issuer, subject, user_id, created_at)
       VALUES (?, ?, ?, ?)`,
      'https://idp.example.com',
      'subject-1',
      'slack:approver-1',
      new Date().toISOString(),
    );

    await db.exec(`
      DROP TABLE nanoco_gateway_approvals;
      CREATE TABLE nanoco_gateway_approvals (
        deployment_id        TEXT NOT NULL,
        summary_body_preview TEXT
      );
      INSERT INTO nanoco_gateway_approvals VALUES ('deployment-1', 'stale body');
      INSERT INTO nanoco_gateway_approval_cursors VALUES ('deployment-1', 'old-epoch', 9, '2026-08-04T00:00:00.000Z');
    `);

    await runMigrations(db, [migration022]);

    expect(columns()).toContain('presentation_json');
    expect(columns()).not.toContain('summary_body_preview');
    expect(await count('nanoco_gateway_approvals')).toBe(0);
    expect(await count('nanoco_gateway_approval_cursors')).toBe(0);
    expect(await count('nanoco_approver_bindings')).toBe(1);
    expect(await applied()).toContain(migration022.name);
  });
});

function columns(): string[] {
  return (sqliteRaw(db).prepare("PRAGMA table_info('nanoco_gateway_approvals')").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

async function count(table: string): Promise<number> {
  return (await db.get<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`))!.count;
}

async function applied(): Promise<string[]> {
  return (await db.all<{ name: string }>('SELECT name FROM schema_version')).map((row) => row.name);
}
