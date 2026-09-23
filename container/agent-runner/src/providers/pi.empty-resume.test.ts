/**
 * pi empty-resume behavior: the pure isEmptyPiResume truth table plus
 * integration-level fallback coverage driven by a scripted ModelRuntime.
 *
 * The integration tests use the same second-constructor-argument seam as the
 * OpenCode/Codex providers: a fake ModelRuntime whose streamSimple returns
 * AssistantMessageEventStreams playing a canned script. Auth/model lookup is
 * answered inline, so no network, API key or agentDir state is needed.
 *
 * Scripting note: pi's agent loop always materializes exactly one final
 * message per model call and forwards it as message_end. A faithfully
 * completed call therefore always reads as "assistant work". The one honest
 * way to script a turn with no assistant message_end and no error — the
 * dead-continuation signature — is a `done` whose final message is not an
 * assistant message; pi.ts ignores non-assistant message_end events, which is
 * exactly how a session that opens but is dead inside shows up downstream.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';

import { isEmptyPiResume, PiProvider, type PiMemorySessionHook } from './pi.js';
import type { ProviderEvent } from './types.js';

describe('isEmptyPiResume', () => {
  it('falls back only on a first empty resume', () => {
    expect(
      isEmptyPiResume({
        resumedExistingSession: true,
        alreadyFellBack: false,
        sawAssistantWork: false,
        sawError: false,
      }),
    ).toBe(true);
  });

  it('does not rotate a brand-new session that stays dry', () => {
    expect(
      isEmptyPiResume({
        resumedExistingSession: false,
        alreadyFellBack: false,
        sawAssistantWork: false,
        sawError: false,
      }),
    ).toBe(false);
  });

  it('does not rotate when the resume produced assistant work', () => {
    expect(
      isEmptyPiResume({
        resumedExistingSession: true,
        alreadyFellBack: false,
        sawAssistantWork: true,
        sawError: false,
      }),
    ).toBe(false);
  });

  it('does not rotate when the resume surfaced an error', () => {
    expect(
      isEmptyPiResume({
        resumedExistingSession: true,
        alreadyFellBack: false,
        sawAssistantWork: false,
        sawError: true,
      }),
    ).toBe(false);
  });

  it('falls back at most once per query', () => {
    expect(
      isEmptyPiResume({
        resumedExistingSession: true,
        alreadyFellBack: true,
        sawAssistantWork: false,
        sawError: false,
      }),
    ).toBe(false);
  });
});

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

function assistantMessage(text: string, stopReason = 'stop', errorMessage?: string): Record<string, unknown> {
  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
    api: 'openai-completions',
    provider: 'fake',
    model: 'fake-model',
    usage: usage(),
    stopReason,
    ...(errorMessage ? { errorMessage } : {}),
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

/**
 * Script step: the dead-continuation turn — the model call settles with a
 * final message that is not an assistant message, so the turn ends with no
 * assistant message_end and no error anywhere.
 */
function emptyTurn(): (stream: AssistantMessageEventStream) => void {
  return (stream) => {
    stream.push({
      type: 'done',
      reason: 'stop',
      message: {
        role: 'user',
        content: [],
        api: 'openai-completions',
        provider: 'fake',
        model: 'fake-model',
        usage: usage(),
        stopReason: 'stop',
        timestamp: Date.now(),
      },
    } as never);
  };
}

/** Script step: the model call settles with an error-stop assistant message. */
function errorTurn(detail: string): (stream: AssistantMessageEventStream) => void {
  return (stream) => {
    stream.push({ type: 'error', reason: 'error', error: assistantMessage('', 'error', detail) } as never);
  };
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
          stream.end(assistantMessage('', 'aborted') as never);
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

/** Materialize a real, resumable pi session file on disk (user + assistant turn). */
function writeResumableSession(dir: string): string {
  const sessionsDir = path.join(dir, '.pi', 'sessions');
  fs.mkdirSync(sessionsDir, { recursive: true });
  const manager = SessionManager.create(dir, sessionsDir);
  manager.appendMessage({
    role: 'user',
    content: [{ type: 'text', text: 'old question' }],
    timestamp: Date.now(),
  } as never);
  // The session file is only flushed to disk once an assistant message exists.
  manager.appendMessage(assistantMessage('old answer') as never);
  const file = manager.getSessionFile();
  if (!file || !fs.existsSync(file)) throw new Error('fixture failed to write a session file');
  return file;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

/** Sink collector that keeps already-streamed events even when the query throws. */
async function collectEvents(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) sink.push(event);
}

function inits(events: ProviderEvent[]): Array<{ type: string; continuation: string }> {
  return events.filter((event): event is Extract<ProviderEvent, { type: 'init' }> => event.type === 'init');
}

function results(events: ProviderEvent[]): Array<{ type: string; text: string | null }> {
  return events.filter((event): event is Extract<ProviderEvent, { type: 'result' }> => event.type === 'result');
}

describe('PiProvider empty-resume fallback', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-empty-resume-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts a fresh session and replays when a resumed session produces nothing', async () => {
    const stale = writeResumableSession(dir);
    const fake = createFakeModelRuntime([emptyTurn(), say('recovered')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: stale });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.calls).toHaveLength(2);
    const inited = inits(events);
    expect(inited).toHaveLength(2);
    expect(inited[0].continuation).toBe(stale);
    expect(inited[1].continuation).not.toBe(stale);
    expect(fs.existsSync(inited[1].continuation)).toBe(true);
    expect(results(events)).toEqual([{ type: 'result', text: 'recovered' }]);
  });

  it('keeps a resume that produced assistant text', async () => {
    const stale = writeResumableSession(dir);
    const fake = createFakeModelRuntime([say('still here')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: stale });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.calls).toHaveLength(1);
    expect(inits(events)).toEqual([{ type: 'init', continuation: stale }]);
    expect(results(events)).toEqual([{ type: 'result', text: 'still here' }]);
  });

  it('treats an errored resume as a live session — error surfaces, no rotation', async () => {
    const stale = writeResumableSession(dir);
    const fake = createFakeModelRuntime([errorTurn('provider auth blew up')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: stale });
    const events: ProviderEvent[] = [];
    let failure: unknown;
    await collectEvents(query.events, events).catch((err: unknown) => {
      failure = err;
    });

    expect(fake.calls).toHaveLength(1);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('pi agent run failed');
    expect((failure as Error).message).toContain('provider auth blew up');
    expect(inits(events)).toEqual([{ type: 'init', continuation: stale }]);
    const errors = events.filter((event) => event.type === 'error') as Array<{ type: string; message: string }>;
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('provider auth blew up');
    expect(results(events)).toEqual([]);
  });

  it('does not rotate a brand-new session that stays dry', async () => {
    const fake = createFakeModelRuntime([emptyTurn()]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.calls).toHaveLength(1);
    expect(inits(events)).toHaveLength(1);
    expect(results(events)).toEqual([{ type: 'result', text: null }]);
  });

  it('falls back at most once per query — a dry replay stays dry', async () => {
    const stale = writeResumableSession(dir);
    const fake = createFakeModelRuntime([emptyTurn(), emptyTurn()]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: stale });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(fake.calls).toHaveLength(2);
    expect(inits(events)).toHaveLength(2);
    expect(results(events)).toEqual([{ type: 'result', text: null }]);
  });

  it('replays with the prompt shape a first-time session would have received', async () => {
    const memoryHook: PiMemorySessionHook = { ...MEMORY_HOOK, command: 'echo MEMORY_BLOCK' };
    const stale = writeResumableSession(dir);
    const resumed = createFakeModelRuntime([emptyTurn(), say('recovered')]);
    const resumedProvider = new PiProvider({}, resumed.runtime);
    resumedProvider.registerMemorySessionHook(memoryHook);
    const resumedQuery = resumedProvider.query({
      prompt: 'hey',
      cwd: dir,
      continuation: stale,
      systemContext: { instructions: 'SYS_INSTR' },
    });
    const resumedDone = collect(resumedQuery.events);
    resumedQuery.end();
    await resumedDone;

    const fresh = createFakeModelRuntime([say('hi')]);
    const freshProvider = new PiProvider({}, fresh.runtime);
    freshProvider.registerMemorySessionHook(memoryHook);
    const freshQuery = freshProvider.query({
      prompt: 'hey',
      cwd: dir,
      systemContext: { instructions: 'SYS_INSTR' },
    });
    const freshDone = collect(freshQuery.events);
    freshQuery.end();
    await freshDone;

    // One <system> block carrying memory then the instructions — byte-identical
    // to the opening prompt of a query that never resumed anything. (Only the
    // text is compared byte-for-byte; pi stamps each user message with its own
    // creation timestamp.)
    const replayPrompt = resumed.calls[1].context.messages.at(-1)!;
    const freshPrompt = fresh.calls[0].context.messages.at(-1)!;
    expect(replayPrompt.role).toBe(freshPrompt.role);
    expect(replayPrompt.content[0].text).toBe(freshPrompt.content[0].text);
    expect(replayPrompt.content[0].text).toBe('<system>\nMEMORY_BLOCK\n\nSYS_INSTR\n</system>\n\nhey');
  });

  it('a missing continuation file surfaces as an invalid session, not a rotation', async () => {
    const missing = path.join(dir, '.pi', 'sessions', 'nope.jsonl');
    const fake = createFakeModelRuntime([say('never reached')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: missing });
    const done = collect(query.events);
    query.end();
    let failure: unknown;
    await done.catch((err: unknown) => {
      failure = err;
    });

    expect(fake.calls).toHaveLength(0);
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('pi session file not found');
    expect(provider.isSessionInvalid(failure)).toBe(true);
  });

  it('the fallback replay turn answers the original prompt, not the dead session context', async () => {
    const stale = writeResumableSession(dir);
    const fake = createFakeModelRuntime([emptyTurn(), say('recovered')]);
    const provider = new PiProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hey', cwd: dir, continuation: stale });
    const done = collect(query.events);
    query.end();
    await done;

    // Turn 1 resumed the stale context (old history visible); turn 2 opened on
    // a fresh session whose context only carries the replayed opening prompt.
    expect(fake.calls[0].context.messages.length).toBeGreaterThan(1);
    const replayMessages = fake.calls[1].context.messages;
    expect(replayMessages).toHaveLength(1);
    expect(replayMessages[0].role).toBe('user');
    expect(replayMessages[0].content[0].text).toContain('hey');
  });
});
