/**
 * Cross-session echo rows (channel_type='session-echo') — the container side
 * of the accumulate fan-out contract:
 *
 * - render as <cross-session-context> blocks, never as <message> blocks;
 * - never provide reply routing;
 * - never flip a task batch's one-door delivery off;
 * - never count as commands (a copied "/clear" is inert);
 * - never trigger on their own (accumulate gate regression).
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import {
  formatMessages,
  extractRouting,
  categorizeMessage,
  isClearCommand,
  isRunnerCommand,
  isSessionEcho,
} from './formatter.js';
import { TIMEZONE, formatLocalStamp } from './timezone.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

interface EchoOpts {
  seq?: number;
  text?: string;
  sender?: string;
  label?: string;
  timestamp?: string;
}

/** Insert an echo row per the fan-out contract: kind='chat', trigger=0, NULL routing. */
function insertEcho(id: string, opts?: EchoOpts): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, "trigger", channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'pending', 0, 'session-echo', NULL, ?)`,
    )
    .run(
      id,
      opts?.seq ?? null,
      opts?.timestamp ?? new Date().toISOString(),
      JSON.stringify({
        text: opts?.text ?? 'hello from elsewhere',
        sender: opts?.sender ?? 'Gavriel',
        senderId: 'slack:U1',
        echo: { surface: 'room', label: opts?.label ?? '#Pixel room' },
      }),
    );
}

function insertMessage(
  id: string,
  kind: string,
  content: object,
  opts?: { seq?: number; trigger?: 0 | 1; platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, "trigger", platform_id, channel_type, thread_id, content)
       VALUES (?, ?, ?, datetime('now'), 'pending', ?, ?, ?, ?, ?)`,
    )
    .run(
      id,
      opts?.seq ?? null,
      kind,
      opts?.trigger ?? 1,
      opts?.platformId ?? null,
      opts?.channelType ?? null,
      opts?.threadId ?? null,
      JSON.stringify(content),
    );
}

describe('formatter rendering', () => {
  it('renders an echo row exactly per the contract', () => {
    const ts = '2026-06-15T12:00:00.000Z';
    insertEcho('e1', { text: "hey what's up", sender: 'Gavriel', label: '#Pixel room', timestamp: ts });

    const result = formatMessages(getPendingMessages());
    const expectedTime = formatLocalStamp(new Date(ts), TIMEZONE);
    expect(result).toContain(
      `<cross-session-context from="#Pixel room" sender="Gavriel" time="${expectedTime}">hey what's up</cross-session-context>`,
    );
    // Never rendered as an addressable <message> block.
    expect(result).not.toContain('<message');
  });

  it('renders channel-timeline backfill rows as <channel-history> (group-surface prelude)', () => {
    insertMessage(
      'bf-ch-1',
      'chat',
      {
        text: 'earlier in the channel',
        sender: 'Gavriel',
        senderId: 'slack:U1',
        echo: { surface: 'channel-timeline', label: 'this channel, just before this conversation' },
      },
      { trigger: 0, channelType: 'session-echo' },
    );

    const result = formatMessages(getPendingMessages());
    expect(result).toContain('<channel-history sender="Gavriel"');
    expect(result).toContain('earlier in the channel</channel-history>');
    expect(result).not.toContain('<message');
  });

  it('XML-escapes label, sender, and text', () => {
    insertEcho('e1', { text: '<b>&"hi"</b>', sender: 'A & B', label: 'DM with <Gavriel>' });

    const result = formatMessages(getPendingMessages());
    expect(result).toContain('from="DM with &lt;Gavriel&gt;"');
    expect(result).toContain('sender="A &amp; B"');
    expect(result).toContain('&lt;b&gt;&amp;&quot;hi&quot;&lt;/b&gt;');
  });

  it('keeps chronological order when echo rows interleave with real chat', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'real one' }, { seq: 2 });
    insertEcho('e1', { seq: 4, text: 'ambient' });
    insertMessage('m2', 'chat', { sender: 'Alice', text: 'real two' }, { seq: 6 });

    const result = formatMessages(getPendingMessages());
    const echoIdx = result.indexOf('<cross-session-context');
    expect(result.indexOf('real one')).toBeLessThan(echoIdx);
    expect(echoIdx).toBeLessThan(result.indexOf('real two'));
  });
});

describe('routing (extractRouting)', () => {
  it('never takes reply routing from an echo row, even when it sorts first', () => {
    insertEcho('e1', { seq: 2 });
    insertMessage(
      'm1',
      'chat',
      { sender: 'Alice', text: 'the real trigger' },
      { seq: 4, platformId: 'C123', channelType: 'slack', threadId: 'th-1' },
    );

    const routing = extractRouting(getPendingMessages());
    expect(routing.platformId).toBe('C123');
    expect(routing.channelType).toBe('slack');
    expect(routing.threadId).toBe('th-1');
    expect(routing.inReplyTo).toBe('m1');
  });

  it('falls back to the first row when the batch is all echo (defensive)', () => {
    insertEcho('e1', { seq: 2 });
    insertEcho('e2', { seq: 4 });

    const routing = extractRouting(getPendingMessages());
    expect(routing.inReplyTo).toBe('e1');
    expect(routing.platformId).toBeNull();
    expect(routing.taskRun).toBe(false);
  });

  it('taskRun stays true when echo rows ride along with a task', () => {
    insertMessage('t1', 'task', { prompt: 'daily digest' }, { seq: 2 });
    insertEcho('e1', { seq: 4 });
    insertEcho('e2', { seq: 6 });

    const routing = extractRouting(getPendingMessages());
    expect(routing.taskRun).toBe(true);
    expect(routing.inReplyTo).toBe('t1');
  });

  it('taskRun is false when a real chat row is in the batch', () => {
    insertMessage('t1', 'task', { prompt: 'daily digest' }, { seq: 2 });
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' }, { seq: 4 });

    expect(extractRouting(getPendingMessages()).taskRun).toBe(false);
  });

  it('taskRun is false without any task row (echo-only batch)', () => {
    insertEcho('e1', { seq: 2 });

    expect(extractRouting(getPendingMessages()).taskRun).toBe(false);
  });
});

describe('command classification', () => {
  it('categorizeMessage returns none for an echoed slash command', () => {
    insertEcho('e1', { text: '/clear' });

    const [msg] = getPendingMessages();
    expect(isSessionEcho(msg)).toBe(true);
    expect(categorizeMessage(msg).category).toBe('none');
  });

  it('echoed /clear and /compact are never runner commands', () => {
    insertEcho('e1', { seq: 2, text: '/clear' });
    insertEcho('e2', { seq: 4, text: '/compact' });

    const messages = getPendingMessages();
    expect(messages.some((m) => isClearCommand(m))).toBe(false);
    expect(messages.some((m) => isRunnerCommand(m))).toBe(false);
  });

  it('a real /clear in the same batch still classifies normally', () => {
    insertEcho('e1', { seq: 2, text: '/clear' });
    insertMessage('m1', 'chat', { sender: 'Alice', text: '/clear' }, { seq: 4 });

    const messages = getPendingMessages();
    const real = messages.find((m) => m.id === 'm1')!;
    expect(isClearCommand(real)).toBe(true);
  });
});

describe('accumulate gate regression', () => {
  it('an echo-only batch has no trigger=1 row — the poll-loop gate stays closed', () => {
    for (let i = 1; i <= 3; i++) insertEcho(`e${i}`, { seq: i * 2 });

    const messages = getPendingMessages();
    expect(messages).toHaveLength(3);
    // Exact predicate from runPollLoop's accumulate gate: false → sleep, no wake.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('one real trigger opens the gate and the echo backlog rides along', () => {
    insertEcho('e1', { seq: 2 });
    insertEcho('e2', { seq: 4 });
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'wake up' }, { seq: 6 });

    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    expect(messages.map((m) => m.id)).toEqual(['e1', 'e2', 'm1']);
  });
});
