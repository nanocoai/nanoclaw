import { afterEach, describe, expect, it } from 'vitest';

import { registerWebhookAdapter, stopWebhookServer } from './webhook-server.js';

async function waitForServer(port: number): Promise<void> {
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/not-found`);
      if (res.status === 404) return;
    } catch {
      // Server may not have started listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('webhook server did not start');
}

describe('webhook server request body limits', () => {
  afterEach(async () => {
    await stopWebhookServer();
    delete process.env.WEBHOOK_PORT;
    delete process.env.WEBHOOK_MAX_BODY_BYTES;
  });

  it('rejects oversized webhook bodies before adapter dispatch', async () => {
    process.env.WEBHOOK_PORT = '43191';
    process.env.WEBHOOK_MAX_BODY_BYTES = '8';
    let handlerCalled = false;

    registerWebhookAdapter(
      {
        webhooks: {
          test: async () => {
            handlerCalled = true;
            return new Response('adapter handled');
          },
        },
      } as never,
      'test',
    );
    await waitForServer(43191);

    const res = await fetch('http://127.0.0.1:43191/webhook/test', {
      method: 'POST',
      body: '0123456789',
    });

    expect(res.status).toBe(413);
    expect(await res.text()).toBe('Payload Too Large');
    expect(handlerCalled).toBe(false);
  });

  it('continues to dispatch webhook bodies within the configured limit', async () => {
    process.env.WEBHOOK_PORT = '43192';
    process.env.WEBHOOK_MAX_BODY_BYTES = '32';
    let handlerCalled = false;

    registerWebhookAdapter(
      {
        webhooks: {
          test: async (req: Request) => {
            handlerCalled = true;
            expect(await req.text()).toBe('small body');
            return new Response('ok');
          },
        },
      } as never,
      'test',
    );
    await waitForServer(43192);

    const res = await fetch('http://127.0.0.1:43192/webhook/test', {
      method: 'POST',
      body: 'small body',
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toBe('ok');
    expect(handlerCalled).toBe(true);
  });
});
