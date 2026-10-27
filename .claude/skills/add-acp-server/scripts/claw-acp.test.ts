import { describe, expect, test } from 'bun:test';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AcpBridge, LineReader, type CliTransport } from './claw-acp.ts';

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Captures ACP output and provides an input LineReader for injection. */
class MockIO {
  readonly written: Record<string, unknown>[] = [];
  private readonly _reader = new LineReader();

  feed(obj: object): void {
    this._reader.feed(JSON.stringify(obj) + '\n');
  }

  end(): void {
    this._reader.end();
  }

  get inputReader(): LineReader {
    return this._reader;
  }

  get outputFn(): (line: string) => void {
    return (line) => this.written.push(JSON.parse(line));
  }

  /** All result/error responses (not notifications). */
  get responses(): Record<string, unknown>[] {
    return this.written.filter(m => 'id' in m);
  }

  /** All notification messages. */
  get notifications(): Record<string, unknown>[] {
    return this.written.filter(m => !('id' in m) && 'method' in m);
  }
}

/** Simulates the NanoClaw CLI socket. */
class MockCli {
  readonly sent: string[] = [];
  private readonly _reader = new LineReader();
  private _closed = false;

  respond(text: string): void {
    this._reader.feed(JSON.stringify({ text }) + '\n');
  }

  terminate(): void {
    if (!this._closed) {
      this._closed = true;
      this._reader.end();
    }
  }

  get transport(): CliTransport {
    return {
      reader: this._reader,
      write: (msg) => {
        const parsed = JSON.parse(msg) as Record<string, unknown>;
        if (typeof parsed.text === 'string') this.sent.push(parsed.text);
      },
      close: () => this.terminate(),
    };
  }
}

/** Creates a bridge with injected MockIO and MockCli. */
function makeBridge(cli: MockCli, io: MockIO, opts: { recvTimeoutMs?: number; fsRoot?: string } = {}) {
  return new AcpBridge({
    input: io.inputReader,
    output: io.outputFn,
    connectCli: () => Promise.resolve(cli.transport),
    recvTimeoutMs: opts.recvTimeoutMs ?? 5_000,
    fsRoot: opts.fsRoot,
  });
}

// ── LineReader ────────────────────────────────────────────────────────────────

describe('LineReader', () => {
  test('reads a complete line', async () => {
    const r = new LineReader();
    r.feed('hello\n');
    expect(await r.readLine()).toBe('hello');
  });

  test('buffers partial chunks and resolves when newline arrives', async () => {
    const r = new LineReader();
    const p = r.readLine();
    r.feed('hel');
    r.feed('lo\n');
    expect(await p).toBe('hello');
  });

  test('skips blank lines', async () => {
    const r = new LineReader();
    r.feed('\n\n  \nfoo\n');
    expect(await r.readLine()).toBe('foo');
  });

  test('resolves null on end()', async () => {
    const r = new LineReader();
    const p = r.readLine();
    r.end();
    expect(await p).toBeNull();
  });

  test('queued lines are returned before null', async () => {
    const r = new LineReader();
    r.feed('a\nb\n');
    r.end();
    expect(await r.readLine()).toBe('a');
    expect(await r.readLine()).toBe('b');
    expect(await r.readLine()).toBeNull();
  });
});

// ── handleInitialize ──────────────────────────────────────────────────────────

describe('handleInitialize', () => {
  test('responds with correct protocol fields', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn });
    bridge.handleInitialize(1);

    expect(io.written).toHaveLength(1);
    const msg = io.written[0] as Record<string, unknown>;
    expect(msg.jsonrpc).toBe('2.0');
    expect(msg.id).toBe(1);
    const result = msg.result as Record<string, unknown>;
    expect(result.protocolVersion).toBe(1);
    expect((result.agentCapabilities as Record<string, unknown>).promptCapabilities).toBeDefined();
    expect((result.serverInfo as Record<string, unknown>).name).toBe('nanoclaw');
    expect(result.authMethods).toEqual([]);
  });

  test('echoes back the request id', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn });
    bridge.handleInitialize(42);
    expect((io.written[0] as Record<string, unknown>).id).toBe(42);
  });
});

// ── handleSessionNew ──────────────────────────────────────────────────────────

describe('handleSessionNew', () => {
  test('returns a valid UUID sessionId', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn });
    bridge.handleSessionNew(2);
    const result = (io.written[0] as Record<string, unknown>).result as Record<string, unknown>;
    expect(typeof result.sessionId).toBe('string');
    expect(result.sessionId as string).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

// ── handleSessionPrompt ───────────────────────────────────────────────────────

describe('handleSessionPrompt', () => {
  test('happy path: sends to CLI, emits update, responds end_turn', async () => {
    const io = new MockIO();
    const cli = new MockCli();
    const bridge = makeBridge(cli, io);

    const promptP = bridge.handleSessionPrompt(3, {
      sessionId: 'sess-1',
      prompt: [{ type: 'text', text: 'Hello' }],
    });

    // CLI receives the prompt — respond
    await new Promise(r => setTimeout(r, 10));
    cli.respond('World');

    await promptP;

    expect(cli.sent).toEqual(['Hello']);

    const notif = io.notifications[0];
    expect(notif.method).toBe('session/update');
    const params = notif.params as Record<string, unknown>;
    expect(params.sessionId).toBe('sess-1');
    const update = params.update as Record<string, unknown>;
    expect(update.sessionUpdate).toBe('agent_message_chunk');
    expect((update.content as Record<string, unknown>).text).toBe('World');

    const resp = io.responses[0];
    expect((resp.result as Record<string, unknown>).stopReason).toBe('end_turn');
  });

  test('empty prompt returns end_turn without connecting to CLI', async () => {
    const io = new MockIO();
    const cli = new MockCli();
    const bridge = makeBridge(cli, io);

    await bridge.handleSessionPrompt(3, { sessionId: 's1', prompt: [] });

    expect(cli.sent).toHaveLength(0);
    expect((io.responses[0].result as Record<string, unknown>).stopReason).toBe('end_turn');
  });

  test('timeout: returns -32000 error and closes CLI', async () => {
    const io = new MockIO();
    const cli = new MockCli();
    const bridge = makeBridge(cli, io, { recvTimeoutMs: 50 });

    await bridge.handleSessionPrompt(3, {
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'ping' }],
    });

    const resp = io.responses[0];
    expect(resp.error).toBeDefined();
    expect((resp.error as Record<string, unknown>).code).toBe(-32000);
    expect((resp.error as Record<string, unknown>).message as string).toContain('timeout');
  });

  test('CLI socket closed mid-wait: returns -32000 error', async () => {
    const io = new MockIO();
    const cli = new MockCli();
    const bridge = makeBridge(cli, io);

    const promptP = bridge.handleSessionPrompt(3, {
      sessionId: 's1',
      prompt: [{ type: 'text', text: 'ping' }],
    });

    await new Promise(r => setTimeout(r, 10));
    cli.terminate();

    await promptP;

    const resp = io.responses[0];
    expect(resp.error).toBeDefined();
    expect((resp.error as Record<string, unknown>).code).toBe(-32000);
  });

  test('concatenates multiple text blocks', async () => {
    const io = new MockIO();
    const cli = new MockCli();
    const bridge = makeBridge(cli, io);

    const promptP = bridge.handleSessionPrompt(3, {
      sessionId: 's1',
      prompt: [
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world' },
      ],
    });

    await new Promise(r => setTimeout(r, 10));
    cli.respond('ok');
    await promptP;

    expect(cli.sent[0]).toBe('Hello world');
  });
});

// ── handleSessionCancel / handleSessionClose ──────────────────────────────────

describe('handleSessionCancel', () => {
  test('responds with empty result', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn });
    bridge.handleSessionCancel(5);
    expect(io.responses[0].result).toEqual({});
  });
});

describe('handleSessionClose', () => {
  test('responds with empty result', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn });
    bridge.handleSessionClose(6);
    expect(io.responses[0].result).toEqual({});
  });
});

// ── handleFsReadTextFile ──────────────────────────────────────────────────────

describe('handleFsReadTextFile', () => {
  let tmpDir: string;

  // Use a real temp dir as the fsRoot so path checks pass
  const setup = () => {
    tmpDir = mkdtempSync(join(tmpdir(), 'claw-acp-test-'));
    return tmpDir;
  };
  const teardown = () => rmSync(tmpDir, { recursive: true, force: true });

  test('reads a file and returns content', () => {
    const root = setup();
    try {
      const filePath = join(root, 'test.txt');
      writeFileSync(filePath, 'hello world');
      const io = new MockIO();
      const bridge = new AcpBridge({ output: io.outputFn, fsRoot: root });
      bridge.handleFsReadTextFile(7, { path: filePath });
      expect((io.responses[0].result as Record<string, unknown>).content).toBe('hello world');
    } finally { teardown(); }
  });

  test('line/limit returns partial content', () => {
    const root = setup();
    try {
      const filePath = join(root, 'multi.txt');
      writeFileSync(filePath, 'line1\nline2\nline3\nline4\n');
      const io = new MockIO();
      const bridge = new AcpBridge({ output: io.outputFn, fsRoot: root });
      bridge.handleFsReadTextFile(7, { path: filePath, line: 2, limit: 2 });
      expect((io.responses[0].result as Record<string, unknown>).content).toBe('line2\nline3');
    } finally { teardown(); }
  });

  test('path outside fsRoot returns -32000', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn, fsRoot: '/tmp/restricted' });
    bridge.handleFsReadTextFile(7, { path: '/etc/passwd' });
    const err = io.responses[0].error as Record<string, unknown>;
    expect(err.code).toBe(-32000);
    expect(err.message as string).toContain('outside allowed root');
  });

  test('missing path param returns -32602', () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ output: io.outputFn });
    bridge.handleFsReadTextFile(7, {});
    const err = io.responses[0].error as Record<string, unknown>;
    expect(err.code).toBe(-32602);
  });

  test('file not found returns -32000 with ENOENT', () => {
    const root = setup();
    try {
      const io = new MockIO();
      const bridge = new AcpBridge({ output: io.outputFn, fsRoot: root });
      bridge.handleFsReadTextFile(7, { path: join(root, 'missing.txt') });
      const err = io.responses[0].error as Record<string, unknown>;
      expect(err.code).toBe(-32000);
      expect(err.message as string).toContain('ENOENT');
    } finally { teardown(); }
  });
});

// ── Unknown method / notifications ────────────────────────────────────────────

describe('run() dispatch', () => {
  test('unknown method with id returns -32601', async () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ input: io.inputReader, output: io.outputFn });
    io.feed({ jsonrpc: '2.0', id: 9, method: 'unknown/method', params: {} });
    io.end();
    await bridge.run();
    const err = io.responses[0].error as Record<string, unknown>;
    expect(err.code).toBe(-32601);
    expect(err.message as string).toContain('unknown/method');
  });

  test('notification (no id) is silently ignored', async () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ input: io.inputReader, output: io.outputFn });
    io.feed({ jsonrpc: '2.0', method: 'some/notification', params: {} });
    io.end();
    await bridge.run();
    expect(io.written).toHaveLength(0);
  });

  test('invalid JSON is silently skipped', async () => {
    const io = new MockIO();
    const bridge = new AcpBridge({ input: io.inputReader, output: io.outputFn });
    // Feed raw invalid JSON via the reader directly
    io.inputReader.feed('not json\n');
    io.end();
    await bridge.run();
    expect(io.written).toHaveLength(0);
  });
});
