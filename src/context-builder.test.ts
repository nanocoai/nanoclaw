import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import { formatContextBlock } from './context-builder.js';
import { closeDb, initTestDb } from './db/connection.js';
import { createAgentGroup } from './db/agent-groups.js';
import { runMigrations } from './db/migrations/index.js';
import type { LogRow } from './db/messaging-group-messages.js';

const now = () => new Date().toISOString();

function inRow(overrides: Partial<LogRow>): LogRow {
  return {
    id: 1,
    messaging_group_id: 'mg-1',
    thread_id: null,
    direction: 'in',
    source_id: 's',
    sender_name: 'Alice',
    sender_id: null,
    agent_group_id: null,
    text: 'hello',
    has_attachments: 0,
    ts: '2026-05-29T10:30:00Z',
    ...overrides,
  };
}

function outRow(overrides: Partial<LogRow>): LogRow {
  return {
    id: 1,
    messaging_group_id: 'mg-1',
    thread_id: null,
    direction: 'out',
    source_id: 's',
    sender_name: null,
    sender_id: null,
    agent_group_id: 'ag-1',
    text: 'bot says hi',
    has_attachments: 0,
    ts: '2026-05-29T10:31:00Z',
    ...overrides,
  };
}

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
  createAgentGroup({ id: 'ag-1', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  createAgentGroup({ id: 'ag-2', name: 'Bobby', folder: 'bobby', agent_provider: null, created_at: now() });
});

afterEach(() => {
  closeDb();
});

describe('formatContextBlock', () => {
  it('returns empty string for empty input', () => {
    expect(formatContextBlock([], 'ag-1')).toBe('');
  });

  it('labels caller agent as [bot]', () => {
    const out = formatContextBlock([outRow({ agent_group_id: 'ag-1' })], 'ag-1');
    expect(out).toContain('[bot, 10:31]: bot says hi');
  });

  it('labels other agents as [bot:Name]', () => {
    const out = formatContextBlock([outRow({ agent_group_id: 'ag-2' })], 'ag-1');
    expect(out).toContain('[bot:Bobby, 10:31]: bot says hi');
  });

  it('labels inbound by sender_name', () => {
    const out = formatContextBlock([inRow({ sender_name: 'Yair', text: 'hey' })], 'ag-1');
    expect(out).toContain('[Yair, 10:30]: hey');
  });

  it('falls back to "unknown" for missing sender_name', () => {
    const out = formatContextBlock([inRow({ sender_name: null, text: 'hey' })], 'ag-1');
    expect(out).toContain('[unknown, 10:30]: hey');
  });

  it('renders attachment-only rows as [image/file]', () => {
    const out = formatContextBlock([inRow({ text: null, has_attachments: 1 })], 'ag-1');
    expect(out).toContain('[Alice, 10:30]: [image/file]');
  });

  it('skips rows with no text and no attachments', () => {
    const out = formatContextBlock([inRow({ text: null, has_attachments: 0 })], 'ag-1');
    expect(out).toBe('');
  });

  it('wraps with header + footer and counts rendered rows', () => {
    const rows = [
      inRow({ id: 1, text: 'a', ts: '2026-05-29T10:30:00Z' }),
      outRow({ id: 2, text: 'b', ts: '2026-05-29T10:31:00Z', agent_group_id: 'ag-1' }),
      inRow({ id: 3, text: 'c', ts: '2026-05-29T10:32:00Z', sender_name: 'Eve' }),
    ];
    const block = formatContextBlock(rows, 'ag-1');
    const lines = block.split('\n');
    expect(lines[0]).toBe('[Context — last 3 messages]');
    expect(lines[lines.length - 1]).toBe('[End context]');
    expect(lines).toHaveLength(5);
  });

  it('handles malformed ts gracefully (??:??)', () => {
    const out = formatContextBlock([inRow({ ts: 'not-a-date' })], 'ag-1');
    expect(out).toContain('??:??');
  });
});
