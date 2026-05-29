import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { closeDb, initTestDb } from './connection.js';
import { createAgentGroup } from './agent-groups.js';
import { createMessagingGroup } from './messaging-groups.js';
import { runMigrations } from './migrations/index.js';
import {
  fetchContextRows,
  findLogRowByPlatformId,
  getAgentMessageCursor,
  recordIncomingMessage,
  recordOutgoingMessage,
  RETENTION_PER_GROUP,
  sweepRetention,
  TEXT_CAP_PER_MSG,
  upsertAgentMessageCursor,
} from './messaging-group-messages.js';

const now = () => new Date().toISOString();

function setupFixtures() {
  createAgentGroup({ id: 'ag-1', name: 'A', folder: 'a', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-2', name: 'B', folder: 'b', agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: 'mg-1',
    channel_type: 'telegram',
    platform_id: 'telegram:1',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
  createMessagingGroup({
    id: 'mg-2',
    channel_type: 'telegram',
    platform_id: 'telegram:2',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'request_approval',
    denied_at: null,
    created_at: now(),
  });
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  setupFixtures();
});

afterEach(() => {
  closeDb();
});

describe('recordIncomingMessage', () => {
  it('inserts a row with direction in', () => {
    recordIncomingMessage({
      messaging_group_id: 'mg-1',
      thread_id: null,
      source_id: 'src-1',
      sender_name: 'Alice',
      sender_id: 'tg:111',
      text: 'hi',
      has_attachments: 0,
      ts: now(),
    });
    const row = findLogRowByPlatformId('mg-1', 'src-1', 'in');
    expect(row).toBeDefined();
  });

  it('truncates text past TEXT_CAP_PER_MSG', () => {
    const long = 'x'.repeat(TEXT_CAP_PER_MSG + 50);
    recordIncomingMessage({
      messaging_group_id: 'mg-1',
      thread_id: null,
      source_id: 'src-long',
      sender_name: 'A',
      sender_id: null,
      text: long,
      has_attachments: 0,
      ts: now(),
    });
    const rows = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 1);
    expect(rows[0].text!.length).toBeLessThanOrEqual(TEXT_CAP_PER_MSG);
    expect(rows[0].text!.endsWith('…')).toBe(true);
  });

  it('is idempotent on (mg, source_id, direction)', () => {
    const args = {
      messaging_group_id: 'mg-1',
      thread_id: null,
      source_id: 'src-dup',
      sender_name: 'A',
      sender_id: null,
      text: 'first',
      has_attachments: 0,
      ts: now(),
    };
    recordIncomingMessage(args);
    recordIncomingMessage({ ...args, text: 'second' });
    const rows = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 10);
    expect(rows.filter((r) => r.source_id === 'src-dup').length).toBe(1);
  });
});

describe('recordOutgoingMessage', () => {
  it('inserts a row with direction out + agent_group_id', () => {
    recordOutgoingMessage({
      messaging_group_id: 'mg-1',
      thread_id: null,
      source_id: 'out-1',
      agent_group_id: 'ag-1',
      text: 'bot reply',
      has_attachments: 0,
      ts: now(),
    });
    const rows = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].direction).toBe('out');
    expect(rows[0].agent_group_id).toBe('ag-1');
  });
});

describe('fetchContextRows', () => {
  it('returns oldest-first within (after, before) window, capped at limit', () => {
    for (let i = 0; i < 10; i++) {
      recordIncomingMessage({
        messaging_group_id: 'mg-1',
        thread_id: null,
        source_id: `src-${i}`,
        sender_name: 'A',
        sender_id: null,
        text: `m${i}`,
        has_attachments: 0,
        ts: now(),
      });
    }
    const rows = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 5);
    // Last 5 with oldest first → m5..m9
    expect(rows.map((r) => r.text)).toEqual(['m5', 'm6', 'm7', 'm8', 'm9']);
  });

  it('respects after cursor (excludes seen rows)', () => {
    for (let i = 0; i < 5; i++) {
      recordIncomingMessage({
        messaging_group_id: 'mg-1',
        thread_id: null,
        source_id: `src-${i}`,
        sender_name: 'A',
        sender_id: null,
        text: `m${i}`,
        has_attachments: 0,
        ts: now(),
      });
    }
    const allRows = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 100);
    const midId = allRows[2].id;
    const subsequent = fetchContextRows('mg-1', null, midId, Number.MAX_SAFE_INTEGER, 100);
    expect(subsequent.map((r) => r.text)).toEqual(['m3', 'm4']);
  });

  it('respects before id (excludes trigger row itself)', () => {
    for (let i = 0; i < 5; i++) {
      recordIncomingMessage({
        messaging_group_id: 'mg-1',
        thread_id: null,
        source_id: `src-${i}`,
        sender_name: 'A',
        sender_id: null,
        text: `m${i}`,
        has_attachments: 0,
        ts: now(),
      });
    }
    const allRows = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 100);
    const triggerId = allRows[4].id;
    const before = fetchContextRows('mg-1', null, 0, triggerId, 100);
    expect(before.map((r) => r.text)).toEqual(['m0', 'm1', 'm2', 'm3']);
  });

  it('isolates by messaging_group_id', () => {
    recordIncomingMessage({
      messaging_group_id: 'mg-1',
      thread_id: null,
      source_id: 'src-a',
      sender_name: 'A',
      sender_id: null,
      text: 'in mg1',
      has_attachments: 0,
      ts: now(),
    });
    recordIncomingMessage({
      messaging_group_id: 'mg-2',
      thread_id: null,
      source_id: 'src-b',
      sender_name: 'A',
      sender_id: null,
      text: 'in mg2',
      has_attachments: 0,
      ts: now(),
    });
    expect(fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 10).map((r) => r.text)).toEqual(['in mg1']);
    expect(fetchContextRows('mg-2', null, 0, Number.MAX_SAFE_INTEGER, 10).map((r) => r.text)).toEqual(['in mg2']);
  });

  it('isolates by thread_id (null vs value)', () => {
    recordIncomingMessage({
      messaging_group_id: 'mg-1',
      thread_id: null,
      source_id: 'src-null',
      sender_name: 'A',
      sender_id: null,
      text: 'no-thread',
      has_attachments: 0,
      ts: now(),
    });
    recordIncomingMessage({
      messaging_group_id: 'mg-1',
      thread_id: 'thread-A',
      source_id: 'src-tA',
      sender_name: 'A',
      sender_id: null,
      text: 'in thread A',
      has_attachments: 0,
      ts: now(),
    });
    expect(fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 10).map((r) => r.text)).toEqual(['no-thread']);
    expect(fetchContextRows('mg-1', 'thread-A', 0, Number.MAX_SAFE_INTEGER, 10).map((r) => r.text)).toEqual([
      'in thread A',
    ]);
  });
});

describe('cursors', () => {
  it('initial get returns undefined; upsert sets it; subsequent get reads it', () => {
    expect(getAgentMessageCursor('ag-1', 'mg-1', '')).toBeUndefined();
    upsertAgentMessageCursor('ag-1', 'mg-1', '', 42);
    expect(getAgentMessageCursor('ag-1', 'mg-1', '')?.last_seen_id).toBe(42);
  });

  it('upsert advances only forward (does not regress)', () => {
    upsertAgentMessageCursor('ag-1', 'mg-1', '', 50);
    upsertAgentMessageCursor('ag-1', 'mg-1', '', 30);
    expect(getAgentMessageCursor('ag-1', 'mg-1', '')?.last_seen_id).toBe(50);
  });

  it('per-agent isolation', () => {
    upsertAgentMessageCursor('ag-1', 'mg-1', '', 10);
    upsertAgentMessageCursor('ag-2', 'mg-1', '', 20);
    expect(getAgentMessageCursor('ag-1', 'mg-1', '')?.last_seen_id).toBe(10);
    expect(getAgentMessageCursor('ag-2', 'mg-1', '')?.last_seen_id).toBe(20);
  });

  it('per-thread isolation (sentinel "" vs named)', () => {
    upsertAgentMessageCursor('ag-1', 'mg-1', '', 5);
    upsertAgentMessageCursor('ag-1', 'mg-1', 'thread-X', 99);
    expect(getAgentMessageCursor('ag-1', 'mg-1', '')?.last_seen_id).toBe(5);
    expect(getAgentMessageCursor('ag-1', 'mg-1', 'thread-X')?.last_seen_id).toBe(99);
  });
});

describe('sweepRetention', () => {
  it('keeps RETENTION_PER_GROUP rows, deletes the oldest beyond cap, per group', () => {
    // Insert RETENTION_PER_GROUP + 25 rows in mg-1, and 3 rows in mg-2.
    const N_OVER = 25;
    for (let i = 0; i < RETENTION_PER_GROUP + N_OVER; i++) {
      recordIncomingMessage({
        messaging_group_id: 'mg-1',
        thread_id: null,
        source_id: `src-${i}`,
        sender_name: 'A',
        sender_id: null,
        text: `m${i}`,
        has_attachments: 0,
        ts: now(),
      });
    }
    for (let i = 0; i < 3; i++) {
      recordIncomingMessage({
        messaging_group_id: 'mg-2',
        thread_id: null,
        source_id: `mg2-${i}`,
        sender_name: 'A',
        sender_id: null,
        text: `x${i}`,
        has_attachments: 0,
        ts: now(),
      });
    }

    sweepRetention();

    const mg1 = fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, RETENTION_PER_GROUP + 100);
    const mg2 = fetchContextRows('mg-2', null, 0, Number.MAX_SAFE_INTEGER, 100);
    expect(mg1).toHaveLength(RETENTION_PER_GROUP);
    expect(mg2).toHaveLength(3);
    // Sanity: the oldest of mg-1 was deleted, the newest kept.
    expect(mg1[0].text).toBe(`m${N_OVER}`);
    expect(mg1[mg1.length - 1].text).toBe(`m${RETENTION_PER_GROUP + N_OVER - 1}`);
  });

  it('is a no-op when no group exceeds the cap', () => {
    for (let i = 0; i < 10; i++) {
      recordIncomingMessage({
        messaging_group_id: 'mg-1',
        thread_id: null,
        source_id: `src-${i}`,
        sender_name: 'A',
        sender_id: null,
        text: `m${i}`,
        has_attachments: 0,
        ts: now(),
      });
    }
    sweepRetention();
    expect(fetchContextRows('mg-1', null, 0, Number.MAX_SAFE_INTEGER, 100)).toHaveLength(10);
  });
});
