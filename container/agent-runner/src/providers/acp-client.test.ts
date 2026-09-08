import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { LineReader, JsonRpcDispatcher, AcpClientProvider, _test } from './acp-client.js';
import type { AcpTransport } from './acp-client.js';
import type { QueryInput, ProviderEvent } from './types.js';

// ── Mock transport ────────────────────────────────────────────────────────────

interface MockTransport extends AcpTransport {
  writes: string[];
  enqueue(line: string): void;
  terminate(): void;
}

function createMockTransport(): MockTransport {
  const writes: string[] = [];
  const reader = new LineReader();
  return {
    writes,
    write(msg) { writes.push(msg); },
    readLine: () => reader.readLine(),
    close() { reader.end(); },
    enqueue(line) { reader.feed(line + '\n'); },
    terminate() { reader.end(); },
  };
}

/**
 * Intercept transport.write so that only outgoing requests (which have a
 * `method` field) increment the step counter. Responses we send back to
 * the agent (which have `id` + `result`/`error` but no `method`) are
 * forwarded unchanged without affecting step.
 */
function autoScript(
  transport: MockTransport,
  steps: Array<(id: number) => void>,
): void {
  let step = 0;
  const orig = transport.write.bind(transport);
  transport.write = (msg: string) => {
    orig(msg);
    const parsed = JSON.parse(msg) as { id?: number; method?: string };
    // Only count outgoing requests (have both id AND method)
    if (!parsed.id || !parsed.method) return;
    const handler = steps[step++];
    handler?.(parsed.id);
  };
}

const initResult = { protocolVersion: 1, agentCapabilities: {}, meta: { name: 'test', version: '0' }, authenticationMethods: [] };

/** Collect all events from a provider query until the generator ends. */
async function collectEvents(provider: AcpClientProvider, input: QueryInput, maxEvents = 30): Promise<ProviderEvent[]> {
  const q = provider.query(input);
  const events: ProviderEvent[] = [];
  for await (const e of q.events) {
    events.push(e);
    if (events.length >= maxEvents) { q.abort(); break; }
  }
  return events;
}

const baseInput: QueryInput = { prompt: 'Hello agent', cwd: '/workspace' };

// ── LineReader ────────────────────────────────────────────────────────────────

describe('LineReader', () => {
  it('yields complete lines', async () => {
    const lr = new LineReader();
    lr.feed('hello\nworld\n');
    expect(await lr.readLine()).toBe('hello');
    expect(await lr.readLine()).toBe('world');
  });

  it('buffers incomplete lines across chunks', async () => {
    const lr = new LineReader();
    lr.feed('hel');
    lr.feed('lo\n');
    expect(await lr.readLine()).toBe('hello');
  });

  it('skips blank lines', async () => {
    const lr = new LineReader();
    lr.feed('\n\nhello\n\n');
    expect(await lr.readLine()).toBe('hello');
  });

  it('returns null immediately when called after end() with no queued lines', async () => {
    const lr = new LineReader();
    lr.end();
    expect(await lr.readLine()).toBeNull();
  });

  it('resolves waiting readers with null on end()', async () => {
    const lr = new LineReader();
    const p = lr.readLine(); // reader is waiting
    lr.end();
    expect(await p).toBeNull();
  });
});

// ── JsonRpcDispatcher ────────────────────────────────────────────────────────

describe('JsonRpcDispatcher', () => {
  it('resolves request when matching response arrives', async () => {
    const transport = createMockTransport();
    const rpc = new JsonRpcDispatcher(transport);
    rpc.pumpLoop().catch(() => {});

    const result = rpc.request('initialize', { protocolVersion: 1 });
    const sent = JSON.parse(transport.writes[0]) as { id: number };
    transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { ok: true } }));

    expect(await result).toEqual({ ok: true });
  });

  it('rejects request when error response arrives', async () => {
    const transport = createMockTransport();
    const rpc = new JsonRpcDispatcher(transport);
    rpc.pumpLoop().catch(() => {});

    const result = rpc.request('session/new', {});
    const sent = JSON.parse(transport.writes[0]) as { id: number };
    transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id: sent.id, error: { code: -32001, message: 'Not found' } }));

    await expect(result).rejects.toThrow('Not found');
  });

  it('fires notification handler on notification', () => {
    const transport = createMockTransport();
    const rpc = new JsonRpcDispatcher(transport);
    const received: unknown[] = [];
    rpc.onNotification('session/update', p => received.push(p));

    rpc.dispatch(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { update: { kind: 'agent_message_chunk' } } }));
    expect(received).toHaveLength(1);
  });

  it('calls request handler and sends result for incoming server requests', async () => {
    const transport = createMockTransport();
    const rpc = new JsonRpcDispatcher(transport);
    rpc.onRequest('fs/read_text_file', async () => ({ content: 'file content' }));

    rpc.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 99, method: 'fs/read_text_file', params: { uri: 'file:///workspace/foo.ts' } }));
    await new Promise(r => setTimeout(r, 0)); // let async handler run

    const resp = JSON.parse(transport.writes[0]) as { id: number; result: unknown };
    expect(resp.id).toBe(99);
    expect(resp.result).toEqual({ content: 'file content' });
  });

  it('sends -32601 for unhandled incoming requests', () => {
    const transport = createMockTransport();
    const rpc = new JsonRpcDispatcher(transport);

    rpc.dispatch(JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'terminal/create', params: {} }));
    const resp = JSON.parse(transport.writes[0]) as { error: { code: number } };
    expect(resp.error.code).toBe(-32601);
  });

  it('rejects all pending when transport closes', async () => {
    const transport = createMockTransport();
    const rpc = new JsonRpcDispatcher(transport);
    const pump = rpc.pumpLoop();

    const p = rpc.request('session/new', {});
    transport.terminate(); // close transport
    await pump.catch(() => {});

    await expect(p).rejects.toThrow('Connection closed');
  });
});

// ── AcpClientProvider — setup ────────────────────────────────────────────────

beforeEach(() => {
  process.env.ACP_CLIENT_CMD = JSON.stringify(['fake-agent']);
  delete process.env.ACP_CLIENT_HOST;
  delete process.env.ACP_CLIENT_PORT;
});

afterEach(() => {
  delete process.env.ACP_CLIENT_CMD;
  delete process.env.ACP_CLIENT_HOST;
  delete process.env.ACP_CLIENT_PORT;
});

// ── AcpClientProvider — constructor ─────────────────────────────────────────

describe('AcpClientProvider constructor', () => {
  it('constructs with ACP_CLIENT_CMD', () => {
    expect(() => new AcpClientProvider()).not.toThrow();
  });

  it('constructs with ACP_CLIENT_HOST + ACP_CLIENT_PORT', () => {
    delete process.env.ACP_CLIENT_CMD;
    process.env.ACP_CLIENT_HOST = 'localhost';
    process.env.ACP_CLIENT_PORT = '7777';
    expect(() => new AcpClientProvider()).not.toThrow();
  });

  it('throws when neither CMD nor HOST+PORT is set', () => {
    delete process.env.ACP_CLIENT_CMD;
    expect(() => new AcpClientProvider()).toThrow('ACP_CLIENT_CMD or ACP_CLIENT_HOST');
  });

  it('supportsNativeSlashCommands is false', () => {
    expect(new AcpClientProvider().supportsNativeSlashCommands).toBe(false);
  });
});

// ── AcpClientProvider — isSessionInvalid ────────────────────────────────────

describe('AcpClientProvider.isSessionInvalid()', () => {
  const p = () => new AcpClientProvider();

  it('returns true for "session not found"', () => {
    expect(p().isSessionInvalid(new Error('session abc not found'))).toBe(true);
  });

  it('returns true for "invalid state"', () => {
    expect(p().isSessionInvalid(new Error('invalid state'))).toBe(true);
  });

  it('returns true for "connection closed"', () => {
    expect(p().isSessionInvalid(new Error('connection closed'))).toBe(true);
  });

  it('returns false for network errors (retryable, not stale)', () => {
    expect(p().isSessionInvalid(new Error('ECONNREFUSED'))).toBe(false);
  });
});

// ── AcpClientProvider — happy path ──────────────────────────────────────────

describe('AcpClientProvider.query(): successful turn', () => {
  it('emits init with sessionId as continuation token', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess-1' } })),
      id => {
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } }));
      },
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    expect(events.find(e => e.type === 'init')).toMatchObject({ type: 'init', continuation: 'sess-1' });
  });

  it('emits result with streamed text from session/update chunks', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess-2' } })),
      id => {
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'sess-2', update: { kind: 'agent_message_chunk', content: { content: [{ type: 'text', text: 'Hello from agent!' }] } } } }));
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } }));
      },
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    expect(events.find(e => e.type === 'result')).toMatchObject({ type: 'result', text: 'Hello from agent!' });
  });

  it('emits at least one activity event', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sess-3' } })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    expect(events.some(e => e.type === 'activity')).toBe(true);
  });

  it('merges multiple streamed chunks into one result', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'multi' } })),
      id => {
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'multi', update: { kind: 'agent_message_chunk', content: { content: [{ type: 'text', text: 'Part1 ' }] } } } }));
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: 'multi', update: { kind: 'agent_message_chunk', content: { content: [{ type: 'text', text: 'Part2' }] } } } }));
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } }));
      },
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    const result = events.find(e => e.type === 'result') as { type: 'result'; text: string } | undefined;
    expect(result?.text).toBe('Part1 Part2');
  });

  it('includes inline text from final prompt response when no stream chunks', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'inline' } })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Inline answer' }], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    expect(events.find(e => e.type === 'result')).toMatchObject({ type: 'result', text: 'Inline answer' });
  });
});

// ── AcpClientProvider — error paths ─────────────────────────────────────────

describe('AcpClientProvider.query(): error paths', () => {
  it('emits retryable error when transport connection fails', async () => {
    _test.createTransport = async () => { throw new Error('ECONNREFUSED'); };

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    const err = events.find(e => e.type === 'error') as { type: 'error'; retryable: boolean; message: string } | undefined;
    expect(err?.retryable).toBe(true);
    expect(err?.message).toContain('ECONNREFUSED');
  });

  it('emits retryable error when initialize RPC fails', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, error: { code: -32603, message: 'Internal error' } })),
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    const err = events.find(e => e.type === 'error') as { type: 'error'; retryable: boolean } | undefined;
    expect(err).toBeDefined();
    expect(err?.retryable).toBe(true);
  });

  it('emits non-retryable error when prompt is cancelled', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'cancel-sess' } })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'cancelled' } })),
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    const err = events.find(e => e.type === 'error') as { type: 'error'; retryable: boolean; message: string } | undefined;
    expect(err?.retryable).toBe(false);
    expect(err?.message).toContain('cancelled');
  });

  it('emits error when transport closes mid-session', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      _id => transport.terminate(), // close before session/new responds
    ]);
    _test.createTransport = async () => transport;

    const events = await collectEvents(new AcpClientProvider(), baseInput);
    expect(events.some(e => e.type === 'error')).toBe(true);
  });
});

// ── AcpClientProvider — fs/ request handling ────────────────────────────────

describe('AcpClientProvider: fs/ request handling', () => {
  it('rejects fs/read_text_file for paths outside /workspace', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => {
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sec-sess' } }));
        // Agent immediately tries to read /etc/passwd
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'fs/read_text_file', params: { uri: 'file:///etc/passwd' } }));
      },
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    await collectEvents(new AcpClientProvider(), baseInput);

    // Wait for fs/ response to be written (async handler)
    await new Promise(r => setTimeout(r, 10));

    const secResp = transport.writes
      .map(w => JSON.parse(w) as { id?: number; error?: { message: string } })
      .find(w => w.id === 77);
    expect(secResp?.error).toBeDefined();
    expect(secResp?.error?.message).toContain('outside workspace');
  });

  it('sends -32601 for terminal/create (capability not declared)', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => {
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'term-sess' } }));
        transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id: 88, method: 'terminal/create', params: {} }));
      },
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    await collectEvents(new AcpClientProvider(), baseInput);
    await new Promise(r => setTimeout(r, 10));

    const termResp = transport.writes
      .map(w => JSON.parse(w) as { id?: number; error?: { code: number } })
      .find(w => w.id === 88);
    expect(termResp?.error?.code).toBe(-32601);
  });
});

// ── AcpClientProvider — session resume (continuation) ───────────────────────

describe('AcpClientProvider.query(): session resume', () => {
  it('skips session/new and uses continuation as sessionId', async () => {
    const transport = createMockTransport();
    // Only 2 requests: initialize + session/prompt (no session/new)
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: 'Resumed!' }], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    const input: QueryInput = { prompt: 'follow up', cwd: '/workspace', continuation: 'existing-sess' };
    const events = await collectEvents(new AcpClientProvider(), input);

    // init should reflect the resumed sessionId
    expect(events.find(e => e.type === 'init')).toMatchObject({ continuation: 'existing-sess' });
    expect(events.find(e => e.type === 'result')).toMatchObject({ text: 'Resumed!' });

    // Verify session/new was never sent
    const methods = transport.writes
      .map(w => (JSON.parse(w) as { method?: string }).method)
      .filter(Boolean);
    expect(methods).not.toContain('session/new');
    expect(methods).toContain('session/prompt');
  });
});

// ── AcpClientProvider — systemContext forwarding ─────────────────────────────

describe('AcpClientProvider.query(): systemContext forwarding', () => {
  it('prepends system instructions to the prompt content', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'sys-sess' } })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    const input: QueryInput = {
      prompt: 'Hello',
      cwd: '/workspace',
      systemContext: { instructions: 'You are a helpful assistant.' },
    };
    await collectEvents(new AcpClientProvider(), input);

    const promptMsg = transport.writes
      .map(w => JSON.parse(w) as { method?: string; params?: { prompt?: Array<{ text?: string }> } })
      .find(w => w.method === 'session/prompt');
    const text = promptMsg?.params?.prompt?.[0]?.text ?? '';
    expect(text).toContain('<system>');
    expect(text).toContain('You are a helpful assistant.');
    expect(text).toContain('Hello');
  });

  it('sends plain prompt when no systemContext', async () => {
    const transport = createMockTransport();
    autoScript(transport, [
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: initResult })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { sessionId: 'plain-sess' } })),
      id => transport.enqueue(JSON.stringify({ jsonrpc: '2.0', id, result: { content: [], stopReason: 'done' } })),
    ]);
    _test.createTransport = async () => transport;

    await collectEvents(new AcpClientProvider(), baseInput);

    const promptMsg = transport.writes
      .map(w => JSON.parse(w) as { method?: string; params?: { prompt?: Array<{ text?: string }> } })
      .find(w => w.method === 'session/prompt');
    expect(promptMsg?.params?.prompt?.[0]?.text).toBe('Hello agent');
  });
});
