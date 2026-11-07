import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { AgentProvider, ProviderEvent, QueryInput } from './providers/types.js';
import {
  registerTurnHook,
  runBeforeTurn,
  runOnError,
  runPrepareQuery,
  runProviderEvent,
  type TurnContext,
  type TurnHook,
} from './turn-hooks.js';

const routing = { platformId: 'channel-1', channelType: 'slack', threadId: null } as unknown as RoutingContext;
const input: QueryInput = { prompt: 'hello', cwd: '/workspace/agent' };

let unregister: Array<() => void> = [];
function register(hook: TurnHook): void {
  unregister.push(registerTurnHook(hook));
}

function context(): TurnContext {
  return { messages: [], routing, followUp: false };
}

afterEach(() => {
  for (const off of unregister) off();
  unregister = [];
});

describe('turn hook registry', () => {
  it('runs every hook point in registration order', async () => {
    const calls: string[] = [];
    for (const name of ['first', 'second']) {
      register({
        name,
        beforeTurn: () => void calls.push(`${name}.beforeTurn`),
        prepareQuery: () => void calls.push(`${name}.prepareQuery`),
        onProviderEvent: () => void calls.push(`${name}.onProviderEvent`),
        onError: () => void calls.push(`${name}.onError`),
      });
    }

    await runBeforeTurn(context());
    await runPrepareQuery(input, context());
    runProviderEvent({ type: 'activity' }, routing);
    await runOnError(new Error('boom'), context());

    expect(calls).toEqual([
      'first.beforeTurn',
      'second.beforeTurn',
      'first.prepareQuery',
      'second.prepareQuery',
      'first.onProviderEvent',
      'second.onProviderEvent',
      'first.onError',
      'second.onError',
    ]);
  });

  it('isolates a throwing or rejecting hook from the hooks after it', async () => {
    const calls: string[] = [];
    register({
      name: 'broken',
      beforeTurn: () => {
        throw new Error('sync');
      },
      prepareQuery: async () => {
        throw new Error('async');
      },
      onProviderEvent: async () => {
        throw new Error('rejected');
      },
      onError: () => {
        throw new Error('sync');
      },
    });
    register({
      name: 'healthy',
      beforeTurn: () => void calls.push('beforeTurn'),
      prepareQuery: (current) => ({ ...current, prompt: `${current.prompt}!` }),
      onProviderEvent: () => void calls.push('onProviderEvent'),
      onError: () => void calls.push('onError'),
    });

    await runBeforeTurn(context());
    const prepared = await runPrepareQuery(input, context());
    runProviderEvent({ type: 'activity' }, routing);
    await runOnError(new Error('boom'), context());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(prepared.prompt).toBe('hello!');
    expect(calls).toEqual(['beforeTurn', 'onProviderEvent', 'onError']);
  });

  it('chains prepareQuery results and keeps the input when a hook returns nothing', async () => {
    register({ name: 'observer', prepareQuery: () => {} });
    register({ name: 'model', prepareQuery: (current) => ({ ...current, systemContext: { instructions: 'x' } }) });
    register({
      name: 'prompt',
      prepareQuery: (current) => ({ ...current, prompt: `${current.systemContext?.instructions}` }),
    });

    expect(await runPrepareQuery(input, context())).toEqual({
      prompt: 'x',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'x' },
    });
  });

  it('passes the input through untouched with no hooks registered', async () => {
    expect(await runPrepareQuery(input, context())).toBe(input);
  });

  it('rejects a duplicate name and stops running a hook once unregistered', async () => {
    const calls: string[] = [];
    const off = registerTurnHook({ name: 'once', beforeTurn: () => void calls.push('once') });
    expect(() => registerTurnHook({ name: 'once' })).toThrow('Turn hook already registered: once');
    await runBeforeTurn(context());
    off();
    await runBeforeTurn(context());
    expect(calls).toEqual(['once']);
  });
});

describe('poll loop turn hooks', () => {
  beforeEach(() => {
    initTestSessionDb();
    getInboundDb().exec(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id)
       VALUES ('main', 'Main', 'channel', 'slack', 'channel-1')`,
    );
  });
  afterEach(() => closeSessionDb());

  function insertMessage(id: string, text: string): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
         VALUES (?, 'chat', ?, 'pending', 1, 'channel-1', 'slack', 'thread-1', ?)`,
      )
      .run(id, new Date().toISOString(), JSON.stringify({ sender: 'Ann', text }));
  }

  async function waitFor(predicate: () => boolean): Promise<void> {
    const deadline = Date.now() + 2500;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the poll loop');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  function provider(
    events: (pushes: string[]) => AsyncGenerator<ProviderEvent>,
    queries: QueryInput[],
    pushes: string[],
  ): AgentProvider {
    return {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: (queryInput) => {
        queries.push(queryInput);
        return { events: events(pushes), push: (prompt) => pushes.push(prompt), end: () => {}, abort: () => {} };
      },
    };
  }

  it('lets hooks rewrite messages, adjust the query input and observe events for opening and follow-up turns', async () => {
    const seen: Array<{ ids: string[]; followUp: boolean }> = [];
    const events: string[] = [];
    register({
      name: 'enrich',
      beforeTurn: (ctx) => {
        seen.push({ ids: ctx.messages.map((m) => m.id), followUp: ctx.followUp });
        for (const row of ctx.messages) {
          row.content = JSON.stringify({ sender: 'Ann', text: `enriched ${row.id}` });
        }
      },
      prepareQuery: (current) => ({ ...current, systemContext: { instructions: 'from hook' } }),
      onProviderEvent: (event) => void events.push(event.type),
    });

    const controller = new AbortController();
    const queries: QueryInput[] = [];
    const pushes: string[] = [];
    insertMessage('m1', 'original');
    const loop = runPollLoop({
      provider: provider(
        async function* (pushed) {
          yield { type: 'init', continuation: 'hook-session' };
          yield { type: 'result', text: '' };
          insertMessage('m2', 'second');
          await waitFor(() => pushed.length === 1);
          yield { type: 'result', text: '' };
          controller.abort();
        },
        queries,
        pushes,
      ),
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });
    await loop;

    expect(seen).toEqual([
      { ids: ['m1'], followUp: false },
      { ids: ['m2'], followUp: true },
    ]);
    expect(queries).toHaveLength(1);
    expect(queries[0].systemContext).toEqual({ instructions: 'from hook' });
    expect(queries[0].prompt).toContain('enriched m1');
    expect(queries[0].prompt).not.toContain('original');
    expect(pushes[0]).toContain('enriched m2');
    expect(events).toEqual(['init', 'result', 'result']);
  });

  it('reports a query error to onError without changing the loop outcome', async () => {
    const errors: string[] = [];
    register({
      name: 'errors',
      onError: (err, ctx) => void errors.push(`${ctx.messages[0]?.id}: ${(err as Error).message}`),
    });
    register({
      name: 'broken',
      onError: () => {
        throw new Error('hook failed');
      },
    });

    const controller = new AbortController();
    insertMessage('m1', 'hi');
    await runPollLoop({
      provider: provider(
        async function* () {
          controller.abort();
          throw new Error('provider failed');
        },
        [],
        [],
      ),
      providerName: 'mock',
      cwd: '/workspace/agent',
      signal: controller.signal,
    });

    expect(errors).toEqual(['m1: provider failed']);
  });
});
