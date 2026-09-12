import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

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
  overrides: { bot?: Record<string, unknown>; callbackStatus?: number; owner?: Record<string, unknown> } = {},
) {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`);
    response.setHeader('content-type', 'application/json');
    if (request.url === '/api/v4/users/me') {
      response.end(JSON.stringify(overrides.bot ?? { id: BOT_ID, is_bot: true }));
    } else if (request.url === `/api/v4/users/${OWNER_ID}`) {
      response.end(JSON.stringify(overrides.owner ?? { id: OWNER_ID }));
    } else if (request.url === `/api/v4/channels/${CHANNEL_ID}`) {
      response.end(JSON.stringify({ id: CHANNEL_ID, type: 'D' }));
    } else if (request.url === '/webhook/mattermost') {
      response.statusCode = overrides.callbackStatus ?? 401;
      response.end('{}');
    } else {
      response.statusCode = 404;
      response.end('{}');
    }
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('test server did not bind');

  const root = await mkdtemp(join(tmpdir(), 'mattermost-runtime-'));
  roots.push(root);
  await writeFile(
    join(root, '.env'),
    [
      `MATTERMOST_BASE_URL=http://127.0.0.1:${address.port}`,
      'MATTERMOST_BOT_TOKEN=test-token',
      'MATTERMOST_CALLBACK_SECRET=test-secret',
      `WEBHOOK_PORT=${address.port}`,
      '',
    ].join('\n'),
  );
  const connected = async () => ({
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
      'GET /api/v4/users/me',
      `GET /api/v4/users/${OWNER_ID}`,
      `GET /api/v4/channels/${CHANNEL_ID}`,
      'POST /webhook/mattermost',
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
    ).rejects.toThrow('unsigned callback returned 200, expected 401');
  });
});
