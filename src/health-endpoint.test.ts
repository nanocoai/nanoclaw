/**
 * Guard for src/health-endpoint.ts — the liveness route a dashboard polls.
 *
 * Drives the REAL shared HTTP server on an ephemeral WEBHOOK_PORT (same
 * approach as webhook-server-raw.test.ts, no mocking of the routing layer),
 * because the thing under test is precisely "does an outside HTTP client get
 * a 200 here". The 405 and no-body-on-HEAD cases are asserted so a dashboard
 * configured with a non-GET probe fails loudly instead of looking healthy.
 */
import { afterAll, describe, expect, it } from 'vitest';

import { registerHealthEndpoint } from './health-endpoint.js';
import { stopWebhookServer } from './webhook-server.js';

const PORT = 21000 + Math.floor(Math.random() * 20000);

interface HealthBody {
  status: string;
  uptimeSeconds: number;
  timestamp: string;
}

async function request(method: string, path = 'health'): Promise<globalThis.Response> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/${path}`, { method });
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

describe('health endpoint', () => {
  it('answers GET /webhook/health with 200 and a JSON status body', async () => {
    process.env.WEBHOOK_PORT = String(PORT);
    registerHealthEndpoint();

    const res = await request('GET');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/json');

    const body = (await res.json()) as HealthBody;
    expect(body.status).toBe('ok');
    expect(typeof body.uptimeSeconds).toBe('number');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
    // Storage/API timestamps are ISO-8601 UTC — see the Timestamps rule in CLAUDE.md.
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });

  it('leaks no install detail — only status, uptime, timestamp', async () => {
    const body = (await (await request('GET')).json()) as HealthBody;
    expect(Object.keys(body).sort()).toEqual(['status', 'timestamp', 'uptimeSeconds']);
  });

  it('answers HEAD with 200 and no body', async () => {
    const res = await request('HEAD');
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('');
  });

  it('rejects non-GET methods with 405 rather than a misleading 200', async () => {
    const res = await request('POST');
    expect(res.status).toBe(405);
    expect(res.headers.get('allow')).toBe('GET, HEAD');
  });

  it('registers the route lazily-started server so an unknown path still 404s', async () => {
    const res = await request('GET', 'not-a-route');
    expect(res.status).toBe(404);
  });
});
