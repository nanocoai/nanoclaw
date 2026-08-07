/**
 * Guard for the raw-route half of src/webhook-server.ts —
 * registerWebhookHandler + the rawRoutes dispatch branch.
 *
 * Drives the REAL shared HTTP server on an ephemeral WEBHOOK_PORT (no
 * mocking of the routing layer): a registered raw route must dispatch,
 * unknown paths must 404, a throwing handler must surface as 500,
 * raw routes must coexist with Chat SDK adapter routes on the same
 * server, and stopWebhookServer must clear them.
 */
import { afterAll, describe, expect, it, vi } from 'vitest';

import type { Chat } from 'chat';

import { registerWebhookAdapter, registerWebhookHandler, stopWebhookServer } from './webhook-server.js';

const PORT = 21000 + Math.floor(Math.random() * 20000);

async function post(path: string, body = '{}'): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/${path}`, { method: 'POST', body });
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

afterAll(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
});

describe('webhook server raw routes', () => {
  it('dispatches a registered raw route to its handler', async () => {
    process.env.WEBHOOK_PORT = String(PORT);
    const methods: string[] = [];
    registerWebhookHandler('ping', (req, res) => {
      methods.push(req.method || '');
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('pong');
    });

    const res = await post('ping');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('pong');
    expect(methods).toEqual(['POST']);
  });

  it('returns 404 for paths with no registered route', async () => {
    const res = await post('nope');
    expect(res.status).toBe(404);
  });

  it('turns a throwing handler into a 500 response', async () => {
    registerWebhookHandler('boom', () => {
      throw new Error('handler exploded');
    });

    const res = await post('boom');
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('Internal Server Error');
  });

  it('coexists with Chat SDK adapter routes on the same server', async () => {
    const handler = vi.fn(async () => new Response('ok-chat', { status: 200 }));
    const chat = { webhooks: { fake: handler } } as unknown as Chat;
    registerWebhookAdapter(chat, 'fake');

    const chatRes = await post('fake');
    expect(chatRes.status).toBe(200);
    expect(await chatRes.text()).toBe('ok-chat');
    expect(handler).toHaveBeenCalledTimes(1);

    // The raw route registered earlier is still live alongside it.
    const rawRes = await post('ping');
    expect(rawRes.status).toBe(200);
  });

  it('clears raw routes on stopWebhookServer', async () => {
    await stopWebhookServer();

    // Restart the server with a fresh route; the old raw routes must be gone.
    registerWebhookHandler('fresh', (_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('fresh');
    });

    const stale = await post('ping');
    expect(stale.status).toBe(404);

    const fresh = await post('fresh');
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toBe('fresh');
  });
});
