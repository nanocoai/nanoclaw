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

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { formatMessages, stripInternalTags, stripLegacyTaskContract } from './formatter.js';
import { TIMEZONE, formatLocalTime } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

// Production always assigns seq (the host writer); a NULL seq makes both the
// query's ORDER BY and getPendingMessages' final sort ties, so multi-row
// ordering becomes whatever SQLite returns — the source of a long flake.
let nextSeq = 1;

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { timestamp?: string; processAfter?: string },
) {
  const timestamp = opts?.timestamp ?? new Date().toISOString();
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, content, seq)
       VALUES (?, ?, ?, 'pending', ?, ?, ?)`,
    )
    .run(id, kind, timestamp, opts?.processAfter ?? null, JSON.stringify(content), nextSeq++);
}

describe('context timezone header', () => {
  it('prepends <context timezone="..."/> to formatted output', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hello' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`<context timezone="${TIMEZONE}"`);
    expect(result).not.toContain('current_time=');
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

describe('task prompt compatibility', () => {
  it('strips the generated #2981 delivery suffix without mutating stored data', () => {
    const prompt =
      'Send the daily digest\n\n' +
      '[A task serves the user two separate ways — legacy generated delivery instructions]';

    expect(stripLegacyTaskContract(prompt)).toBe('Send the daily digest');
  });

  it('strips the generated #2988 delivery suffix', () => {
    const prompt = 'Check the feeds\n\n[Task delivery contract:\nlegacy generated instructions]';

    expect(stripLegacyTaskContract(prompt)).toBe('Check the feeds');
  });

  it('leaves ordinary user prompts unchanged', () => {
    const prompt = 'Explain [Task delivery contract:] as plain text';

    expect(stripLegacyTaskContract(prompt)).toBe(prompt);
  });

  it('does not expose a legacy delivery contract in a formatted task run', () => {
    insertMessage('task-1', 'task', {
      prompt: 'Check the feeds\n\n[Task delivery contract:\nlegacy generated instructions]',
    });

    const result = formatMessages(getPendingMessages());
    expect(result).toContain('Instructions:\nCheck the feeds');
    expect(result).not.toContain('legacy generated instructions');
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

describe('structured chat links', () => {
  it('preserves a link target hidden by shortened display text', () => {
    insertMessage('m1', 'chat-sdk', {
      sender: 'Joel',
      text: 'read example.com/assets/…/review',
      links: [{ url: 'https://example.com/assets/a_123/review?x=1&y=2' }],
    });

    const result = formatMessages(getPendingMessages());

    expect(result).toContain(
      'read example.com/assets/…/review\n[link: https://example.com/assets/a_123/review?x=1&amp;y=2]',
    );
  });

  it('does not repeat a link already present in message text', () => {
    const url = 'https://example.com/full-path';
    insertMessage('m1', 'chat-sdk', { sender: 'Joel', text: `read ${url}`, links: [{ url }] });

    const result = formatMessages(getPendingMessages());

    expect(result.match(/https:\/\/example\.com\/full-path/g)).toHaveLength(1);
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

describe('task timestamps', () => {
  it('falls back to creation time for legacy rows without process_after', () => {
    insertMessage('t1', 'task', { prompt: 'do the thing' }, { timestamp: '2026-01-05T12:00:00.000Z' });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain(`time="${formatLocalTime('2026-01-05T12:00:00.000Z', TIMEZONE)}"`);
  });

  it('renders the scheduled time plus the current run time', () => {
    const created = '2026-01-04T12:00:00.000Z';
    const scheduled = '2026-01-05T12:00:00.000Z';
    insertMessage('t1', 'task', { prompt: "prepare today's brief" }, { timestamp: created, processAfter: scheduled });

    const result = formatMessages(getPendingMessages());

    expect(result).toContain(`time="${formatLocalTime(scheduled, TIMEZONE)}"`);
    expect(result).not.toContain(`time="${formatLocalTime(created, TIMEZONE)}"`);
    expect(result).toMatch(/current_time="(?:Sunday|Monday|Tuesday|Wednesday|Thursday|Friday|Saturday), [^"]+"/);
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

describe('app_context rendering (Slack agent mode, contract C4)', () => {
  it('renders a compact single (viewing: …) line inside the message block', () => {
    insertMessage('m1', 'chat-sdk', {
      sender: 'Gavriel',
      text: 'what do you think?',
      app_context: { entities: [{ type: 'channel', id: 'C0DESIGN' }] },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('what do you think?\n(viewing: channel C0DESIGN)</message>');
  });

  it('joins multiple entities in order with commas', () => {
    insertMessage('m1', 'chat-sdk', {
      sender: 'Gavriel',
      text: 'here',
      app_context: {
        entities: [
          { type: 'channel', id: 'C0DESIGN' },
          { type: 'canvas', id: 'F0CANVAS' },
        ],
      },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('(viewing: channel C0DESIGN, canvas F0CANVAS)');
  });

  it('renders nothing for absent, empty, or malformed app_context', () => {
    insertMessage('m1', 'chat-sdk', { sender: 'A', text: 'no context' });
    insertMessage('m2', 'chat-sdk', { sender: 'A', text: 'empty', app_context: { entities: [] } });
    insertMessage('m3', 'chat-sdk', { sender: 'A', text: 'malformed', app_context: 'C0DESIGN' });
    insertMessage('m4', 'chat-sdk', {
      sender: 'A',
      text: 'idless',
      app_context: { entities: [{ type: 'channel' }] },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).not.toContain('(viewing:');
  });

  it('escapes XML-significant characters in entity values', () => {
    insertMessage('m1', 'chat-sdk', {
      sender: 'A',
      text: 'x',
      app_context: { entities: [{ type: 'channel', id: 'C1<&>' }] },
    });
    const result = formatMessages(getPendingMessages());
    expect(result).toContain('(viewing: channel C1&lt;&amp;&gt;)');
  });
});
