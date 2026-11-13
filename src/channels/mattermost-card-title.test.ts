/**
 * Mattermost reads a card title as Markdown: in the post text without a
 * callback URL, and in the attachment title and resolved post with one.
 * Real adapter, only fetch stubbed.
 */
import { afterAll, beforeEach, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from './adapter.js';

type PostBody = { message: string; props?: { attachments?: Array<{ title?: string }> } };
const bodies: PostBody[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: 'm', channel_id: 'chan', message: '', props: {} }), { status: 200 });
  }),
);
afterAll(() => vi.unstubAllGlobals());
beforeEach(() => {
  bodies.length = 0;
});

const env = vi.hoisted(() => ({ values: {} as Record<string, string> }));
vi.mock('../env.js', () => ({ readEnvFile: () => env.values }));
vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
const { factories } = vi.hoisted(() => ({ factories: new Map<string, () => ChannelAdapter | null>() }));
vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (name: string, registration: { factory: () => ChannelAdapter | null }) =>
    factories.set(name, registration.factory),
}));

import './mattermost.js';

it.each([undefined, 'https://host.test'])('keeps an approval title literal with callback URL %s', async (callback) => {
  env.values = {
    MATTERMOST_BASE_URL: 'https://mm.test',
    MATTERMOST_BOT_TOKEN: 'test-token',
    ...(callback ? { MATTERMOST_CALLBACK_URL: callback } : {}),
  };
  const bridge = factories.get('mattermost')!()!;
  const title = '[Admin](https://evil.test) &#x202E;';
  await bridge.deliver('mattermost:chan', null, {
    kind: 'chat-sdk',
    content: { type: 'ask_question', questionId: 'q', title, question: 'Allow?', options: ['Approve'] },
  });
  await bridge.deliver('mattermost:chan', null, {
    kind: 'chat-sdk',
    content: { operation: 'edit', messageId: 'm', terminalCard: { title, question: 'Allow?', resolution: 'Approved' } },
  });
  const escaped = '\\[Admin\\]\\(https://evil.test\\) \\&#x202E;';
  const shown = bodies.map((body) => body.props?.attachments?.[0]?.title ?? body.message.split('\n')[0]);
  expect(shown).toEqual([callback ? escaped : `> **${escaped}**`, `> **${escaped}**`]);
});
