/**
 * Echo backlog pruner tests: keep-newest logic, age cutoff, and
 * non-echo/non-pending rows staying untouched.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { wrapSqliteInbound } from '../../mailbox/sqlite/index.js';
import { ECHO_BACKLOG_CAP, ECHO_CHANNEL_TYPE, ECHO_MAX_AGE_DAYS } from './config.js';
import { pruneEchoBacklog } from './prune.js';

const NOW = Date.parse('2026-08-01T12:00:00.000Z');

let db: Database.Database;

function insertRow(opts: { id: string; seq: number; channelType?: string; status?: string; ageMs?: number }): void {
  db.prepare(
    `INSERT INTO messages_in (id, seq, kind, timestamp, status, channel_type, content, trigger)
     VALUES (?, ?, 'chat', ?, ?, ?, '{"text":"x"}', 0)`,
  ).run(
    opts.id,
    opts.seq,
    new Date(NOW - (opts.ageMs ?? 0)).toISOString(),
    opts.status ?? 'pending',
    opts.channelType ?? ECHO_CHANNEL_TYPE,
  );
}

function remainingIds(): string[] {
  return (db.prepare('SELECT id FROM messages_in ORDER BY seq').all() as Array<{ id: string }>).map((r) => r.id);
}

beforeEach(() => {
  db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
});

afterEach(() => {
  db.close();
});

describe('pruneEchoBacklog', () => {
  it('keeps only the newest CAP pending echo rows', () => {
    const total = ECHO_BACKLOG_CAP + 5;
    for (let i = 0; i < total; i++) insertRow({ id: `e-${i}`, seq: i * 2 + 2 });

    const pruned = pruneEchoBacklog(wrapSqliteInbound(db), { now: NOW });
    expect(pruned).toBe(5);

    const ids = remainingIds();
    expect(ids).toHaveLength(ECHO_BACKLOG_CAP);
    // The oldest (lowest-seq) rows are the ones dropped.
    expect(ids[0]).toBe('e-5');
    expect(ids[ids.length - 1]).toBe(`e-${total - 1}`);
  });

  it('drops pending echo rows older than the TTL even under the count cap', () => {
    insertRow({ id: 'old', seq: 2, ageMs: (ECHO_MAX_AGE_DAYS * 24 + 1) * 60 * 60 * 1000 });
    insertRow({ id: 'fresh', seq: 4, ageMs: 60_000 });

    expect(pruneEchoBacklog(wrapSqliteInbound(db), { now: NOW })).toBe(1);
    expect(remainingIds()).toEqual(['fresh']);
  });

  it('never touches non-echo rows or already-processed echo rows', () => {
    // A real chat row and a task row far older than the TTL.
    insertRow({ id: 'chat', seq: 2, channelType: 'slack', ageMs: 30 * 24 * 60 * 60 * 1000 });
    insertRow({ id: 'done-echo', seq: 4, status: 'completed', ageMs: 30 * 24 * 60 * 60 * 1000 });
    // Overflow of pending echoes to prove the delete fires while sparing the above.
    for (let i = 0; i < ECHO_BACKLOG_CAP + 1; i++) insertRow({ id: `e-${i}`, seq: 100 + i * 2 });

    expect(pruneEchoBacklog(wrapSqliteInbound(db), { now: NOW })).toBe(1);
    const ids = remainingIds();
    expect(ids).toContain('chat');
    expect(ids).toContain('done-echo');
    expect(ids).not.toContain('e-0');
  });

  it('returns 0 on an empty session', () => {
    expect(pruneEchoBacklog(wrapSqliteInbound(db), { now: NOW })).toBe(0);
  });
});
