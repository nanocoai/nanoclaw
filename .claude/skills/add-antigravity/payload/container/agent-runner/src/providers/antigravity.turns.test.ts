/**
 * Turn handling against a fake agy child process. The NDJSON fixtures are the
 * shapes agy 1.5.8 emits in `--output-format stream-json` (captured live
 * against a fake Gemini server): `init`, `step_update` (tool steps arrive
 * ACTIVE then DONE), and one `result` per turn.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import fs from 'fs';
import os from 'os';
import path from 'path';

import { antigravityRulePath, antigravityRuntimeOwnership, prepareAntigravityRules } from './antigravity-config.js';
import { AntigravityProvider, type AntigravityRuntimeDeps } from './antigravity.js';
import type { ProviderEvent } from './types.js';

const MEMORY_SESSION_HOOK = {
  command: 'bun /app/src/memory/hook.ts',
  legacyCommands: ['bun /app/src/memory-hook.ts'],
  sources: ['startup', 'clear', 'compact'],
} as const;

const CONVERSATION = '91b8a588-3396-401a-b561-47ef93eef8b2';

const fixtures = {
  init: (id = CONVERSATION) => ({
    event: 'init',
    conversation_id: id,
    init: { cwd: '/workspace/agent', tools: ['call_mcp_tool', 'run_command'], permission_mode: 'always-proceed' },
  }),
  userInput: (index: number, id = CONVERSATION) => ({
    event: 'step_update',
    step_update: { conversation_id: id, step_index: index, state: 'DONE', step_type: 'user_input' },
  }),
  mcpTool: (index: number, state: 'ACTIVE' | 'DONE' | 'ERROR') => ({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION,
      step_index: index,
      state,
      step_type: 'tool',
      tool_name: 'call_mcp_tool',
      tool_info: {
        name: 'call_mcp_tool',
        parameters: { Arguments: { text: 'hi' }, ServerName: 'nanoclaw', ToolName: 'send_message' },
        ...(state === 'DONE' ? { output: 'sent' } : {}),
      },
    },
  }),
  agentResponse: (index: number, text: string) => ({
    event: 'step_update',
    step_update: {
      conversation_id: CONVERSATION,
      step_index: index,
      state: 'DONE',
      step_type: 'agent_response',
      text_delta: text,
      usage: { input_tokens: 10, output_tokens: 5, thinking_tokens: 0, cache_read_tokens: 0, total_tokens: 15 },
    },
  }),
  success: (response: string, id = CONVERSATION) => ({
    event: 'result',
    result: { conversation_id: id, status: 'SUCCESS', response, duration_seconds: 0.05, num_turns: 1, usage: {} },
  }),
  error: (error: string, extra: Record<string, unknown> = {}) => ({
    event: 'result',
    result: { conversation_id: CONVERSATION, status: 'ERROR', response: '', error, num_turns: 1, usage: {}, ...extra },
  }),
};

/** A ChildProcess stand-in: real pipes, a recorded kill(), and an explicit exit. */
class FakeAgy extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly userLines: unknown[] = [];
  readonly signals: string[] = [];
  stdinEnded = false;
  /** Called on kill(); default: exit as agy does on SIGTERM. */
  onKill: (signal: string) => void = (signal) => {
    if (signal === 'SIGTERM') {
      this.emitLine(fixtures.error('interrupted', { finished_reason: 'interrupted' }));
      this.writeStderr('error: interrupted');
      this.exit(0);
    } else this.exit(null, 'SIGKILL');
  };
  private exited = false;

  constructor(
    readonly args: string[],
    readonly options: { cwd: string; env: NodeJS.ProcessEnv },
  ) {
    super();
    let partial = '';
    this.stdin.on('data', (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop()!;
      for (const line of lines) if (line) this.userLines.push(JSON.parse(line));
    });
    this.stdin.on('finish', () => {
      this.stdinEnded = true;
    });
  }

  emitLine(event: unknown): void {
    this.stdout.write(JSON.stringify(event) + '\n');
  }

  writeStderr(line: string): void {
    this.stderr.write(line + '\n');
  }

  kill(signal: string = 'SIGTERM'): boolean {
    this.signals.push(signal);
    this.onKill(signal);
    return true;
  }

  /** End the pipes, then emit `close` once they have drained, as Node does. */
  exit(code: number | null, signal: string | null = null): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => {
      this.emit('exit', code, signal);
      this.emit('close', code, signal);
    }, 5);
  }

  /** User-turn contents in the order agy received them. */
  get prompts(): string[] {
    return this.userLines.map((line) => (line as { message: { content: string } }).message.content);
  }
}

function createFakeRuntime(opts: { prepareRules?: () => Promise<void>; realRules?: boolean } = {}) {
  const spawned: FakeAgy[] = [];
  const runtimeFileWrites: unknown[] = [];
  const ruleWrites: unknown[] = [];
  const runtime: AntigravityRuntimeDeps = {
    spawnAgy: (args, options) => {
      const child = new FakeAgy(args, options);
      spawned.push(child);
      return child as unknown as ChildProcess;
    },
    writeRuntimeFiles: (config) => {
      runtimeFileWrites.push(config);
    },
    prepareRules: async (hook) => {
      ruleWrites.push(hook);
      if (opts.realRules) await prepareAntigravityRules(hook);
      await opts.prepareRules?.();
    },
    killGraceMs: 50,
  };
  return {
    runtime,
    spawned,
    runtimeFileWrites,
    ruleWrites,
    get child(): FakeAgy {
      return spawned[0];
    },
  };
}

function createProvider(...args: ConstructorParameters<typeof AntigravityProvider>): AntigravityProvider {
  const provider = new AntigravityProvider(...args);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider;
}

let previousOwnership: boolean;

beforeEach(() => {
  // Other files in this process may have loaded the contract, which flips
  // ownership; these tests exercise the provider's own path and restore it.
  previousOwnership = antigravityRuntimeOwnership.contractOwnsRuntimeFiles;
  antigravityRuntimeOwnership.contractOwnsRuntimeFiles = false;
});

afterEach(() => {
  antigravityRuntimeOwnership.contractOwnsRuntimeFiles = previousOwnership;
});

describe('AntigravityProvider turns', () => {
  it('spawns agy for the query, writes the prompt as a user line and maps a tool turn', async () => {
    const fake = createFakeRuntime();
    const provider = createProvider({ model: 'gemini-3.8-flash-medium' }, fake.runtime);
    const query = provider.query({
      prompt: 'first prompt',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'CORE' },
    });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    expect(fake.child.args).toEqual([
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--dangerously-skip-permissions',
      '--model',
      'gemini-3.8-flash-medium',
    ]);
    expect(fake.child.options.cwd).toBe('/workspace/agent');
    expect(fake.child.options.env.AGY_CLI_DISABLE_AUTO_UPDATE).toBe('true');
    // The session's instructions travel in-band, ahead of the first prompt.
    expect(fake.child.userLines).toEqual([
      {
        event: 'user',
        message: { content: '<nanoclaw_system_context>\nCORE\n</nanoclaw_system_context>\n\nfirst prompt' },
      },
    ]);
    expect(fake.ruleWrites).toEqual([MEMORY_SESSION_HOOK]);
    expect(fake.runtimeFileWrites).toHaveLength(1);

    for (const line of [
      fixtures.init(),
      fixtures.userInput(0),
      fixtures.mcpTool(1, 'ACTIVE'),
      fixtures.mcpTool(1, 'DONE'),
      fixtures.agentResponse(2, 'final answer\n'),
      fixtures.success('final answer\n'),
    ])
      fake.child.emitLine(line);
    await waitFor(() => events.some((event) => event.type === 'result'));

    query.end();
    await waitFor(() => fake.child.stdinEnded);
    fake.child.exit(0);
    await collect;

    expect(events.filter((event) => event.type !== 'activity')).toEqual([
      { type: 'init', continuation: CONVERSATION },
      { type: 'progress', message: 'nanoclaw/send_message…' },
      { type: 'result', text: 'final answer\n' },
    ]);
    // Liveness on every agy line.
    expect(events.filter((event) => event.type === 'activity')).toHaveLength(6);
    expect(fake.child.signals).toEqual([]);
  });

  it('writes one turn at a time: a follow-up waits for the previous result', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.init());
    query.push('second');
    await sleep(20);
    expect(fake.child.prompts).toEqual(['first']);

    fake.child.emitLine(fixtures.success('answer one'));
    await waitFor(() => fake.child.prompts.length === 2);
    expect(fake.child.prompts).toEqual(['first', 'second']);
    expect(fake.child.stdinEnded).toBe(false);

    query.end();
    await waitFor(() => fake.child.stdinEnded);
    fake.child.emitLine(fixtures.success('answer two'));
    fake.child.exit(0);
    await collect;

    expect(results(events)).toEqual([
      { type: 'result', text: 'answer one' },
      { type: 'result', text: 'answer two' },
    ]);
  });

  it('queues pushes made before agy is spawned', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fake = createFakeRuntime({ prepareRules: () => gate });
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.ruleWrites.length === 1);
    query.push('early follow-up');
    expect(fake.spawned).toHaveLength(0);
    release();

    await waitFor(() => fake.child?.prompts.length === 1);
    expect(fake.child.prompts).toEqual(['first']);
    fake.child.emitLine(fixtures.success('one'));
    await waitFor(() => fake.child.prompts.length === 2);
    expect(fake.child.prompts).toEqual(['first', 'early follow-up']);

    query.end();
    fake.child.emitLine(fixtures.success('two'));
    await waitFor(() => fake.child.stdinEnded);
    fake.child.exit(0);
    await collect;
    expect(results(events).map((event) => (event as { text: string }).text)).toEqual(['one', 'two']);
  });

  it('keeps stdin open on end() until every queued turn has been written', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const collect = collectEvents(query.events, []);

    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('queued');
    query.end();
    await sleep(20);
    expect(fake.child.stdinEnded).toBe(false);

    fake.child.emitLine(fixtures.success('one'));
    await waitFor(() => fake.child.stdinEnded);
    expect(fake.child.prompts).toEqual(['first', 'queued']);

    fake.child.emitLine(fixtures.success('two'));
    fake.child.exit(0);
    await collect;
  });

  it('ignores pushes after end()', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const collect = collectEvents(query.events, []);
    await waitFor(() => fake.child?.prompts.length === 1);
    query.end();
    query.push('too late');
    fake.child.emitLine(fixtures.success('one'));
    fake.child.exit(0);
    await collect;
    expect(fake.child.prompts).toEqual(['first']);
  });

  it('aborts with SIGTERM and stays quiet about the interrupted turn', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'slow', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.init());
    await waitFor(() => events.some((event) => event.type === 'init'));
    query.abort();
    await collect;

    expect(fake.child.signals).toEqual(['SIGTERM']);
    expect(events.some((event) => event.type === 'result' || event.type === 'error')).toBe(false);
  });

  it('follows SIGTERM with SIGKILL when agy does not exit, and waits for the exit', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'stuck', cwd: '/workspace/agent' });
    const collect = collectEvents(query.events, []);

    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.onKill = (signal) => {
      if (signal === 'SIGKILL') fake.child.exit(null, 'SIGKILL');
    };
    query.abort();
    await collect;

    expect(fake.child.signals).toEqual(['SIGTERM', 'SIGKILL']);
  });

  it('never spawns agy when aborted before the spawn', async () => {
    let release!: () => void;
    const fake = createFakeRuntime({
      prepareRules: () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    });
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.ruleWrites.length === 1);
    query.abort();
    release();
    await collect;
    expect(fake.spawned).toHaveLength(0);
    expect(events).toEqual([]);
  });

  it('reports a model failure as an error plus a failed result, and keeps the process for the next turn', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('second');
    fake.child.emitLine(
      fixtures.error(
        'API error (attempt 5): doRequest: error sending request: Post "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse": dial tcp 142.250.0.1:443: connect: connection refused',
      ),
    );
    await waitFor(() => fake.child.prompts.length === 2);
    query.end();
    fake.child.emitLine(fixtures.success('recovered'));
    fake.child.exit(0);
    await collect;

    const error = events.find((event) => event.type === 'error') as Extract<ProviderEvent, { type: 'error' }>;
    expect(error.message).toContain('connection refused');
    expect(error.retryable).toBe(false);
    expect(error.classification).toBe('network');
    expect(results(events)).toEqual([
      {
        type: 'result',
        text: null,
        isError: true,
        error: 'Antigravity could not reach the Gemini API (network or gateway error). Try again shortly.',
      },
      { type: 'result', text: 'recovered' },
    ]);
  });

  it("takes retryable from agy's AGY_ERROR line when there is one", async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.writeStderr(
      'AGY_ERROR: {"short_error":"model overloaded","status":"UNAVAILABLE","error_code":14,"code_kind":"grpc","retryable":true,"error_id":"x"}',
    );
    fake.child.emitLine({ event: 'result', result: { conversation_id: CONVERSATION, status: 'ERROR', response: '' } });
    await waitFor(() => events.some((event) => event.type === 'result'));
    query.end();
    fake.child.exit(0);
    await collect;

    const error = events.find((event) => event.type === 'error') as Extract<ProviderEvent, { type: 'error' }>;
    expect(error).toEqual({ type: 'error', message: 'model overloaded', retryable: true });
    expect(results(events)).toEqual([
      { type: 'result', text: null, isError: true, error: 'Antigravity turn failed: model overloaded' },
    ]);
  });

  it('reports a turn agy ended as interrupted without being asked to', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine({
      event: 'result',
      result: { conversation_id: CONVERSATION, status: 'CANCELED', response: '' },
    });
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.find((event) => event.type === 'error')).toMatchObject({ classification: 'interrupted' });
    expect(results(events)).toEqual([
      { type: 'result', text: null, isError: true, error: 'The Antigravity turn was interrupted before it finished.' },
    ]);
  });

  it('fails the query with the real cause when agy dies mid-turn', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.init());
    fake.child.writeStderr('error: agent executor crashed');
    await sleep(20);
    fake.child.exit(2);

    await expect(collect).rejects.toThrow('agy exited mid-turn (code=2 signal=null): agent executor crashed');
    const errors = events.filter((event) => event.type === 'error');
    expect(errors).toHaveLength(1);
    expect(results(events)).toEqual([]);
  });

  it('fails the query when agy cannot be started', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.spawned.length === 1);
    fake.child.emit('error', Object.assign(new Error('spawn agy ENOENT'), { code: 'ENOENT' }));
    await expect(collect).rejects.toThrow('agy could not be started: spawn agy ENOENT');
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
  });

  it('ends quietly when agy exits between turns', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.success('done'));
    await waitFor(() => events.some((event) => event.type === 'result'));
    fake.child.exit(0);
    await collect;
    expect(events.some((event) => event.type === 'error')).toBe(false);
  });

  it('resumes a stored conversation with --conversation, keeping the configured model and effort', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({ model: 'gemini-3.8-flash-medium', effort: 'high' }, fake.runtime).query({
      prompt: 'p',
      continuation: CONVERSATION,
      cwd: '/workspace/agent',
    });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    expect(fake.child.args.slice(5)).toEqual([
      '--model',
      'gemini-3.8-flash-medium',
      '--effort',
      'high',
      '--conversation',
      CONVERSATION,
    ]);
    fake.child.emitLine(fixtures.init(CONVERSATION));
    fake.child.emitLine(fixtures.success('resumed'));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.filter((event) => event.type === 'init' || event.type === 'progress')).toEqual([
      { type: 'init', continuation: CONVERSATION },
    ]);
  });

  it('treats an unknown conversation as a fresh session: new init plus a progress note', async () => {
    const fake = createFakeRuntime();
    const missing = '00000000-0000-0000-0000-000000000000';
    const query = createProvider({}, fake.runtime).query({
      prompt: 'p',
      continuation: missing,
      cwd: '/workspace/agent',
    });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.writeStderr(`warning: conversation "${missing}" not found`);
    fake.child.emitLine(fixtures.init('6ccbe521-7240-4953-8b20-623a14cb43b6'));
    fake.child.emitLine(fixtures.success('fresh', '6ccbe521-7240-4953-8b20-623a14cb43b6'));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.filter((event) => event.type === 'init' || event.type === 'progress')).toEqual([
      { type: 'init', continuation: '6ccbe521-7240-4953-8b20-623a14cb43b6' },
      { type: 'progress', message: `Antigravity conversation ${missing} was not found; started a new conversation` },
    ]);
    expect(results(events)).toEqual([{ type: 'result', text: 'fresh' }]);
  });

  it('takes the continuation from the result when agy sent no init', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.success('ok'));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.filter((event) => event.type !== 'activity')).toEqual([
      { type: 'init', continuation: CONVERSATION },
      { type: 'result', text: 'ok' },
    ]);
  });

  it('skips unparseable stdout lines but still counts them as activity', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.stdout.write('not json\n');
    fake.child.emitLine({ event: 'something_new', payload: 1 });
    fake.child.emitLine(fixtures.success('ok'));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.filter((event) => event.type === 'activity')).toHaveLength(3);
    expect(results(events)).toEqual([{ type: 'result', text: 'ok' }]);
  });

  it('reports a failed tool step as progress', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine({
      event: 'step_update',
      step_update: { state: 'ACTIVE', step_type: 'tool', tool_name: 'run_command', tool_info: { name: 'run_command' } },
    });
    fake.child.emitLine({
      event: 'step_update',
      step_update: { state: 'ERROR', step_type: 'tool', tool_name: 'run_command', tool_info: { error: 'exit 1' } },
    });
    fake.child.emitLine(fixtures.success('ok'));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.filter((event) => event.type === 'progress')).toEqual([
      { type: 'progress', message: 'run_command…' },
      { type: 'progress', message: 'run_command failed' },
    ]);
  });
});

describe('AntigravityProvider session handling', () => {
  it("recognises agy's conversation-not-found wording as an invalid session", () => {
    const provider = createProvider({}, createFakeRuntime().runtime);
    expect(provider.isSessionInvalid(new Error('warning: conversation "abc" not found'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('agy exited mid-turn: conversation "abc" not found'))).toBe(true);
    expect(provider.isSessionInvalid(new Error('connection refused'))).toBe(false);
    expect(provider.isSessionInvalid(new Error('failed to load conversation state: model gemini-x not found'))).toBe(
      false,
    );
  });
});

describe('AntigravityProvider system context', () => {
  it('prefixes only the first user line of each process', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({
      prompt: 'first',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'CHAT-CONTEXT' },
    });
    const collect = collectEvents(query.events, []);
    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('second');
    fake.child.emitLine(fixtures.success('one'));
    await waitFor(() => fake.child.prompts.length === 2);
    query.end();
    fake.child.emitLine(fixtures.success('two'));
    fake.child.exit(0);
    await collect;
    expect(fake.child.prompts).toEqual([
      '<nanoclaw_system_context>\nCHAT-CONTEXT\n</nanoclaw_system_context>\n\nfirst',
      'second',
    ]);
  });

  it('sends the bare prompt when the session has no instructions', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'plain', cwd: '/workspace/agent' });
    const collect = collectEvents(query.events, []);
    await waitFor(() => fake.child?.prompts.length === 1);
    query.end();
    fake.child.emitLine(fixtures.success('ok'));
    fake.child.exit(0);
    await collect;
    expect(fake.child.prompts).toEqual(['plain']);
  });

  it('keeps two sessions of one group from clobbering each other', async () => {
    // Both sessions share the group's ~/.gemini volume and therefore its rule
    // file. Only group-level content may live there; each session's own
    // instructions reach only its own agy process.
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-two-sessions-'));
    const previousHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const hook = { command: 'echo GROUP-MEMORY', legacyCommands: [], sources: ['startup'] };
      const fake = createFakeRuntime({ realRules: true });
      const chat = new AntigravityProvider({}, fake.runtime);
      chat.registerMemorySessionHook(hook);
      const task = new AntigravityProvider({}, fake.runtime);
      task.registerMemorySessionHook(hook);

      const chatQuery = chat.query({
        prompt: 'chat',
        cwd: '/workspace/agent',
        systemContext: { instructions: 'CHAT' },
      });
      const chatDone = collectEvents(chatQuery.events, []);
      await waitFor(() => fake.spawned[0]?.prompts.length === 1);
      const ruleAfterChat = fs.readFileSync(antigravityRulePath(), 'utf-8');

      const taskQuery = task.query({
        prompt: 'task',
        cwd: '/workspace/agent',
        systemContext: { instructions: 'TASK' },
      });
      const taskDone = collectEvents(taskQuery.events, []);
      await waitFor(() => fake.spawned[1]?.prompts.length === 1);
      const ruleAfterTask = fs.readFileSync(antigravityRulePath(), 'utf-8');

      // The second spawn rewrote the shared file with identical bytes.
      expect(ruleAfterTask).toBe(ruleAfterChat);
      expect(ruleAfterTask).toContain('GROUP-MEMORY');
      expect(ruleAfterTask).not.toContain('CHAT');
      expect(ruleAfterTask).not.toContain('TASK');
      expect(fake.spawned[0].prompts[0]).toContain('<nanoclaw_system_context>\nCHAT\n');
      expect(fake.spawned[1].prompts[0]).toContain('<nanoclaw_system_context>\nTASK\n');

      for (const [query, child] of [
        [chatQuery, fake.spawned[0]],
        [taskQuery, fake.spawned[1]],
      ] as const) {
        query.end();
        child.emitLine(fixtures.success('ok'));
        child.exit(0);
      }
      await Promise.all([chatDone, taskDone]);
    } finally {
      if (previousHome === undefined) delete process.env.HOME;
      else process.env.HOME = previousHome;
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('AntigravityProvider failure diagnostics', () => {
  it('uses stderr that arrives just after the result line', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    // Same tick, stdout first: the order the two pipes can be read in.
    fake.child.emitLine({ event: 'result', result: { conversation_id: CONVERSATION, status: 'ERROR', response: '' } });
    fake.child.writeStderr('error: agent executor error: Error 400, Message: API key not valid.');
    await waitFor(() => events.some((event) => event.type === 'result'));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(events.find((event) => event.type === 'error')).toMatchObject({
      message: 'agent executor error: Error 400, Message: API key not valid.',
      classification: 'auth',
    });
  });

  it('delivers a turn that answered despite the stale ERROR status agy carries over from a failed turn', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('second');
    // The failed turn: an error_message step, then the ERROR result.
    fake.child.emitLine({ event: 'step_update', step_update: { state: 'DONE', step_type: 'error_message' } });
    fake.child.emitLine(fixtures.error('Error 400, Message: API key not valid.'));
    await waitFor(() => fake.child.prompts.length === 2);
    // The next turn answers, but its result still carries the old error.
    query.end();
    fake.child.emitLine(fixtures.agentResponse(4, 'PONG #2\n'));
    fake.child.emitLine(fixtures.error('Error 400, Message: API key not valid.', { response: 'PONG #2\n' }));
    fake.child.exit(0);
    await collect;
    expect(results(events)).toEqual([
      { type: 'result', text: null, isError: true, error: expect.stringContaining('could not authenticate') },
      { type: 'result', text: 'PONG #2\n' },
    ] as never);
    expect(events.filter((event) => event.type === 'error')).toHaveLength(1);
  });

  it('still fails a turn whose own error_message step accompanies a partial response', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'p', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.agentResponse(1, 'partial'));
    fake.child.emitLine({ event: 'step_update', step_update: { state: 'DONE', step_type: 'error_message' } });
    fake.child.emitLine(fixtures.error('quota exceeded', { response: 'partial' }));
    query.end();
    fake.child.exit(0);
    await collect;
    expect(results(events)).toEqual([
      { type: 'result', text: null, isError: true, error: expect.stringContaining('quota') },
    ] as never);
  });

  it("clears one turn's diagnostics when the next turn is written", async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);
    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('second');
    fake.child.writeStderr('error: first turn diagnostic');
    fake.child.emitLine({ event: 'result', result: { conversation_id: CONVERSATION, status: 'ERROR', response: '' } });
    await waitFor(() => fake.child.prompts.length === 2);
    query.end();
    fake.child.emitLine({ event: 'result', result: { conversation_id: CONVERSATION, status: 'ERROR', response: '' } });
    fake.child.exit(0);
    await collect;
    const messages = events
      .filter((event) => event.type === 'error')
      .map((event) => (event as { message: string }).message);
    expect(messages).toEqual(['first turn diagnostic', 'Antigravity turn ended with status ERROR']);
  });
});

describe('AntigravityProvider exit after a failed turn', () => {
  it('resumes the conversation in a new process for a follow-up queued behind the failure', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({ model: 'gemini-3.8-flash-medium' }, fake.runtime).query({
      prompt: 'first',
      cwd: '/workspace/agent',
      systemContext: { instructions: 'CTX' },
    });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    fake.child.emitLine(fixtures.init());
    query.push('follow-up');
    // HTTP 400: agy reports the failed turn, reads the next line, then exits 3.
    fake.child.writeStderr('error: Error 400, Message: API key not valid.');
    fake.child.emitLine(fixtures.error('Error 400, Message: API key not valid.'));
    await waitFor(() => fake.child.prompts.length === 2);
    fake.child.exit(3);

    await waitFor(() => fake.spawned[1]?.prompts.length === 1);
    const second = fake.spawned[1];
    expect(second.args.slice(5)).toEqual(['--model', 'gemini-3.8-flash-medium', '--conversation', CONVERSATION]);
    // A fresh process carries the system context again.
    expect(second.prompts).toEqual(['<nanoclaw_system_context>\nCTX\n</nanoclaw_system_context>\n\nfollow-up']);
    query.end();
    second.emitLine(fixtures.init());
    second.emitLine(fixtures.success('answered'));
    second.exit(0);
    await collect;

    expect(results(events)).toEqual([
      { type: 'result', text: null, isError: true, error: expect.stringContaining('could not authenticate') },
      { type: 'result', text: 'answered' },
    ] as never);
    // Same conversation, so no second init.
    expect(events.filter((event) => event.type === 'init')).toHaveLength(1);
  });

  it('respawns at most once per failure', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const collect = collectEvents(query.events, events);

    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('follow-up');
    fake.child.emitLine(fixtures.error('Error 400'));
    await waitFor(() => fake.child.prompts.length === 2);
    fake.child.exit(3);
    await waitFor(() => fake.spawned[1]?.prompts.length === 1);
    // The respawned process dies before answering: no further respawn.
    fake.spawned[1].exit(1);

    await expect(collect).rejects.toThrow('agy exited mid-turn (code=1 signal=null)');
    expect(fake.spawned).toHaveLength(2);
  });

  it('does not respawn when agy dies without a failed result', async () => {
    const fake = createFakeRuntime();
    const query = createProvider({}, fake.runtime).query({ prompt: 'first', cwd: '/workspace/agent' });
    const collect = collectEvents(query.events, []);
    await waitFor(() => fake.child?.prompts.length === 1);
    query.push('follow-up');
    fake.child.emitLine(fixtures.success('one'));
    await waitFor(() => fake.child.prompts.length === 2);
    fake.child.exit(3);
    await expect(collect).rejects.toThrow('agy exited mid-turn (code=3 signal=null)');
    expect(fake.spawned).toHaveLength(1);
  });
});

function results(events: ProviderEvent[]): ProviderEvent[] {
  return events.filter((event) => event.type === 'result');
}

async function collectEvents(events: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const event of events) sink.push(event);
}

async function waitFor(condition: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(5);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
