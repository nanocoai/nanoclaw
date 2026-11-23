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

import { SessionManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AssistantMessageEventStream } from '@earendil-works/pi-ai';

import { PiProvider, type PiMemorySessionHook } from './pi.js';
import { readPiSettings } from './pi-auth.js';
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
  model: { provider: string; id: string };
}

interface FakeRuntimeOptions {
  /** Models the runtime reports; defaults to the single FAKE_MODEL. */
  models?: Array<typeof FAKE_MODEL>;
  /** Providers whose live credential is a subscription login rather than a key. */
  subscriptions?: string[];
}

function createFakeModelRuntime(
  script: Array<(stream: AssistantMessageEventStream) => void>,
  options: FakeRuntimeOptions = {},
): {
  runtime: ModelRuntime;
  calls: ScriptedCall[];
  complete(index: number, text: string): void;
} {
  const calls: ScriptedCall[] = [];
  const streams: AssistantMessageEventStream[] = [];
  const models = options.models ?? [FAKE_MODEL];
  const subscriptions = new Set(options.subscriptions ?? []);
  const runtime = {
    getModel: (provider: string, id: string) => models.find((model) => model.provider === provider && model.id === id),
    getModels: (provider?: string) => (provider ? models.filter((model) => model.provider === provider) : models),
    getAvailable: async () => models,
    getAvailableSnapshot: () => models,
    getProviders: () => [],
    getProvider: () => undefined,
    getRegisteredProviderIds: () => [],
    getRegisteredProviderConfig: () => undefined,
    hasConfiguredAuth: () => true,
    checkAuth: async () => ({ ok: true }),
    isUsingOAuth: () => false,
    isUsingSubscription: (provider: string) => subscriptions.has(provider),
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
    streamSimple: (model: ScriptedCall['model'], context: ScriptedCall['context'], options: ScriptedCall['options']) => {
      const stream = new AssistantMessageEventStream();
      const index = calls.length;
      calls.push({ context, options, model });
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

describe('PiProvider instructions injection', () => {
  it('carries the runner instructions on a resumed query too, not only a fresh one', async () => {
    // The poll loop builds a NEW query per message batch, so instructions are
    // re-read on every batch. A resumed query must still carry them: pi caches
    // a session's history, and an instructions block that only appeared on the
    // first-ever prompt would go stale as soon as destinations change.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-instr-'));
    try {
      const sessionsDir = path.join(dir, '.pi', 'sessions');
      fs.mkdirSync(sessionsDir, { recursive: true });
      const manager = SessionManager.create(dir, sessionsDir);
      manager.appendMessage({
        role: 'user',
        content: [{ type: 'text', text: 'old question' }],
        timestamp: Date.now(),
      } as never);
      manager.appendMessage(assistantMessage('old answer') as never);
      const resumable = manager.getSessionFile();
      expect(resumable).toBeTruthy();

      const fake = createFakeModelRuntime([say('ok')]);
      const provider = new PiProvider({}, fake.runtime);
      provider.registerMemorySessionHook(MEMORY_HOOK);
      const query = provider.query({
        prompt: 'hello',
        cwd: dir,
        continuation: resumable!,
        systemContext: { instructions: 'DESTINATIONS: telegram, wechat' },
      });
      const done = collectEvents(query.events, []);
      query.end();
      await done.catch(() => {});

      // The resumed history carries its own user messages; the instructions
      // belong to THIS turn's prompt, which is the last user message.
      const users = fake.calls[0]!.context.messages.filter((message) => message.role === 'user');
      expect(users.at(-1)!.content[0]!.text).toContain('DESTINATIONS: telegram, wechat');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** Run one turn against a fresh provider and drain its events. */
async function runTurn(
  fake: ReturnType<typeof createFakeModelRuntime>,
  dir: string,
  continuation?: string,
): Promise<void> {
  const provider = new PiProvider({}, fake.runtime);
  provider.registerMemorySessionHook(MEMORY_HOOK);
  const query = provider.query({ prompt: 'hey', cwd: dir, ...(continuation ? { continuation } : {}) });
  const done = collectEvents(query.events, []);
  query.end();
  await done;
}

/** Apply env for the duration of `body`, restoring what was there afterwards. */
async function withEnv(vars: Record<string, string>, body: () => Promise<void>): Promise<void> {
  const previous = new Map(Object.keys(vars).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(vars)) process.env[key] = value;
  try {
    await body();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const CODEX_SPARK = { ...FAKE_MODEL, id: 'gpt-5.3-codex-spark', name: 'Codex Spark', provider: 'openai-codex' };
const DEEPSEEK_FLASH = { ...FAKE_MODEL, id: 'deepseek-v4-flash', name: 'DeepSeek Flash', provider: 'deepseek' };
const DEEPSEEK_PRO = { ...FAKE_MODEL, id: 'deepseek-v4-pro', name: 'DeepSeek Pro', provider: 'deepseek' };

describe('PiProvider gateway model defaults', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-defaults-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const agentDir = (): string => path.join(dir, '.pi', 'agent');

  // pi's catalog lists every model of a subscription provider as available, and
  // Codex's order opens with a model a ChatGPT account rejects outright. pi also
  // keeps its own curated default per provider, so guessing is strictly worse.
  it('pins only the provider when the login is a subscription', async () => {
    await withEnv({ PI_GATEWAY_PROVIDERS: 'openai-codex' }, async () => {
      const fake = createFakeModelRuntime([say('ok')], {
        models: [CODEX_SPARK],
        subscriptions: ['openai-codex'],
      });
      await runTurn(fake, dir);
      expect(readPiSettings(agentDir())).toEqual({ defaultProvider: 'openai-codex' });
    });
  });

  it('still writes a catalog model for a key-backed provider', async () => {
    await withEnv({ PI_GATEWAY_PROVIDERS: 'deepseek' }, async () => {
      const fake = createFakeModelRuntime([say('ok')], { models: [DEEPSEEK_FLASH] });
      await runTurn(fake, dir);
      expect(readPiSettings(agentDir())).toEqual({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash' });
    });
  });

  // The first spawn writes a default of its own; without the managed-defaults
  // record it would look operator-authored forever and PI_DEFAULT_MODEL would be
  // ignored on every later spawn.
  it('lets PI_DEFAULT_MODEL replace the default an earlier spawn wrote', async () => {
    const models = [DEEPSEEK_FLASH, DEEPSEEK_PRO];
    await withEnv({ PI_GATEWAY_PROVIDERS: 'deepseek' }, async () => {
      await runTurn(createFakeModelRuntime([say('first')], { models }), dir);
      expect(readPiSettings(agentDir()).defaultModel).toBe('deepseek-v4-flash');

      const second = createFakeModelRuntime([say('second')], { models });
      await withEnv({ PI_DEFAULT_MODEL: 'deepseek-v4-pro' }, () => runTurn(second, dir));
      expect(readPiSettings(agentDir()).defaultModel).toBe('deepseek-v4-pro');
      expect(second.calls[0]!.model.id).toBe('deepseek-v4-pro');
    });
  });

  it('switches a resumed session to the configured default instead of its recorded model', async () => {
    const sessionsDir = path.join(dir, '.pi', 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    const manager = SessionManager.create(dir, sessionsDir);
    manager.appendMessage({
      role: 'user',
      content: [{ type: 'text', text: 'old question' }],
      timestamp: Date.now(),
    } as never);
    manager.appendMessage(assistantMessage('old answer') as never);
    const resumable = manager.getSessionFile()!;
    expect(fs.existsSync(resumable)).toBe(true);

    const switched = { ...FAKE_MODEL, id: 'fake-model-2', name: 'Fake Model 2' };
    await withEnv({ PI_GATEWAY_PROVIDERS: 'fake', PI_DEFAULT_MODEL: 'fake-model-2' }, async () => {
      const fake = createFakeModelRuntime([say('ok')], { models: [FAKE_MODEL, switched] });
      await runTurn(fake, dir, resumable);
      // The transcript recorded `fake-model`; a resumed session keeps it unless
      // the provider moves the session, which is what a changed default needs.
      expect(fake.calls[0]!.model.id).toBe('fake-model-2');
    });
  });
});
