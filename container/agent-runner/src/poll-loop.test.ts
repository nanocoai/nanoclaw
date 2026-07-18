import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getPendingMessages, markCompleted } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { formatMessages, extractRouting } from './formatter.js';
import { isCorruptionError, processQuery } from './poll-loop.js';
import { MockProvider } from './providers/mock.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

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
  opts?: { processAfter?: string; trigger?: 0 | 1; onWake?: 0 | 1 },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, on_wake, content)
     VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, kind, opts?.processAfter ?? null, opts?.trigger ?? 1, opts?.onWake ?? 0, JSON.stringify(content));
}

describe('formatter', () => {
  it('should format a single chat message', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello world' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('Hello world');
  });

  it('should format multiple chat messages as distinct <message> blocks', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'chat', { sender: 'Jane', text: 'Hi there' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    // The <messages> envelope was dropped in fe2e881b (#2556) so the SDK calls
    // the API; each message is now its own self-contained <message> block.
    expect(prompt).not.toContain('<messages>');
    expect(prompt.match(/<message /g) ?? []).toHaveLength(2);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('sender="Jane"');
  });

  it('should format task messages', () => {
    insertMessage('m1', 'task', { prompt: 'Review open PRs' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<task');
    expect(prompt).toContain('Review open PRs');
  });

  it('should format webhook messages', () => {
    insertMessage('m1', 'webhook', { source: 'github', event: 'push', payload: { ref: 'main' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('source="github"');
    expect(prompt).toContain('event="push"');
  });

  it('should format system messages', () => {
    insertMessage('m1', 'system', { action: 'register_group', status: 'success', result: { id: 'ag-1' } });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('action="register_group"');
  });

  it('should handle mixed kinds', () => {
    insertMessage('m1', 'chat', { sender: 'John', text: 'Hello' });
    insertMessage('m2', 'system', { action: 'test', status: 'ok', result: null });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('sender="John"');
    expect(prompt).toContain('<system_response');
  });

  it('should escape XML in content', () => {
    insertMessage('m1', 'chat', { sender: 'A<B', text: 'x > y && z' });
    const messages = getPendingMessages();
    const prompt = formatMessages(messages);
    expect(prompt).toContain('A&lt;B');
    expect(prompt).toContain('x &gt; y &amp;&amp; z');
  });
});

describe('accumulate gate (trigger column)', () => {
  it('getPendingMessages returns both trigger=0 and trigger=1 rows', () => {
    // trigger=0 rides along as context, trigger=1 is the wake-eligible row.
    // The poll loop's gate depends on this data contract.
    insertMessage('m1', 'chat', { sender: 'A', text: 'chit chat' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'actual mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages).toHaveLength(2);
    const byId = Object.fromEntries(messages.map((m) => [m.id, m]));
    expect(byId.m1.trigger).toBe(0);
    expect(byId.m2.trigger).toBe(1);
  });

  it('trigger=0-only batch: gate predicate `some(trigger===1)` is false', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'noise' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'more noise' }, { trigger: 0 });
    const messages = getPendingMessages();
    // This is the exact predicate the poll loop uses to skip accumulate-only
    // batches — gate should be false, so the loop sleeps without waking the agent.
    expect(messages.some((m) => m.trigger === 1)).toBe(false);
  });

  it('mixed batch: gate is true → loop proceeds, accumulated rows ride along', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'earlier chatter' }, { trigger: 0 });
    insertMessage('m2', 'chat', { sender: 'B', text: 'the real mention' }, { trigger: 1 });
    const messages = getPendingMessages();
    expect(messages.some((m) => m.trigger === 1)).toBe(true);
    // Both messages are present for the formatter → agent sees the prior context.
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('trigger column defaults to 1 for legacy inserts without explicit value', () => {
    // The schema default is 1 (see src/db/schema.ts INBOUND_SCHEMA) — existing
    // rows / tests without the column set are effectively wake-eligible.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    const [msg] = getPendingMessages();
    expect(msg.trigger).toBe(1);
  });
});

describe('on_wake filtering', () => {
  it('first poll returns on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('subsequent polls skip on_wake=1 messages', () => {
    insertMessage('m1', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(0);
  });

  it('normal messages returned regardless of isFirstPoll', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'hello' });
    expect(getPendingMessages(true)).toHaveLength(1);

    // Reset: mark completed so we can re-test with a fresh message
    markCompleted(['m1']);
    insertMessage('m2', 'chat', { sender: 'A', text: 'hello again' });
    expect(getPendingMessages(false)).toHaveLength(1);
  });

  it('mixed batch: first poll returns both normal and on_wake messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(true);
    expect(messages).toHaveLength(2);
    expect(messages.map((m) => m.id).sort()).toEqual(['m1', 'm2']);
  });

  it('mixed batch: subsequent poll returns only normal messages', () => {
    insertMessage('m1', 'chat', { sender: 'A', text: 'user msg' });
    insertMessage('m2', 'chat', { sender: 'system', text: 'Resuming.' }, { onWake: 1 });
    const messages = getPendingMessages(false);
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe('m1');
  });

  it('on_wake defaults to 0 for inserts without explicit value', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', '{"text":"hi"}')`,
      )
      .run();
    // Should be returned even on non-first poll (on_wake=0)
    expect(getPendingMessages(false)).toHaveLength(1);
  });
});

describe('routing', () => {
  it('should extract routing from messages', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-123', 'discord', 'thread-456', '{"text":"hi"}')`,
      )
      .run();

    const messages = getPendingMessages();
    const routing = extractRouting(messages);
    expect(routing.platformId).toBe('chan-123');
    expect(routing.channelType).toBe('discord');
    expect(routing.threadId).toBe('thread-456');
    expect(routing.inReplyTo).toBe('m1');
  });
});

describe('origin metadata (from= attribute)', () => {
  function seedDestination(name: string, channelType: string, platformId: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES (?, ?, 'channel', ?, ?, NULL)`,
      )
      .run(name, name, channelType, platformId);
  }

  function insertWithRouting(id: string, kind: string, content: object, channelType: string | null, platformId: string | null): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES (?, ?, datetime('now'), 'pending', ?, ?, ?)`,
      )
      .run(id, kind, platformId, channelType, JSON.stringify(content));
  }

  it('chat message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="discord-main"');
  });

  it('chat message falls back to raw routing when no destination matches', () => {
    insertWithRouting('m1', 'chat', { sender: 'Alice', text: 'hi' }, 'telegram', 'chat-999');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('from="unknown:telegram:chat-999"');
  });

  it('chat message omits from= when routing is null', () => {
    insertMessage('m1', 'chat', { sender: 'Alice', text: 'hi' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).not.toContain('from=');
  });

  it('task message includes from= when destination matches', () => {
    seedDestination('slack-ops', 'slack', 'C-OPS');
    insertWithRouting('t1', 'task', { prompt: 'check status' }, 'slack', 'C-OPS');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).toContain('from="slack-ops"');
  });

  it('task message omits from= when routing is null', () => {
    insertMessage('t1', 'task', { prompt: 'check status' });
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<task');
    expect(prompt).not.toContain('from=');
  });

  it('webhook message includes from= when destination matches', () => {
    seedDestination('github-ch', 'github', 'repo-1');
    insertWithRouting('w1', 'webhook', { source: 'github', event: 'push', payload: {} }, 'github', 'repo-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<webhook');
    expect(prompt).toContain('from="github-ch"');
  });

  it('system message includes from= when destination matches', () => {
    seedDestination('discord-main', 'discord', 'chan-1');
    insertWithRouting('s1', 'system', { action: 'test', status: 'ok', result: null }, 'discord', 'chan-1');
    const prompt = formatMessages(getPendingMessages());
    expect(prompt).toContain('<system_response');
    expect(prompt).toContain('from="discord-main"');
  });
});

describe('mock provider', () => {
  it('should produce init + result events', async () => {
    const provider = new MockProvider({}, (prompt) => `Echo: ${prompt}`);
    const query = provider.query({
      prompt: 'Hello',
      cwd: '/tmp',
    });

    const events: Array<{ type: string }> = [];
    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      events.push(event);
    }

    const typed = events.filter((e) => e.type !== 'activity');
    expect(typed.length).toBeGreaterThanOrEqual(2);
    expect(typed[0].type).toBe('init');
    expect(typed[1].type).toBe('result');
    expect((typed[1] as { text: string }).text).toBe('Echo: Hello');
  });

  it('should handle push() during active query', async () => {
    const provider = new MockProvider({}, (prompt) => `Re: ${prompt}`);
    const query = provider.query({
      prompt: 'First',
      cwd: '/tmp',
    });

    const events: Array<{ type: string; text?: string }> = [];

    setTimeout(() => query.push('Second'), 30);
    setTimeout(() => query.end(), 60);

    for await (const event of query.events) {
      events.push(event);
    }

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(2);
    expect(results[0].text).toBe('Re: First');
    expect(results[1].text).toBe('Re: Second');
  });
});

describe('end-to-end with mock provider', () => {
  it('should read messages_in, process with mock provider, write messages_out', async () => {
    // Insert a chat message into inbound DB
    insertMessage('m1', 'chat', { sender: 'User', text: 'What is 2+2?' });

    // Read and process
    const messages = getPendingMessages();
    expect(messages).toHaveLength(1);

    const routing = extractRouting(messages);
    const prompt = formatMessages(messages);

    // Create mock provider and run query
    const provider = new MockProvider({}, () => 'The answer is 4');
    const query = provider.query({
      prompt,
      cwd: '/tmp',
    });

    // Process events — simulate what poll-loop does
    const { markProcessing } = await import('./db/messages-in.js');
    const { writeMessageOut } = await import('./db/messages-out.js');

    markProcessing(['m1']);

    setTimeout(() => query.end(), 50);

    for await (const event of query.events) {
      if (event.type === 'result' && event.text) {
        writeMessageOut({
          id: `out-${Date.now()}`,
          in_reply_to: routing.inReplyTo,
          kind: 'chat',
          platform_id: routing.platformId,
          channel_type: routing.channelType,
          thread_id: routing.threadId,
          content: JSON.stringify({ text: event.text }),
        });
      }
    }

    markCompleted(['m1']);

    // Verify: message was processed (not pending, acked in processing_ack)
    const processed = getPendingMessages();
    expect(processed).toHaveLength(0);

    // Verify: response was written to outbound DB
    const outMessages = getUndeliveredMessages();
    expect(outMessages).toHaveLength(1);
    expect(JSON.parse(outMessages[0].content).text).toBe('The answer is 4');
    expect(outMessages[0].in_reply_to).toBe('m1');
  });
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

const ERR_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

describe('error result with no <message> envelope', () => {
  it('delivers a budget/billing error to the triggering channel and does not nudge', async () => {
    const budgetText = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query, pushes } = makeResultQuery({ type: 'result', text: budgetText, isError: true });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(budgetText);
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });

  it('still nudges (and does not deliver) a normal unwrapped result', async () => {
    const { query, pushes } = makeResultQuery({ type: 'result', text: 'bare text, no envelope' });

    await processQuery(query, ERR_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages()).toHaveLength(0);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('was not delivered');
  });
});

describe('isCorruptionError', () => {
  it('matches the Docker Desktop macOS torn-read symptom', () => {
    expect(isCorruptionError('database disk image is malformed')).toBe(true);
  });

  it('matches wrapped SQLite corruption codes', () => {
    expect(isCorruptionError('SqliteError: SQLITE_CORRUPT_VTAB: ...')).toBe(true);
    expect(isCorruptionError('file is not a database')).toBe(true);
  });

  it('returns false for unrelated errors', () => {
    expect(isCorruptionError('database is locked')).toBe(false);
    expect(isCorruptionError('no such table: messages_in')).toBe(false);
    expect(isCorruptionError('')).toBe(false);
  });
});

// --- Task-run turn wiring: the REAL processQuery path (one-door) ---
// These drive the actual call sites (autoAppendTaskLog at result-handling,
// shouldNudgeTaskBlocks gating, and follow-up turn reset). Deleting the wiring
// — not just the helpers — goes red here.

const TASK_ROUTING = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

function taskLogRows(): Array<{ text: string }> {
  return (
    getOutboundDb()
      .prepare("SELECT content FROM messages_out WHERE kind = 'task_log' ORDER BY seq")
      .all() as Array<{ content: string }>
  ).map((r) => JSON.parse(r.content) as { text: string });
}

describe('task-run turn wiring (real processQuery)', () => {
  it('auto-appends the final text as a task_log row', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'checked feeds — nothing new' };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const logs = taskLogRows();
    expect(logs).toHaveLength(1);
    expect(logs[0].text).toBe('checked feeds — nothing new');
    // and nothing was delivered as chat
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });

  it('logs and conditionally nudges a second task run in the same open query', async () => {
    const pushes: string[] = [];

    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1 uses the legacy wrong door and consumes its one correction.
      yield { type: 'result', text: '<message to="local-cli">fire one result</message>' };
      yield { type: 'result', text: 'first delivery decision handled' };

      // A SECOND task run lands while the query is open — the follow-up poller
      // pushes it and must reset the per-turn correction state.
      insertMessage('t2', 'task', { prompt: 'fire two' });
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('fire two')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }

      // Turn 2 repeats the mistake. This receives a second independent nudge
      // only if the follow-up path reset taskBlockNudged.
      yield { type: 'result', text: '<message to="local-cli">fire two result</message>' };
      yield { type: 'result', text: 'second delivery decision handled' };
    }

    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined);

    const nudges = pushes.filter((p) => p.includes('If and only if'));
    expect(nudges).toHaveLength(2);
    expect(nudges[0]).toContain('fire one result');
    expect(nudges[1]).toContain('fire two result');

    const logs = taskLogRows().map((l) => l.text);
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('[undelivered → local-cli] fire one result');
    expect(logs[1]).toContain('[undelivered → local-cli] fire two result');
    expect(logs).not.toContain('first delivery decision handled');
    expect(logs).not.toContain('second delivery decision handled');
  });
});


describe('turn-generation routing (regression)', () => {
  // Incident shape: several batches pushed into a single long turn get
  // answered by ONE result. A flat one-shift-per-result queue (or routing
  // frozen at processQuery entry) leaves stale entries that mis-route later
  // results — observed in production as replies delivered to a disconnected
  // channel hours after its batches were answered. The observable door here
  // is the error-result delivery (deliverErrorResult), which routes by the
  // current turn generation.

  function insertRouted(id: string, channelType: string, platformId: string, text: string) {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, on_wake, platform_id, channel_type, thread_id, content)
         VALUES (?, 'chat', datetime('now'), 'pending', 1, 0, ?, ?, NULL, ?)`,
      )
      .run(id, platformId, channelType, JSON.stringify({ sender: 'S', text }));
  }

  /**
   * Query stub with manual result control: pushes are recorded (and NOT
   * auto-answered), results emit only when the test calls emitResult —
   * mirroring an SDK turn that consumes every queued push at once.
   */
  function makeSteppedQuery(): {
    query: AgentQuery;
    pushes: string[];
    emitResult: (text: string, isError?: boolean) => void;
    finish: () => void;
  } {
    const pushes: string[] = [];
    const queued: ProviderEvent[] = [];
    let waiting: (() => void) | null = null;
    let finished = false;
    const wake = (): void => {
      waiting?.();
      waiting = null;
    };
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      for (;;) {
        while (queued.length > 0) yield queued.shift()!;
        if (finished) return;
        await new Promise<void>((res) => {
          waiting = res;
        });
      }
    }
    return {
      pushes,
      emitResult: (text: string, isError?: boolean) => {
        queued.push(isError ? { type: 'result', text, isError: true } : { type: 'result', text });
        wake();
      },
      finish: () => {
        finished = true;
        wake();
      },
      query: {
        push: (m: string) => {
          pushes.push(m);
        },
        end: () => {
          finished = true;
          wake();
        },
        events: events(),
        abort: () => {
          finished = true;
          wake();
        },
      },
    };
  }

  async function waitFor(cond: () => boolean, timeoutMs = 4000): Promise<void> {
    const start = Date.now();
    while (!cond()) {
      if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
      await new Promise((res) => setTimeout(res, 50));
    }
  }

  const textOuts = () =>
    getUndeliveredMessages()
      .map((m) => ({ row: m, body: JSON.parse(m.content) as { text?: string } }))
      .filter((m) => typeof m.body.text === 'string' && m.body.text.length > 0);

  it('a coalesced multi-push turn leaves no stale entries to hijack a later error notice', async () => {
    const cliRouting = { platformId: 'local', channelType: 'cli', threadId: null, inReplyTo: 'm0' };
    const { query, pushes, emitResult, finish } = makeSteppedQuery();
    const run = processQuery(query, cliRouting, ['m0'], 'claude', undefined, 'prompt', undefined);

    // Two Telegram batches ride into the active turn (separate poll ticks) —
    // the SDK will answer BOTH with the next single result.
    insertRouted('t1', 'telegram', 'tg-dm', 'question one');
    await waitFor(() => pushes.length >= 1);
    insertRouted('t2', 'telegram', 'tg-dm', 'question two');
    await waitFor(() => pushes.length >= 2);

    // Turn 1 ends answering the ORIGINAL cli batch; nothing user-visible.
    emitResult('<internal>opener handled</internal>');
    // Turn 2 answers BOTH telegram batches at once.
    emitResult('<internal>both questions handled via send_message</internal>');
    // Turn 3: a non-retryable provider error with no <message> envelope. The
    // notice must reach the channel of the CURRENT generation lineage
    // (telegram, via latest-batch fallback) — not the cli channel that
    // opened the query (frozen routing) or a stale FIFO leftover.
    insertRouted('t3', 'telegram', 'tg-dm', 'still there?');
    await waitFor(() => pushes.length >= 3);
    emitResult('Credit balance too low to continue.', true);
    await waitFor(() => textOuts().length >= 1);

    const notice = textOuts()[0];
    expect(notice.row.channel_type).toBe('telegram');
    expect(notice.row.platform_id).toBe('tg-dm');
    expect(notice.row.in_reply_to).toBe('t3');

    finish();
    await run;
  });

  it('spurious extra result falls back to the latest batch, not the query-opening channel', async () => {
    const discordRouting = { platformId: 'chan-old', channelType: 'discord', threadId: null, inReplyTo: 'm0' };
    const { query, pushes, emitResult, finish } = makeSteppedQuery();
    const run = processQuery(query, discordRouting, ['m0'], 'claude', undefined, 'prompt', undefined);

    emitResult('<internal>opener handled</internal>');
    insertRouted('t1', 'telegram', 'tg-dm', 'ping');
    await waitFor(() => pushes.length >= 1);
    emitResult('<internal>answered</internal>');
    // Generation is now empty; an extra error result must use latest-batch
    // routing, not revive the channel that opened the query.
    emitResult('Gateway unreachable.', true);
    await waitFor(() => textOuts().length >= 1);

    const notice = textOuts()[0];
    expect(notice.row.channel_type).toBe('telegram');

    finish();
    await run;
  });

  it('negative control: one-result-per-push does not over-rotate into misdelivery', async () => {
    const tgRouting = { platformId: 'tg-dm', channelType: 'telegram', threadId: null, inReplyTo: 'm0' };
    const { query, pushes, emitResult, finish } = makeSteppedQuery();
    const run = processQuery(query, tgRouting, ['m0'], 'claude', undefined, 'prompt', undefined);

    insertRouted('c1', 'cli', 'local', 'question one');
    await waitFor(() => pushes.length >= 1);
    emitResult('<internal>opener handled</internal>');
    insertRouted('c2', 'cli', 'local', 'question two');
    await waitFor(() => pushes.length >= 2);
    emitResult('<internal>answer one</internal>');
    // Current generation is [c2]; an error now belongs to the cli channel.
    emitResult('Provider quota exhausted.', true);
    await waitFor(() => textOuts().length >= 1);

    expect(textOuts()[0].row.channel_type).toBe('cli');

    finish();
    await run;
  });
});
