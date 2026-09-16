/**
 * Tests for the v2 webchat channel adapter.
 *
 * Exercises the HTTP surface (GET /, POST /api/message, GET /api/messages),
 * bearer-token auth, and the ChannelAdapter lifecycle (setup / teardown /
 * isConnected / deliver). Mirrors the emacs adapter's test conventions.
 */
import http from 'http';
import type { AddressInfo } from 'net';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createWebchatAdapter } from './webchat.js';
import type { ChannelAdapter, ChannelSetup } from './adapter.js';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function makeSetup(overrides: Partial<ChannelSetup> = {}): ChannelSetup {
  return {
    onInbound: vi.fn(),
    onInboundEvent: vi.fn(),
    onMetadata: vi.fn(),
    onAction: vi.fn(),
    ...overrides,
  };
}

/** Ask the OS for a free port, then immediately release it. Small race window
 * before the adapter grabs it, but sufficient for local test use. */
async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = http.createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}

async function req(
  port: number,
  method: string,
  path: string,
  body?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ status: number; data: unknown }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...extraHeaders };
    const request = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      let raw = '';
      res.on('data', (chunk: Buffer) => (raw += chunk.toString()));
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode!, data: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, data: raw });
        }
      });
    });
    request.on('error', reject);
    if (body) request.write(body);
    request.end();
  });
}

describe('webchat adapter', () => {
  let adapter: ChannelAdapter;
  let port: number;

  beforeEach(async () => {
    port = await getFreePort();
    adapter = createWebchatAdapter({ port, authToken: null, platformId: 'default' });
  });

  afterEach(async () => {
    if (adapter.isConnected()) await adapter.teardown();
  });

  describe('lifecycle', () => {
    it('isConnected is false before setup', () => {
      expect(adapter.isConnected()).toBe(false);
    });

    it('isConnected is true after setup', async () => {
      await adapter.setup(makeSetup());
      expect(adapter.isConnected()).toBe(true);
    });

    it('isConnected is false after teardown', async () => {
      await adapter.setup(makeSetup());
      await adapter.teardown();
      expect(adapter.isConnected()).toBe(false);
    });

    it('teardown is a no-op before setup', async () => {
      await expect(adapter.teardown()).resolves.not.toThrow();
    });

    it('calls onMetadata after setup with channel name', async () => {
      const onMetadata = vi.fn();
      await adapter.setup(makeSetup({ onMetadata }));
      expect(onMetadata).toHaveBeenCalledWith('default', 'Web Chat', false);
    });
  });

  describe('GET / (chat page)', () => {
    beforeEach(async () => {
      await adapter.setup(makeSetup());
    });

    it('serves the chat UI', async () => {
      const { status, data } = await req(port, 'GET', '/');
      expect(status).toBe(200);
      expect(String(data)).toContain('<!doctype html');
      expect(String(data)).toContain('NanoClaw');
    });

    it('serves the page at /index.html too', async () => {
      const { status } = await req(port, 'GET', '/index.html');
      expect(status).toBe(200);
    });
  });

  describe('POST /api/message', () => {
    let onInbound: ChannelSetup['onInbound'] & { mock: { calls: unknown[][] } };

    beforeEach(async () => {
      onInbound = vi.fn() as unknown as typeof onInbound;
      await adapter.setup(makeSetup({ onInbound }));
    });

    it('fires onInbound with chat kind and sender metadata', async () => {
      const { status, data } = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hello' }));
      expect(status).toBe(200);
      expect((data as { messageId: string }).messageId).toMatch(/^webchat-/);
      expect(onInbound).toHaveBeenCalledOnce();
      const [platformId, threadId, msg] = onInbound.mock.calls[0] as [string, string | null, { content: unknown }];
      expect(platformId).toBe('default');
      expect(threadId).toBeNull();
      expect(msg).toMatchObject({
        kind: 'chat',
        content: { text: 'hello', sender: 'Web', senderId: 'webchat:default' },
      });
    });

    it('returns 400 for empty text', async () => {
      const { status } = await req(port, 'POST', '/api/message', JSON.stringify({ text: '' }));
      expect(status).toBe(400);
      expect(onInbound).not.toHaveBeenCalled();
    });

    it('returns 400 for invalid JSON', async () => {
      const { status } = await req(port, 'POST', '/api/message', 'not-json');
      expect(status).toBe(400);
    });

    it('returns 404 for unknown paths', async () => {
      const { status } = await req(port, 'POST', '/api/unknown', JSON.stringify({ text: 'hi' }));
      expect(status).toBe(404);
    });
  });

  describe('GET /api/messages + deliver', () => {
    beforeEach(async () => {
      await adapter.setup(makeSetup());
    });

    it('returns empty buffer initially', async () => {
      const { status, data } = await req(port, 'GET', '/api/messages?since=0');
      expect(status).toBe(200);
      expect(data).toEqual({ messages: [] });
    });

    it('deliver pushes text for the poll endpoint to return', async () => {
      await adapter.deliver('default', null, { kind: 'chat', content: { text: 'reply' } });
      const { data } = await req(port, 'GET', '/api/messages?since=0');
      const messages = (data as { messages: { text: string; timestamp: number }[] }).messages;
      expect(messages).toHaveLength(1);
      expect(messages[0]?.text).toBe('reply');
      expect(typeof messages[0]?.timestamp).toBe('number');
    });

    it('since filters out already-seen messages', async () => {
      await adapter.deliver('default', null, { kind: 'chat', content: { text: 'old' } });
      const future = Date.now() + 60_000;
      const { data } = await req(port, 'GET', `/api/messages?since=${future}`);
      expect(data).toEqual({ messages: [] });
    });

    it('deliver returns undefined for an unknown platformId', async () => {
      const id = await adapter.deliver('other', null, { kind: 'chat', content: { text: 'x' } });
      expect(id).toBeUndefined();
    });
  });

  describe('auth', () => {
    beforeEach(async () => {
      await adapter.teardown();
      adapter = createWebchatAdapter({ port, authToken: 'sekrit', platformId: 'default' });
      await adapter.setup(makeSetup());
    });

    it('serves the page without auth (it holds no secrets)', async () => {
      const { status } = await req(port, 'GET', '/');
      expect(status).toBe(200);
    });

    it('rejects API calls without the bearer token', async () => {
      const post = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }));
      expect(post.status).toBe(401);
      const poll = await req(port, 'GET', '/api/messages?since=0');
      expect(poll.status).toBe(401);
    });

    it('accepts API calls with the bearer token', async () => {
      const headers = { Authorization: 'Bearer sekrit' };
      const post = await req(port, 'POST', '/api/message', JSON.stringify({ text: 'hi' }), headers);
      expect(post.status).toBe(200);
      const poll = await req(port, 'GET', '/api/messages?since=0', undefined, headers);
      expect(poll.status).toBe(200);
    });
  });
});
