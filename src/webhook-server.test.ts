/**
 * Webhook server route/handler split tests.
 *
 * The route key (URL segment, `/webhook/<routingPath>`) and the handler key
 * (`chat.webhooks[adapterName]`) are independent: a named adapter instance
 * registers its own Chat under its own URL while dispatching to the same
 * SDK adapter name. The 2-arg default keeps the historical single-instance
 * route byte-identical. Conventions follow PR #2617: real HTTP server on a
 * fixed WEBHOOK_PORT, real fetch.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import type { Chat } from 'chat';

import { registerWebhookAdapter, stopWebhookServer } from './webhook-server.js';

const PORT = 3917;
const BASE = `http://127.0.0.1:${PORT}`;

/** Minimal Chat stand-in: only `webhooks` is touched by the server. */
function stubChat(tag: string, adapterName = 'slack'): { chat: Chat; calls: string[] } {
  const calls: string[] = [];
  const chat = {
    webhooks: {
      [adapterName]: async (req: Request) => {
        calls.push(await req.text());
        return new Response(JSON.stringify({ via: tag }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    },
  } as unknown as Chat;
  return { chat, calls };
}

async function post(path: string, body: string): Promise<Response> {
  // The server starts listening asynchronously after registration — retry
  // briefly on connection refusal instead of sleeping a fixed amount.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, { method: 'POST', body });
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

beforeEach(() => {
  process.env.WEBHOOK_PORT = String(PORT);
});

afterEach(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
});

describe('registerWebhookAdapter — route/handler split', () => {
  it('2-arg default: /webhook/<adapterName> dispatches to chat.webhooks[adapterName]', async () => {
    const { chat, calls } = stubChat('default');
    registerWebhookAdapter(chat, 'slack');

    const res = await post('/webhook/slack', 'payload-default');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'default' });
    expect(calls).toEqual(['payload-default']);
  });

  it('3-arg: routes by routingPath, dispatches by adapterName; the bare route stays unregistered', async () => {
    const { chat, calls } = stubChat('tester');
    registerWebhookAdapter(chat, 'slack', 'slack-tester');

    const res = await post('/webhook/slack-tester', 'payload-tester');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'tester' });
    expect(calls).toEqual(['payload-tester']);

    // Only the routed entry exists — /webhook/slack must 404, not leak into
    // the named instance's Chat.
    const miss = await post('/webhook/slack', 'stray');
    expect(miss.status).toBe(404);
    expect(calls).toEqual(['payload-tester']);
  });

  it('two same-adapterName registrations under distinct paths hit their own Chat instances', async () => {
    const worker = stubChat('worker');
    const tester = stubChat('tester');
    registerWebhookAdapter(worker.chat, 'slack');
    registerWebhookAdapter(tester.chat, 'slack', 'slack-tester');

    const r1 = await post('/webhook/slack', 'to-worker');
    const r2 = await post('/webhook/slack-tester', 'to-tester');
    expect(await r1.json()).toEqual({ via: 'worker' });
    expect(await r2.json()).toEqual({ via: 'tester' });
    expect(worker.calls).toEqual(['to-worker']);
    expect(tester.calls).toEqual(['to-tester']);
  });

  it('unregistered path 404s', async () => {
    const { chat } = stubChat('only');
    registerWebhookAdapter(chat, 'slack');
    const res = await post('/webhook/nope', 'x');
    expect(res.status).toBe(404);
  });
});
