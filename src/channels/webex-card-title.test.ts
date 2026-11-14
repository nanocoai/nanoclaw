/**
 * Webex reads a card title as Markdown twice: in the Adaptive Card and in the
 * message's Markdown fallback. Real adapter, only fetch stubbed.
 */
import { afterAll, expect, it, vi } from 'vitest';

import type { ChannelAdapter } from './adapter.js';

type WebexBody = { markdown: string; attachments: Array<{ content: { body: Array<{ text: string }> } }> };
const bodies: WebexBody[] = [];
vi.stubGlobal(
  'fetch',
  vi.fn(async (_url: string, init?: { body?: string }) => {
    if (init?.body) bodies.push(JSON.parse(init.body));
    const headers = { 'content-type': 'application/json' };
    return new Response(JSON.stringify({ id: 'm', roomId: 'ROOM' }), { status: 200, headers });
  }),
);
afterAll(() => vi.unstubAllGlobals());

vi.mock('../env.js', () => ({ readEnvFile: () => ({ WEBEX_BOT_TOKEN: 'test-token' }) }));
vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));
const { factories } = vi.hoisted(() => ({ factories: new Map<string, () => ChannelAdapter | null>() }));
vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (name: string, registration: { factory: () => ChannelAdapter | null }) =>
    factories.set(name, registration.factory),
}));

import './webex.js';

it('keeps an approval title literal in the Webex card and its Markdown on post and edit', async () => {
  const bridge = factories.get('webex')!()!;
  const thread = `webex:${Buffer.from('ROOM').toString('base64url')}:${Buffer.from('root').toString('base64url')}`;
  const title = '[Admin](https://evil.test) &#x202E;';
  await bridge.deliver(thread, null, {
    kind: 'chat-sdk',
    content: { type: 'ask_question', questionId: 'q', title, question: 'Allow?', options: ['Approve'] },
  });
  await bridge.deliver(thread, null, {
    kind: 'chat-sdk',
    content: { operation: 'edit', messageId: 'm', terminalCard: { title, question: 'Allow?', resolution: 'Approved' } },
  });
  const escaped = '\\[Admin\\]\\(https://evil.test\\) \\&#x202E;';
  expect(bodies).toHaveLength(2);
  for (const body of bodies) {
    expect(body.attachments[0].content.body[0].text).toBe(escaped);
    expect(body.markdown.split('\n')[0]).toBe(`**${escaped}**`);
  }
});
