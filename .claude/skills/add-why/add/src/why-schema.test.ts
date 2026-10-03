/**
 * Drift guard for scripts/why.ts.
 *
 * `why` reads the session schemas directly rather than going through the db
 * layer, because it has to join across the inbound/outbound boundary that the
 * single-writer design deliberately keeps separate. That makes it vulnerable to
 * a column rename in a way a normal consumer is not.
 *
 * These tests build real tables from the exported schema constants and assert
 * every column `why` selects still exists. Rename `delivered.status` or drop
 * `container_state.current_tool` and this goes red in CI instead of the tool
 * printing a confusing verdict to an operator mid-incident.
 */

import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './db/schema.js';

function columnsOf(schema: string, table: string): Set<string> {
  const db = new Database(':memory:');
  db.exec(schema);
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
  db.close();
  expect(rows.length, `table ${table} does not exist in the schema`).toBeGreaterThan(0);
  return new Set(rows.map((r) => r.name));
}

describe('why: columns it reads still exist', () => {
  it('messages_out keeps the fields why reports on', () => {
    const cols = columnsOf(OUTBOUND_SCHEMA, 'messages_out');
    for (const c of ['id', 'seq', 'timestamp', 'deliver_after', 'kind',
                     'channel_type', 'platform_id', 'thread_id', 'content']) {
      expect(cols, `messages_out.${c} is read by scripts/why.ts`).toContain(c);
    }
  });

  it('delivered keeps the outcome fields — this is the whole verdict', () => {
    const cols = columnsOf(INBOUND_SCHEMA, 'delivered');
    for (const c of ['message_out_id', 'platform_message_id', 'status', 'delivered_at']) {
      expect(cols, `delivered.${c} is read by scripts/why.ts`).toContain(c);
    }
  });

  it('messages_in and processing_ack keep the inbound-side fields', () => {
    const inbound = columnsOf(INBOUND_SCHEMA, 'messages_in');
    for (const c of ['id', 'status', 'timestamp', 'tries', 'content']) {
      expect(inbound, `messages_in.${c} is read by scripts/why.ts`).toContain(c);
    }
    const ack = columnsOf(OUTBOUND_SCHEMA, 'processing_ack');
    for (const c of ['message_id', 'status', 'status_changed']) {
      expect(ack, `processing_ack.${c} is read by scripts/why.ts`).toContain(c);
    }
  });

  it('container_state keeps the in-flight tool fields', () => {
    const cols = columnsOf(OUTBOUND_SCHEMA, 'container_state');
    for (const c of ['current_tool', 'tool_started_at']) {
      expect(cols, `container_state.${c} is read by scripts/why.ts`).toContain(c);
    }
  });
});

describe('why: the join it depends on', () => {
  it('messages_out and delivered live in different databases', () => {
    // Not a style preference — it is why this tool exists. If these ever land in
    // one file, why.ts should be simplified to a single SQL join, and this test
    // is the reminder.
    expect(OUTBOUND_SCHEMA).toContain('messages_out');
    expect(INBOUND_SCHEMA).toContain('delivered');
    expect(OUTBOUND_SCHEMA).not.toContain('CREATE TABLE IF NOT EXISTS delivered');
    expect(INBOUND_SCHEMA).not.toContain('CREATE TABLE IF NOT EXISTS messages_out');
  });

  it('delivered is keyed by the outbound message id', () => {
    const db = new Database(':memory:');
    db.exec(INBOUND_SCHEMA);
    db.prepare(
      `INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at)
       VALUES (?, ?, ?, ?)`,
    ).run('m1', 'p1', 'delivered', new Date().toISOString());
    const row = db.prepare('SELECT * FROM delivered WHERE message_out_id = ?').get('m1') as
      { status: string } | undefined;
    expect(row?.status).toBe('delivered');
    db.close();
  });
});
