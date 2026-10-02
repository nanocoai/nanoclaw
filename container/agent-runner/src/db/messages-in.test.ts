/**
 * Batch-selection tests for getPendingMessages.
 *
 * The two-phase selection (due trigger=1 rows first, oldest-first; remaining
 * slots filled with the NEWEST trigger=0 rows) exists so accumulated context
 * (e.g. non-engaged group messages) can never crowd a due wake row (e.g. a
 * task) out of the batch — without it, the wake fires but the work itself
 * never reaches the agent.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getPendingMessages, markProcessing } from './messages-in.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

// Default cap when config isn't loaded (test harness) — see getMaxMessagesPerPrompt.
const CAP = 10;

function insertMessage(
  id: string,
  seq: number,
  kind: string,
  content: object,
  opts?: { trigger?: 0 | 1; onWake?: 0 | 1; processAfter?: string; channelType?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, "trigger", on_wake, channel_type, content)
       VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      seq,
      kind,
      opts?.processAfter ?? null,
      opts?.trigger ?? 1,
      opts?.onWake ?? 0,
      opts?.channelType ?? null,
      JSON.stringify(content),
    );
}

function insertContextRow(id: string, seq: number, text: string): void {
  insertMessage(id, seq, 'chat', { text, sender: 'Ambient User', senderId: 'telegram:U1' }, { trigger: 0 });
}

describe('trigger=1 rows never crowded out', () => {
  it('a due task row survives 12 newer context rows at cap 10', () => {
    insertMessage('task-1', 2, 'task', { prompt: 'daily digest' });
    for (let i = 1; i <= 12; i++) {
      insertContextRow(`ctx-${i}`, 2 + i * 2, `ambient ${i}`);
    }

    const batch = getPendingMessages();
    expect(batch).toHaveLength(CAP);
    expect(batch.map((m) => m.id)).toContain('task-1');
    // Oldest-first: the task row (lowest seq) leads the batch.
    expect(batch[0].id).toBe('task-1');
    // Remaining slots hold the NEWEST 9 context rows (ctx-1..3 dropped).
    expect(batch.slice(1).map((m) => m.id)).toEqual(
      ['ctx-4', 'ctx-5', 'ctx-6', 'ctx-7', 'ctx-8', 'ctx-9', 'ctx-10', 'ctx-11', 'ctx-12'],
    );
  });

  it('trigger=1 rows are all included even when they interleave with newer context', () => {
    insertMessage('chat-old', 2, 'chat', { sender: 'A', text: 'first real' });
    insertContextRow('ctx-1', 4, 'noise');
    insertMessage('chat-new', 6, 'chat', { sender: 'A', text: 'second real' });
    insertContextRow('ctx-2', 8, 'more noise');

    const batch = getPendingMessages();
    // All four fit — merged in chronological (seq) order.
    expect(batch.map((m) => m.id)).toEqual(['chat-old', 'ctx-1', 'chat-new', 'ctx-2']);
  });

  it('takes the oldest trigger=1 rows when wake rows alone exceed the cap', () => {
    for (let i = 1; i <= 12; i++) {
      insertMessage(`chat-${i}`, i * 2, 'chat', { sender: 'A', text: `msg ${i}` });
    }

    const batch = getPendingMessages();
    expect(batch).toHaveLength(CAP);
    expect(batch[0].id).toBe('chat-1');
    expect(batch[batch.length - 1].id).toBe('chat-10');
  });

  it('context-only backlog still returns the newest rows, oldest-first', () => {
    for (let i = 1; i <= 12; i++) {
      insertContextRow(`ctx-${i}`, i * 2, `ambient ${i}`);
    }

    const batch = getPendingMessages();
    expect(batch).toHaveLength(CAP);
    expect(batch[0].id).toBe('ctx-3');
    expect(batch[batch.length - 1].id).toBe('ctx-12');
  });
});

describe('claimed-but-unsynced rows never hide new work', () => {
  // Claimed rows stay status='pending' in inbound.db until the host sweep
  // syncs processing_ack back (~60s). The ack filter must run BEFORE the cap
  // windowing: windowing first lets a cap-sized claimed batch fill the
  // window, the filter empties it, and newer rows are invisible all turn.
  it('a new message arriving after a full claimed batch is returned immediately', () => {
    const claimed: string[] = [];
    for (let i = 1; i <= CAP; i++) {
      insertMessage(`claimed-${i}`, i * 2, 'chat', { sender: 'A', text: `msg ${i}` });
      claimed.push(`claimed-${i}`);
    }
    markProcessing(claimed);

    insertMessage('fresh', (CAP + 1) * 2, 'chat', { sender: 'A', text: 'follow-up' });

    expect(getPendingMessages().map((m) => m.id)).toEqual(['fresh']);
  });

  it('an older unclaimed task row survives a cap of newer claimed rows', () => {
    insertMessage('task-old', 2, 'task', { prompt: 'due work' });
    const claimed: string[] = [];
    for (let i = 1; i <= CAP; i++) {
      insertMessage(`claimed-${i}`, 100 + i * 2, 'chat', { sender: 'A', text: `msg ${i}` });
      claimed.push(`claimed-${i}`);
    }
    markProcessing(claimed);

    expect(getPendingMessages().map((m) => m.id)).toEqual(['task-old']);
  });

  it('claimed context rows do not consume phase-2 slots', () => {
    const claimed: string[] = [];
    for (let i = 1; i <= CAP; i++) {
      insertContextRow(`claimed-ctx-${i}`, i * 2, `old ambient ${i}`);
      claimed.push(`claimed-ctx-${i}`);
    }
    markProcessing(claimed);
    insertMessage('chat-new', 100, 'chat', { sender: 'A', text: 'real' });
    insertContextRow('ctx-new', 102, 'fresh ambient');

    expect(getPendingMessages().map((m) => m.id)).toEqual(['chat-new', 'ctx-new']);
  });
});

describe('existing selection semantics preserved', () => {
  it('skips rows whose process_after is in the future, both phases', () => {
    const future = new Date(Date.now() + 60_000).toISOString();
    insertMessage('due-task', 2, 'task', { prompt: 'now' });
    insertMessage('later-task', 4, 'task', { prompt: 'later' }, { processAfter: future });
    insertContextRow('ctx-1', 6, 'ambient');
    getInboundDb()
      .prepare(`UPDATE messages_in SET process_after = ? WHERE id = 'ctx-1'`)
      .run(future);

    const batch = getPendingMessages();
    expect(batch.map((m) => m.id)).toEqual(['due-task']);
  });

  it('filters rows already acked in processing_ack', () => {
    insertMessage('m1', 2, 'chat', { sender: 'A', text: 'one' });
    insertContextRow('ctx-1', 4, 'ambient');
    markProcessing(['m1', 'ctx-1']);

    expect(getPendingMessages()).toHaveLength(0);
  });

  it('on_wake=1 rows only surface on the first poll, both phases', () => {
    insertMessage('wake-1', 2, 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    insertContextRow('ctx-1', 4, 'ambient');
    getInboundDb().prepare(`UPDATE messages_in SET on_wake = 1 WHERE id = 'ctx-1'`).run();

    expect(getPendingMessages(true).map((m) => m.id)).toEqual(['wake-1', 'ctx-1']);
    expect(getPendingMessages(false)).toHaveLength(0);
  });
});
