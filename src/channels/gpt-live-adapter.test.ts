/**
 * Integration test for the gpt-live adapter at the host boundary.
 *
 * Real pieces: the adapter, its session state machine, the shared webhook
 * server (the call page and SDP routes are hit over HTTP the way a browser
 * would), Node's built-in fetch and WebSocket client. Faked: OpenAI only —
 * a local HTTP server that answers `POST /v1/live/sessions` and accepts the
 * sideband WebSocket upgrade at `/v1/live/sessions/{id}/attach`, so the test
 * can push transcript and delegation events and record every client frame
 * the adapter sends back.
 *
 * The WebSocket server side is ~40 lines of RFC 6455 by hand (handshake,
 * masked text frames, close) because the repo carries no `ws` package and
 * Node ships a client only.
 */
import { createHash } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, InboundMessage } from './adapter.js';
import { createGptLiveAdapter, lineIdForToken } from './gpt-live.js';

/** What NanoClaw calls the line: a hash of the token, never the token. */
const LINE = lineIdForToken('tok123');
import { stopWebhookServer } from '../webhook-server.js';

// ---------------------------------------------------------------------------
// Minimal WebSocket server framing (text + close only)
// ---------------------------------------------------------------------------

function acceptKey(key: string): string {
  return createHash('sha1')
    .update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
}

function encodeFrame(opcode: number, payload: Buffer): Buffer {
  let header: Buffer;
  if (payload.length < 126) header = Buffer.from([0x80 | opcode, payload.length]);
  else if (payload.length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(payload.length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(payload.length), 2);
  }
  return Buffer.concat([header, payload]);
}

function decodeFrames(input: Buffer): { frames: Array<{ opcode: number; payload: Buffer }>; rest: Buffer } {
  const frames: Array<{ opcode: number; payload: Buffer }> = [];
  let buf = input;
  for (;;) {
    if (buf.length < 2) break;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let offset = 2;
    if (len === 126) {
      if (buf.length < 4) break;
      len = buf.readUInt16BE(2);
      offset = 4;
    } else if (len === 127) {
      if (buf.length < 10) break;
      len = Number(buf.readBigUInt64BE(2));
      offset = 10;
    }
    const maskKey = masked ? buf.subarray(offset, offset + 4) : null;
    if (masked) offset += 4;
    if (buf.length < offset + len) break;
    const payload = Buffer.from(buf.subarray(offset, offset + len));
    if (maskKey) for (let i = 0; i < payload.length; i++) payload[i] ^= maskKey[i % 4];
    frames.push({ opcode, payload });
    buf = buf.subarray(offset + len);
  }
  return { frames, rest: buf };
}

// ---------------------------------------------------------------------------
// Fake OpenAI Live API
// ---------------------------------------------------------------------------

interface FakeAttach {
  sessionId: string;
  auth: string | undefined;
  path: string | undefined;
  socket: Duplex;
  received: Array<Record<string, unknown>>;
  closedByClient: boolean;
}

interface FakeOpenAI {
  port: number;
  sessionCreates: Array<{ auth: string | undefined; body: Record<string, unknown> }>;
  /** Every sideband attach in order; `attach` is the latest. */
  attaches: FakeAttach[];
  attach: { auth?: string; path?: string; socket?: Duplex };
  /** Frames from every attach, in arrival order. */
  received: Array<Record<string, unknown>>;
  closedByClient: boolean;
  /** Delay the next attach's 101 by this many ms (consumed once) — lets two calls overlap. */
  nextAttachDelayMs: number;
  push(event: Record<string, unknown>): void;
  close(): Promise<void>;
}

function startFakeOpenAI(): Promise<FakeOpenAI> {
  let sessions = 0;
  const fake: FakeOpenAI = {
    port: 0,
    sessionCreates: [],
    attaches: [],
    attach: {},
    received: [],
    closedByClient: false,
    nextAttachDelayMs: 0,
    push(event) {
      fake.attach.socket?.write(encodeFrame(0x1, Buffer.from(JSON.stringify(event))));
    },
    close: async () => {},
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method === 'POST' && req.url === '/v1/live/sessions') {
        fake.sessionCreates.push({
          auth: req.headers.authorization,
          body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        sessions += 1;
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            session: { id: `live_fake${sessions}` },
            transport: { type: 'webrtc', sdp: 'v=0\r\nanswer' },
          }),
        );
        return;
      }
      res.writeHead(404);
      res.end();
    });
  });
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'] as string;
    const sessionId = /\/v1\/live\/sessions\/([^/]+)\/attach/.exec(req.url ?? '')?.[1] ?? '';
    const delay = fake.nextAttachDelayMs;
    fake.nextAttachDelayMs = 0;
    const a: FakeAttach = {
      sessionId,
      auth: req.headers.authorization,
      path: req.url,
      socket,
      received: [],
      closedByClient: false,
    };
    setTimeout(() => {
      fake.attaches.push(a);
      fake.attach = { auth: a.auth, path: a.path, socket };
      socket.write(
        'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
          `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
      );
    }, delay);
    let pending: Buffer = Buffer.alloc(0);
    socket.on('data', (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      const { frames, rest } = decodeFrames(pending);
      pending = rest;
      for (const f of frames) {
        if (f.opcode === 0x1) {
          const ev = JSON.parse(f.payload.toString('utf8')) as Record<string, unknown>;
          a.received.push(ev);
          fake.received.push(ev);
        } else if (f.opcode === 0x8) {
          a.closedByClient = true;
          fake.closedByClient = true;
          socket.write(encodeFrame(0x8, f.payload.subarray(0, 2)));
          socket.end();
        } else if (f.opcode === 0x9) socket.write(encodeFrame(0xa, f.payload));
      }
    });
    socket.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      fake.port = (server.address() as AddressInfo).port;
      fake.close = () =>
        new Promise((r) => {
          for (const a of fake.attaches) a.socket.destroy();
          server.close(() => r());
        });
      resolve(fake);
    });
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const s = http.createServer();
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
  });
}

// ---------------------------------------------------------------------------

describe('gpt-live adapter (fake OpenAI, real webhook server)', () => {
  let fake: FakeOpenAI;
  let adapter: ChannelAdapter;
  let base: string;
  const clock = { now: Date.now() };
  const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];

  beforeAll(async () => {
    fake = await startFakeOpenAI();
    const webhookPort = await freePort();
    process.env.WEBHOOK_PORT = String(webhookPort);
    base = `http://127.0.0.1:${webhookPort}/webhook/gpt-live`;
    adapter = createGptLiveAdapter({
      apiKey: 'sk-test-key',
      publicUrl: `http://127.0.0.1:${webhookPort}`,
      voice: 'marin',
      linkTokens: ['tok123'],
      fallbackAgentName: 'the assistant',
      apiBase: `http://127.0.0.1:${fake.port}/v1`,
      wsBase: `ws://127.0.0.1:${fake.port}/v1`,
      resolveAgent: async () => ({ name: 'Andy', personality: 'Dry humour, precise.' }),
      now: () => clock.now,
    });
    await adapter.setup({
      onInbound: (platformId, threadId, message) => {
        inbound.push({ platformId, threadId, message });
      },
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: () => {},
    });
  });

  afterAll(async () => {
    await adapter.teardown();
    await stopWebhookServer();
    await fake.close();
  });

  it('serves the call page', async () => {
    const res = await fetch(`${base}/call?t=tok123`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('RTCPeerConnection');
    expect(html).toContain("new URL('sdp?t='");
  });

  it('refuses an SDP offer without a known link token', async () => {
    const res = await fetch(`${base}/sdp?t=nope`, { method: 'POST', body: 'v=0\r\noffer' });
    expect(res.status).toBe(403);
    expect(fake.sessionCreates).toHaveLength(0);
  });

  it('creates the session in client-delegation mode with the wired agent, and attaches the sideband', async () => {
    const res = await fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\noffer',
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('x-gpt-live-session')).toBe('live_fake1');
    expect(await res.text()).toBe('v=0\r\nanswer');

    expect(fake.sessionCreates).toHaveLength(1);
    const create = fake.sessionCreates[0];
    expect(create.auth).toBe('Bearer sk-test-key');
    const session = create.body.session as Record<string, unknown>;
    expect(session.model).toBe('gpt-live-1');
    expect(session.delegation).toEqual({ type: 'client' });
    expect(session.instructions).toContain('You are Andy');
    expect(session.instructions).toContain('Dry humour');
    expect(create.body.transport).toEqual({ type: 'webrtc', sdp: 'v=0\r\noffer' });

    expect(fake.attach.path).toBe('/v1/live/sessions/live_fake1/attach');
    expect(fake.attach.auth).toBe('Bearer sk-test-key');
  });

  it('turns a delegation into an inbound message and acknowledges it to the voice model', async () => {
    fake.push({ type: 'session.started', session: { id: 'live_fake1' } });
    fake.push({ type: 'session.output_transcript.delta', delta: 'Hi, how can I help?', start_ms: 0, end_ms: 900 });
    fake.push({ type: 'session.input_transcript.delta', delta: 'What is on my ', start_ms: 1000, end_ms: 1600 });
    fake.push({ type: 'session.input_transcript.delta', delta: 'calendar tomorrow?', start_ms: 1600, end_ms: 2300 });
    fake.push({
      type: 'session.delegation.created',
      event_id: 'ev_1',
      offset_ms: 2400,
      delegation: { id: 'item_1', type: 'delegation', target: 'client' },
    });

    await vi.waitFor(() => expect(inbound).toHaveLength(1), { timeout: 5000 });
    const { platformId, threadId, message } = inbound[0];
    expect(platformId).toBe(LINE);
    expect(LINE).toMatch(/^gpt-live:[0-9a-f]{12}$/);
    expect(JSON.stringify(message.content)).not.toContain('tok123');
    expect(threadId).toBeNull();
    expect(message.kind).toBe('chat');
    expect(message.isMention).toBe(true);
    expect(message.isGroup).toBe(false);
    expect(message.content).toMatchObject({
      text: 'Assistant: Hi, how can I help?\nCaller: What is on my calendar tomorrow?',
      sender: 'Voice line',
      senderId: LINE,
      gptLive: { sessionId: 'live_fake1', delegationId: 'item_1', supersedes: null },
    });

    await vi.waitFor(() => expect(fake.received.some((e) => e.type === 'session.thinking.append')).toBe(true));
    const ack = fake.received.find((e) => e.type === 'session.thinking.append');
    expect(ack).toMatchObject({ delegation_id: 'item_1', content: 'Working on it.' });
  });

  it('rate-limits typing notes: one per 20 s while a reply is pending', async () => {
    const thinking = () => fake.received.filter((e) => e.type === 'session.thinking.append').map((e) => e.content);
    const before = thinking().length; // 'Working on it.' from the delegation, sent just now
    await adapter.setTyping?.(LINE, null, 'Checking the calendar');
    await new Promise((r) => setTimeout(r, 150));
    expect(thinking().length).toBe(before); // within 20 s of the last note: suppressed
    clock.now += 21_000;
    await adapter.setTyping?.(LINE, null, 'Checking the calendar');
    await vi.waitFor(() => expect(thinking().length).toBe(before + 1));
    expect(thinking().at(-1)).toBe('Checking the calendar');
    await adapter.setTyping?.(LINE, null, 'Checking the calendar');
    await new Promise((r) => setTimeout(r, 150));
    expect(thinking().length).toBe(before + 1); // again within 20 s: suppressed
  });

  it('speaks the agent reply as commentary on the open delegation', async () => {
    const id = await adapter.deliver(LINE, null, {
      kind: 'chat',
      content: { text: 'Two meetings: standup at nine and lunch with Dana.' },
    });
    expect(id).toBeTruthy();
    await vi.waitFor(() => expect(fake.received.some((e) => e.type === 'session.commentary.append')).toBe(true));
    expect(fake.received.find((e) => e.type === 'session.commentary.append')).toMatchObject({
      event_id: id,
      delegation_id: 'item_1',
      content: 'Two meetings: standup at nine and lunch with Dana.',
    });
  });

  it('sends no typing notes once the reply went out', async () => {
    const count = () => fake.received.filter((e) => e.type === 'session.thinking.append').length;
    const before = count();
    clock.now += 60_000;
    await adapter.setTyping?.(LINE, null, 'Still checking');
    await new Promise((r) => setTimeout(r, 150));
    expect(count()).toBe(before);
  });

  it('hangs up: closes the session, and later replies are dropped', async () => {
    const res = await fetch(`${base}/hangup?t=tok123`, { method: 'POST' });
    expect(res.status).toBe(204);
    await vi.waitFor(() => expect(fake.received.some((e) => e.type === 'session.close')).toBe(true));
    await vi.waitFor(() => expect(fake.closedByClient).toBe(true));

    const id = await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'too late' } });
    expect(id).toBeUndefined();
  });

  it('two calls in flight on one link: the newest wins, the older is refused and its session closed', async () => {
    const before = fake.sessionCreates.length;
    const loserId = `live_fake${before + 1}`;
    const winnerId = `live_fake${before + 2}`;
    fake.nextAttachDelayMs = 400; // the first call's sideband attaches slowly

    const first = fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\noffer-a',
    });
    await new Promise((r) => setTimeout(r, 120)); // first call has its session and is mid-attach
    const second = await fetch(`${base}/sdp?t=tok123`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/sdp' },
      body: 'v=0\r\noffer-b',
    });
    expect(second.status).toBe(200);
    expect(second.headers.get('x-gpt-live-session')).toBe(winnerId);

    const firstRes = await first;
    expect(firstRes.status).toBe(409);

    // The loser's session was closed over its own sideband, and that sideband is gone.
    await vi.waitFor(() => {
      const loser = fake.attaches.find((a) => a.sessionId === loserId);
      expect(loser?.received.some((e) => e.type === 'session.close')).toBe(true);
      expect(loser?.closedByClient).toBe(true);
    });
    const winner = fake.attaches.find((a) => a.sessionId === winnerId);
    expect(winner?.closedByClient).toBe(false);

    // The line delivers to the winner.
    const id = await adapter.deliver(LINE, null, { kind: 'chat', content: { text: 'Still here.' } });
    expect(id).toBeTruthy();
    await vi.waitFor(() =>
      expect(winner?.received.some((e) => e.type === 'session.commentary.append' && e.content === 'Still here.')).toBe(
        true,
      ),
    );
  });
});
