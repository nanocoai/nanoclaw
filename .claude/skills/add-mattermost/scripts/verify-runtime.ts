import { pathToFileURL } from 'node:url';
import { createHmac, randomUUID } from 'node:crypto';

import { readEnvFile } from '../../../../src/env.js';
import { queryHost } from '../../../../setup/lib/host-status.mjs';

const MATTERMOST_ID = /^[a-z0-9]{26}$/;

type HostStatus = {
  channels: Array<{ connected: boolean; instance: string; type: string }>;
  webhook?: { id: string; port: number; paths: string[] } | null;
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
    redirect: 'error',
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
    ['MATTERMOST_BASE_URL', 'MATTERMOST_BOT_TOKEN', 'MATTERMOST_CALLBACK_SECRET', 'MATTERMOST_CALLBACK_URL'],
    root,
  );
  const baseUrl = required(env, 'MATTERMOST_BASE_URL').replace(/\/+$/, '');
  const token = required(env, 'MATTERMOST_BOT_TOKEN');
  const secret = required(env, 'MATTERMOST_CALLBACK_SECRET');
  const callbackBase = required(env, 'MATTERMOST_CALLBACK_URL').replace(/\/+$/, '');
  const callbackUrl = callbackBase.includes('/webhook/') ? callbackBase : `${callbackBase}/webhook/mattermost`;
  for (const url of [baseUrl, callbackUrl]) {
    const parsed = new URL(url);
    if (
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash
    )
      throw new Error('Mattermost runtime verification: invalid saved URL');
  }

  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const status = await (dependencies.queryHostImpl ?? queryHost)(root);
  if (!status.channels.some((channel) => channel.instance === 'mattermost' && channel.connected === true)) {
    throw new Error('Mattermost runtime verification: the running host has no connected mattermost adapter');
  }

  const listener = status.webhook;
  if (!listener?.id || !listener.paths.includes('/webhook/mattermost')) {
    throw new Error('Mattermost runtime verification: this host has no listening Mattermost callback route');
  }
  // Use the actual host's bound port, including service-level overrides. The
  // response identity binds the HTTP route to the host queried over its socket.
  const localUrl = `http://127.0.0.1:${listener.port}/webhook/mattermost`;
  const challenge = randomUUID();
  const probe = async (received: boolean) => {
    const callback = await fetchImpl(localUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ context: { callback_token: secret, nanoclaw_setup_probe: challenge } }),
      redirect: 'error',
      signal: AbortSignal.timeout(10_000),
    });
    if (callback.status !== 200 || callback.headers.get('x-nanoclaw-webhook-id') !== listener.id) {
      throw new Error(
        'Mattermost runtime verification: callback does not identify this host; refresh the Mattermost registry payload with /update-skills and retry',
      );
    }
    const runtime = (await callback.json()) as Record<string, unknown>;
    const selected = {
      challenge,
      bot_id: expectedBotId,
      base_url: baseUrl,
      callback_url: callbackUrl,
      connected: true,
      callback_received: received,
    };
    const proof = createHmac('sha256', token).update(JSON.stringify(selected)).digest('hex');
    if (runtime.proof !== proof) {
      throw new Error(
        received
          ? 'Mattermost runtime verification: server callback was not received by this running adapter'
          : 'Mattermost runtime verification: running adapter configuration or connection differs from the selected settings',
      );
    }
  };
  await probe(false);

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

  for (const id of [expectedBotId, expectedOwnerId]) {
    const member = await getJson(fetchImpl, `${baseUrl}/api/v4/channels/${channelId}/members/${id}`, token);
    if (member.user_id !== id || member.channel_id !== channelId)
      throw new Error('Mattermost runtime verification: the DM does not contain the selected bot and owner');
  }

  const unsigned = await fetchImpl(localUrl, {
    method: 'POST',
    body: '{}',
    redirect: 'error',
    signal: AbortSignal.timeout(10_000),
  });
  if (unsigned.status !== 401 || unsigned.headers.get('x-nanoclaw-webhook-id') !== listener.id)
    throw new Error('Mattermost runtime verification: local callback does not reject unsigned requests');

  const request = async (path: string, method: string, body?: unknown) => {
    const response = await fetchImpl(`${baseUrl}/api/v4${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Mattermost runtime verification: ${method} ${path} returned ${response.status}`);
    return response;
  };
  // Trigger the same integration API the UI calls. Mattermost makes the
  // callback request, exercising its routing, TLS and internal-host policy.
  // The short-lived proof cannot authenticate normal approval callbacks.
  const posted = (await (
    await request('/posts', 'POST', {
      channel_id: channelId,
      message: 'NanoClaw setup: checking the card callback (removed automatically).',
      props: {
        attachments: [
          {
            text: 'Setup verification',
            actions: [
              {
                id: 'nanoclawsetup',
                name: 'Verify setup',
                type: 'button',
                integration: {
                  url: callbackUrl,
                  context: {
                    nanoclaw_setup_action: challenge,
                    nanoclaw_setup_proof: createHmac('sha256', token)
                      .update(`nanoclaw-setup:${challenge}`)
                      .digest('hex'),
                  },
                },
              },
            ],
          },
        ],
      },
    })
  ).json()) as { id?: unknown };
  if (typeof posted.id !== 'string' || !MATTERMOST_ID.test(posted.id))
    throw new Error('Mattermost runtime verification: server did not identify the temporary verification post');
  try {
    await request(`/posts/${posted.id}/actions/nanoclawsetup`, 'POST', {});
    await probe(true);
  } finally {
    try {
      await request(`/posts/${posted.id}`, 'DELETE');
    } catch {
      // Deleting posts can be disabled independently of working bot/card
      // delivery. Preserve the verification outcome and identify cleanup.
      console.error(
        `Mattermost setup: remove diagnostic post ${posted.id} from the owner DM; automatic cleanup failed.`,
      );
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [expectedBotId, expectedOwnerId, platformId] = process.argv.slice(2);
  try {
    await verifyMattermostRuntime(process.cwd(), expectedBotId ?? '', expectedOwnerId ?? '', platformId ?? '');
    console.log(
      'Mattermost verified: running bot and settings, authenticated adapter, owner DM, and callback delivery from the Mattermost server.',
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
