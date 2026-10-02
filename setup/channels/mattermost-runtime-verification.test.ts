import { createHmac } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { verifyMattermostRuntime } from '../../.claude/skills/add-mattermost/scripts/verify-runtime.js';

const BOT_ID = 'b'.repeat(26);
const OWNER_ID = 'o'.repeat(26);
const CHANNEL_ID = 'd'.repeat(26);
const roots: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(
  overrides: {
    bot?: Record<string, unknown>;
    callbackStatus?: number;
    owner?: Record<string, unknown>;
    runtimeToken?: string;
    listenerId?: string;
    dropCallback?: boolean;
    deleteStatus?: number;
  } = {},
) {
  const requests: string[] = [];
  let baseUrl: string;
  let callbackReceived = false;
  const server = createServer(async (request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v4/users/me') {
      response.end(JSON.stringify(overrides.bot ?? { id: BOT_ID, is_bot: true }));
    } else if (request.url === `/api/v4/users/${OWNER_ID}`) {
      response.end(JSON.stringify(overrides.owner ?? { id: OWNER_ID }));
    } else if (request.url === `/api/v4/channels/${CHANNEL_ID}`) {
      response.end(JSON.stringify({ id: CHANNEL_ID, type: 'D' }));
    } else if (request.url?.includes('/members/')) {
      response.end(JSON.stringify({ channel_id: CHANNEL_ID, user_id: request.url.split('/').at(-1) }));
    } else if (request.url === '/api/v4/posts') {
      response.end(JSON.stringify({ id: 'p'.repeat(26) }));
    } else if (request.url?.endsWith('/actions/nanoclawsetup')) {
      callbackReceived = !overrides.dropCallback;
      response.end('{}');
    } else if (request.method === 'DELETE') {
      response.statusCode = overrides.deleteStatus ?? 200;
      response.end('{}');
    } else if (request.url === '/webhook/mattermost') {
      response.setHeader('x-nanoclaw-webhook-id', overrides.listenerId ?? 'test-listener');
      let body = '';
      for await (const chunk of request) body += chunk;
      const payload = JSON.parse(body);
      if (payload.context?.callback_token === 'test-secret') {
        const runtime = {
          challenge: payload.context.nanoclaw_setup_probe,
          bot_id: BOT_ID,
          base_url: baseUrl,
          callback_url: `${baseUrl}/webhook/mattermost`,
          connected: true,
          callback_received: callbackReceived,
        };
        const proof = createHmac('sha256', overrides.runtimeToken ?? 'test-token')
          .update(JSON.stringify(runtime))
          .digest('hex');
        response.end(JSON.stringify({ ...runtime, proof }));
      } else {
        response.statusCode = overrides.callbackStatus ?? 401;
        response.end('{}');
      }
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  baseUrl = `http://127.0.0.1:${address.port}`;
  const root = await mkdtemp(join(tmpdir(), 'mattermost-runtime-'));
  roots.push(root);
  await writeFile(
    join(root, '.env'),
    [
      `MATTERMOST_BASE_URL=http://127.0.0.1:${address.port}`,
      'MATTERMOST_BOT_TOKEN=test-token',
      'MATTERMOST_CALLBACK_SECRET=test-secret',
      `MATTERMOST_CALLBACK_URL=${baseUrl}`,
      `WEBHOOK_PORT=${address.port}`,
      '',
    ].join('\n'),
  );
  const connected = async () => ({
    webhook: { id: 'test-listener', port: address.port, paths: ['/webhook/mattermost'] },
    channels: [{ connected: true, instance: 'mattermost', type: 'mattermost' }],
  });
  return { connected, requests, root };
}

describe('Mattermost runtime verification', () => {
  it('proves the connected adapter, bot, owner, DM, and unsigned callback rejection', async () => {
    const { connected, requests, root } = await fixture();
    await verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, {
      queryHostImpl: connected,
    });
    expect(requests).toEqual([
      'POST /webhook/mattermost',
      'GET /api/v4/users/me',
      `GET /api/v4/users/${OWNER_ID}`,
      `GET /api/v4/channels/${CHANNEL_ID}`,
      `GET /api/v4/channels/${CHANNEL_ID}/members/${BOT_ID}`,
      `GET /api/v4/channels/${CHANNEL_ID}/members/${OWNER_ID}`,
      'POST /webhook/mattermost',
      'POST /api/v4/posts',
      `POST /api/v4/posts/${'p'.repeat(26)}/actions/nanoclawsetup`,
      'POST /webhook/mattermost',
      `DELETE /api/v4/posts/${'p'.repeat(26)}`,
    ]);
  });

  it('rejects a live host without a connected Mattermost adapter before using credentials', async () => {
    const { requests, root } = await fixture();
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, {
        queryHostImpl: async () => ({ channels: [] }),
      }),
    ).rejects.toThrow('no connected mattermost adapter');
    expect(requests).toEqual([]);
  });

  it('rejects a running credential for a different bot', async () => {
    const { connected, root } = await fixture({ bot: { id: 'x'.repeat(26), is_bot: true } });
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, {
        queryHostImpl: connected,
      }),
    ).rejects.toThrow('does not identify the selected bot');
  });

  it('rejects an owner lookup that does not match the selected account', async () => {
    const { connected, root } = await fixture({ owner: { id: 'x'.repeat(26) } });
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, {
        queryHostImpl: connected,
      }),
    ).rejects.toThrow('selected owner is not resolvable');
  });

  it('requires the local callback route to reject unsigned requests', async () => {
    const { connected, root } = await fixture({ callbackStatus: 200 });
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, {
        queryHostImpl: connected,
      }),
    ).rejects.toThrow('local callback does not reject unsigned requests');
  });
  it('rejects a stale running token even when the saved token authenticates successfully', async () => {
    const { connected, root } = await fixture({ runtimeToken: 'previous-token' });
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, { queryHostImpl: connected }),
    ).rejects.toThrow('running adapter configuration');
  });

  it('rejects a listener belonging to another installation', async () => {
    const { connected, root } = await fixture({ listenerId: 'other-listener' });
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, { queryHostImpl: connected }),
    ).rejects.toThrow('callback does not identify this host');
  });

  it('rejects a failed listener bind even with a connected adapter', async () => {
    const { connected, root, requests } = await fixture();
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, {
        queryHostImpl: async () => ({ ...(await connected()), webhook: null }),
      }),
    ).rejects.toThrow('no listening Mattermost callback route');
    expect(requests).toEqual([]);
  });

  it('uses the effective service port even when .env specifies a different port', async () => {
    const { connected, root } = await fixture();
    const { appendFile } = await import('node:fs/promises');
    await appendFile(join(root, '.env'), 'WEBHOOK_PORT=1\n');
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, { queryHostImpl: connected }),
    ).resolves.toBeUndefined();
  });

  it('does not accept a successful action response without receipt and still removes the test post', async () => {
    const { connected, root, requests } = await fixture({ dropCallback: true });
    await expect(
      verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, { queryHostImpl: connected }),
    ).rejects.toThrow('server callback was not received');
    expect(requests.at(-1)).toBe(`DELETE /api/v4/posts/${'p'.repeat(26)}`);
  });
  it('reports cleanup separately when a working bot lacks delete-post permission', async () => {
    const { connected, root } = await fixture({ deleteStatus: 403 });
    const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await verifyMattermostRuntime(root, BOT_ID, OWNER_ID, `mattermost:${CHANNEL_ID}`, { queryHostImpl: connected });
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('automatic cleanup failed'));
    } finally {
      warning.mockRestore();
    }
  });
});
