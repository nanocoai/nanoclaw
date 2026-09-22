/**
 * Per-instance webhook routes and pending routes on the shared server.
 *
 * Two-segment routes (`/webhook/slack/<instance>`) coexist with the
 * historical single-segment ones; a two-segment URL with no such route falls
 * back to the first segment exactly as before. A pending route answers a
 * Slack `url_verification` with no signature and no live adapter, and acks
 * and drops everything else. Conventions follow webhook-server.test.ts: real
 * HTTP server on a fixed WEBHOOK_PORT, real fetch.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { Chat } from 'chat';

import {
  getWebhookStatus,
  registerPendingWebhookRoute,
  registerWebhookAdapter,
  stopWebhookServer,
  unregisterWebhookRoute,
} from './webhook-server.js';

const PORT = 3921;
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

async function send(path: string, init: RequestInit): Promise<Response> {
  // The server starts listening asynchronously after registration — retry
  // briefly on connection refusal instead of sleeping a fixed amount.
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`${BASE}${path}`, init);
    } catch (err) {
      if (attempt >= 20) throw err;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

const post = (path: string, body: string, headers?: Record<string, string>) =>
  send(path, { method: 'POST', body, headers });

beforeEach(() => {
  process.env.WEBHOOK_PORT = String(PORT);
});

afterEach(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
});

describe('per-instance routes', () => {
  it('routes /webhook/slack/<instance> to its own Chat and keeps /webhook/slack for the default instance', async () => {
    const dflt = stubChat('default');
    const acme = stubChat('acme');
    registerWebhookAdapter(dflt.chat, 'slack');
    registerWebhookAdapter(acme.chat, 'slack', 'slack/acme-hq');

    const r1 = await post('/webhook/slack', 'to-default');
    const r2 = await post('/webhook/slack/acme-hq', 'to-acme');
    const r3 = await post('/webhook/slack/acme-hq?token=1', 'to-acme-query');
    expect(await r1.json()).toEqual({ via: 'default' });
    expect(await r2.json()).toEqual({ via: 'acme' });
    expect(await r3.json()).toEqual({ via: 'acme' });
    expect(dflt.calls).toEqual(['to-default']);
    expect(acme.calls).toEqual(['to-acme', 'to-acme-query']);
    expect(getWebhookStatus()?.paths.sort()).toEqual(['/webhook/slack', '/webhook/slack/acme-hq']);
  });

  it('a two-segment URL with no such route still falls back to the first segment, as it always did', async () => {
    const { chat, calls } = stubChat('default');
    registerWebhookAdapter(chat, 'slack');

    const res = await post('/webhook/slack/whatever', 'stray-extra-segment');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ via: 'default' });
    expect(calls).toEqual(['stray-extra-segment']);

    const miss = await post('/webhook/teams/acme', 'nobody');
    expect(miss.status).toBe(404);
    expect(await miss.text()).toBe('Unknown adapter: teams');
  });

  it('the disposer removes only its own registration', async () => {
    const first = stubChat('first');
    const second = stubChat('second');
    const disposeFirst = registerWebhookAdapter(first.chat, 'slack', 'slack/acme-hq');
    expect(typeof disposeFirst).toBe('function');

    // Superseded at the same path: disposing the old registration must not
    // take the new one down.
    registerWebhookAdapter(second.chat, 'slack', 'slack/acme-hq');
    disposeFirst();
    const res = await post('/webhook/slack/acme-hq', 'after-dispose');
    expect(await res.json()).toEqual({ via: 'second' });
    expect(first.calls).toEqual([]);

    // Its own registration: gone, 404 afterwards.
    const disposeSecond = registerWebhookAdapter(second.chat, 'slack', 'slack/acme-hq');
    disposeSecond();
    const miss = await post('/webhook/slack/acme-hq', 'gone');
    expect(miss.status).toBe(404);
    expect(second.calls).toEqual(['after-dispose']);
  });

  it('unregisterWebhookRoute removes an adapter route and reports whether it found one', async () => {
    const { chat } = stubChat('acme');
    registerWebhookAdapter(chat, 'slack', 'slack/acme-hq');
    expect(unregisterWebhookRoute('slack/acme-hq')).toBe(true);
    expect(unregisterWebhookRoute('slack/acme-hq')).toBe(false);
    const miss = await post('/webhook/slack/acme-hq', 'gone');
    expect(miss.status).toBe(404);
  });
});

describe('pending routes', () => {
  const challengeBody = JSON.stringify({
    token: 'ignored',
    challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P',
    type: 'url_verification',
  });

  it('echoes a Slack url_verification challenge with no signature and no live adapter', async () => {
    registerPendingWebhookRoute('slack/acme-hq');

    const res = await post('/webhook/slack/acme-hq', challengeBody, { 'Content-Type': 'application/json' });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');
    expect(await res.json()).toEqual({ challenge: '3eZbrw1aBm2rZgRNFdxV2595E9CY3gmdALWMmHkvFXO7tYXAYM8P' });
    expect(getWebhookStatus()?.paths).toEqual(['/webhook/slack/acme-hq']);
  });

  it('acknowledges and drops everything else while pending (200, empty body)', async () => {
    registerPendingWebhookRoute('slack/acme-hq');

    const event = await post(
      '/webhook/slack/acme-hq',
      JSON.stringify({ type: 'event_callback', team_id: 'T02AXK3', event: { type: 'message', text: 'hi' } }),
      { 'Content-Type': 'application/json' },
    );
    expect(event.status).toBe(200);
    expect(await event.text()).toBe('');

    const form = await post('/webhook/slack/acme-hq', 'command=%2Fnanoco&team_id=T02AXK3', {
      'Content-Type': 'application/x-www-form-urlencoded',
    });
    expect(form.status).toBe(200);
    expect(await form.text()).toBe('');

    // A challenge-shaped body with no challenge string is not a challenge.
    const notChallenge = await post('/webhook/slack/acme-hq', JSON.stringify({ type: 'url_verification' }), {
      'Content-Type': 'application/json',
    });
    expect(notChallenge.status).toBe(200);
    expect(await notChallenge.text()).toBe('');

    const probe = await send('/webhook/slack/acme-hq', { method: 'GET' });
    expect(probe.status).toBe(200);
  });

  it('is pending only at its own path; other paths keep 404ing', async () => {
    registerPendingWebhookRoute('slack/acme-hq');
    const miss = await post('/webhook/slack/other', challengeBody, { 'Content-Type': 'application/json' });
    expect(miss.status).toBe(404);
  });

  it('a live registration at the same path consumes the pending entry and takes the traffic', async () => {
    registerPendingWebhookRoute('slack/acme-hq');
    const { chat, calls } = stubChat('acme');
    registerWebhookAdapter(chat, 'slack', 'slack/acme-hq');

    // The live adapter now sees the challenge too (and answers it itself,
    // after its own signature check — here the stub just records it).
    const res = await post('/webhook/slack/acme-hq', challengeBody, { 'Content-Type': 'application/json' });
    expect(await res.json()).toEqual({ via: 'acme' });
    expect(calls).toEqual([challengeBody]);
    expect(getWebhookStatus()?.paths).toEqual(['/webhook/slack/acme-hq']);

    // Removing the live route does not resurrect the consumed pending entry.
    expect(unregisterWebhookRoute('slack/acme-hq')).toBe(true);
    const miss = await post('/webhook/slack/acme-hq', challengeBody, { 'Content-Type': 'application/json' });
    expect(miss.status).toBe(404);
  });

  it('a live route wins over a pending entry registered after it', async () => {
    const { chat, calls } = stubChat('acme');
    registerWebhookAdapter(chat, 'slack', 'slack/acme-hq');
    registerPendingWebhookRoute('slack/acme-hq');

    const res = await post('/webhook/slack/acme-hq', 'live-first');
    expect(await res.json()).toEqual({ via: 'acme' });
    expect(calls).toEqual(['live-first']);
  });

  it('unregisterWebhookRoute removes a pending entry', async () => {
    registerPendingWebhookRoute('slack/acme-hq');
    expect(unregisterWebhookRoute('slack/acme-hq')).toBe(true);
    const miss = await post('/webhook/slack/acme-hq', challengeBody, { 'Content-Type': 'application/json' });
    expect(miss.status).toBe(404);
    expect(getWebhookStatus()?.paths).toEqual([]);
  });
});
