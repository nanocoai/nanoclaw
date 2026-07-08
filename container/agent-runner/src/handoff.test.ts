/**
 * Tests for the cross-provider handoff recap — the compact conversation
 * summary prepended to the first prompt after a Claude↔Codex switch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { writeMessageOut } from './db/messages-out.js';
import { buildHandoffRecap } from './handoff.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertInbound(id: string, text: string, timestamp: string, kind = 'chat'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify({ text }));
}

function insertOutbound(id: string, text: string): void {
  writeMessageOut({
    id,
    kind: 'chat',
    platform_id: 'telegram:1',
    channel_type: 'telegram',
    thread_id: null,
    content: JSON.stringify({ text }),
  });
}

describe('buildHandoffRecap', () => {
  it('returns empty string for a fresh session (never blocks the turn)', () => {
    expect(buildHandoffRecap()).toBe('');
  });

  it('recaps both sides of the exchange, oldest first, wrapped in <system>', () => {
    insertInbound('u1', 'תערוך לי את קורות החיים', '2026-01-01 10:00:00');
    insertInbound('u2', 'תתמקד במשרות שיווק', '2026-01-01 10:01:00');
    insertOutbound('a1', 'קיבלתי, מתחיל לעבוד על הקובץ');

    const recap = buildHandoffRecap();
    expect(recap).toContain('<system>');
    expect(recap).toContain('[User] תערוך לי את קורות החיים');
    expect(recap).toContain('[User] תתמקד במשרות שיווק');
    expect(recap).toContain('[You] קיבלתי, מתחיל לעבוד על הקובץ');
    // Oldest first.
    expect(recap.indexOf('תערוך לי')).toBeLessThan(recap.indexOf('תתמקד'));
    // Continuity instruction present.
    expect(recap).toContain('do not re-introduce yourself');
  });

  it('excludes the pipeline own quota/fallback notices from the recap', () => {
    insertInbound('u1', 'שאלה רגילה', '2026-01-01 10:00:00');
    insertOutbound('n1', '⚠️ מכסת Claude נגמרה כרגע — ממשיך לענות דרך Codex (OpenAI).');
    insertOutbound('n2', '❌ גם מנוע הגיבוי (Codex) לא הצליח לענות כרגע.');
    insertOutbound('n3', '✅ מכסת Claude התחדשה — חזרתי לענות דרך Claude.');
    insertOutbound('a1', 'תשובה אמיתית');

    const recap = buildHandoffRecap();
    expect(recap).toContain('תשובה אמיתית');
    expect(recap).not.toContain('מכסת Claude');
    expect(recap).not.toContain('מנוע הגיבוי');
  });

  it('skips non-text rows (reactions) and truncates very long messages', () => {
    insertInbound('r1', '', '2026-01-01 09:59:00'); // empty text → skipped
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('op1', 'chat', '2026-01-01 09:59:30', 'pending', ?)`,
      )
      .run(JSON.stringify({ operation: 'reaction', emoji: 'thumbs_up' }));
    insertInbound('u1', 'א'.repeat(600), '2026-01-01 10:00:00');

    const recap = buildHandoffRecap();
    expect(recap).toContain('…'); // truncated
    expect(recap).not.toContain('א'.repeat(500)); // not the full 600 chars
    expect(recap).not.toContain('thumbs_up');
  });

  it('keeps only the most recent messages within the cap', () => {
    for (let i = 1; i <= 20; i++) {
      insertInbound(`u${i}`, `הודעה מספר ${i}`, `2026-01-01 10:${String(i).padStart(2, '0')}:00`);
    }
    const recap = buildHandoffRecap();
    expect(recap).toContain('הודעה מספר 20');
    expect(recap).not.toContain('הודעה מספר 1,'); // oldest dropped (cap is 12)
    expect(recap).not.toContain('הודעה מספר 5');
  });
});
