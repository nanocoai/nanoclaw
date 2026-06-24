import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';

// --- Mocks ---

vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('../env.js', () => ({ readEnvFile: vi.fn(() => ({})) }));
vi.mock('../log.js', () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: vi.fn(),
  execFileSync: vi.fn(),
}));

// --- TCP socket mock ---

import { EventEmitter } from 'events';

const tcpRef = vi.hoisted(() => ({
  rpcResponses: new Map<string, unknown>(),
  fakeSocket: null as any,
}));

function createFakeSocket(): EventEmitter & {
  write: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  destroyed: boolean;
} {
  const sock = new EventEmitter() as any;
  sock.destroyed = false;
  sock.destroy = vi.fn(() => {
    sock.destroyed = true;
    sock.emit('close');
  });
  sock.write = vi.fn((data: string) => {
    try {
      const req = JSON.parse(data.trim());
      const result = tcpRef.rpcResponses.get(req.method) ?? { ok: true };
      const response = JSON.stringify({ jsonrpc: '2.0', id: req.id, result }) + '\n';
      setImmediate(() => sock.emit('data', Buffer.from(response)));
    } catch {
      /* ignore */
    }
  });
  return sock;
}

vi.mock('node:net', () => ({
  createConnection: vi.fn((_port: number, _host: string, cb?: () => void) => {
    const sock = createFakeSocket();
    tcpRef.fakeSocket = sock;
    if (cb) setImmediate(cb);
    return sock;
  }),
}));

import type { ChannelSetup } from './adapter.js';
import { createSignalAdapter } from './signal.js';

// --- Test helpers ---

function createMockSetup() {
  return {
    onInbound: vi.fn() as unknown as ChannelSetup['onInbound'] & ReturnType<typeof vi.fn>,
    onInboundEvent: vi.fn() as unknown as ChannelSetup['onInboundEvent'] & ReturnType<typeof vi.fn>,
    onMetadata: vi.fn() as unknown as ChannelSetup['onMetadata'] & ReturnType<typeof vi.fn>,
    onAction: vi.fn() as unknown as ChannelSetup['onAction'] & ReturnType<typeof vi.fn>,
  };
}

function createAdapter() {
  return createSignalAdapter({
    cliPath: 'signal-cli',
    account: '+15551234567',
    tcpHost: '127.0.0.1',
    tcpPort: 7583,
    manageDaemon: false,
    signalDataDir: '/tmp/signal-cli-test-data',
  });
}

function getRpcCalls(): Array<{
  method: string;
  params: Record<string, unknown>;
  id: string;
}> {
  if (!tcpRef.fakeSocket) return [];
  return tcpRef.fakeSocket.write.mock.calls
    .map((c: any[]) => {
      try {
        return JSON.parse(c[0].trim());
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function getRpcCallsForMethod(method: string) {
  return getRpcCalls().filter((c) => c.method === method);
}

function pushEvent(envelope: Record<string, unknown>) {
  if (!tcpRef.fakeSocket) throw new Error('TCP socket not connected');
  const notification =
    JSON.stringify({
      jsonrpc: '2.0',
      method: 'receive',
      params: { envelope },
    }) + '\n';
  tcpRef.fakeSocket.emit('data', Buffer.from(notification));
}

// --- Tests ---

describe('SignalAdapter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    tcpRef.rpcResponses.clear();
    tcpRef.fakeSocket = null;
    tcpRef.rpcResponses.set('send', { timestamp: 1234567890 });
    tcpRef.rpcResponses.set('sendTyping', {});
  });

  afterEach(() => {
    try {
      tcpRef.fakeSocket?.destroy();
    } catch {
      // already closed
    }
  });

  // --- Connection lifecycle ---

  describe('connection lifecycle', () => {
    it('connects when daemon is reachable', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      expect(adapter.isConnected()).toBe(true);
      expect(tcpRef.fakeSocket).not.toBeNull();

      await adapter.teardown();
    });

    it('isConnected() returns false before setup', () => {
      const adapter = createAdapter();
      expect(adapter.isConnected()).toBe(false);
    });

    it('disconnects cleanly', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      expect(adapter.isConnected()).toBe(true);

      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('throws NetworkError if daemon is unreachable', async () => {
      const { createConnection } = await import('node:net');
      vi.mocked(createConnection).mockImplementationOnce((...args: any[]) => {
        const sock = createFakeSocket();
        setImmediate(() => sock.emit('error', new Error('Connection refused')));
        return sock as any;
      });

      const adapter = createAdapter();
      await expect(adapter.setup(createMockSetup())).rejects.toThrow(/not reachable/);
    });
  });

  // --- Inbound message handling ---

  describe('inbound message handling', () => {
    it('delivers DM via onInbound', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Hello from Signal',
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onMetadata).toHaveBeenCalledWith('+15555550123', 'Alice', false);
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          id: '1700000000000',
          kind: 'chat',
          content: expect.objectContaining({
            text: 'Hello from Signal',
            sender: '+15555550123',
            senderName: 'Alice',
          }),
        }),
      );

      await adapter.teardown();
    });

    it('delivers group message with group platformId', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'Group hello',
          groupInfo: { groupId: 'abc123', groupName: 'Family' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));

      expect(cfg.onMetadata).toHaveBeenCalledWith('group:abc123', 'Family', true);
      expect(cfg.onInbound).toHaveBeenCalledWith(
        'group:abc123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'Group hello',
            sender: '+15555550999',
          }),
        }),
      );

      await adapter.teardown();
    });

    it('skips sync messages (own outbound)', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15551234567',
        syncMessage: {
          sentMessage: {
            timestamp: 1700000000000,
            message: 'My own message',
            destination: '+15555550123',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });

    it('processes Note to Self sync messages as inbound', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15551234567',
        syncMessage: {
          sentMessage: {
            timestamp: 1700000000000,
            message: 'Hello Bee',
            destinationNumber: '+15551234567',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15551234567',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'Hello Bee',
            senderName: 'Me',
            isFromMe: true,
          }),
        }),
      );

      await adapter.teardown();
    });

    it('skips empty messages', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: '   ' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });

    it('skips echoed outbound messages', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Echo test' },
      });

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: 'Echo test' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });

    it('forwards image attachments as [Image: <path>] plus structured attachments array', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          attachments: [{ id: 'att123abc', contentType: 'image/jpeg', size: 50000 }],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: expect.stringMatching(/^\[Image: .+att123abc\]$/),
            attachments: [expect.objectContaining({ contentType: 'image/jpeg' })],
          }),
        }),
      );

      await adapter.teardown();
    });
  });

  // --- groupV2 ---

  describe('group routing', () => {
    it('routes to groupV2.id when present, falling back to legacy groupInfo.groupId', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'hello v2',
          groupV2: { id: 'v2group=' },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith('group:v2group=', null, expect.anything());

      await adapter.teardown();
    });
  });

  // --- mention resolution ---

  describe('mention resolution', () => {
    it('replaces inline mention placeholders with display names', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'hey ￼ are you here?',
          mentions: [{ start: 4, length: 1, name: 'Bob', uuid: 'bob-uuid' }],
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'hey @Bob are you here?' }),
        }),
      );

      await adapter.teardown();
    });
  });

  // --- Quote context ---

  describe('quote context', () => {
    it('emits a nested replyTo object matching the formatter contract', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      pushEvent({
        sourceNumber: '+15555550123',
        sourceName: 'Alice',
        dataMessage: {
          timestamp: 1700000000000,
          message: 'I disagree',
          quote: {
            id: 1699999999000,
            authorNumber: '+15555550888',
            authorName: 'Pineapple Pete',
            text: 'Pineapple belongs on pizza',
          },
        },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550123',
        null,
        expect.objectContaining({
          content: expect.objectContaining({
            text: 'I disagree',
            replyTo: {
              id: '1699999999000',
              sender: 'Pineapple Pete',
              text: 'Pineapple belongs on pizza',
            },
          }),
        }),
      );

      await adapter.teardown();
    });
  });

  // --- deliver ---

  describe('deliver', () => {
    it('sends DM via TCP RPC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(0);

      const last = sendCalls[sendCalls.length - 1];
      expect(last.params).toEqual(
        expect.objectContaining({
          recipient: ['+15555550123'],
          message: 'Hello',
          account: '+15551234567',
        }),
      );

      await adapter.teardown();
    });

    it('sends group message via groupId', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.deliver('group:abc123', null, {
        kind: 'text',
        content: { text: 'Group msg' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params).toEqual(
        expect.objectContaining({
          groupId: 'abc123',
          message: 'Group msg',
        }),
      );

      await adapter.teardown();
    });

    it('chunks long messages', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      const longText = 'x'.repeat(5000);
      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: longText },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(1);

      await adapter.teardown();
    });

    it('extracts text from string content', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: 'Plain string content',
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(0);
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Plain string content');

      await adapter.teardown();
    });
  });

  // --- Outbound attachments ---

  describe('deliver — attachments', () => {
    // Real fs writes happen in tmpdir(); confirm the bytes round-trip and
    // are cleaned up after deliver returns.
    it('sends a single attachment via attachments[] param', async () => {
      const fs = await import('node:fs');
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: 'report.md', data: Buffer.from('# Report\n\nbody') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBe(1);
      const params = sendCalls[0].params as Record<string, unknown>;
      expect(params.recipient).toEqual(['+15555550123']);
      expect(params.account).toBe('+15551234567');
      expect(params.message).toBeUndefined();
      const paths = params.attachments as string[];
      expect(paths).toHaveLength(1);
      expect(paths[0]).toMatch(/signal-out-\d+-[a-z0-9]+-report\.md$/);
      // Temp file should no longer exist — finally{} cleanup ran
      expect(fs.existsSync(paths[0])).toBe(false);

      await adapter.teardown();
    });

    it('sends text first, then attachment, when both are present', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: { text: 'Here is the digest' },
        files: [{ filename: 'digest.md', data: Buffer.from('content') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(2);
      // First call: text message
      expect(sendCalls[0].params).toEqual(
        expect.objectContaining({ message: 'Here is the digest', recipient: ['+15555550123'] }),
      );
      expect((sendCalls[0].params as Record<string, unknown>).attachments).toBeUndefined();
      // Second call: attachment, no message
      expect(sendCalls[1].params).toEqual(expect.objectContaining({ recipient: ['+15555550123'] }));
      const attachments = (sendCalls[1].params as Record<string, unknown>).attachments as string[];
      expect(attachments).toHaveLength(1);

      await adapter.teardown();
    });

    it('sends multiple attachments in a single send call', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [
          { filename: 'a.txt', data: Buffer.from('a') },
          { filename: 'b.png', data: Buffer.from([0x89, 0x50, 0x4e, 0x47]) },
        ],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(1);
      const attachments = (sendCalls[0].params as Record<string, unknown>).attachments as string[];
      expect(attachments).toHaveLength(2);
      expect(attachments[0]).toMatch(/-a\.txt$/);
      expect(attachments[1]).toMatch(/-b\.png$/);

      await adapter.teardown();
    });

    it('uses groupId for group destinations', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('group:abc123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: 'pic.jpg', data: Buffer.from('jpg') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls).toHaveLength(1);
      const params = sendCalls[0].params as Record<string, unknown>;
      expect(params.groupId).toBe('abc123');
      expect(params.recipient).toBeUndefined();

      await adapter.teardown();
    });

    /**
     * Defensive test: `OutboundFile.filename` is operator-supplied data, so
     * the implementation must not let a filename containing path separators
     * escape the temp directory. We feed an attempt-to-traverse filename and
     * assert the resolved path stays strictly inside `tmpdir()`.
     */
    it('keeps temp paths inside tmpdir even when filename contains path separators', async () => {
      const path = await import('node:path');
      const os = await import('node:os');
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'file',
        content: {},
        files: [{ filename: '../sneaky.txt', data: Buffer.from('x') }],
      });

      const sendCalls = getRpcCallsForMethod('send');
      const paths = (sendCalls[0].params as Record<string, unknown>).attachments as string[];
      const resolvedTmp = path.resolve(os.tmpdir());
      const resolvedResult = path.resolve(paths[0]);
      // path.resolve normalizes away any "../"; if sanitization failed, the
      // result would resolve to tmpdir's parent.
      expect(resolvedResult.startsWith(resolvedTmp + path.sep)).toBe(true);

      await adapter.teardown();
    });
  });

  // --- Text styles ---

  describe('text styles', () => {
    it('sends bold text with textStyle parameter', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello **world**' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBeGreaterThan(0);
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Hello world');
      expect(last.params.textStyle).toEqual(['6:5:BOLD']);

      await adapter.teardown();
    });

    it('sends inline code with MONOSPACE style', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Run `npm test` now' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Run npm test now');
      expect(last.params.textStyle).toEqual(['4:8:MONOSPACE']);

      await adapter.teardown();
    });

    it('sends plain text without textStyle', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'No formatting here' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('No formatting here');
      expect(last.params.textStyle).toBeUndefined();

      await adapter.teardown();
    });

    it('falls back to original markup when textStyle is rejected', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      let sendCount = 0;
      tcpRef.fakeSocket.write.mockImplementation((data: string) => {
        try {
          const req = JSON.parse(data.trim());
          if (req.method === 'send') {
            sendCount++;
            if (sendCount === 1) {
              const response =
                JSON.stringify({
                  jsonrpc: '2.0',
                  id: req.id,
                  error: { message: 'Unknown parameter: textStyle' },
                }) + '\n';
              setImmediate(() => tcpRef.fakeSocket.emit('data', Buffer.from(response)));
              return;
            }
          }
          const response =
            JSON.stringify({
              jsonrpc: '2.0',
              id: req.id,
              result: { ok: true },
            }) + '\n';
          setImmediate(() => tcpRef.fakeSocket.emit('data', Buffer.from(response)));
        } catch {
          /* ignore */
        }
      });

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello **world**' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      expect(sendCalls.length).toBe(2);
      expect(sendCalls[1].params.message).toBe('Hello **world**');
      expect(sendCalls[1].params.textStyle).toBeUndefined();

      await adapter.teardown();
    });

    it('tracks nested styles with correct offsets', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: '**bold with `code` inside**' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('bold with code inside');
      // BOLD covers the full inner span, MONOSPACE points at "code" in the
      // final plain text (offset 10, length 4) — not the intermediate text.
      const styles = (last.params.textStyle as string[]).slice().sort();
      expect(styles).toEqual(['0:21:BOLD', '10:4:MONOSPACE']);

      await adapter.teardown();
    });

    it('maps *single-asterisk* to ITALIC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello *world*' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('Hello world');
      expect(last.params.textStyle).toEqual(['6:5:ITALIC']);

      await adapter.teardown();
    });

    it('maps _underscore_ to ITALIC', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      tcpRef.fakeSocket.write.mockClear();

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'hey _there_' },
      });

      const sendCalls = getRpcCallsForMethod('send');
      const last = sendCalls[sendCalls.length - 1];
      expect(last.params.message).toBe('hey there');
      expect(last.params.textStyle).toEqual(['4:5:ITALIC']);

      await adapter.teardown();
    });
  });

  // --- Echo cache ---

  describe('echo cache', () => {
    it('does not drop same-text inbound from a different recipient', async () => {
      // Bot sends "Hello" to Alice. Immediately after, Bob sends "Hello" from
      // a different DM. Bob's message must still route — the earlier echo key
      // was scoped to Alice.
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Hello' },
      });

      pushEvent({
        sourceNumber: '+15555550999',
        sourceName: 'Bob',
        dataMessage: { timestamp: 1700000000000, message: 'Hello' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).toHaveBeenCalledWith(
        '+15555550999',
        null,
        expect.objectContaining({
          content: expect.objectContaining({ text: 'Hello', sender: '+15555550999' }),
        }),
      );

      await adapter.teardown();
    });

    it('still skips echo on the same recipient', async () => {
      const adapter = createAdapter();
      const cfg = createMockSetup();
      await adapter.setup(cfg);

      await adapter.deliver('+15555550123', null, {
        kind: 'text',
        content: { text: 'Echo test' },
      });

      pushEvent({
        sourceNumber: '+15555550123',
        dataMessage: { timestamp: 1700000000000, message: 'Echo test' },
      });

      await new Promise((r) => setTimeout(r, 50));
      expect(cfg.onInbound).not.toHaveBeenCalled();

      await adapter.teardown();
    });
  });

  // --- Connection drop ---

  describe('connection drop', () => {
    it('flips isConnected to false when the socket closes', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());
      expect(adapter.isConnected()).toBe(true);

      // Simulate the daemon dropping the TCP connection.
      tcpRef.fakeSocket.destroy();
      await new Promise((r) => setTimeout(r, 20));

      expect(adapter.isConnected()).toBe(false);

      await adapter.teardown();
    });
  });

  // --- setTyping ---

  describe('setTyping', () => {
    it('sends typing indicator for DMs', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.setTyping!('+15555550123', null);

      expect(getRpcCallsForMethod('sendTyping')).toHaveLength(1);

      await adapter.teardown();
    });

    it('skips typing for groups', async () => {
      const adapter = createAdapter();
      await adapter.setup(createMockSetup());

      await adapter.setTyping!('group:abc123', null);

      expect(getRpcCallsForMethod('sendTyping')).toHaveLength(0);

      await adapter.teardown();
    });
  });

  // --- Adapter properties ---

  describe('adapter properties', () => {
    it('has channelType "signal"', () => {
      const adapter = createAdapter();
      expect(adapter.channelType).toBe('signal');
    });

    it('does not support threads', () => {
      const adapter = createAdapter();
      expect(adapter.supportsThreads).toBe(false);
    });
  });
});
