/**
 * Echo backlog pruner tests: keep-newest logic, age cutoff,
 * non-echo/non-pending rows staying untouched, and copied files of pruned
 * rows being removed.
 */
import fs from 'fs';
import path from 'path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-prune' };
});

import { INBOUND_SCHEMA } from '../../mailbox/sqlite/schema.js';
import { wrapSqliteInbound } from '../../mailbox/sqlite/index.js';
import { ECHO_BACKLOG_CAP, ECHO_CHANNEL_TYPE, ECHO_MAX_AGE_DAYS } from './config.js';
import { sessionDir } from '../../session-manager.js';
import { pruneEchoBacklog } from './prune.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-prune';
const SESSION = { agentGroupId: 'ag-1', sessionId: 's-1' };

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
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  db = new Database(':memory:');
  db.exec(INBOUND_SCHEMA);
});

afterEach(() => {
  db.close();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('pruneEchoBacklog', () => {
  it('keeps only the newest CAP pending echo rows', () => {
    const total = ECHO_BACKLOG_CAP + 5;
    for (let i = 0; i < total; i++) insertRow({ id: `e-${i}`, seq: i * 2 + 2 });

    const pruned = pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW });
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

    expect(pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW })).toBe(1);
    expect(remainingIds()).toEqual(['fresh']);
  });

  it('never touches non-echo rows or already-processed echo rows', () => {
    // A real chat row and a task row far older than the TTL.
    insertRow({ id: 'chat', seq: 2, channelType: 'slack', ageMs: 30 * 24 * 60 * 60 * 1000 });
    insertRow({ id: 'done-echo', seq: 4, status: 'completed', ageMs: 30 * 24 * 60 * 60 * 1000 });
    // Overflow of pending echoes to prove the delete fires while sparing the above.
    for (let i = 0; i < ECHO_BACKLOG_CAP + 1; i++) insertRow({ id: `e-${i}`, seq: 100 + i * 2 });

    expect(pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW })).toBe(1);
    const ids = remainingIds();
    expect(ids).toContain('chat');
    expect(ids).toContain('done-echo');
    expect(ids).not.toContain('e-0');
  });

  it('returns 0 on an empty session', () => {
    expect(pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW })).toBe(0);
  });

  describe('copied files', () => {
    const inbox = () => path.join(sessionDir(SESSION.agentGroupId, SESSION.sessionId), 'inbox');
    function stage(folder: string, file = 'photo.png'): string {
      fs.mkdirSync(path.join(inbox(), folder), { recursive: true });
      const filePath = path.join(inbox(), folder, file);
      fs.writeFileSync(filePath, 'png');
      return filePath;
    }
    const oldMs = (ECHO_MAX_AGE_DAYS * 24 + 1) * 60 * 60 * 1000;

    it('removes the inbox folder of each pruned row and keeps the rest', () => {
      insertRow({ id: 'm1:echo:s-1', seq: 2, ageMs: oldMs });
      insertRow({ id: 'm2:echo:s-1', seq: 4, ageMs: 60_000 });
      insertRow({ id: 'm3:echo:s-1', seq: 6, status: 'completed', ageMs: oldMs });
      stage('m1:echo:s-1');
      stage('m2:echo:s-1');
      stage('m3:echo:s-1');
      stage('own-message');

      expect(pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW })).toBe(1);

      expect(fs.readdirSync(inbox()).sort()).toEqual(['m2:echo:s-1', 'm3:echo:s-1', 'own-message']);
    });

    it('prunes rows that had no files without error', () => {
      insertRow({ id: 'm1:echo:s-1', seq: 2, ageMs: oldMs });
      expect(pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW })).toBe(1);
      expect(fs.existsSync(inbox())).toBe(false);
    });

    it('removes a symlink inside the folder without touching its target', () => {
      const outside = path.join(TEST_DIR, 'outside.txt');
      fs.mkdirSync(TEST_DIR, { recursive: true });
      fs.writeFileSync(outside, 'keep');
      insertRow({ id: 'm1:echo:s-1', seq: 2, ageMs: oldMs });
      stage('m1:echo:s-1');
      fs.symlinkSync(outside, path.join(inbox(), 'm1:echo:s-1', 'link'));

      pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW });

      expect(fs.existsSync(path.join(inbox(), 'm1:echo:s-1'))).toBe(false);
      expect(fs.readFileSync(outside, 'utf8')).toBe('keep');
    });

    it('does not follow a row folder swapped for a symlink', () => {
      const outsideDir = path.join(TEST_DIR, 'outside');
      fs.mkdirSync(outsideDir, { recursive: true });
      fs.writeFileSync(path.join(outsideDir, 'keep.txt'), 'keep');
      insertRow({ id: 'm1:echo:s-1', seq: 2, ageMs: oldMs });
      fs.mkdirSync(inbox(), { recursive: true });
      fs.symlinkSync(outsideDir, path.join(inbox(), 'm1:echo:s-1'));

      expect(pruneEchoBacklog(wrapSqliteInbound(db), { ...SESSION, now: NOW })).toBe(1);

      expect(fs.readFileSync(path.join(outsideDir, 'keep.txt'), 'utf8')).toBe('keep');
    });
  });
});
