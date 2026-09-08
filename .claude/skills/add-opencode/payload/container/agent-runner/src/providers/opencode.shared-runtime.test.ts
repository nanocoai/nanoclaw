import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import type { OpenCodeMessage, OpenCodeSessionClient } from './opencode-turn.js';

import {
  destroySharedRuntime,
  OpenCodeProvider,
  setSharedRuntimeDepsForTesting,
  type OpenCodeMemorySessionHook,
  type OpenCodeSharedRuntimeDeps,
  type QuestionClient,
} from './opencode.js';
import { initTestSessionDb, closeSessionDb, getInboundDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { processQuery } from '../poll-loop.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import { createProvider } from './factory.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import '../provider-contracts/index.js';
import type { ProviderEvent, ProviderExchange } from './types.js';

/**
 * The shared `opencode serve` lifecycle, driven through the
 * `setSharedRuntimeDepsForTesting` seam so no server process is ever spawned.
 *
 * Covers three review findings against the provider:
 *  - a failed or half-failed runtime init must never be cached, and a server
 *    that dies must drop out of the cache, so the next turn respawns it
 *    instead of every later message failing instantly with the same error;
 *  - `isSessionInvalid` must only fire on OpenCode's own session-not-found
 *    signal, never on backend/model errors, so a mistyped model id or a proxy
 *    hiccup does not wipe the stored conversation;
 *  - `abort()` stops one session and keeps the server; the in-turn watchdog
 *    treats the server's 10-second `server.heartbeat` as liveness.
 */

type Ev = { type: string; properties: Record<string, unknown> };

const MEMORY_HOOK: OpenCodeMemorySessionHook = {
  command: 'true',
  legacyCommands: [],
  sources: ['startup', 'compact'],
};

const CWD = '/tmp/opencode-shared-runtime-test';

function assistantReply(sessionID: string, text: string): Ev[] {
  return [
    { type: 'message.updated', properties: { info: { id: `msg_${text}`, role: 'assistant', sessionID } } },
    {
      type: 'message.part.updated',
      properties: { part: { type: 'text', messageID: `msg_${text}`, sessionID, text } },
    },
    { type: 'session.idle', properties: { sessionID } },
  ];
}

type FakeProc = ChildProcess & { kill: ReturnType<typeof mock>; emitExit(code: number): void };

/**
 * One fake server: a process handle whose `kill` ends the event stream (the
 * way SIGKILL drops a real SSE connection), plus a client whose `prompt`
 * hands the session id to the test so it decides what the server "emits".
 */
function fakeServer(onPrompt: (sessionId: string, promptIndex: number) => void) {
  const END = Symbol('end');
  const queue: Array<Ev | typeof END> = [{ type: 'server.connected', properties: {} }];
  const history = new Map<string, OpenCodeMessage[]>();
  let current:
    | { sessionId: string; userId: string; resolve(value: { data?: OpenCodeMessage; error?: unknown }): void }
    | undefined;
  let promptHandler = onPrompt;
  const finish = (error?: unknown) => {
    if (!current) return;
    let message = history
      .get(current.sessionId)!
      .findLast((m) => m.info.role === 'assistant' && m.info.parentID === current!.userId);
    if (error) {
      message = {
        info: {
          id: 'msg_error_' + current.userId,
          role: 'assistant',
          parentID: current.userId,
          time: { created: Date.now(), completed: Date.now() },
          error,
        },
        parts: [],
      };
      history.get(current.sessionId)!.push(message);
    }
    if (message) {
      current.resolve({ data: message });
      current = undefined;
    }
  };
  const waiters: Array<() => void> = [];
  const push = (events: Ev[]): void => {
    for (const event of events) {
      if (!current) continue;
      const rows = history.get(current.sessionId)!;
      const info = event.properties.info as (OpenCodeMessage['info'] & { sessionID?: string }) | undefined;
      if (event.type === 'message.updated' && info?.sessionID === current.sessionId && info.role === 'assistant') {
        rows.push({
          info: { ...info, parentID: current.userId, time: { created: Date.now(), completed: Date.now() } },
          parts: [],
        });
      }
      const part = event.properties.part as { type: string; text?: string; messageID: string } | undefined;
      if (event.type === 'message.part.updated' && part)
        rows.find((m) => m.info.id === part.messageID)?.parts.push({ ...part, id: 'prt_' + part.messageID });
    }
    queue.push(...events);
    while (waiters.length > 0 && queue.length > 0) waiters.shift()!();
  };
  const endStream = (): void => {
    queue.push(END);
    while (waiters.length > 0) waiters.shift()!();
  };
  async function* stream(): AsyncGenerator<Ev, void, void> {
    while (true) {
      if (queue.length === 0) await new Promise<void>((resolve) => waiters.push(resolve));
      const ev = queue.shift()!;
      if (ev === END) return;
      yield ev;
    }
  }

  const emitter = new EventEmitter();
  const proc = Object.assign(emitter, {
    pid: undefined,
    exitCode: null as number | null,
    signalCode: null,
    // Teardown marks the subscription released before killing its server.
    // The real SDK's onSseError then stops retries; model the closed stream.
    kill: mock(() => {
      endStream();
      return true;
    }),
    emitExit(code: number) {
      proc.exitCode = code;
      endStream();
      emitter.emit('exit', code, null);
    },
  }) as unknown as FakeProc;

  let sessionCount = 0;
  let promptCount = 0;
  // A live server answers an abort with that session's own error event.
  const abort = mock(async (params: { path: { id: string } }) => {
    push([
      {
        type: 'session.error',
        properties: {
          sessionID: params.path.id,
          error: { name: 'MessageAbortedError', data: { message: 'aborted' } },
        },
      },
    ]);
    finish({ name: 'MessageAbortedError', data: { message: 'aborted' } });
    return {};
  });
  const subscribe = mock(async (opts?: { signal?: AbortSignal }) => {
    opts?.signal?.addEventListener('abort', () => endStream(), { once: true });
    return { stream: stream() };
  });
  const client = {
    event: { subscribe },
    session: {
      async create() {
        sessionCount += 1;
        return { data: { id: `ses_${sessionCount}` } };
      },
      prompt: (async (params) => {
        promptCount += 1;
        const rows = history.get(params.path.id) ?? [];
        history.set(params.path.id, rows);
        rows.push({ info: { id: params.body.messageID, role: 'user', time: { created: Date.now() } }, parts: [] });
        return await new Promise((resolve) => {
          current = { sessionId: params.path.id, userId: params.body.messageID, resolve };
          promptHandler(params.path.id, promptCount);
        });
      }) as OpenCodeSessionClient['prompt'],
      messages: (async (params) => ({
        data: (history.get(params.path.id) ?? []).slice(-params.query.limit),
      })) as OpenCodeSessionClient['messages'],
      abort,
    },
  };
  const questionClient: QuestionClient = {
    question: {
      async reply() {
        return { data: true };
      },
      async list() {
        return { data: [] };
      },
    },
  };

  return {
    proc,
    client,
    questionClient,
    push,
    // Events and HTTP completion are independent. A stale idle/error event
    // cannot resolve the native prompt in this fixture any more than in production.
    finish,
    reply(sessionId: string, text: string) {
      push(assistantReply(sessionId, text));
      finish();
    },
    fail(sessionId: string, error: unknown) {
      push([{ type: 'session.error', properties: { sessionID: sessionId, error } }]);
      finish(error);
    },
    endStream,
    abort,
    subscribe,
    setPromptHandler: (handler: typeof onPrompt) => {
      promptHandler = handler;
    },
  };
}

function installDeps(servers: Array<ReturnType<typeof fakeServer>>, spawnFailures: Error[] = []) {
  let spawned = 0;
  let current: ReturnType<typeof fakeServer> | undefined;
  const spawnServer = mock(async (_configuration: Record<string, unknown>) => {
    const failure = spawnFailures.shift();
    if (failure) throw failure;
    current = servers[spawned];
    if (!current) throw new Error(`test: no fake server for spawn #${spawned + 1}`);
    spawned += 1;
    return { url: `http://127.0.0.1:0/${spawned}`, proc: current.proc };
  });
  const deps: OpenCodeSharedRuntimeDeps = {
    spawnServer,
    createClient: () => current!.client,
    createQuestionClient: () => current!.questionClient,
  };
  setSharedRuntimeDepsForTesting(deps);
  return { spawnServer };
}

function newProvider(): OpenCodeProvider {
  const provider = new OpenCodeProvider({});
  provider.registerMemorySessionHook(MEMORY_HOOK);
  return provider;
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

async function runOneTurn(provider: OpenCodeProvider, continuation?: string): Promise<ProviderEvent[]> {
  const query = provider.query({ prompt: 'hi', cwd: CWD, continuation });
  query.end();
  return collect(query.events);
}

const resultText = (events: ProviderEvent[]) =>
  events.filter((e) => e.type === 'result').map((e) => (e as { text: string | null }).text);

let composedFactory: ReturnType<typeof resetAgentMailboxForTesting>;
let memoryDir: string;
let savedXdg: string | undefined;
beforeEach(() => {
  composedFactory = resetAgentMailboxForTesting();
  initTestSessionDb();
  registerAgentMailbox(() => new SqliteAgentMailbox());
  savedXdg = process.env.XDG_DATA_HOME;
  memoryDir = mkdtempSync(path.join(tmpdir(), 'opencode-runtime-memory-'));
  process.env.XDG_DATA_HOME = memoryDir;
  destroySharedRuntime();
});
afterEach(() => {
  destroySharedRuntime();
  setSharedRuntimeDepsForTesting(undefined);
  if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = savedXdg;
  resetAgentMailboxForTesting();
  closeSessionDb();
  if (composedFactory) registerAgentMailbox(composedFactory);
  rmSync(memoryDir, { recursive: true, force: true });
});

describe('shared runtime recovery', () => {
  it('routes question.asked through the production event pump before native work continues', async () => {
    let sessionId = '';
    const replies: Array<{ requestID: string; answers: string[][] }> = [];
    const server = fakeServer((sid) => {
      sessionId = sid;
      server.push([
        { type: 'question.asked', properties: { id: 'que_fixture', sessionID: 'ses_other', questions: [{}] } },
      ]);
    });
    server.questionClient.question.reply = async (params) => {
      replies.push(params);
      server.reply(sessionId, 'continued after steering');
      return { data: true };
    };
    installDeps([server]);
    const query = newProvider().query({ prompt: 'work', cwd: CWD });
    query.end();
    // A missing routing branch must fail promptly rather than waiting for
    // the production idle watchdog.
    const timer = setTimeout(() => query.abort(), 1000);
    try {
      expect(resultText(await collect(query.events))).toEqual(['continued after steering']);
      expect(replies).toHaveLength(1);
      expect(replies[0].requestID).toBe('que_fixture');
      expect(replies[0].answers[0][0]).toContain('ask_user_question');
      expect(server.abort).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      query.abort();
    }
  });

  for (const partial of [false, true]) {
    it(`completes a native error once without a retry, with prior text: ${partial}`, async () => {
      getInboundDb()
        .prepare(
          `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('main', 'main', 'channel', 'discord', 'chan-1', NULL)`,
        )
        .run();
      const server = fakeServer((sid) => {
        if (partial) server.push(assistantReply(sid, '<message to="main">Completed before failure.</message>'));
        server.fail(sid, { name: 'APIError', data: { message: 'backend failed', isRetryable: false } });
      });
      installDeps([server]);
      const query = newProvider().query({ prompt: 'work', cwd: CWD });
      query.push = mock(query.push);
      query.end();
      const exchanges: ProviderExchange[] = [];
      await processQuery(
        query,
        { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1', taskRun: false },
        ['m1'],
        'opencode',
        (exchange) => exchanges.push(exchange),
        'work',
        undefined,
      );
      expect(exchanges).toHaveLength(1);
      expect(exchanges[0].result).toContain('backend failed');
      const sent = getUndeliveredMessages()
        .filter((row) => row.kind === 'chat')
        .map((row) => (JSON.parse(row.content) as { text: string }).text);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain(partial ? 'Completed before failure.' : 'backend failed');
      if (partial) expect(exchanges[0].result).toContain('Completed before failure.');
      expect(exchanges[0].status).toBe('error');
      expect(query.push).not.toHaveBeenCalled();
      expect(server.abort).not.toHaveBeenCalled();
    });
  }

  it('retries the spawn on the next query instead of caching the rejection', async () => {
    const server = fakeServer((sid) => server.reply(sid, 'back'));
    const { spawnServer } = installDeps([server], [new Error('Timeout waiting for OpenCode server to start')]);
    const provider = newProvider();

    await expect(runOneTurn(provider)).rejects.toThrow('Timeout waiting for OpenCode server');
    expect(resultText(await runOneTurn(provider))).toEqual(['back']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('kills a server whose client setup fails after the spawn, and respawns next time', async () => {
    const broken = fakeServer(() => {});
    broken.subscribe.mockImplementationOnce(async () => {
      throw new Error('subscribe exploded');
    });
    const healthy = fakeServer((sid) => healthy.reply(sid, 'ok'));
    const { spawnServer } = installDeps([broken, healthy]);
    const provider = newProvider();

    await expect(runOneTurn(provider)).rejects.toThrow('subscribe exploded');
    expect(broken.proc.kill).toHaveBeenCalledTimes(1);

    expect(resultText(await runOneTurn(provider))).toEqual(['ok']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('respawns after the server process exits between turns', async () => {
    const first = fakeServer((sid) => first.reply(sid, 'one'));
    const second = fakeServer((sid) => second.reply(sid, 'two'));
    const { spawnServer } = installDeps([first, second]);
    const provider = newProvider();

    expect(resultText(await runOneTurn(provider))).toEqual(['one']);
    first.proc.emitExit(137);

    expect(resultText(await runOneTurn(provider))).toEqual(['two']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('server exit mid-turn fails the in-flight query promptly, keeps the continuation, and respawns', async () => {
    const dying = fakeServer(() => {
      // Prompt accepted, then the server is SIGKILLed before any event.
      setTimeout(() => dying.proc.emitExit(137), 20);
    });
    const healthy = fakeServer((sid) => healthy.reply(sid, 'ok'));
    const { spawnServer } = installDeps([dying, healthy]);
    const provider = newProvider();

    let thrown: unknown;
    const started = Date.now();
    await runOneTurn(provider, 'ses_kept').catch((err: unknown) => {
      thrown = err;
    });
    expect((thrown as Error).message).toContain('OpenCode event stream ended unexpectedly');
    expect(Date.now() - started).toBeLessThan(2000);
    // The session on disk is intact: a dead server is not a stale session.
    expect(provider.isSessionInvalid(thrown)).toBe(false);
    // The subscription was opened with an abort signal and it was aborted.
    expect(dying.subscribe.mock.calls[0][0]?.signal?.aborted).toBe(true);
    // No retry cap: the SDK counts attempts cumulatively per subscription, so
    // a cap would end a long-lived stream on the Nth transient hiccup.
    expect((dying.subscribe.mock.calls[0][0] as { sseMaxRetryAttempts?: number })?.sseMaxRetryAttempts).toBeUndefined();

    expect(resultText(await runOneTurn(provider))).toEqual(['ok']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('drops the runtime when the event stream ends mid-turn so the next query respawns', async () => {
    const dying = fakeServer(() => dying.endStream());
    const healthy = fakeServer((sid) => healthy.reply(sid, 'ok'));
    const { spawnServer } = installDeps([dying, healthy]);
    const provider = newProvider();

    await expect(runOneTurn(provider)).rejects.toThrow('OpenCode event stream ended unexpectedly');
    expect(dying.proc.kill).toHaveBeenCalledTimes(1);

    expect(resultText(await runOneTurn(provider))).toEqual(['ok']);
    expect(spawnServer).toHaveBeenCalledTimes(2);
  });

  it('reuses one server across queries when nothing went wrong', async () => {
    const server = fakeServer((sid, n) => server.reply(sid, `r${n}`));
    const { spawnServer } = installDeps([server]);
    const provider = newProvider();

    expect(resultText(await runOneTurn(provider))).toEqual(['r1']);
    expect(resultText(await runOneTurn(provider, 'ses_1'))).toEqual(['r2']);
    expect(spawnServer).toHaveBeenCalledTimes(1);
    expect(server.proc.kill).not.toHaveBeenCalled();
  });

  it('does not finish a native prompt when its event stream reports idle or a recoverable error', async () => {
    let sessionId = '';
    const server = fakeServer((sid) => {
      sessionId = sid;
    });
    installDeps([server]);
    let settled = false;
    const result = runOneTurn(newProvider()).finally(() => {
      settled = true;
    });
    while (!sessionId) await Bun.sleep(1);
    server.push(assistantReply(sessionId, 'verified text'));
    server.push([
      { type: 'session.error', properties: { sessionID: sessionId, error: { name: 'ContextOverflowError' } } },
    ]);
    await Bun.sleep(10);
    expect(settled).toBe(false);
    server.finish();
    expect(resultText(await result)).toEqual(['verified text']);
    expect(server.abort).not.toHaveBeenCalled();
  });
});

describe('isSessionInvalid', () => {
  const provider = newProvider();

  it("fires only on OpenCode's own NotFoundError for the session", () => {
    expect(
      provider.isSessionInvalid(
        new Error('OpenCode prompt: {"name":"NotFoundError","data":{"message":"Session not found: ses_gone"}}'),
      ),
    ).toBe(true);
  });

  it('keeps the continuation on backend, proxy and watchdog errors', () => {
    for (const msg of [
      '404 No endpoints found',
      'OpenCode retry limit (3): 404 No endpoints found',
      'read ECONNRESET',
      'connection reset by peer',
      'OpenCode event stream silent for 60000ms; server dropped',
      'OpenCode turn produced no activity for 900000ms; aborted',
      'OpenCode SSE stream ended unexpectedly',
      'OpenCode prompt: {}',
    ]) {
      expect(provider.isSessionInvalid(new Error(msg))).toBe(false);
    }
  });

  it('a backend 404 surfaced as session.error is a turn error, not a stale session', async () => {
    const server = fakeServer((sid) =>
      server.fail(sid, { name: 'APIError', data: { message: '404 No endpoints found' } }),
    );
    installDeps([server]);
    const provider = newProvider();

    const result = (await runOneTurn(provider, 'ses_1')).find((event) => event.type === 'result');
    expect(result?.isError).toBe(true);
    expect(result?.text).toContain('404 No endpoints found');
    expect(provider.isSessionInvalid(new Error(result?.text ?? ''))).toBe(false);
  });

  it.each(['APIError', 'ProviderAuthError'])(
    'an authentication failure (%s) preserves the resumable session contract',
    async (name) => {
      const server = fakeServer((sid) =>
        server.fail(sid, { name, data: { statusCode: 401, message: 'Authentication failed' } }),
      );
      installDeps([server]);
      const provider = newProvider();
      const result = (await runOneTurn(provider, 'ses_1')).find((event) => event.type === 'result');
      expect(result?.isError).toBe(true);
      expect(result?.text).toContain('Authentication failed');
      expect(provider.isSessionInvalid(new Error(result?.text ?? ''))).toBe(false);
    },
  );

  it('a prompt NotFoundError for the resumed id is a stale session', async () => {
    const server = fakeServer(() => {});
    server.client.session.prompt = async () => ({
      error: { name: 'NotFoundError', data: { message: 'Session not found: ses_gone' } },
    });
    installDeps([server]);
    const provider = newProvider();

    let thrown: unknown;
    await runOneTurn(provider, 'ses_gone').catch((err: unknown) => {
      thrown = err;
    });
    expect(provider.isSessionInvalid(thrown)).toBe(true);
  });
});

describe('abort and watchdog', () => {
  it('abort() stops the in-flight session and keeps the shared server', async () => {
    const server = fakeServer(() => {});
    const { spawnServer } = installDeps([server]);
    const provider = newProvider();

    const query = provider.query({ prompt: 'work', cwd: CWD });
    const iterator = query.events[Symbol.asyncIterator]();
    expect((await iterator.next()).value).toEqual({ type: 'init', continuation: 'ses_1' });

    // The generator is now parked on stream.next() with a prompt in flight.
    const pendingNext = iterator.next();
    await Bun.sleep(10);
    query.abort();

    // What the server sends back for the aborted session (the fake abort
    // emits it) must not become this query's error.
    expect((await pendingNext).done).toBe(true);
    expect(server.abort).toHaveBeenCalledTimes(1);
    expect(server.abort.mock.calls[0][0]).toMatchObject({ path: { id: 'ses_1' } });
    expect(server.proc.kill).not.toHaveBeenCalled();

    // The next query lands on the same server.
    const again = provider.query({ prompt: 'again', cwd: CWD });
    again.end();
    const promptedOn: string[] = [];
    server.setPromptHandler((sid) => {
      promptedOn.push(sid);
      server.reply(sid, 'fresh');
    });
    expect(resultText(await collect(again.events))).toEqual(['fresh']);
    expect(promptedOn).toEqual(['ses_2']);
    expect(spawnServer).toHaveBeenCalledTimes(1);
  });

  it('abort() while parked in session.create() sends no prompt', async () => {
    const server = fakeServer(() => {});
    let releaseCreate: (() => void) | undefined;
    const realCreate = server.client.session.create;
    server.client.session.create = async () => {
      await new Promise<void>((resolve) => {
        releaseCreate = resolve;
      });
      return realCreate();
    };
    const prompt = mock(server.client.session.prompt);
    server.client.session.prompt = prompt;
    installDeps([server]);
    const provider = newProvider();

    const query = provider.query({ prompt: 'work', cwd: CWD });
    const iterator = query.events[Symbol.asyncIterator]();
    const first = iterator.next();
    while (!releaseCreate) await new Promise((r) => setTimeout(r, 1));

    query.abort();
    releaseCreate();
    expect((await first).done).toBe(true);

    expect(prompt).not.toHaveBeenCalled();
    expect(server.abort).not.toHaveBeenCalled();
  });

  describe('with short watchdog budgets', () => {
    const saved: Record<string, string | undefined> = {};
    const KEYS = ['OPENCODE_IDLE_TIMEOUT_MS', 'OPENCODE_STREAM_SILENCE_MS'] as const;
    beforeEach(() => {
      for (const k of KEYS) saved[k] = process.env[k];
    });
    afterEach(() => {
      for (const k of KEYS) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    });

    it('stream tier: heartbeats keep a quiet tool run alive; only agent events count as activity', async () => {
      process.env.OPENCODE_STREAM_SILENCE_MS = '150';
      process.env.OPENCODE_IDLE_TIMEOUT_MS = '10000';
      const server = fakeServer((sid) => {
        // A tool that streams nothing for well over the silence budget while
        // the server's heartbeat keeps ticking, then the reply.
        let ticks = 0;
        const beat = setInterval(() => {
          server.push([{ type: 'server.heartbeat', properties: {} }]);
          ticks += 1;
          if (ticks >= 12) {
            clearInterval(beat);
            server.reply(sid, 'done after a long tool');
          }
        }, 40);
      });
      installDeps([server]);
      const provider = newProvider();

      const events = await runOneTurn(provider);
      expect(resultText(events)).toEqual(['done after a long tool']);
      expect(server.proc.kill).not.toHaveBeenCalled();
      expect(server.abort).not.toHaveBeenCalled();
      expect(events.filter((e) => e.type === 'activity').length).toBeLessThanOrEqual(2);
    });

    it('stream tier: silence including heartbeats drops the server as genuine death', async () => {
      process.env.OPENCODE_STREAM_SILENCE_MS = '150';
      process.env.OPENCODE_IDLE_TIMEOUT_MS = '10000';
      const server = fakeServer(() => {});
      installDeps([server]);
      const provider = newProvider();

      await expect(runOneTurn(provider)).rejects.toThrow('OpenCode event stream silent for 150ms');
      expect(server.proc.kill).toHaveBeenCalledTimes(1);
      expect(server.abort).toHaveBeenCalledTimes(1);
    });

    it('activity tier: a wedged backend on a live stream aborts the session and keeps the server', async () => {
      process.env.OPENCODE_STREAM_SILENCE_MS = '10000';
      process.env.OPENCODE_IDLE_TIMEOUT_MS = '150';
      const server = fakeServer(() => {
        const beat = setInterval(() => server.push([{ type: 'server.heartbeat', properties: {} }]), 40);
        setTimeout(() => clearInterval(beat), 2000);
      });
      const { spawnServer } = installDeps([server]);
      const provider = newProvider();

      await expect(runOneTurn(provider)).rejects.toThrow('OpenCode turn produced no activity for 150ms; aborted');
      expect(server.abort).toHaveBeenCalledTimes(1);
      expect(server.abort.mock.calls[0][0]).toMatchObject({ path: { id: 'ses_1' } });
      expect(server.proc.kill).not.toHaveBeenCalled();
      // A backend wedge is not a stale session: the continuation must survive.
      expect(provider.isSessionInvalid(new Error('OpenCode turn produced no activity for 150ms; aborted'))).toBe(false);

      // The server is still the one we had.
      server.setPromptHandler((sid) => server.reply(sid, 'recovered'));
      expect(resultText(await runOneTurn(provider))).toEqual(['recovered']);
      expect(spawnServer).toHaveBeenCalledTimes(1);
    });
  });
});

describe('SDK stream cleanup', () => {
  it('handles an asynchronous AbortError from the stream return operation', async () => {
    const server = fakeServer((sid) => server.reply(sid, 'done'));
    const subscribe = server.subscribe.getMockImplementation()!;
    const returnStream = mock(async () => {
      throw new DOMException('Aborted', 'AbortError');
    });
    server.subscribe.mockImplementationOnce(async (options) => {
      const subscription = await subscribe(options);
      subscription.stream.return = returnStream;
      return subscription;
    });
    installDeps([server]);
    await runOneTurn(newProvider());
    destroySharedRuntime();
    await Bun.sleep(0);
    expect(returnStream).toHaveBeenCalled();
  });
});

describe('runtime contract consumption', () => {
  it('uses the core-resolved configuration even if environment defaults change before query', async () => {
    const server = fakeServer((sid) => server.reply(sid, 'configured'));
    const { spawnServer } = installDeps([server]);
    const saved = { ...process.env };
    try {
      process.env.OPENCODE_PROVIDER = 'openai';
      process.env.OPENCODE_MODEL = 'openai/default';
      process.env.ANTHROPIC_BASE_URL = 'http://localhost:8891/v1';
      const provider = createProvider('opencode', { model: 'openai/group-model', effort: 'high' });
      registerProviderMemorySessionHook('opencode', provider, MEMORY_HOOK);
      process.env.OPENCODE_PROVIDER = 'anthropic';
      process.env.OPENCODE_MODEL = 'changed-after-resolution';
      await runOneTurn(provider as OpenCodeProvider);
      expect(spawnServer.mock.calls[0][0]).toMatchObject({
        model: 'openai/group-model',
        enabled_providers: ['openai'],
        permission: { question: 'deny', bash: 'allow' },
        provider: { openai: { models: { 'group-model': { options: { reasoningEffort: 'high' } } } } },
      });
    } finally {
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved);
    }
  });

  it('restarts the shared server when effective effort changes', async () => {
    const first = fakeServer((sid) => first.reply(sid, 'one'));
    const second = fakeServer((sid) => second.reply(sid, 'two'));
    const { spawnServer } = installDeps([first, second]);
    const config = (effort: string) => ({
      executionPolicy: { question: 'deny' },
      inference: { model: 'openai/test', provider: { openai: { options: { reasoningEffort: effort } } } },
      mcpServers: {},
    });
    for (const effort of ['low', 'high']) {
      const provider = new OpenCodeProvider({}, undefined, config(effort));
      provider.registerMemorySessionHook(MEMORY_HOOK);
      await runOneTurn(provider);
    }
    expect(spawnServer).toHaveBeenCalledTimes(2);
    expect(first.proc.kill).toHaveBeenCalled();
  });
});
