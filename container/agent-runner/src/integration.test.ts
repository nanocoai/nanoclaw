import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { getContinuation, setContinuation } from './db/session-state.js';
import { MockProvider } from './providers/mock.js';
import type { ProviderExchange } from './providers/types.js';
import { runPollLoop } from './poll-loop.js';
import {
  registerFollowupDrop,
  registerFollowupEndStream,
  __resetFollowupHooksForTest,
} from './poll-loop-extensions.js';

beforeEach(() => {
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

function insertMessage(id: string, content: object, opts?: { platformId?: string; channelType?: string; threadId?: string }) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('should pick up a message, process it, and write a response', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'What is the meaning of life?' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' });

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage('m-discord', { sender: 'Alice', text: 'from discord' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' });
    insertMessage('m-slack', { sender: 'Bob', text: 'from slack' }, { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' });

    // Agent replies to both destinations
    const provider = new MockProvider({}, () =>
      '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text produces no outbound messages (scratchpad only)', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    // Agent responds with bare text — no <message to="..."> wrapping
    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait long enough for the poll loop to process
    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    // Only the valid destination should produce output
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage('m1', { sender: 'Alice', text: 'tell slack' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' });

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage('m-old', { sender: 'Alice', text: 'old' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' });
    insertMessage('m-new', { sender: 'Alice', text: 'new' }, { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' });

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('handles mixed task + chat batch with correct origin metadata', async () => {
    // Seed destination for routing lookup
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    // Task with same routing — simulates a scheduled task in a channel session
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-1');

    await loopPromise.catch(() => {});
  });

});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  // Own an internal stop signal so an abandoned loop ALWAYS exits — on caller abort AND on
  // timeout. MockProvider's stream stays open, so a loop left running with a non-aborted
  // signal keeps an active follow-up poll and steals the next test's messages (see the
  // PollLoopConfig.signal note). The pristine helper only aborted on caller abort, so a test
  // that relied on the timeout leaked a message-stealing poller — a cross-test flake that
  // only surfaced under slow CI scheduling.
  const stop = new AbortController();
  if (signal.aborted) stop.abort();
  else signal.addEventListener('abort', () => stop.abort());
  return Promise.race([
    runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/tmp',
      signal: stop.signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) =>
      setTimeout(() => {
        stop.abort();
        reject(new Error('timeout'));
      }, timeoutMs),
    ),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — exchange hook (onExchangeComplete)', () => {
  // A provider that declares the per-exchange hook. The hook call is the
  // wiring under test — these tests go red if the poll-loop seam is severed.
  // What the provider DOES with an exchange (e.g. write markdown into
  // conversations/) ships with the provider, not the runner.
  class HookedMockProvider extends MockProvider {
    readonly exchanges: ProviderExchange[] = [];
    onExchangeComplete(exchange: ProviderExchange): void {
      this.exchanges.push(exchange);
    }
  }

  it('reports each exchange to a provider that declares the hook', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'please archive this' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new HookedMockProvider({}, () => '<message to="discord-test">archived answer</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.exchanges.length > 0, 2000);
    controller.abort();

    expect(provider.exchanges.length).toBe(1);
    const exchange = provider.exchanges[0];
    expect(exchange.prompt).toContain('please archive this');
    expect(exchange.result).toContain('archived answer');
    expect(exchange.continuation).toStartWith('mock-session-');
    expect(exchange.status).toBe('completed');

    await loopPromise.catch(() => {});
  });

  it('does not report the internal wrapping-retry nudge as a user prompt', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'wrap this later' }, { platformId: 'chan-1', channelType: 'discord' });

    let calls = 0;
    const provider = new HookedMockProvider({}, () => {
      calls += 1;
      // First result is unwrapped (triggers the retry nudge), second is wrapped.
      return calls === 1 ? 'unwrapped text' : '<message to="discord-test">wrapped now</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => provider.exchanges.length >= 2, 3000);
    controller.abort();

    // Both exchanges attribute themselves to the real user prompt, never the nudge.
    for (const exchange of provider.exchanges) {
      expect(exchange.prompt).not.toContain('Your response was not delivered');
      expect(exchange.prompt).toContain('wrap this later');
    }
    expect(provider.exchanges.map((e) => e.status)).toEqual(['undelivered', 'completed']);

    await loopPromise.catch(() => {});
  });

  it('a throwing hook never breaks delivery', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'still deliver this' }, { platformId: 'chan-1', channelType: 'discord' });

    class ThrowingHookProvider extends MockProvider {
      onExchangeComplete(): void {
        throw new Error('hook exploded');
      }
    }
    const provider = new ThrowingHookProvider({}, () => '<message to="discord-test">delivered anyway</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('delivered anyway');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — provider error recovery', () => {
  it('writes error to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('API rate limit exceeded');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');
    expect(JSON.parse(out[0].content).text).toContain('API rate limit exceeded');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // Error was written to outbound
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toContain('Error:');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
class ThrowingProvider {
  readonly supportsNativeSlashCommands = false;
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  readonly supportsNativeSlashCommands = false;

  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}

describe('poll loop — slash command during active query', () => {
  it('aborts the active query when /clear arrives as a follow-up', async () => {
    insertMessage('m-active', { sender: 'Alice', text: 'long running request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => provider.queries === 1, 2000);
    insertMessage('m-clear-active', { sender: 'Alice', text: '/clear' }, { platformId: 'chan-1', channelType: 'discord' });

    await waitFor(() => provider.aborts === 1, 2000);
    await waitFor(
      () => getUndeliveredMessages().some((msg) => JSON.parse(msg.content).text === 'Session cleared.'),
      2000,
    );
    controller.abort();

    expect(provider.ends).toBe(0);
    expect(getContinuation('mock')).toBeUndefined();
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — test helper loop isolation', () => {
  // Guards the property the PollLoopConfig.signal comment promises: an abandoned loop
  // must stop, not "poll forever and steal messages from the next test's DB". MockProvider's
  // stream stays open, so a loop whose caller relied on the helper TIMEOUT (never called
  // controller.abort()) keeps an active follow-up poll. Before the fix it grabbed the next
  // message a later test inserted — the exact cross-test flake that made the '/clear during
  // active query' test fail under slow CI scheduling (confirmed via CI instrumentation).
  it('a loop the caller let time out does not steal a later message', async () => {
    insertMessage('m-keepalive', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });
    const orphan = new MockProvider({}, () => 'thinking, no reply');
    const orphanController = new AbortController();
    // Caller never aborts — it lets the helper's timeout end the await (a real pattern).
    await runPollLoopWithTimeout(orphan, orphanController.signal, 600).catch(() => {});

    // A fresh /clear must remain pending for a real loop to handle. A still-polling abandoned
    // loop would grab it: abort its own stream, write "Session cleared.", and ack the row.
    insertMessage('m-clear-orphan', { sender: 'Alice', text: '/clear' }, { platformId: 'chan-1', channelType: 'discord' });
    await sleep(1200); // > 2 follow-up poll intervals — ample time for a leftover loop to steal

    const stillPending = getPendingMessages().some((m) => m.id === 'm-clear-orphan');
    const sessionCleared = getUndeliveredMessages().some((msg) => JSON.parse(msg.content).text === 'Session cleared.');
    orphanController.abort(); // clean up regardless of outcome
    await sleep(50);

    expect(sessionCleared).toBe(false); // the abandoned loop must not have processed /clear
    expect(stillPending).toBe(true); // /clear stays pending for a real loop
  });
});

/**
 * Provider whose query never completes until ended/aborted — for testing how
 * the loop interrupts an active stream.
 */
class BlockingProvider {
  readonly supportsNativeSlashCommands = false;
  queries = 0;
  aborts = 0;
  ends = 0;

  isSessionInvalid(): boolean {
    return false;
  }

  query() {
    const owner = this;
    this.queries += 1;
    let wake: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    return {
      push() {},
      end: () => {
        owner.ends += 1;
        ended = true;
        wake?.();
      },
      abort: () => {
        owner.aborts += 1;
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'blocking-session' };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })(),
    };
  }
}

/**
 * Follow-up interceptor seam — the cross-turn partner of the main turn
 * interceptor, exercised through processQuery's inner poll via the BlockingProvider
 * (a stream that stays open until end()/abort()). Hooks are registered inline and
 * reset in afterEach (self-contained — the apply* are only called by the poll).
 */
describe('poll loop — follow-up interceptor seam', () => {
  afterEach(() => __resetFollowupHooksForTest());

  function ackStatus(id: string): string | undefined {
    const row = getOutboundDb()
      .prepare('SELECT status FROM processing_ack WHERE message_id = ?')
      .get(id) as { status: string } | undefined;
    return row?.status;
  }

  it('DROP hook markCompletes the claimed follow-up rows and leaves the stream open', async () => {
    // A drop hook claims external-flagged follow-up rows (they belong to a confined turn).
    registerFollowupDrop((ctx) =>
      ctx.pending.filter((m) => JSON.parse(m.content).text === 'external').map((m) => m.id),
    );
    insertMessage('m-active', { sender: 'Alice', text: 'long request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => provider.queries === 1, 2000);
    insertMessage('m-ext', { sender: 'Ext', text: 'external' }, { platformId: 'chan-1', channelType: 'discord' });

    // The dropped row is markCompleted (acked completed), never re-read, never pushed.
    await waitFor(() => ackStatus('m-ext') === 'completed', 2000);
    expect(provider.ends).toBe(0); // drop does NOT end the stream
    expect(provider.aborts).toBe(0); // and does NOT abort it

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('END-STREAM hook ends (NOT aborts) the active stream so the in-flight reply is not discarded', async () => {
    // An end-stream hook decides any follow-up crosses a turn boundary → end() the stream.
    registerFollowupEndStream(() => true);
    insertMessage('m-active', { sender: 'Alice', text: 'long request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => provider.queries === 1, 2000);
    insertMessage('m-boundary', { sender: 'Bob', text: 'crosses boundary' }, { platformId: 'chan-1', channelType: 'discord' });

    await waitFor(() => provider.ends === 1, 2000);
    // query.end(), NOT abort — abort would discard the in-flight turn's reply (the Q-B regression).
    expect(provider.aborts).toBe(0);

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('accumulate gate: a trigger=0 context-only follow-up is left PENDING, never pushed/processed', async () => {
    // Mirrors the main read's accumulate gate: a follow-up batch with only trigger=0 rows must not
    // wake/push the active turn ("store as context, don't engage"). Without the follow-up gate it
    // would be markProcessing'd here and dropped from the next real accumulate batch.
    insertMessage('m-active', { sender: 'Alice', text: 'long request' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new BlockingProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2500);

    await waitFor(() => provider.queries === 1, 2000);
    // a trigger=0 (accumulate) context row arrives mid-stream
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, trigger, content)
         VALUES ('m-ctx', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', 0, ?)`,
      )
      .run(JSON.stringify({ sender: 'C', text: 'background chatter' }));

    await new Promise((r) => setTimeout(r, 700)); // let the follow-up poll tick a couple of times
    // NOT processed: still pending (never markProcessing'd), so it can ride the next trigger=1 batch.
    expect(getPendingMessages().map((m) => m.id)).toContain('m-ctx');
    expect(ackStatus('m-ctx')).toBeUndefined();

    controller.abort();
    await loopPromise.catch(() => {});
  });
});
