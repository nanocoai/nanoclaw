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

  it('keeps a retrying turn alive and steers into it until it completes', async () => {
    const fake = createFakeCodexRuntime();
    const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events).catch((error: Error) => error);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('error', { error: { message: 'stream disconnected' }, willRetry: true });
    await sleep(20);

    expect(fake.killed).toBe(false);
    expect(events.some((event) => event.type === 'error' || event.type === 'result')).toBe(false);
    query.push('follow-up during retry');
    await waitFor(() => fake.steerCalls.length === 1);
    query.end();
    fake.completeTurn('recovered answer');

    expect(await collect).toBeUndefined();
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', inputText: 'follow-up during retry' }]);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'recovered answer' }]);
    expect(fake.killed).toBe(true);
  });

  it('reports a terminal turn failure after a transient error without starting another turn', async () => {
    const fake = createFakeCodexRuntime();
    const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
    query.end();
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events).catch((error: Error) => error);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('error', { error: { message: 'stream disconnected' }, willRetry: true });
    await sleep(20);
    fake.notify('turn/completed', {
      turn: {
        status: 'failed',
        error: { message: 'terminal failure', additionalDetails: 'retry exhausted' },
        items: [],
      },
    });

    expect((await collect)?.message).toBe('terminal failure: retry exhausted');
    expect(events.filter((event) => event.type === 'error')).toEqual([
      { type: 'error', message: 'terminal failure: retry exhausted', retryable: false, classification: undefined },
    ]);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.killed).toBe(true);
  });

  it.each([false, undefined, 'true'])(
    'keeps nonretrying error notifications terminal (willRetry=%s)',
    async (willRetry) => {
      const fake = createFakeCodexRuntime();
      const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
      const events: ProviderEvent[] = [];
      const collect = collectEvents(query.events, events).catch((error: Error) => error);

      await waitFor(() => fake.startCalls.length === 1);
      fake.notify('error', {
        error: { message: 'permission denied' },
        ...(willRetry === undefined ? {} : { willRetry }),
      });

      expect((await collect)?.message).toBe('permission denied');
      expect(events.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', message: 'permission denied', retryable: false, classification: 'sandbox' },
      ]);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(fake.killed).toBe(true);
    },
  );

  it('can abort a turn while the app-server is retrying', async () => {
    const fake = createFakeCodexRuntime();
    const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events).catch((error: Error) => error);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('error', { error: { message: 'stream disconnected' }, willRetry: true });
    await sleep(20);
    query.abort();

    expect(await collect).toBeUndefined();
    expect(fake.interruptCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1' }]);
    expect(events.some((event) => event.type === 'error' || event.type === 'result')).toBe(false);
    expect(fake.startCalls).toHaveLength(1);
    expect(fake.killed).toBe(true);
  });

  it('keeps the existing turn deadline active during native retries', async () => {
    const originalSetTimeout = globalThis.setTimeout;
    let fireDeadline: (() => void) | undefined;
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      if (ms === 10 * 60 * 1000) fireDeadline = () => callback(...args);
      return originalSetTimeout(callback, ms, ...args);
    });
    const fake = createFakeCodexRuntime();
    const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events).catch((error: Error) => error);
    try {
      await waitFor(() => fake.startCalls.length === 1);
      fake.notify('error', { error: { message: 'stream disconnected' }, willRetry: true });
      await sleep(20);
      expect(fireDeadline).toBeDefined();
      fireDeadline!();

      expect((await collect)?.message).toBe('Turn timed out after 600000ms');
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.killed).toBe(true);
    } finally {
      timeout.mockRestore();
      query.abort();
      await collect;
    }
  });

  it('does not report earlier partial text as success when an interrupted turn has no final items', async () => {
    const fake = createFakeCodexRuntime();
    const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
    query.end();
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events).catch((error: Error) => error);

    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('item/agentMessage/delta', { delta: 'partial answer' });
    fake.notify('turn/completed', { turn: { status: 'interrupted', error: null, items: [] } });

    expect((await collect)?.message).toBe('Codex turn interrupted');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(events.some((event) => event.type === 'result')).toBe(false);
    expect(fake.killed).toBe(true);
  });

  it.each(['failed', 'inProgress', undefined, null, 'unexpected', 1])(
    'does not report success for a noncompleted or malformed completion status (%s)',
    async (status) => {
      const fake = createFakeCodexRuntime();
      const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
      query.end();
      const events: ProviderEvent[] = [];
      const collect = collectEvents(query.events, events).catch((error: Error) => error);

      await waitFor(() => fake.startCalls.length === 1);
      // failed/null is a nullable-schema control, not a claimed native emission.
      fake.notify('turn/completed', {
        turn: { status, error: null, items: [{ type: 'agentMessage', text: 'partial answer' }] },
      });

      expect((await collect)?.message).toBe('Codex turn failed');
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(fake.killed).toBe(true);
    },
  );

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

  it('ends the turn immediately with the real cause when the app-server dies mid-turn', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);

    // No pending request exists mid-turn (turn/start already resolved), so
    // only the exitHandlers seam can end the turn — without it this parks
    // on the waker until the 10-minute turn timeout.
    fake.crashServer(new Error('Codex app-server exited: code=1 signal=null'));

    // The generator yields the error event, then rethrows to its consumer.
    await collect.catch(() => {});

    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect((errors[0] as { message: string }).message).toContain('app-server exited');
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
      notify('turn/started', { turn: { id: turnId } });
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
    notify,
    get killed() {
      return killed;
    },
    completeTurn(text: string) {
      notify('turn/completed', { turn: { status: 'completed', error: null, items: [{ type: 'agentMessage', text }] } });
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
