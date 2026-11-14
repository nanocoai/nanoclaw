import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { CodexProvider, type CodexRuntimeDeps } from './codex.js';
import type { AppServer, JsonRpcNotification, TurnParams } from './codex-app-server.js';
import type { ProviderEvent } from './types.js';

const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

function createCodexProvider(...args: ConstructorParameters<typeof CodexProvider>): CodexProvider {
  const provider = new CodexProvider(...args);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

describe('CodexProvider active turns', () => {
  it('steers follow-ups into the active turn and yields liveness activity', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.push('follow-up prompt');
    await waitFor(() => fake.steerCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');

    await collect;

    expect(fake.startCalls).toHaveLength(1);
    expect(fake.startCalls[0].inputText).toBe('first prompt');
    expect(fake.steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', inputText: 'follow-up prompt' }]);
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThanOrEqual(2);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
    expect(fake.killed).toBe(true);
  });

  it('queues follow-ups for the next turn when steering is rejected', async () => {
    const fake = createFakeCodexRuntime({ rejectSteer: true });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.push('queued follow-up');
    await waitFor(() => fake.steerCalls.length === 1);
    await sleep(0);

    fake.completeTurn('first answer');
    await waitFor(() => fake.startCalls.length === 2);
    query.end();
    fake.completeTurn('second answer');

    await collect;

    expect(fake.startCalls.map((call) => call.inputText)).toEqual(['first prompt', 'queued follow-up']);
    expect(fake.steerCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'second answer' },
    ]);
  });

  it('queues a follow-up that races turn completion into a new turn, never steering the finished turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);

    // The turn completes, then a follow-up lands in the same tick — before the
    // generator has drained and torn the turn down. codex's turn/steer no-ops
    // on a finished turn (resolves without error), so steering here would drop
    // the message silently. It must start a fresh turn instead.
    fake.completeTurn('first answer');
    query.push('racing follow-up');

    await waitFor(() => fake.startCalls.length === 2);
    query.end();
    fake.completeTurn('second answer');

    await collect;

    expect(fake.steerCalls).toHaveLength(0);
    expect(fake.startCalls.map((call) => call.inputText)).toEqual(['first prompt', 'racing follow-up']);
    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'second answer' },
    ]);
  });

  it('interrupts the active turn and closes the stream on abort', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.abort();

    await collect;

    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(fake.killed).toBe(true);
  });

  it('threads the configured model and effort into the turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({ model: 'gpt-5.5', effort: 'high' }, fake.runtime);
    const query = provider.query({ prompt: 'first prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');

    await collect;

    expect(fake.startCalls[0].model).toBe('gpt-5.5');
    expect(fake.startCalls[0].effort).toBe('high');
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
  });

  it('delivers harness-generated images as file events — the model never sends them itself', async () => {
    const codexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-home-'));
    const prevHome = process.env.CODEX_HOME;
    process.env.CODEX_HOME = codexHome;
    try {
      const fake = createFakeCodexRuntime();
      const provider = createCodexProvider({}, fake.runtime);
      const query = provider.query({ prompt: 'make an image', cwd: '/workspace/agent' });
      const events: ProviderEvent[] = [];
      const collect = collectEvents(query.events, events);

      await waitFor(() => fake.startCalls.length === 1);
      // Codex's built-in image_gen writes into CODEX_HOME mid-turn.
      const imagesDir = path.join(codexHome, 'generated_images', 'thread-1');
      fs.mkdirSync(imagesDir, { recursive: true });
      fs.writeFileSync(path.join(imagesDir, 'ig_abc.png'), 'png-bytes');

      query.end();
      fake.completeTurn('Here you go — created the image.');
      await collect;

      const files = events.filter((event) => event.type === 'file') as Array<{ type: 'file'; path: string }>;
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(path.join(imagesDir, 'ig_abc.png'));
      // file events arrive before the result so delivery shares the turn.
      expect(events.findIndex((e) => e.type === 'file')).toBeLessThan(events.findIndex((e) => e.type === 'result'));
    } finally {
      if (prevHome === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = prevHome;
      fs.rmSync(codexHome, { recursive: true, force: true });
    }
  });

  it("keeps a sub-agent's events out of the parent turn: no early end, no result text, no turn takeover", async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delegate this', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    const activityBefore = events.filter((event) => event.type === 'activity').length;

    // Codex attaches every spawned sub-agent thread to this connection, so the
    // child's lifecycle arrives on the same stream, tagged with its own threadId.
    fake.notify('turn/started', { threadId: 'child-thread', turn: { id: 'child-turn' } });
    fake.notify('item/agentMessage/delta', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      itemId: 'm1',
      delta: 'child ',
    });
    fake.notify('item/completed', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      item: { type: 'agentMessage', text: 'child answer' },
    });
    fake.notify('error', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      willRetry: false,
      error: { message: 'child failed' },
    });
    fake.notify('turn/completed', {
      threadId: 'child-thread',
      turn: { id: 'child-turn', items: [{ type: 'agentMessage', text: 'child answer' }] },
    });
    // Child work still counts as liveness for the parent.
    await waitFor(() => events.filter((event) => event.type === 'activity').length >= activityBefore + 5);

    // The parent turn is still the active one: a follow-up steers into it.
    query.push('follow-up');
    await waitFor(() => fake.steerCalls.length === 1);
    query.end();
    fake.completeTurn('parent answer');
    await collect;

    expect(fake.startCalls).toHaveLength(1);
    expect(fake.steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', inputText: 'follow-up' }]);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'parent answer' }]);
  });

  it("never reports a sub-agent's text as the result of a parent turn that ends without a message", async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delegate this', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('item/agentMessage/delta', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      itemId: 'm1',
      delta: 'child text',
    });
    fake.notify('item/completed', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      item: { type: 'agentMessage', text: 'child answer' },
    });
    query.end();
    // Codex sends turn.items only when the turn produced an agent message.
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', items: [] } });
    await collect;

    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: null }]);
  });

  it("interrupts the parent turn on abort, not a sub-agent's turn", async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delegate this', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('turn/started', { threadId: 'child-thread', turn: { id: 'child-turn' } });
    await sleep(0);
    query.abort();
    await collect;

    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
  });

  it('ends the turn immediately with the real cause when the app-server dies mid-turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);

    // No pending request exists mid-turn (turn/start already resolved), so
    // only the exitHandlers seam can end the turn — without it this parks
    // on the waker until the inactivity watchdog expires.
    fake.crashServer(new Error('Codex app-server exited: code=1 signal=null'));

    // The generator yields the error event, then rethrows to its consumer.
    await collect.catch(() => {});

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('app-server exited');
  });
});

// Drive the production watchdog with a monotonic clock, without waiting minutes
// or replacing the provider/event stream under test.
async function withWatchdog(
  check: (
    f: ReturnType<typeof createFakeCodexRuntime> & {
      query: ReturnType<CodexProvider['query']>;
      events: ProviderEvent[];
      tick(ms: number): Promise<void>;
      outcome(): Error | undefined;
    },
  ) => Promise<void>,
) {
  let now = 0;
  let tick: (() => void) | undefined;
  const clock = spyOn(performance, 'now').mockImplementation(() => now);
  const interval = spyOn(globalThis, 'setInterval').mockImplementation(((callback: () => void) => {
    tick = callback;
    return 987654;
  }) as typeof setInterval);
  const clear = spyOn(globalThis, 'clearInterval').mockImplementation(() => {});
  const deadlines = new Map<number, { at: number; callback: () => void }>();
  let nextTimer = 100;
  const timeout = spyOn(globalThis, 'setTimeout').mockImplementation(((callback: () => void, ms: number) => {
    const id = nextTimer++;
    deadlines.set(id, { at: now + ms, callback });
    return id;
  }) as typeof setTimeout);
  const clearTimeoutSpy = spyOn(globalThis, 'clearTimeout').mockImplementation((id) => {
    deadlines.delete(Number(id));
  });
  const fake = createFakeCodexRuntime();
  const query = createCodexProvider({}, fake.runtime).query({ prompt: 'long task', cwd: '/workspace/agent' });
  const events: ProviderEvent[] = [];
  let failure: Error | undefined;
  const collect = collectEvents(query.events, events).catch((error: Error) => {
    failure = error;
  });
  try {
    for (let attempt = 0; fake.startCalls.length === 0 && attempt < 100; attempt++) await Bun.sleep(0);
    expect(fake.startCalls).toHaveLength(1);
    await check({
      ...fake,
      query,
      events,
      outcome: () => failure,
      tick: async (ms) => {
        now += ms;
        for (const [id, deadline] of deadlines) {
          if (deadline.at <= now) {
            deadlines.delete(id);
            deadline.callback();
          }
        }
        tick?.();
        await Bun.sleep(0);
      },
    });
  } finally {
    query.abort();
    await collect;
    const cleared = clear.mock.calls.length;
    clearTimeoutSpy.mockRestore();
    timeout.mockRestore();
    clear.mockRestore();
    interval.mockRestore();
    clock.mockRestore();
    expect(fake.killed).toBe(true);
    if (tick) expect(cleared).toBeGreaterThan(0);
  }
}

const MINUTE = 60_000;
const parentItem = (id: string, type = 'commandExecution') => ({
  threadId: 'thread-1',
  turnId: 'turn-1',
  item: { id, type },
});

describe('Codex turn inactivity watchdog', () => {
  it('keeps an active turn alive overnight without a total-duration cap', async () => {
    await withWatchdog(async (f) => {
      for (let step = 0; step < 60; step++) {
        await f.tick(10 * MINUTE);
        f.notify('item/reasoning/textDelta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'thinking' });
      }
      f.query.end();
      f.completeTurn('done');
      await f.tick(0);
      expect(f.outcome()).toBeUndefined();
      expect(f.events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'done' }]);
    });
  });

  it('times out after 15 minutes of silence even while runner heartbeats are emitted', async () => {
    await withWatchdog(async (f) => {
      await f.tick(14 * MINUTE);
      expect(f.outcome()).toBeUndefined();
      expect(f.events.some((e) => e.type === 'activity')).toBe(true);
      await f.tick(MINUTE);
      expect(f.outcome()?.message).toBe('Codex turn produced no activity for 900000ms; aborted');
      expect(f.events.filter((e) => e.type === 'error')).toHaveLength(1);
      expect(f.events.some((e) => e.type === 'result')).toBe(false);
      expect(f.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    });
  });

  it('resets the idle budget on tool output', async () => {
    await withWatchdog(async (f) => {
      await f.tick(14 * MINUTE);
      f.notify('item/commandExecution/outputDelta', { threadId: 'thread-1', turnId: 'turn-1', delta: 'compiled' });
      await f.tick(14 * MINUTE);
      expect(f.outcome()).toBeUndefined();
      await f.tick(MINUTE);
      expect(f.outcome()?.message).toContain('no activity');
    });
  });

  for (const type of [
    'commandExecution',
    'mcpToolCall',
    'dynamicToolCall',
    'fileChange',
    'webSearch',
    'imageView',
    'imageGeneration',
    'collabAgentToolCall',
    'sleep',
  ]) {
    it(`allows a quiet ${type} beyond the idle budget and remains cancellable`, async () => {
      await withWatchdog(async (f) => {
        f.notify('item/started', parentItem('tool', type));
        const before = f.events.filter((e) => e.type === 'activity').length;
        await f.tick(8 * 60 * MINUTE);
        expect(f.outcome()).toBeUndefined();
        expect(f.events.filter((e) => e.type === 'activity').length).toBeGreaterThan(before);
        f.query.abort();
        await f.tick(0);
        expect(f.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
      });
    });
  }

  it('resumes idle detection only after all tools have completed', async () => {
    await withWatchdog(async (f) => {
      f.notify('item/started', parentItem('a'));
      f.notify('item/started', parentItem('b', 'mcpToolCall'));
      await f.tick(30 * MINUTE);
      f.notify('item/completed', parentItem('a'));
      await f.tick(30 * MINUTE);
      expect(f.outcome()).toBeUndefined();
      f.notify('item/completed', {
        ...parentItem('b', 'mcpToolCall'),
        item: { id: 'b', type: 'mcpToolCall', error: 'tool failed' },
      });
      await f.tick(14 * MINUTE);
      expect(f.outcome()).toBeUndefined();
      await f.tick(MINUTE);
      expect(f.outcome()?.message).toContain('no activity');
    });
  });

  it('does not let unrelated tools, stale turns, or global notifications disable the watchdog', async () => {
    await withWatchdog(async (f) => {
      await f.tick(14 * MINUTE);
      f.notify('item/started', { ...parentItem('foreign'), threadId: 'other-thread' });
      f.notify('item/started', { ...parentItem('stale'), turnId: 'old-turn' });
      f.notify('account/rateLimits/updated', {});
      await f.tick(MINUTE);
      expect(f.outcome()?.message).toContain('no activity');
    });
  });

  it('does not exempt reasoning items as running tools', async () => {
    await withWatchdog(async (f) => {
      f.notify('item/started', parentItem('reasoning', 'reasoning'));
      await f.tick(15 * MINUTE);
      expect(f.outcome()?.message).toContain('no activity');
    });
  });

  it('preserves completion when the watchdog tick races a completed turn', async () => {
    await withWatchdog(async (f) => {
      f.query.end();
      f.completeTurn('done');
      await f.tick(15 * MINUTE);
      expect(f.outcome()).toBeUndefined();
      expect(f.events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'done' }]);
    });
  });

  it('reports server death immediately even with a running tool', async () => {
    await withWatchdog(async (f) => {
      f.notify('item/started', parentItem('tool'));
      f.crashServer(new Error('Codex app-server exited: code=1'));
      await f.tick(0);
      expect(f.outcome()?.message).toContain('app-server exited');
    });
  });
});

function createFakeCodexRuntime(opts: { rejectSteer?: boolean } = {}) {
  const server = fakeServer();
  const startCalls: TurnParams[] = [];
  const steerCalls: Array<{ threadId: string; turnId: string; inputText: string }> = [];
  const interruptCalls: Array<{ threadId: string; turnId: string }> = [];
  let killed = false;

  const notify = (method: string, params?: Record<string, unknown>): void => {
    const notification: JsonRpcNotification = { method, params };
    for (const handler of [...server.notificationHandlers]) handler(notification);
  };

  const runtime: CodexRuntimeDeps = {
    writeCodexConfigToml: () => {},
    spawnCodexAppServer: () => server,
    attachCodexAutoApproval: () => {},
    initializeCodexAppServer: async () => {},
    startOrResumeCodexThread: async (_server, threadId) => threadId ?? 'thread-1',
    startCodexTurn: async (_server, params) => {
      startCalls.push(params);
      const turnId = `turn-${startCalls.length}`;
      notify('turn/started', { threadId: params.threadId, turn: { id: turnId } });
      return turnId;
    },
    steerCodexTurn: async (_server, threadId, turnId, inputText) => {
      steerCalls.push({ threadId, turnId, inputText });
      if (opts.rejectSteer) throw new Error('steer rejected');
    },
    interruptCodexTurn: async (_server, threadId, turnId) => {
      interruptCalls.push({ threadId, turnId });
    },
    killCodexAppServer: () => {
      killed = true;
    },
  };

  return {
    runtime,
    startCalls,
    steerCalls,
    interruptCalls,
    get killed() {
      return killed;
    },
    notify,
    completeTurn(text: string) {
      const threadId = startCalls[startCalls.length - 1]?.threadId;
      notify('turn/completed', { threadId, turn: { items: [{ type: 'agentMessage', text }] } });
    },
    crashServer(err: Error) {
      for (const h of [...server.exitHandlers]) h(err);
    },
  };
}

function fakeServer(): AppServer {
  return {
    process: { stdin: { write: () => true }, kill: () => true },
    readline: { close: () => {} },
    pending: new Map(),
    notificationHandlers: [],
    exitHandlers: [],
    serverRequestHandlers: [],
  } as unknown as AppServer;
}

async function collectEvents(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) {
    sink.push(event);
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
