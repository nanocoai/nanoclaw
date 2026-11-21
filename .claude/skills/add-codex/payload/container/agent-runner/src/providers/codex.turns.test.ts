import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { CodexProvider, codexImageSavedNote, type CodexRuntimeDeps } from './codex.js';
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
    fake.notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      error: { message: 'stream disconnected' },
      willRetry: true,
    });
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
    fake.notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      error: { message: 'stream disconnected' },
      willRetry: true,
    });
    await sleep(20);
    fake.notify('turn/completed', {
      threadId: 'thread-1',
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
        threadId: 'thread-1',
        turnId: 'turn-1',
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
    fake.notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      error: { message: 'stream disconnected' },
      willRetry: true,
    });
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
    const originalClearTimeout = globalThis.clearTimeout;
    let fireDeadline: (() => void) | undefined;
    const deadlines: unknown[] = [];
    const cleared: unknown[] = [];
    const timeout = spyOn(globalThis, 'setTimeout').mockImplementation((callback, ms, ...args) => {
      const handle = originalSetTimeout(callback, ms, ...args);
      if (ms === 10 * 60 * 1000) {
        deadlines.push(handle);
        fireDeadline = () => callback(...args);
      }
      return handle;
    });
    const clear = spyOn(globalThis, 'clearTimeout').mockImplementation((handle) => {
      cleared.push(handle);
      return originalClearTimeout(handle);
    });
    const fake = createFakeCodexRuntime();
    const query = createCodexProvider({}, fake.runtime).query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events).catch((error: Error) => error);
    try {
      await waitFor(() => fake.startCalls.length === 1);
      fake.notify('error', {
        threadId: 'thread-1',
        turnId: 'turn-1',
        error: { message: 'stream disconnected' },
        willRetry: true,
      });
      await sleep(20);
      // One deadline, armed at turn start: the retry neither restarts nor cancels it.
      expect(deadlines).toHaveLength(1);
      expect(cleared).not.toContain(deadlines[0]);
      fireDeadline!();

      expect((await collect)?.message).toBe('Turn timed out after 600000ms');
      expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
      expect(events.some((event) => event.type === 'result')).toBe(false);
      expect(fake.startCalls).toHaveLength(1);
      expect(fake.killed).toBe(true);
    } finally {
      timeout.mockRestore();
      clear.mockRestore();
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
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { status: 'interrupted', error: null, items: [] } });

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
        threadId: 'thread-1',
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

  it('tells the agent mid-turn where a generated image is saved, so it sends the file itself', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'make an image', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    // Codex's built-in image tool reports each saved image mid-turn; one that
    // failed to save has no path and gets no note. A sub-agent's turn/started
    // arrives on the same connection, so the note must follow the image's own
    // thread and turn, not the last turn started.
    const savedPath = '/home/node/.codex/generated_images/thread-1/ig_abc.png';
    fake.notify('turn/started', { threadId: 'child-thread', turn: { id: 'child-turn' } });
    fake.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', status: 'failed' },
    });
    fake.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', status: 'completed', savedPath },
    });
    // A sub-agent's image is noted in the sub-agent's own turn.
    const childPath = '/home/node/.codex/generated_images/child-thread/ig_def.png';
    fake.notify('item/completed', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      item: { type: 'imageGeneration', status: 'completed', savedPath: childPath },
    });
    await waitFor(() => fake.steerCalls.length === 2);

    query.end();
    fake.completeTurn('Sent it.');
    await collect;

    expect(fake.steerCalls).toEqual([
      { threadId: 'thread-1', turnId: 'turn-1', inputText: codexImageSavedNote(savedPath) },
      { threadId: 'child-thread', turnId: 'child-turn', inputText: codexImageSavedNote(childPath) },
    ]);
    expect(codexImageSavedNote(savedPath)).toContain(savedPath);
    expect(codexImageSavedNote(savedPath)).toContain('send_file');
    expect(fake.startCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'Sent it.' }]);
  });

  it('keeps a save-only image unsent: the note defers to the request and the provider delivers nothing', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    // Like an isolated task that must not notify anyone unless it asks to.
    const query = provider.query({
      prompt: 'Save a logo to /workspace/agent/logo.png. Do not send it to anyone.',
      cwd: '/workspace/agent',
    });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    const savedPath = '/home/node/.codex/generated_images/thread-1/ig_logo.png';
    fake.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', status: 'completed', savedPath },
    });
    await waitFor(() => fake.steerCalls.length === 1);

    query.end();
    fake.completeTurn('Saved.');
    await collect;

    // Exact text: any edit that makes sending unconditional must change this test.
    expect(fake.steerCalls.map((call) => call.inputText)).toEqual([
      `<system>Your image generation tool saved ${savedPath}. Nobody has seen it: it is not shown automatically. ` +
        "Follow the original request's delivery instructions. If whoever asked expects to see the image, send it with send_file. " +
        'If the request only asked to save it, said not to send it, or is a task that did not ask you to notify anyone, do not send it.</system>',
    ]);
    // Only the agent's own send_file delivers; the provider emits no file.
    expect(events.map((event) => event.type)).not.toContain('file');
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'Saved.' }]);
  });

  it('drops an image note it cannot steer instead of starting a turn the runner never asked for', async () => {
    const fake = createFakeCodexRuntime({ rejectSteer: true });
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'make an image', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.startCalls.length === 1);
    const savedPath = '/home/node/.codex/generated_images/thread-1/ig_abc.png';
    fake.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'imageGeneration', status: 'completed', savedPath },
    });
    await waitFor(() => fake.steerCalls.length === 1);
    await sleep(0);

    query.end();
    fake.completeTurn('Done.');
    await collect;

    expect(fake.startCalls).toHaveLength(1);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'Done.' }]);
  });

  it("keeps a sub-agent's events out of the parent turn: no early end, no result text, no turn takeover", async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delegate this', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    let collected = false;
    const collect = collectEvents(query.events, events).finally(() => {
      collected = true;
    });
    try {
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
      // Bounded, so a query that never finishes still fails here and reaches the finally.
      await waitFor(() => collected);
      await collect;
    } finally {
      // If a wait fails (say the child ended the parent turn), stop the query
      // so it does not keep running into later tests.
      query.abort();
      await collect.catch(() => {});
    }

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
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    await collect;

    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: null }]);
  });

  it("keeps the parent's own text when a sub-agent's text arrives in between", async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'delegate this', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    const delta = (threadId: string, turnId: string, text: string): void =>
      fake.notify('item/agentMessage/delta', { threadId, turnId, itemId: `${threadId}-m`, delta: text });
    delta('thread-1', 'turn-1', 'parent ');
    delta('child-thread', 'child-turn', 'child ');
    delta('thread-1', 'turn-1', 'answer');
    fake.notify('item/completed', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      item: { type: 'agentMessage', text: 'child answer' },
    });
    query.end();
    // Empty items, so the result can only come from the parent's own deltas.
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    await collect;

    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'parent answer' }]);
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

  it('keeps the turn open through an error Codex says it will retry', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);

    // A transient stream error: Codex retries it itself and the turn goes on.
    fake.notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'Reconnecting... 1/5', additionalDetails: 'stream disconnected' },
    });
    await waitFor(() => events.some((event) => event.type === 'progress'));

    // The turn is still the active one: a follow-up steers into it.
    query.push('follow-up');
    await waitFor(() => fake.steerCalls.length === 1);
    query.end();
    fake.completeTurn('final answer');
    await collect;

    expect(fake.steerCalls).toEqual([{ threadId: 'thread-1', turnId: 'turn-1', inputText: 'follow-up' }]);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(0);
    expect(events.filter((event) => event.type === 'progress')).toEqual([
      { type: 'progress', message: 'Codex retrying: Reconnecting... 1/5: stream disconnected' },
    ]);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
  });

  it('keeps completed messages but drops text a broken stream left unfinished', async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('item/completed', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      item: { type: 'agentMessage', text: 'first message' },
    });
    fake.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId: 'turn-1', itemId: 'm2', delta: 'half a ' });
    fake.notify('error', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      willRetry: true,
      error: { message: 'Reconnecting... 1/5', additionalDetails: 'stream disconnected' },
    });
    await waitFor(() => events.some((event) => event.type === 'progress'));
    query.end();
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    await collect;

    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'first message' }]);
  });

  it("leaves the parent's text alone when a sub-agent's stream error is retried", async () => {
    const fake = createFakeCodexRuntime();
    const provider = createCodexProvider({}, fake.runtime);
    const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];

    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.startCalls.length === 1);
    fake.notify('item/agentMessage/delta', {
      threadId: 'thread-1',
      turnId: 'turn-1',
      itemId: 'm1',
      delta: 'parent answer',
    });
    fake.notify('error', {
      threadId: 'child-thread',
      turnId: 'child-turn',
      willRetry: true,
      error: { message: 'Reconnecting... 1/5', additionalDetails: 'stream disconnected' },
    });
    await sleep(20);
    query.end();
    fake.notify('turn/completed', { threadId: 'thread-1', turn: { id: 'turn-1', status: 'completed', items: [] } });
    await collect;

    expect(events.some((event) => event.type === 'progress')).toBe(false);
    expect(events.filter((event) => event.type === 'result')).toEqual([{ type: 'result', text: 'parent answer' }]);
  });

  for (const willRetry of [false, undefined]) {
    it(`ends the turn on an error Codex will not retry (willRetry: ${willRetry})`, async () => {
      const fake = createFakeCodexRuntime();
      const provider = createCodexProvider({}, fake.runtime);
      const query = provider.query({ prompt: 'prompt', cwd: '/workspace/agent' });
      const events: ProviderEvent[] = [];

      const collect = collectEvents(query.events, events);
      await waitFor(() => fake.startCalls.length === 1);
      fake.notify('error', { threadId: 'thread-1', turnId: 'turn-1', willRetry, error: { message: 'quota exceeded' } });
      // The runner treats the turn as failed only when iteration throws.
      await expect(collect).rejects.toThrow('quota exceeded');

      expect(events.filter((event) => event.type === 'error')).toEqual([
        { type: 'error', message: 'quota exceeded', retryable: false, classification: 'quota' },
      ]);
      expect(events.some((event) => event.type === 'result')).toBe(false);
    });
  }

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
      notify('turn/completed', {
        threadId,
        turn: { status: 'completed', error: null, items: [{ type: 'agentMessage', text }] },
      });
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
