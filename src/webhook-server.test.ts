import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { Chat } from 'chat';

import { registerWebhookAdapter, stopWebhookServer } from './webhook-server.js';

// Pick a non-default port so the suite doesn't clash with a real running host.
// WEBHOOK_PORT is read inside ensureServer() the first time a registration
// triggers it, so the env must be set before the first registerWebhookAdapter
// call in this suite.
const TEST_PORT = 17389;

beforeAll(() => {
  process.env.WEBHOOK_PORT = String(TEST_PORT);
});

afterAll(async () => {
  await stopWebhookServer();
});

function fakeChat(handlerMap: Record<string, (req: Request) => Promise<Response>>): Chat {
  return { webhooks: handlerMap } as unknown as Chat;
}

describe('registerWebhookAdapter', () => {
  it('without routingPath, the route equals adapterName', async () => {
    const chat = fakeChat({
      'default-route-adapter': async () => new Response('ok-default', { status: 200 }),
    });
    registerWebhookAdapter(chat, 'default-route-adapter');
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/default-route-adapter`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok-default');
  });

  it('with routingPath, the URL uses routingPath while handler lookup still uses adapterName', async () => {
    let received = 0;
    const chat = fakeChat({
      // Note: keyed by the original adapter.name, not by the routing path.
      'shared-adapter-A': async () => {
        received++;
        return new Response('ok-routed', { status: 200 });
      },
    });
    registerWebhookAdapter(chat, 'shared-adapter-A', 'custom-path-A');

    // The route URL is the routingPath ...
    const routed = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/custom-path-A`, {
      method: 'POST',
      body: '{}',
    });
    expect(routed.status).toBe(200);
    expect(await routed.text()).toBe('ok-routed');
    expect(received).toBe(1);

    // ... and the bare adapter name does NOT resolve (no registration under it).
    const bare = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/shared-adapter-A`, {
      method: 'POST',
      body: '{}',
    });
    expect(bare.status).toBe(404);
    expect(received).toBe(1);
  });

  it('two bridges sharing an adapterName but distinct routingPaths do not collide', async () => {
    const chatA = fakeChat({
      'shared-adapter-B': async () => new Response('alpha', { status: 200 }),
    });
    const chatB = fakeChat({
      'shared-adapter-B': async () => new Response('beta', { status: 200 }),
    });
    registerWebhookAdapter(chatA, 'shared-adapter-B', 'instance-alpha');
    registerWebhookAdapter(chatB, 'shared-adapter-B', 'instance-beta');

    const resA = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/instance-alpha`, {
      method: 'POST',
      body: '{}',
    });
    const resB = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/instance-beta`, {
      method: 'POST',
      body: '{}',
    });
    expect(await resA.text()).toBe('alpha');
    expect(await resB.text()).toBe('beta');
  });

  it('returns 404 for an unregistered route', async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/webhook/never-registered-xyz`, {
      method: 'POST',
      body: '{}',
    });
    expect(res.status).toBe(404);
  });
});
