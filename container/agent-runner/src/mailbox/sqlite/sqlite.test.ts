import { afterEach, describe, expect, test } from 'bun:test';

import { closeSessionDb, initTestSessionDb } from './connection.js';
import { SqliteAgentMailbox } from './index.js';

afterEach(() => closeSessionDb());

describe('SQLite runner mailbox canonical serialization', () => {
  test('classifies only corruption errors as requiring a fresh runner', () => {
    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.shouldRestartAfter(new Error('database disk image is malformed'))).toBe(true);
    expect(mailbox.shouldRestartAfter('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(mailbox.shouldRestartAfter('file is not a database')).toBe(true);
    expect(mailbox.shouldRestartAfter('database is locked')).toBe(false);
    expect(mailbox.shouldRestartAfter('no such table: messages_in')).toBe(false);
  });

  test('round-trips full inbound and outbound lifecycle records', async () => {
    const { inbound, outbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
            platform_id, channel_type, thread_id, content, on_wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'in-1',
        2,
        'chat',
        '2026-01-01 00:00:00',
        'pending',
        null,
        null,
        'in-1',
        0,
        1,
        'room',
        'test',
        'thread',
        '{"text":"hello"}',
        1,
      );
    inbound
      .prepare(
        `INSERT INTO destinations
           (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('test-room', null, 'channel', 'test', 'room', null);
    outbound
      .prepare('INSERT INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
      .run('continuation', 'token', '2026-01-01 00:00:00');

    const mailbox = new SqliteAgentMailbox();
    await mailbox.start({ agentGroupId: 'agent', sessionId: 'session', mailbox: null });
    expect(mailbox.getPendingMessages(10, true)).toEqual([
      {
        id: 'in-1',
        sequence: 2,
        kind: 'chat',
        timestamp: '2026-01-01T00:00:00.000Z',
        status: 'pending',
        processAfter: null,
        recurrence: null,
        seriesId: 'in-1',
        tries: 0,
        trigger: true,
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"hello"}',
        sourceSessionId: null,
        onWake: true,
      },
    ]);
    expect(mailbox.getState('continuation')).toEqual({
      value: 'token',
      updatedAt: '2026-01-01T00:00:00.000Z',
    });
    expect(mailbox.getDestinations()).toEqual([
      {
        name: 'test-room',
        displayName: null,
        type: 'channel',
        channelType: 'test',
        platformId: 'room',
        agentGroupId: null,
      },
    ]);

    for (const invalidTimeout of [-1, 1.5]) {
      mailbox.setContainerToolInFlight('Bash', invalidTimeout);
      expect(outbound.prepare('SELECT current_tool, tool_declared_timeout_ms FROM container_state').get()).toEqual({
        current_tool: 'Bash',
        tool_declared_timeout_ms: null,
      });
    }

    expect(
      await mailbox.writeMessageOut({
        id: 'out-1',
        inReplyTo: 'in-1',
        deliverAfter: '2026-01-01T00:00:01.000Z',
        recurrence: '0 * * * *',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
      }),
    ).toBe(3);
    expect(mailbox.getUndeliveredMessages()).toEqual([
      {
        id: 'out-1',
        sequence: 3,
        inReplyTo: 'in-1',
        timestamp: expect.any(String),
        deliverAfter: '2026-01-01T00:00:01.000Z',
        recurrence: '0 * * * *',
        kind: 'chat',
        platformId: 'room',
        channelType: 'test',
        threadId: 'thread',
        content: '{"text":"reply"}',
      },
    ]);
  });

  test('skips malformed pending inbound rows instead of crashing the runner', () => {
    const { inbound } = initTestSessionDb();
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, trigger,
            platform_id, channel_type, thread_id, content, on_wake)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'bad-row',
        2,
        'not-a-kind',
        new Date().toISOString(),
        'pending',
        null,
        null,
        null,
        0,
        1,
        null,
        null,
        null,
        '{}',
        0,
      );

    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.getPendingMessages(10, false)).toEqual([]);
  });

  /** Insert a messages_in row with just the columns these tests care about. */
  function seedMessage(inbound: ReturnType<typeof initTestSessionDb>['inbound'], id: string, seq: number): void {
    inbound
      .prepare(
        `INSERT INTO messages_in
           (id, seq, kind, timestamp, status, tries, trigger, content, on_wake)
         VALUES (?, ?, 'chat', ?, 'pending', 0, 1, '{}', 0)`,
      )
      .run(id, seq, new Date().toISOString());
  }

  test('clearStaleProcessingAcks drops acks whose message is gone, keeping the live ones', () => {
    const { inbound, outbound } = initTestSessionDb();
    seedMessage(inbound, 'chat:32:group', 2);

    const ack = outbound.prepare(
      'INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)',
    );
    ack.run('chat:32:group', 'completed', '2026-09-09T00:00:00.000Z'); // live — message exists
    ack.run('chat:12:group', 'completed', '2026-08-12T00:00:00.000Z'); // orphan — pruned message
    ack.run('chat:70:group', 'completed', '2026-08-27T00:00:00.000Z'); // orphan — pruned message

    new SqliteAgentMailbox().operations.clearStaleProcessingAcks();

    const left = (
      outbound.prepare('SELECT message_id FROM processing_ack ORDER BY message_id').all() as Array<{
        message_id: string;
      }>
    ).map(({ message_id }) => message_id);
    expect(left).toEqual(['chat:32:group']);
  });

  test('a message reusing a pruned id is delivered, not swallowed by the old ack', () => {
    const { inbound, outbound } = initTestSessionDb();
    // The 2026-09 incident in miniature: a recreated bot restarts its counter,
    // so a brand-new message arrives carrying an id an old ack already holds.
    outbound
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('chat:32:group', 'completed', '2026-08-24T17:32:07.539Z');

    const mailbox = new SqliteAgentMailbox();
    seedMessage(inbound, 'chat:32:group', 2);
    // Without the sweep the stale ack hides it: the agent never sees the message.
    expect(mailbox.getPendingMessages(10, false)).toEqual([]);

    // The sweep runs at container start and removes the ack, because at that
    // point no messages_in row carried that id.
    outbound.prepare('DELETE FROM processing_ack').run();
    outbound
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('chat:99:gone', 'completed', '2026-08-24T17:32:07.539Z');
    mailbox.operations.clearStaleProcessingAcks();

    expect(mailbox.getPendingMessages(10, false).map((m) => m.id)).toEqual(['chat:32:group']);
  });

  test('clearStaleProcessingAcks still clears processing entries from a crashed turn', () => {
    const { inbound, outbound } = initTestSessionDb();
    seedMessage(inbound, 'chat:5:group', 2);
    outbound
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run('chat:5:group', 'processing', new Date().toISOString());

    const mailbox = new SqliteAgentMailbox();
    expect(mailbox.getPendingMessages(10, false)).toEqual([]); // claimed, so hidden
    mailbox.operations.clearStaleProcessingAcks();
    expect(mailbox.getPendingMessages(10, false).map((m) => m.id)).toEqual(['chat:5:group']);
  });
});
