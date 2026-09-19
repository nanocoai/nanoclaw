/**
 * PiProvider turn/push behavior, driven by a scripted ModelRuntime injected
 * through the same second-constructor-argument seam the OpenCode/Codex
 * providers use. See pi.empty-resume.test.ts for the fake's rationale: pi's
 * agent loop materializes one final message per model call, so a scripted
 * turn is either a normal assistant reply, an error-stop reply, or (not used
 * here) a non-assistant final message.
 *
 * Two push paths exist in the provider and both are covered:
 * - mid-turn (session.isStreaming): the message goes to pi's own follow-up
 *   queue via prompt(…, { streamingBehavior: 'followUp' }); pi's prompt()
 *   promise spans the follow-up, so ONE result covers the whole batch and its
 *   text is the last assistant message of the batch.
 * - idle (between turns): the message joins the pending queue and starts a
 *   NEW turn with its own result.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';

import { PiProvider, type PiMemorySessionHook } from './pi.js';
import type { ProviderEvent } from './types.js';

const MEMORY_HOOK: PiMemorySessionHook = {
  command: 'true',
  legacyCommands: [],
  sources: ['startup'],
};

const FAKE_MODEL = {
  id: 'fake-model',
  name: 'Fake Model',
  api: 'openai-completions',
  provider: 'fake',
  baseUrl: 'https://fake.invalid/v1',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200_000,
  maxTokens: 8_192,
};

function usage(): Record<string, unknown> {
  return {
    input: 1,
    output: 1,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 2,
    cost: { input: 0, output: 0, total: 0 },
  };
}

function assistantMessage(text: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: usage(),
    stopReason: 'stop',
    timestamp: Date.now(),
  };
}

/** Script step: a normal completed assistant reply. */
function say(text: string): (stream: AssistantMessageEventStream) => void {
  return (stream) => {
    const message = assistantMessage(text);
    stream.push({ type: 'start', partial: message } as never);
    stream.push({ type: 'done', reason: 'stop', message } as never);
  };
}

/** Script step: hold the stream open until the test completes it manually. */
function holdOpen(): (stream: AssistantMessageEventStream) => void {
  return () => {};
}

interface ScriptedCall {
  context: { systemPrompt?: unknown; messages: Array<{ role: string; content: Array<{ type: string; text?: string }> }> };
  options: { signal?: AbortSignal };
}

function createFakeModelRuntime(script: Array<(stream: AssistantMessageEventStream) => void>): {
  runtime: ModelRuntime;
  calls: ScriptedCall[];
  complete(index: number, text: string): void;
} {
  const calls: ScriptedCall[] = [];
  const streams: AssistantMessageEventStream[] = [];
  const runtime = {
    getModel: () => FAKE_MODEL,
    getModels: () => [FAKE_MODEL],
    getAvailable: async () => [FAKE_MODEL],
    getAvailableSnapshot: () => [FAKE_MODEL],
    getProviders: () => [],
    getProvider: () => undefined,
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig: () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    isUsingSubscription: () => false,
    getAuth: async () => ({ auth: { apiKey: 'test-key' } }),
    getProviderAuthStatus: () => ({ configured: true }),
    getError: () => undefined,
    getCompatibilityRequestConfig: () => ({}),
    listCredentials: async () => [],
    setRuntimeApiKey: async () => {},
    removeRuntimeApiKey: async () => {},
    registerProvider: () => {},
    unregisterProvider: () => {},
    registerNativeProvider: () => {},
    refresh: async () => ({ providers: [], errors: [] }),
    streamSimple: (_model: unknown, context: ScriptedCall['context'], options: ScriptedCall['options']) => {
      const stream = new AssistantMessageEventStream();
      const index = calls.length;
      calls.push({ context, options });
      streams.push(stream);
      // Real model streams honor the abort signal. Without this an aborted
      // turn would hang the prompt promise and leak the session.
      options?.signal?.addEventListener(
        'abort',
        () => {
          stream.end(assistantMessage('') as never);
        },
        { once: true },
      );
      const step = script[index];
      if (!step) throw new Error(`no scripted model turn #${index + 1}`);
      step(stream);
      return stream;
    },
  };
  return {
    runtime: runtime as unknown as ModelRuntime,
    calls,
    complete(index: number, text: string): void {
      streams[index].push({ type: 'done', reason: 'stop', message: assistantMessage(text) } as never);
    },
  };
}

async function collectEvents(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) sink.push(event);
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(10);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function results(events: ProviderEvent[]): Array<{ type: string; text: string | null }> {
  return events.filter((event): event is Extract<ProviderEvent, { type: 'result' }> => event.type === 'result');
}

/** Text of the last user message the model actually received on a call. */
function lastUserText(call: ScriptedCall): string {
  const last = call.context.messages.at(-1)!;
  return last.content[0].text ?? '';
}

describe('PiProvider active turns', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-turns-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('steers a mid-turn push into pi\'s follow-up queue and covers it with the pending result', async () => {
    const fake = createFakeModelRuntime([holdOpen(), say('second answer')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'first prompt', cwd: dir });
    const events: ProviderEvent[] = [];
    const done = collectEvents(query.events, events);

    await waitFor(() => fake.calls.length === 1);
    // The first stream is still open, so the session is mid-turn: the push
    // must ride pi's follow-up queue, not a second provider turn.
    query.push('follow-up prompt');
    fake.complete(0, 'first answer');
    await waitFor(() => fake.calls.length === 2);
    query.end();
    await done;

    expect(fake.calls).toHaveLength(2);
    expect(lastUserText(fake.calls[1])).toBe('follow-up prompt');
    // pi's prompt() spans queued follow-ups, so the batch yields one result
    // whose text is the batch's last assistant message.
    expect(results(events)).toEqual([{ type: 'result', text: 'second answer' }]);
    // Liveness: at least one activity per underlying SDK event batch.
    expect(events.filter((event) => event.type === 'activity').length).toBeGreaterThanOrEqual(2);
  });

  it('captures a push racing turn completion in the same tick — nothing is lost', async () => {
    const fake = createFakeModelRuntime([holdOpen(), say('second answer')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'first prompt', cwd: dir });
    const events: ProviderEvent[] = [];
    const done = collectEvents(query.events, events);

    await waitFor(() => fake.calls.length === 1);
    // Complete the turn and push in the same synchronous tick: the loop has
    // not consumed the final event yet, so the session is still streaming and
    // pi's follow-up queue absorbs the message inside the same run.
    fake.complete(0, 'first answer');
    query.push('racing follow-up');
    await waitFor(() => fake.calls.length === 2);
    query.end();
    await done;

    expect(fake.calls).toHaveLength(2);
    expect(lastUserText(fake.calls[1])).toBe('racing follow-up');
    expect(results(events)).toEqual([{ type: 'result', text: 'second answer' }]);
  });

  it('starts a new turn for a push that lands after the turn settled', async () => {
    const fake = createFakeModelRuntime([holdOpen(), say('queued answer')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'first prompt', cwd: dir });
    const events: ProviderEvent[] = [];
    // Keep pulling in the background: the event generator is pull-based, so
    // the next turn only runs while the consumer drains the stream.
    const done = collectEvents(query.events, events);

    await waitFor(() => fake.calls.length === 1);
    fake.complete(0, 'first answer');
    await waitFor(() => results(events).length === 1);
    query.push('queued prompt');
    await waitFor(() => fake.calls.length === 2);
    query.end();
    await done;

    expect(fake.calls).toHaveLength(2);
    expect(lastUserText(fake.calls[1])).toBe('queued prompt');
    expect(results(events)).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'queued answer' },
    ]);
  });

  it('batches a push that arrives before the session opens into ordered turns', async () => {
    const fake = createFakeModelRuntime([say('first answer'), say('queued answer')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    // Both pushes land synchronously, before the generator can even open the
    // session: they must run as two ordered turns.
    const query = provider.query({ prompt: 'first prompt', cwd: dir });
    query.push('pushed before open');
    query.end();
    const events: ProviderEvent[] = [];
    await collectEvents(query.events, events);

    expect(fake.calls).toHaveLength(2);
    expect(lastUserText(fake.calls[0])).toBe('first prompt');
    expect(lastUserText(fake.calls[1])).toBe('pushed before open');
    expect(results(events)).toEqual([
      { type: 'result', text: 'first answer' },
      { type: 'result', text: 'queued answer' },
    ]);
  });

  it('interrupts the active turn on abort and closes the stream without a result', async () => {
    const fake = createFakeModelRuntime([holdOpen()]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'first prompt', cwd: dir });
    const events: ProviderEvent[] = [];
    const done = collectEvents(query.events, events);

    await waitFor(() => fake.calls.length === 1);
    query.abort();
    await done;

    expect(results(events)).toEqual([]);
    expect(inits(events)).toHaveLength(1);
  });
});

function inits(events: ProviderEvent[]): Array<{ type: string; continuation: string }> {
  return events.filter((event): event is Extract<ProviderEvent, { type: 'init' }> => event.type === 'init');
}
