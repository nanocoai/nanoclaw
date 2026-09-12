import { pathToFileURL } from 'node:url';

import { readEnvFile } from '../../../../src/env.js';
import { queryHost } from '../../../../setup/lib/host-status.mjs';

const MATTERMOST_ID = /^[a-z0-9]{26}$/;

type HostStatus = {
  channels: Array<{ connected: boolean; instance: string; type: string }>;
};

type Dependencies = {
  fetchImpl?: typeof fetch;
  queryHostImpl?: (root: string) => Promise<HostStatus>;
};

function required(env: Record<string, string>, key: string): string {
  const value = env[key];
  if (!value) throw new Error(`Mattermost runtime verification: ${key} is missing from .env`);
  return value;
}

async function getJson(fetchImpl: typeof fetch, url: string, token: string): Promise<Record<string, unknown>> {
  const response = await fetchImpl(url, {
    headers: { authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok)
    throw new Error(`Mattermost runtime verification: GET ${new URL(url).pathname} returned ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export async function verifyMattermostRuntime(
  root: string,
  expectedBotId: string,
  expectedOwnerId: string,
  platformId: string,
  dependencies: Dependencies = {},
): Promise<void> {
  if (!MATTERMOST_ID.test(expectedBotId) || !MATTERMOST_ID.test(expectedOwnerId)) {
    throw new Error('Mattermost runtime verification: expected bot and owner IDs must be 26 lowercase characters');
  }
  const channelId = platformId.startsWith('mattermost:') ? platformId.slice('mattermost:'.length) : '';
  if (!MATTERMOST_ID.test(channelId)) {
    throw new Error('Mattermost runtime verification: invalid owner DM platform ID');
  }

  const env = readEnvFile(
    ['MATTERMOST_BASE_URL', 'MATTERMOST_BOT_TOKEN', 'MATTERMOST_CALLBACK_SECRET', 'WEBHOOK_PORT'],
    root,
  );
  const baseUrl = required(env, 'MATTERMOST_BASE_URL').replace(/\/+$/, '');
  const token = required(env, 'MATTERMOST_BOT_TOKEN');
  required(env, 'MATTERMOST_CALLBACK_SECRET');
  const port = Number(env.WEBHOOK_PORT || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('Mattermost runtime verification: WEBHOOK_PORT must be between 1 and 65535');
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const status = await (dependencies.queryHostImpl ?? queryHost)(root);
  if (!status.channels.some((channel) => channel.instance === 'mattermost' && channel.connected === true)) {
    throw new Error('Mattermost runtime verification: the running host has no connected mattermost adapter');
  }

  const me = await getJson(fetchImpl, `${baseUrl}/api/v4/users/me`, token);
  if (me.id !== expectedBotId || me.is_bot !== true) {
    throw new Error('Mattermost runtime verification: the running credential does not identify the selected bot');
  }
  const owner = await getJson(fetchImpl, `${baseUrl}/api/v4/users/${expectedOwnerId}`, token);
  if (owner.id !== expectedOwnerId) {
    throw new Error('Mattermost runtime verification: the selected owner is not resolvable');
  }
  const dm = await getJson(fetchImpl, `${baseUrl}/api/v4/channels/${channelId}`, token);
  if (dm.id !== channelId || dm.type !== 'D') {
    throw new Error('Mattermost runtime verification: the selected owner DM is not available');
  }

  const callback = await fetchImpl(`http://127.0.0.1:${port}/webhook/mattermost`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
    signal: AbortSignal.timeout(10_000),
  });
  if (callback.status !== 401) {
    throw new Error(`Mattermost runtime verification: unsigned callback returned ${callback.status}, expected 401`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [expectedBotId, expectedOwnerId, platformId] = process.argv.slice(2);
  try {
    await verifyMattermostRuntime(process.cwd(), expectedBotId ?? '', expectedOwnerId ?? '', platformId ?? '');
    console.log('Mattermost runtime verified: adapter, callback, bot, owner, and owner DM are ready.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
