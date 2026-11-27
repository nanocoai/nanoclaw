/**
 * pr-factory-core guard — the GitHub receiver's consumption of core's raw
 * webhook registry (registerWebhookHandler) plus its HMAC-SHA256 signature
 * verification and pull_request event filtering.
 *
 * Drives the REAL shared webhook server over HTTP on an ephemeral
 * WEBHOOK_PORT: registerGitHubWebhook mounts /webhook/github through
 * registerWebhookHandler, so deleting the registration call — or core's raw
 * dispatch branch drifting under it — turns every leg red.
 */
import crypto from 'crypto';
import { afterAll, describe, expect, it } from 'vitest';

import { registerWebhookHandler, stopWebhookServer } from '../../webhook-server.js';
import { registerGitHubWebhook, type PREvent } from './webhook.js';

const PORT = 21000 + Math.floor(Math.random() * 20000);
const SECRET = 'test-webhook-secret';

const received: PREvent[] = [];
let registered = false;

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

function prPayload(action: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    action,
    pull_request: {
      number: 42,
      title: 'Add widgets',
      body: 'Body text',
      user: { login: 'octocat' },
      head: { sha: 'abc123' },
      diff_url: 'https://github.com/acme/widgets/pull/42.diff',
      html_url: 'https://github.com/acme/widgets/pull/42',
      merged: false,
      draft: false,
      ...overrides,
    },
    repository: { full_name: 'acme/widgets' },
  });
}

async function post(path: string, body: string, headers: Record<string, string>): Promise<globalThis.Response> {
  if (!registered) {
    process.env.WEBHOOK_PORT = String(PORT);
    registerGitHubWebhook(SECRET, async (pr) => {
      received.push(pr);
    });
    registerWebhookHandler('boom', () => {
      throw new Error('handler exploded');
    });
    registered = true;
  }
  for (let attempt = 0; ; attempt++) {
    try {
      return await fetch(`http://127.0.0.1:${PORT}/webhook/${path}`, { method: 'POST', body, headers });
    } catch (err) {
      if (attempt >= 40) throw err;
      await new Promise((r) => setTimeout(r, 50));
    }
  }
}

async function settle(): Promise<void> {
  // The receiver responds 200 before dispatching; give the async callback a tick.
  await new Promise((r) => setTimeout(r, 20));
}

afterAll(async () => {
  await stopWebhookServer();
  delete process.env.WEBHOOK_PORT;
});

describe('GitHub webhook on the shared raw-handler route', () => {
  it('accepts a signed pull_request.opened and hands the parsed PREvent to the callback', async () => {
    const body = prPayload('opened');
    const res = await post('github', body, {
      'x-hub-signature-256': sign(body, SECRET),
      'x-github-event': 'pull_request',
    });
    await settle();

    expect(res.status).toBe(200);
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      action: 'opened',
      number: 42,
      author: 'octocat',
      repoFullName: 'acme/widgets',
      headSha: 'abc123',
      draft: false,
      merged: false,
    });
  });

  it('rejects a bad signature with 401 and never calls the callback', async () => {
    received.length = 0;
    const body = prPayload('opened');
    const res = await post('github', body, {
      'x-hub-signature-256': sign(body, 'wrong-secret'),
      'x-github-event': 'pull_request',
    });
    await settle();

    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
  });

  it('silently drops non-pull_request events and unhandled actions', async () => {
    received.length = 0;

    const pushBody = JSON.stringify({ ref: 'refs/heads/main' });
    const pushRes = await post('github', pushBody, {
      'x-hub-signature-256': sign(pushBody, SECRET),
      'x-github-event': 'push',
    });
    expect(pushRes.status).toBe(200);

    const labeled = prPayload('labeled');
    const labeledRes = await post('github', labeled, {
      'x-hub-signature-256': sign(labeled, SECRET),
      'x-github-event': 'pull_request',
    });
    expect(labeledRes.status).toBe(200);

    await settle();
    expect(received).toHaveLength(0);
  });

  it('returns 405 for non-POST requests', async () => {
    // touch the server first so the route exists
    await post('boom', '{}', {}).catch(() => undefined);
    const res = await fetch(`http://127.0.0.1:${PORT}/webhook/github`, { method: 'GET' });
    expect(res.status).toBe(405);
  });

  it('a throwing raw handler yields 500 from the shared dispatch branch', async () => {
    const res = await post('boom', '{}', {});
    expect(res.status).toBe(500);
  });
});
