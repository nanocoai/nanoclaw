/**
 * Tests for core per-session messages_in schema maintenance.
 *
 * Task-specific DB tests (insertTask, cancel/pause/resume, updateTask,
 * insertRecurrence) live in `src/modules/scheduling/db.test.ts` with the
 * rest of the scheduling module.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, it, expect, afterEach } from 'vitest';

import { getInboundSourceSessionId, migrateMessagesInTable } from './session-db.js';

const TEST_DIR = '/tmp/nanoclaw-session-db-test';
const DB_PATH = path.join(TEST_DIR, 'inbound.db');

afterEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('migrateMessagesInTable', () => {
  it('backfills series_id = id on legacy rows and is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    // Build a legacy inbound.db WITHOUT series_id to simulate a pre-fix install.
    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'task', datetime('now'), 'pending', '{}')",
    ).run('legacy-1', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const row = db.prepare('SELECT series_id FROM messages_in WHERE id = ?').get('legacy-1') as {
      series_id: string;
    };
    expect(row.series_id).toBe('legacy-1');
    db.close();
  });

  it('adds source_session_id on a legacy DB, leaves existing rows NULL, is idempotent', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        tries          INTEGER DEFAULT 0,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      "INSERT INTO messages_in (id, seq, kind, timestamp, status, content) VALUES (?, ?, 'chat', datetime('now'), 'pending', '{}')",
    ).run('legacy-2', 2);

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const cols = (db.prepare("PRAGMA table_info('messages_in')").all() as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toContain('source_session_id');

    expect(getInboundSourceSessionId(db, 'legacy-2')).toBeNull();
    expect(getInboundSourceSessionId(db, 'does-not-exist')).toBeNull();
    db.close();
  });

  it('adds platform_message_id and only backfills routed Discord rows', () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = new Database(DB_PATH);
    db.exec(`
      CREATE TABLE messages_in (
        id             TEXT PRIMARY KEY,
        seq            INTEGER UNIQUE,
        kind           TEXT NOT NULL,
        timestamp      TEXT NOT NULL,
        status         TEXT DEFAULT 'pending',
        process_after  TEXT,
        recurrence     TEXT,
        series_id      TEXT,
        tries          INTEGER DEFAULT 0,
        trigger        INTEGER NOT NULL DEFAULT 1,
        platform_id    TEXT,
        channel_type   TEXT,
        thread_id      TEXT,
        content        TEXT NOT NULL
      );
    `);
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, '{}')`,
    ).run('111122223333444455:ag-discord-test-agent', 2, '987654321098765432', 'discord');
    db.prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, ?, 'chat', datetime('now'), 'pending', ?, ?, '{}')`,
    ).run('6037840640:42', 4, 'telegram-chat', 'telegram');

    migrateMessagesInTable(db);
    migrateMessagesInTable(db); // idempotent

    const rows = db.prepare('SELECT id, platform_message_id FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      platform_message_id: string | null;
    }>;
    expect(rows).toEqual([
      {
        id: '111122223333444455:ag-discord-test-agent',
        platform_message_id: '111122223333444455',
      },
      {
        id: '6037840640:42',
        platform_message_id: null,
      },
    ]);
    db.close();
  });
});
