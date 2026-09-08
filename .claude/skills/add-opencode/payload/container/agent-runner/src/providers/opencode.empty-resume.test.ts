import { afterEach, describe, expect, it, mock } from 'bun:test';
import {
  executeOpenCodeTurn,
  OpenCodeEventPump,
  createOpenCodeMessageId,
  type OpenCodeEvent,
  type OpenCodeMessage,
  type OpenCodeSessionClient,
} from './opencode-turn.js';

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function fixture() {
  const events: OpenCodeEvent[] = [{ type: 'server.connected', properties: {} }];
  let wake: (() => void) | undefined;
  let closed = false;
  let subscribed = false;
  const emit = (event: OpenCodeEvent) => {
    events.push(event);
    wake?.();
  };
  const pump = new OpenCodeEventPump(
    (async function* () {
      subscribed = true;
      while (!closed) {
        if (!events.length)
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
        const event = events.shift();
        if (event) yield event;
      }
    })(),
    () => {},
  );
  const close = () => {
    closed = true;
    wake?.();
  };
  cleanups.push(close);
  const history: OpenCodeMessage[] = [];
  let request = deferred<{ data?: OpenCodeMessage; error?: unknown }>();
  let marker = '';
  const prompts: Parameters<OpenCodeSessionClient['prompt']>[0][] = [];
  const abort = mock(async () => {
    request.resolve({ error: { name: 'MessageAbortedError' } });
    return {};
  });
  const client: OpenCodeSessionClient = {
    create: async () => ({ data: { id: 'ses_test' } }),
    prompt: (params) => {
      expect(subscribed).toBe(true);
      prompts.push(params);
      marker = params.body.messageID;
      history.push({ info: { id: marker, role: 'user', time: { created: Date.now() } }, parts: [] });
      request = deferred();
      return request.promise;
    },
    messages: async (params) => ({ data: history.slice(-params.query.limit) }),
    abort,
  };
  const discard = mock(close);
  const runtime = {};
  const run = (
    signal = new AbortController().signal,
    overrides: Partial<Parameters<typeof executeOpenCodeTurn>[0]> = {},
  ) =>
    executeOpenCodeTurn({
      runtime,
      client,
      pump,
      sessionId: 'ses_test',
      parts: [{ type: 'text', text: 'test' }],
      signal,
      silenceMs: 10000,
      idleMs: 10000,
      discard,
      ...overrides,
    });
  const assistant = (id: string, text: string[], extra: Partial<OpenCodeMessage['info']> = {}): OpenCodeMessage => ({
    info: { id, role: 'assistant', parentID: marker, time: { created: Date.now(), completed: Date.now() }, ...extra },
    parts: text.map((text, index) => ({ id: `prt_${id}_${index}`, type: 'text', text })),
  });
  const complete = (message = assistant('msg_answer', ['answer'])) => {
    history.push(message);
    request.resolve({ data: message });
  };
  return {
    run,
    history,
    emit,
    client,
    abort,
    prompts,
    complete,
    assistant,
    discard,
    get request() {
      return request;
    },
    get marker() {
      return marker;
    },
  };
}

async function collectTurn(turn: ReturnType<typeof executeOpenCodeTurn>) {
  const events: Array<{ type: string }> = [];
  while (true) {
    const event = await turn.next();
    if (event.done) return { result: event.value, events };
    events.push(event.value);
  }
}
async function collect(turn: ReturnType<typeof executeOpenCodeTurn>) {
  return (await collectTurn(turn)).result.text;
}
async function prompted(f: ReturnType<typeof fixture>, count = 1) {
  for (let attempt = 0; attempt < 1000 && f.prompts.length < count; attempt++) await Bun.sleep(1);
  expect(f.prompts.length).toBe(count);
}

describe('verified OpenCode turn completion', () => {
  it('starts the lazy SSE subscription before the first prompt and preserves native ID shape', async () => {
    const f = fixture();
    const result = collect(f.run());
    await prompted(f);
    expect(f.marker).toMatch(/^msg_[a-f0-9]{12}[A-Za-z0-9]{14}$/);
    expect(new Set(Array.from({ length: 100 }, createOpenCodeMessageId)).size).toBe(100);
    f.complete();
    expect(await result).toBe('answer');
  });

  it('ignores stale idle and recoverable overflow while the HTTP turn remains active', async () => {
    const f = fixture();
    let settled = false;
    const result = collect(f.run()).finally(() => {
      settled = true;
    });
    await prompted(f);
    f.emit({ type: 'session.idle', properties: { sessionID: 'ses_test' } });
    f.emit({ type: 'session.error', properties: { sessionID: 'ses_test', error: { name: 'ContextOverflowError' } } });
    await Bun.sleep(10);
    expect(settled).toBe(false);
    expect(f.prompts).toHaveLength(1);
    f.complete();
    expect(await result).toBe('answer');
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('collects all text parts and assistant messages, excluding prior output and compaction summaries', async () => {
    const f = fixture();
    const created = Date.now() + 1000;
    f.history.push({ info: { id: 'msg_old_user', role: 'user', time: { created } }, parts: [] });
    const result = collect(f.run());
    await prompted(f);
    f.history.push(f.assistant('msg_old_assistant', ['old output'], { parentID: 'msg_old_user' }));
    const first = f.assistant('msg_first', ['<message to="a">one</message>', '<message to="b">two</message>']);
    f.history.unshift(first); // Native/client counters need not sort parent before child.
    f.history.push(f.assistant('msg_summary', ['<message to="a">do not send summary</message>'], { summary: true }));
    const replay = 'msg_replay';
    f.history.push({ info: { id: replay, role: 'user', time: { created: Date.now() } }, parts: [] });
    const final = f.assistant('msg_final', ['<message to="c">three</message>'], { parentID: replay });
    final.parts.push(first.parts[0]); // Repeated part ID is delivered once.
    f.complete(final);
    expect(await result).toBe(
      '<message to="a">one</message>\n\n<message to="b">two</message>\n\n<message to="c">three</message>',
    );
  });

  it('does not replay when the response belongs to an older assistant', async () => {
    const f = fixture();
    const result = collect(f.run());
    await prompted(f);
    f.complete(f.assistant('msg_old', ['old'], { parentID: 'msg_previous' }));
    await expect(result).rejects.toThrow('another turn');
    expect(f.prompts).toHaveLength(1);
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('fails visibly when history cannot prove the prompt', async () => {
    const f = fixture();
    const result = collect(f.run());
    await prompted(f);
    f.history.length = 0;
    f.complete();
    await expect(result).rejects.toThrow('verifiable prompt');
    expect(f.prompts).toHaveLength(1);
  });

  it('surfaces a completed native error as one final error result without aborting an idle session', async () => {
    const f = fixture();
    const result = collectTurn(f.run());
    await prompted(f);
    f.complete(
      f.assistant('msg_failed', [], { error: { name: 'APIError', data: { message: 'backend rejected request' } } }),
    );
    const completed = await result;
    expect(completed.result.isError).toBe(true);
    expect(completed.result.text).toBeNull();
    expect(completed.events).toEqual([
      { type: 'error', message: expect.stringContaining('backend rejected request'), retryable: false },
    ]);
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('preserves only completed text from this prompt when a later native step fails', async () => {
    const f = fixture();
    f.history.push({ info: { id: 'msg_prior_user', role: 'user', time: { created: Date.now() + 1000 } }, parts: [] });
    const result = collectTurn(f.run());
    await prompted(f);
    f.history.push(f.assistant('msg_prior', ['PRIOR_TURN'], { parentID: 'msg_prior_user' }));
    f.history.push(f.assistant('msg_done', ['<message to="a">COMPLETED_STEP</message>']));
    f.history.push(f.assistant('msg_summary', ['INTERNAL_SUMMARY'], { summary: true }));
    f.history.push(f.assistant('msg_unfinished', ['UNFINISHED_STEP'], { time: { created: Date.now() } }));
    f.complete(
      f.assistant('msg_failed', ['FAILED_STEP'], {
        error: {
          name: 'APIError',
          data: {
            message: 'FINAL_STEP_FAILED',
            responseBody: '<message to="a">RAW_DIAGNOSTIC_MUST_NOT_DELIVER</message>',
            responseHeaders: { 'x-fixture': 'RAW_HEADER' },
          },
        },
      }),
    );
    const completed = await result;
    expect(completed.result).toEqual({
      text: '<message to="a">COMPLETED_STEP</message>',
      isError: true,
    });
    expect(completed.events.filter((event) => event.type === 'error')).toHaveLength(1);
    expect(completed.events).toContainEqual({
      type: 'error',
      message: expect.stringContaining('RAW_DIAGNOSTIC_MUST_NOT_DELIVER'),
      retryable: false,
    });
    expect(f.prompts).toHaveLength(1);
    expect(f.abort).not.toHaveBeenCalled();
  });

  it('lets native retries finish while keeping a second prompt queued', async () => {
    const f = fixture();
    const first = collect(f.run());
    await prompted(f);
    const second = collect(f.run());
    for (let attempt = 1; attempt <= 5; attempt++) {
      f.emit({ type: 'session.status', properties: { sessionID: 'ses_test', status: { type: 'retry', attempt } } });
      await Bun.sleep(1);
      expect(f.prompts).toHaveLength(1);
      expect(f.abort).not.toHaveBeenCalled();
    }
    f.complete();
    expect(await first).toBe('answer');
    await prompted(f, 2);
    f.complete();
    expect(await second).toBe('answer');
  });

  it('gives every history page its own request budget after native completion', async () => {
    const f = fixture();
    const messages = f.client.messages;
    const reads: number[] = [];
    f.client.messages = async (params) => {
      if (f.prompts.length) {
        reads.push(params.query.limit);
        await Bun.sleep(1600);
      }
      return messages(params);
    };
    const result = collect(f.run(undefined, { silenceMs: 60000, idleMs: 60000 }));
    await prompted(f);
    for (let step = 0; step < 3300; step++) f.history.push(f.assistant(`msg_step_${step}`, []));
    f.complete();
    expect(await result).toBe('answer');
    expect(reads).toEqual([100, 200, 400, 800, 1600, 3200, 6400]);
    expect(f.prompts).toHaveLength(1);
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.discard).not.toHaveBeenCalled();
  }, 20000);

  it('does not abort completed native execution when a later history read fails', async () => {
    const f = fixture();
    const messages = f.client.messages;
    f.client.messages = async (params) =>
      f.prompts.length
        ? { error: { name: 'StorageError', data: { message: 'History unavailable' } } }
        : messages(params);
    const result = collect(f.run());
    await prompted(f);
    f.complete();
    await expect(result).rejects.toThrow('History unavailable');
    expect(f.abort).not.toHaveBeenCalled();
    expect(f.prompts).toHaveLength(1);
  });

  it('explicitly aborts and discards uncertain native execution after HTTP disconnect', async () => {
    const f = fixture();
    const result = collect(f.run());
    await prompted(f);
    f.request.reject(new Error('connection reset'));
    await expect(result).rejects.toThrow('connection reset');
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(f.discard).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued query promptly without aborting the earlier turn', async () => {
    const f = fixture();
    const first = collect(f.run());
    await prompted(f);
    const cancel = new AbortController();
    const second = collect(f.run(cancel.signal));
    cancel.abort();
    await expect(second).rejects.toThrow('aborted');
    expect(f.abort).not.toHaveBeenCalled();
    f.complete();
    expect(await first).toBe('answer');
  });

  it('waits for original HTTP completion after an abort that raced prompt registration', async () => {
    const f = fixture();
    const cancel = new AbortController();
    f.abort.mockImplementation(async () => ({}));
    let settled = false;
    const result = collect(f.run(cancel.signal)).finally(() => {
      settled = true;
    });
    await prompted(f);
    cancel.abort();
    await Bun.sleep(10);
    expect(f.abort).toHaveBeenCalledTimes(1);
    expect(settled).toBe(false);
    f.request.resolve({ error: { name: 'MessageAbortedError' } });
    await expect(result).rejects.toThrow('aborted');
    expect(f.discard).not.toHaveBeenCalled();
  });

  it('aborts when the consumer closes the generator after an activity event', async () => {
    const f = fixture();
    const turn = f.run();
    const first = turn.next();
    await prompted(f);
    f.emit({ type: 'message.updated', properties: { info: { sessionID: 'ses_test', id: 'msg_work' } } });
    expect((await first).value).toEqual({ type: 'activity' });
    await turn.return({ text: null });
    expect(f.abort).toHaveBeenCalledTimes(1);
  });

  it('counts owned task-child activity while excluding an unrelated session', async () => {
    const f = fixture();
    const result = collect(f.run(undefined, { idleMs: 50 }));
    await prompted(f);
    f.emit({ type: 'session.created', properties: { info: { id: 'ses_child', parentID: 'ses_test' } } });
    for (let step = 0; step < 8; step++) {
      f.emit({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_child' } } });
      await Bun.sleep(10);
    }
    f.complete();
    expect(await result).toBe('answer');
    expect(f.abort).not.toHaveBeenCalled();

    const second = collect(f.run(undefined, { idleMs: 40 }));
    const rejected = second.then(
      () => undefined,
      (error: Error) => error,
    );
    await prompted(f, 2);
    for (let step = 0; step < 6; step++) {
      f.emit({ type: 'message.part.updated', properties: { part: { sessionID: 'ses_unrelated' } } });
      await Bun.sleep(10);
    }
    expect((await rejected)?.message).toContain('no activity');
  });
});
