/**
 * v1-parity tests for formatter behavior.
 *
 * Port of src/v1/formatting.test.ts (at commit 27c5220, parent of the v1
 * deletion commit 86becf8). Covers: context timezone header, reply_to +
 * quoted_message rendering, XML escaping, and stripInternalTags.
 *
 * Timestamp-format assertions use `formatLocalTime()` output format, which
 * is host locale-dependent for decorators (month abbr, "," separator) but
 * stable for the numeric parts we assert on (hour, minute, year).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags, extractRouting } from './formatter.js';
import type { MessageInRow } from './db/messages-in.js';
import { TIMEZONE } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, ?, ?, 'pending', ?)`,
    )
    .run(id, kind, timestamp, JSON.stringify(content));
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('includes the header even when the message list is empty', () => {
    const result = formatMessages([]);
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
  });

  it('header comes before the first <message> block when multiple are present', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    const ctxIdx = result.indexOf('<context');
    const firstMsgIdx = result.indexOf('<message ');
    expect(ctxIdx).toBeGreaterThanOrEqual(0);
    expect(firstMsgIdx).toBeGreaterThan(ctxIdx);
  });
});

describe('multi-message chat batches', () => {
  // Regression guard for #2555: an outer `<messages>` envelope around
  // multiple chat messages caused the Claude Agent SDK to emit a synthetic
  // `No response requested.` stub instead of calling the API. Each
  // `<message>` block is self-contained; concatenating them is enough.
  it('does NOT wrap multiple chat messages in an outer <messages> envelope', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'one' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'two' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('<messages>');
    expect(result).not.toContain('</messages>');
  });

  it('emits one <message> block per inbound row, in order', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'first' });
    insertMessage('m2', 'chat', { sender: 'Bob', text: 'second' });
    insertMessage('m3', 'chat', { sender: 'Carol', text: 'third' });
    const result = formatMessages(getPendingMessages());
    const matches = result.match(/<message [^>]*>/g) ?? [];
    expect(matches.length).toBe(3);
    const firstIdx = result.indexOf('first');
    const secondIdx = result.indexOf('second');
    const thirdIdx = result.indexOf('third');
    expect(firstIdx).toBeGreaterThan(0);
    expect(secondIdx).toBeGreaterThan(firstIdx);
    expect(thirdIdx).toBeGreaterThan(secondIdx);
  });
});

describe('timestamp formatting', () => {
  it('renders time via formatLocalTime (user TZ)', () => {
    // 2026-06-15T12:00:00Z — timezone-agnostic assertions (year is stable)
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    // formatLocalTime's format in en-US contains the year and a month abbrev
    expect(result).toContain('2026');
    expect(result).toMatch(/Jun/);
  });

  it('uses 12-hour AM/PM format', () => {
    // 15:30 UTC — some hour will show with AM or PM depending on TZ
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { timestamp: '2026-06-15T15:30:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toMatch(/(AM|PM)/);
  });
});

describe('reply_to + quoted_message rendering', () => {
  it('renders reply_to attribute and quoted_message when all fields present', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'Yes, on my way!',
      replyTo: { id: '42', sender: 'Bob', text: 'Are you coming tonight?' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).toContain('<quoted_message from="Bob">Are you coming tonight?</quoted_message>');
    expect(result).toContain('Yes, on my way!</message>');
  });

  it('omits reply_to and quoted_message when no reply context', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'plain' });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('reply_to');
    expect(result).not.toContain('quoted_message');
  });

  it('renders reply_to but omits quoted_message when original content is missing', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'ack',
      replyTo: { id: '42', sender: 'Bob' }, // no text
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('reply_to="42"');
    expect(result).not.toContain('quoted_message');
  });

  it('XML-escapes reply context', () => {
    insertMessage('m1', 'chat', {
      sender: 'Alice',
      text: 'reply',
      replyTo: { id: '1', sender: 'A & B', text: '<script>alert("xss")</script>' },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="A &amp; B"');
    expect(result).toContain('&lt;script&gt;');
    expect(result).toContain('&quot;xss&quot;');
  });
});

describe('XML escaping', () => {
  it('escapes <, >, &, " in sender and body', () => {
    insertMessage('m1', 'chat', {
      sender: 'A & B <Co>',
      text: '<script>alert("xss")</script>',
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('sender="A &amp; B &lt;Co&gt;"');
    expect(result).toContain('&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;');
  });
});

describe('stripInternalTags', () => {
  it('strips single-line internal tags and trims', () => {
    expect(stripInternalTags('hello <internal>secret</internal> world')).toBe('hello  world');
  });

  it('strips multi-line internal tags', () => {
    expect(stripInternalTags('hello <internal>\nsecret\nstuff\n</internal> world')).toBe(
      'hello  world',
    );
  });

  it('strips multiple internal tag blocks', () => {
    expect(stripInternalTags('<internal>a</internal>hello<internal>b</internal>')).toBe('hello');
  });

  it('returns empty string when input is only internal tags', () => {
    expect(stripInternalTags('<internal>only this</internal>')).toBe('');
  });

  it('returns input unchanged when there are no internal tags', () => {
    expect(stripInternalTags('hello world')).toBe('hello world');
  });

  it('preserves content that surrounds internal tags', () => {
    expect(stripInternalTags('<internal>thinking</internal>The answer is 42')).toBe(
      'The answer is 42',
    );
  });
});

// --- extractRouting (Slack thread context preservation) ---

function row(overrides: Partial<MessageInRow>): MessageInRow {
  return {
    id: 'm-default',
    seq: 0,
    kind: 'chat-sdk',
    timestamp: '2026-05-08T01:00:00.000Z',
    status: 'pending',
    platform_id: null,
    channel_type: null,
    thread_id: null,
    content: '{}',
    process_after: null,
    recurrence: null,
    trigger: 1,
    tries: 0,
    ...overrides,
  };
}

describe('extractRouting', () => {
  it('uses messages[0] when first row has full routing', () => {
    const messages = [
      row({
        id: 'm-1',
        platform_id: 'slack:C06HTHNR3DH',
        channel_type: 'slack',
        thread_id: 'slack:C06HTHNR3DH:1778199266.779799',
      }),
    ];
    const r = extractRouting(messages);
    expect(r.platformId).toBe('slack:C06HTHNR3DH');
    expect(r.threadId).toBe('slack:C06HTHNR3DH:1778199266.779799');
    expect(r.inReplyTo).toBe('m-1');
  });

  it('skips a system "agent" channel row at messages[0] and uses the chat row behind it', () => {
    // Reproduces incident 2026-05-08 (sess-1778201595257-akx9i0):
    // an install_packages approval-note (channel_type='agent', no thread)
    // landed at messages[0] and previously null-ed out the chat reply's
    // thread context.
    const messages = [
      row({
        id: 'appr-note-1',
        kind: 'chat',
        channel_type: 'agent',
        platform_id: 'ag-1777563454330-or4qfh',
        thread_id: null,
      }),
      row({
        id: 'm-real-2',
        platform_id: 'slack:C06HTHNR3DH',
        channel_type: 'slack',
        thread_id: 'slack:C06HTHNR3DH:1778201592.978489',
      }),
    ];
    const r = extractRouting(messages);
    expect(r.platformId).toBe('slack:C06HTHNR3DH');
    expect(r.channelType).toBe('slack');
    expect(r.threadId).toBe('slack:C06HTHNR3DH:1778201592.978489');
    expect(r.inReplyTo).toBe('m-real-2');
  });

  it('falls back to platform-only row when no row carries thread_id', () => {
    const messages = [
      row({ id: 'sys-1', channel_type: 'agent', platform_id: 'ag-x', thread_id: null }),
      row({
        id: 'm-channel-2',
        platform_id: 'slack:C06HTHNR3DH',
        channel_type: 'slack',
        thread_id: null, // top-level channel mention
      }),
    ];
    const r = extractRouting(messages);
    expect(r.platformId).toBe('slack:C06HTHNR3DH');
    expect(r.threadId).toBe(null);
    expect(r.inReplyTo).toBe('m-channel-2');
  });

  it('falls back to messages[0] when no row carries platform_id (system-only batch)', () => {
    const messages = [
      row({ id: 'sys-only-1', channel_type: 'agent', platform_id: null, thread_id: null }),
    ];
    const r = extractRouting(messages);
    expect(r.platformId).toBe(null);
    expect(r.channelType).toBe('agent');
    expect(r.inReplyTo).toBe('sys-only-1');
  });

  it('returns all-null routing for an empty batch', () => {
    const r = extractRouting([]);
    expect(r.platformId).toBe(null);
    expect(r.channelType).toBe(null);
    expect(r.threadId).toBe(null);
    expect(r.inReplyTo).toBe(null);
  });

  it('prefers a thread-bearing chat row over an earlier platform-only row', () => {
    const messages = [
      row({
        id: 'm-channel-1',
        platform_id: 'slack:C06HTHNR3DH',
        channel_type: 'slack',
        thread_id: null,
      }),
      row({
        id: 'm-thread-2',
        platform_id: 'slack:C06HTHNR3DH',
        channel_type: 'slack',
        thread_id: 'slack:C06HTHNR3DH:1778199266.779799',
      }),
    ];
    const r = extractRouting(messages);
    expect(r.threadId).toBe('slack:C06HTHNR3DH:1778199266.779799');
    expect(r.inReplyTo).toBe('m-thread-2');
  });
});
