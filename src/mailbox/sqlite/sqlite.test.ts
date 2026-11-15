import fs from 'fs';
import os from 'os';
import path from 'path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';

import { INBOUND_SCHEMA, OUTBOUND_SCHEMA } from './schema.js';
import { wrapSqliteInbound, wrapSqliteOutbound } from './index.js';
import { migrateMessagesInTable } from './session-db.js';

describe('SQLite mailbox canonical serialization', () => {
  const databases: Database.Database[] = [];

  afterEach(() => {
    for (const database of databases.splice(0)) database.close();
  });

  it('round-trips full lifecycle records through the SQLite adapter', async () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);
    let sequence = 0;
    const nextSequence = () => (sequence += 2);
    const inbound = wrapSqliteInbound(inboundDb, nextSequence);
    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      nextSequence,
    );

    await inbound.insertMessage({
      id: 'in-1',
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{"text":"hello"}',
      processAfter: '2026-01-01T00:00:01.000Z',
      recurrence: '0 * * * *',
      trigger: false,
      sourceSessionId: 'source-session',
      onWake: true,
    });
    expect(inboundDb.prepare('SELECT * FROM messages_in WHERE id = ?').get('in-1')).toMatchObject({
      id: 'in-1',
      seq: 2,
      kind: 'chat',
      timestamp: '2026-01-01T00:00:00.000Z',
      status: 'pending',
      process_after: '2026-01-01T00:00:01.000Z',
      recurrence: '0 * * * *',
      series_id: 'in-1',
      tries: 0,
      trigger: 0,
      platform_id: 'room',
      channel_type: 'test',
      thread_id: 'thread',
      content: '{"text":"hello"}',
      source_session_id: 'source-session',
      on_wake: 1,
    });

    await inbound.insertTask({
      id: 'task-1',
      seriesId: 'series-1',
      processAfter: '2999-01-01T00:00:00.000Z',
      recurrence: null,
      content: '{"prompt":"later"}',
      status: 'paused',
    });
    inboundDb
      .prepare('UPDATE messages_in SET timestamp = ?, process_after = ? WHERE id = ?')
      .run('2026-01-01 00:00:00', '2999-01-01 00:00:00', 'task-1');
    expect(inbound.getTask('task-1')).toMatchObject({
      id: 'task-1',
      seriesId: 'series-1',
      status: 'paused',
      processAfter: '2999-01-01T00:00:00.000Z',
      recurrence: null,
      content: '{"prompt":"later"}',
      timestamp: '2026-01-01T00:00:00.000Z',
      tries: 0,
      sequence: 4,
    });

    outboundDb
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('in-1', 'completed', '2026-01-01 00:00:00');
    expect(outbound.getTerminalProcessingAcks()).toEqual([
      {
        messageId: 'in-1',
        status: 'completed',
        statusChanged: '2026-01-01T00:00:00.000Z',
      },
    ]);

    outboundDb
      .prepare(
        `INSERT INTO container_state
           (id, current_tool, tool_declared_timeout_ms, tool_started_at, updated_at)
         VALUES (1, ?, ?, ?, ?)`,
      )
      .run('Bash', 30_000, '2026-01-01 00:00:00', '2026-01-01 00:00:01');
    expect(outbound.getContainerState()).toEqual({
      currentTool: 'Bash',
      toolDeclaredTimeoutMs: 30_000,
      toolStartedAt: '2026-01-01T00:00:00.000Z',
    });

    await outbound.writeDirect({
      id: 'out-1',
      kind: 'chat',
      platformId: 'room',
      channelType: 'test',
      threadId: 'thread',
      content: '{"text":"reply"}',
    });
    expect(outbound.getDueMessages()).toEqual([
      {
        id: 'out-1',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
        inReplyTo: null,
      },
    ]);
  });

  it('reports wake evidence: none, then chatter, then woken; echoes, agent rows and silent replies do not count', () => {
    const inboundDb = new Database(':memory:');
    databases.push(inboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    const insert = inboundDb.prepare(
      `INSERT INTO messages_in (id, seq, timestamp, kind, channel_type, content, trigger)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', ?, ?, '{}', ?)`,
    );
    const inbound = wrapSqliteInbound(inboundDb);

    expect(inbound.wakeEvidence()).toBe('none');
    insert.run('echo', 2, 'chat', 'session-echo', 1);
    insert.run('cli-reply', 3, 'system', null, 0);
    insert.run('member-note', 7, 'chat', 'agent', 0);
    expect(inbound.wakeEvidence()).toBe('none');

    insert.run('ambient', 4, 'chat', 'slack', 0);
    expect(inbound.wakeEvidence()).toBe('chatter');
    insert.run('a2a', 5, 'chat', 'agent', 1);
    expect(inbound.wakeEvidence()).toBe('chatter');

    insert.run('answer', 6, 'system', null, 1);
    expect(inbound.wakeEvidence()).toBe('woken');

    // A silent chat row with no channel is chatter too, as for the wake probe.
    const bare = new Database(':memory:');
    databases.push(bare);
    bare.exec(INBOUND_SCHEMA);
    bare
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, kind, channel_type, content, trigger)
         VALUES ('bare', 1, '2026-01-01T00:00:00.000Z', 'chat', NULL, '{}', 0)`,
      )
      .run();
    expect(wrapSqliteInbound(bare).wakeEvidence()).toBe('chatter');
  });

  it('answers the wake check and the conversation root from an index, also on inboxes made before it', () => {
    const legacy = new Database(':memory:');
    databases.push(legacy);
    legacy.exec(INBOUND_SCHEMA.replace(/^CREATE INDEX IF NOT EXISTS idx_messages_in_trigger_seq .*$/m, ''));
    expect(
      legacy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'idx_messages_in_trigger_seq'").get(),
    ).toBeUndefined();
    migrateMessagesInTable(legacy);

    const channelRow = "(channel_type IS NULL OR channel_type NOT IN ('session-echo', 'agent'))";
    for (const sql of [
      `SELECT 1 FROM messages_in WHERE trigger = 1 AND ${channelRow} LIMIT 1`,
      `SELECT 1 FROM messages_in WHERE trigger = 0 AND kind IN ('chat', 'chat-sdk') AND ${channelRow} LIMIT 1`,
      `SELECT timestamp, content FROM messages_in WHERE kind IN ('chat','chat-sdk') AND trigger = 1 AND ${channelRow}
       ORDER BY seq ASC LIMIT 1`,
    ]) {
      const plan = (legacy.prepare(`EXPLAIN QUERY PLAN ${sql}`).all() as Array<{ detail: string }>)
        .map((row) => row.detail)
        .join('\n');
      expect(plan).toContain('idx_messages_in_trigger_seq');
      expect(plan).not.toContain('TEMP B-TREE');
    }
  });

  it('scopes ack and due-outbound reads to open work (history is never re-read)', () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);
    let sequence = 0;
    const nextSequence = () => (sequence += 2);
    const inbound = wrapSqliteInbound(inboundDb, nextSequence);
    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      nextSequence,
    );

    const insertIn = inboundDb.prepare(
      "INSERT INTO messages_in (id, seq, timestamp, kind, status, content) VALUES (?, ?, '2026-01-01 00:00:00', 'chat', ?, '{}')",
    );
    insertIn.run('done', 2, 'completed');
    insertIn.run('failed', 4, 'failed');
    insertIn.run('open', 6, 'processing');
    insertIn.run('waiting', 8, 'pending');
    expect(inbound.getUnsettledMessageIds().sort()).toEqual(['open', 'waiting']);

    const ack = outboundDb.prepare(
      "INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, '2026-01-01 00:00:00')",
    );
    ack.run('done', 'completed');
    ack.run('open', 'completed');
    ack.run('waiting', 'processing');
    expect(outbound.getTerminalProcessingAcks(inbound.getUnsettledMessageIds()).map((a) => a.messageId)).toEqual([
      'open',
    ]);
    expect(outbound.getTerminalProcessingAcks([])).toEqual([]);
    expect(
      outbound
        .getTerminalProcessingAcks()
        .map((a) => a.messageId)
        .sort(),
    ).toEqual(['done', 'open']);

    const insertOut = outboundDb.prepare(
      "INSERT INTO messages_out (id, seq, timestamp, kind, content) VALUES (?, ?, ?, 'chat', '{}')",
    );
    insertOut.run('sent', 1, '2026-01-01 00:00:00');
    insertOut.run('b', 5, '2026-01-01 00:00:02');
    insertOut.run('a', 3, '2026-01-01 00:00:01');
    expect(outbound.getDueMessages(new Set(['sent'])).map((m) => m.id)).toEqual(['a', 'b']);
    expect(outbound.getDueMessages(new Set(['sent', 'a', 'b']))).toEqual([]);
  });

  it('delivered watermark never skips a row that was not yet due or not yet delivered', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mbx-wm-'));
    const outboundDb = new Database(path.join(dir, 'outbound.db'));
    databases.push(outboundDb);
    outboundDb.exec(OUTBOUND_SCHEMA);
    const outbound = wrapSqliteOutbound(
      () => outboundDb,
      () => outboundDb,
      () => 0,
    );
    const insert = outboundDb.prepare(
      "INSERT INTO messages_out (id, seq, timestamp, deliver_after, kind, content) VALUES (?, ?, ?, ?, 'chat', '{}')",
    );
    insert.run('d1', 1, '2026-01-01 00:00:01', null);
    insert.run('later', 3, '2026-01-01 00:00:02', '2999-01-01 00:00:00');
    insert.run('d2', 5, '2026-01-01 00:00:03', null);
    insert.run('open', 7, '2026-01-01 00:00:04', null);

    const delivered = new Set(['d1', 'd2']);
    expect(outbound.getDueMessages(delivered).map((m) => m.id)).toEqual(['open']);
    delivered.add('open');
    expect(outbound.getDueMessages(delivered)).toEqual([]);

    outboundDb.prepare("UPDATE messages_out SET deliver_after = NULL WHERE id = 'later'").run();
    insert.run('new', 9, '2026-01-01 00:00:05', null);
    expect(outbound.getDueMessages(delivered).map((m) => m.id)).toEqual(['later', 'new']);
    delivered.add('later').add('new');
    expect(outbound.getDueMessages(delivered)).toEqual([]);
    insert.run('newest', 11, '2026-01-01 00:00:06', null);
    expect(outbound.getDueMessages(delivered).map((m) => m.id)).toEqual(['newest']);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns only the conversation root and top-level outbound timeline', () => {
    const inboundDb = new Database(':memory:');
    const outboundDb = new Database(':memory:');
    databases.push(inboundDb, outboundDb);
    inboundDb.exec(INBOUND_SCHEMA);
    outboundDb.exec(OUTBOUND_SCHEMA);
    inboundDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, kind, channel_type, content, trigger)
         VALUES (?, ?, ?, 'chat', ?, ?, 1)`,
      )
      .run('echo', 2, '2026-01-01T00:00:00.000Z', 'session-echo', '{"text":"ambient"}');
    inboundDb
      .prepare(
        `INSERT INTO messages_in (id, seq, timestamp, kind, channel_type, content, trigger)
         VALUES (?, ?, ?, 'chat', ?, ?, 1)`,
      )
      .run('root', 4, '2026-01-01T00:00:01.000Z', 'slack', '{"text":"root"}');
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, thread_id, content)
         VALUES (?, ?, ?, ?, 'slack', ?, ?)`,
      )
      .run('system', 1, '2026-01-01T00:00:02.000Z', 'system', null, '{"text":"hidden"}');
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, thread_id, content)
         VALUES (?, ?, ?, 'chat', 'slack', ?, ?)`,
      )
      .run('reply', 3, '2026-01-01T00:00:03.000Z', 'thread:reply', '{"text":"thread reply"}');
    outboundDb
      .prepare(
        `INSERT INTO messages_out (id, seq, timestamp, kind, channel_type, thread_id, content)
         VALUES (?, ?, ?, 'chat', 'slack', NULL, ?)`,
      )
      .run('top', 5, '2026-01-01T00:00:04.000Z', '{"text":"top level"}');

    expect(wrapSqliteInbound(inboundDb).getConversationRoot()).toEqual({
      timestamp: '2026-01-01T00:00:01.000Z',
      content: '{"text":"root"}',
    });
    expect(wrapSqliteOutbound(outboundDb).getTopLevelOutbound(10)).toEqual([
      { timestamp: '2026-01-01T00:00:04.000Z', content: '{"text":"top level"}' },
    ]);
  });
});
