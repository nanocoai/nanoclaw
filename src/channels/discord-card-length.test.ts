/**
 * Discord card limit against the real @chat-adapter/discord: only fetch is
 * stubbed, so the test sees the exact embed the adapter posts. Discord rejects
 * an embed description over 4,096.
 */
import { createDiscordAdapter } from '@chat-adapter/discord';
import { Actions, Button, Card, CardText, type CardChild } from 'chat';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelRegistration } from './adapter.js';

const registrations = vi.hoisted(() => new Map<string, ChannelRegistration>());
const gateway = vi.hoisted(() => ({ url: '' }));

// The bridge starts a gateway listener on setup; keep it local and note where
// clicks are forwarded.
vi.mock('@chat-adapter/discord', async (importOriginal) => {
  const real = await importOriginal<typeof import('@chat-adapter/discord')>();
  return {
    ...real,
    createDiscordAdapter: (...args: Parameters<typeof real.createDiscordAdapter>) =>
      Object.assign(real.createDiscordAdapter(...args), {
        startGatewayListener: async (_options: unknown, _ms: number, _signal: unknown, url: string) => {
          gateway.url = url;
          return new Response('{}');
        },
      }),
  };
});

vi.mock('./channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./channel-registry.js')>()),
  registerChannelAdapter: (name: string, registration: ChannelRegistration) => registrations.set(name, registration),
}));

vi.mock('../env.js', () => ({
  readEnvFile: () => ({
    DISCORD_BOT_TOKEN: 'test-bot-token',
    DISCORD_PUBLIC_KEY: 'a'.repeat(64),
    DISCORD_APPLICATION_ID: 'test-app-id',
  }),
}));

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { CardTooLongError } from './ask-question.js';
import { clearButtonsOnCardEdits, escapeDiscordCardText } from './discord.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';

const posts: Array<{ embeds: Array<{ title?: string; description?: string }>; components?: unknown[] }> = [];
const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;
/** Set by a test: Discord refuses every edit of a channel message. */
let cardEditsFail = false;

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    if (init.method === 'PATCH') patches.push({ url, body: JSON.parse(init.body!) });
    else posts.push(JSON.parse(init.body!));
    if (cardEditsFail && init.method === 'PATCH' && /\/channels\/[^/]+\/messages\//.test(url))
      return new Response('{"message":"Internal Server Error"}', { status: 500 });
    return new Response(JSON.stringify({ id: `m${posts.length}`, channel_id: 'c1' }), { status: 200 });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  posts.length = 0;
  patches.length = 0;
  cardEditsFail = false;
});

const adapter = createDiscordAdapter({
  botToken: 'test-bot-token',
  publicKey: 'a'.repeat(64),
  applicationId: 'test-app-id',
});
const approve = Actions([Button({ id: 'ncq:q:0', label: 'Approve' })]);
const card = (blocks: string[], rest: CardChild[] = [approve], title = 'Approve') =>
  Card({ title, children: [...blocks.map((block) => CardText(block)), ...rest] });

/** The review case: a 572-character resource and six 600-character details. */
function longGatewayCard() {
  const summary = {
    agent: 'agent',
    action: 'Post a comment',
    resource: 'POST api.example.com/' + 'r'.repeat(551),
    reason: 'The gateway policy requires human approval for this request.',
    details: Array.from({ length: 6 }, (_, i) => ({ label: `Field ${i}`, value: `D${i}${'v'.repeat(596)}E${i}` })),
  };
  return gatewayApprovalPresentation({ title: 'Credentials Request', question: '', summary } as GatewayApprovalRequest);
}

describe('Discord card limit through the bridge', () => {
  let bridge: ChannelAdapter;
  const ask = async (title: string, question: string) => {
    bridge ??= (await registrations.get('discord')!.factory())!;
    return bridge.deliver('discord:g1:c1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-long-1',
        title,
        question,
        options: [{ label: 'Approve', style: 'primary' }, { label: 'Reject' }],
      },
    });
  };

  // A pipe doubles when escaped, and the limit counts the escaped text.
  it('posts a card at the limit whole, as one embed Discord accepts', async () => {
    await ask('Approve', '|'.repeat(1996));
    expect(posts).toHaveLength(1);
    const { description } = posts[0].embeds[0];
    expect(description!.length).toBeLessThanOrEqual(4096);
    expect(description!.match(/\|/g)).toHaveLength(1996);
    expect(posts[0].components?.length).toBeGreaterThan(0);
  });

  it('refuses a card one character longer and posts nothing', async () => {
    await expect(ask('Approve', '|'.repeat(1997))).rejects.toBeInstanceOf(CardTooLongError);
    expect(posts).toHaveLength(0);
  });

  it('refuses a long gateway card instead of cutting it', async () => {
    const { title, question } = longGatewayCard();
    await expect(ask(title, question)).rejects.toBeInstanceOf(CardTooLongError);
    expect(posts).toHaveLength(0);
  });
});

describe('clearButtonsOnCardEdits', () => {
  const resolved = Card({ title: 'Approve', children: [CardText('Approved by admin', { style: 'muted' })] });

  it('shows the gap: the adapter edits a card without actions and sends no components', async () => {
    await adapter.editMessage('discord:g1:c1', 'm9', { card: resolved });
    expect(patches[0].body).not.toHaveProperty('components');
  });

  it('sends components: [] when a message is edited into a card without actions', async () => {
    const wrapped = createDiscordAdapter({
      botToken: 'test-bot-token',
      publicKey: 'a'.repeat(64),
      applicationId: 'test-app-id',
    });
    clearButtonsOnCardEdits(wrapped);

    await wrapped.editMessage('discord:g1:c1', 'm9', { card: resolved });
    expect(patches[0].url).toMatch(/\/channels\/c1\/messages\/m9$/);
    expect(patches[0].body.components).toEqual([]);

    await wrapped.editMessage('discord:g1:c1', 'm9', { card: card(['Approve?']) });
    expect((patches[1].body.components as unknown[]).length).toBeGreaterThan(0);

    await wrapped.editMessage('discord:g1:c1', 'm9', { markdown: 'plain text' });
    expect(patches[2].body).not.toHaveProperty('components');
  });

  it('is wired into the Discord bridge: a resolved approval card loses its buttons', async () => {
    const bridge = (await registrations.get('discord')!.factory())!;
    await bridge.deliver('discord:g1:c1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'm9',
        terminalCard: { title: 'Approve', question: 'Run it?', resolution: 'Approved by admin' },
      },
    });
    expect(patches).toHaveLength(1);
    expect(patches[0].body.components).toEqual([]);
  });

  // What riding on the card edit cannot do: when Discord refuses the edit, its
  // `components: []` never lands, and only the click's own removal is left.
  it('leaves a refused click edit to the interaction, which still removes the buttons', async () => {
    registerQuestionRenderResolver((id) =>
      id === 'q-edit-fails'
        ? {
            title: 'Approve',
            question: 'Run it?',
            options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          }
        : undefined,
    );
    await runMigrations(await initTestDb());
    const bridge = (await registrations.get('discord')!.factory())!;
    await bridge.setup({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: async () => 'accepted' as const,
    });
    cardEditsFail = true;
    try {
      const response = await realFetch(gateway.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': 'test-bot-token' },
        body: JSON.stringify({
          type: 'GATEWAY_INTERACTION_CREATE',
          data: {
            type: 3,
            id: 'i1',
            token: 'interaction-token',
            application_id: 'test-app-id',
            guild_id: 'g1',
            channel_id: 'c1',
            data: { custom_id: 'ncq:q-edit-fails:0\napprove' },
            member: { user: { id: 'u1', username: 'ann' } },
            message: { id: 'm9', embeds: [{ title: 'Approve', description: 'Run it?' }] },
          },
        }),
      });
      expect(response.status).toBe(200);
      await vi.waitFor(() =>
        expect(patches.map((patch) => patch.url.replace(/^.*\/api\/v10/, ''))).toEqual([
          '/channels/c1/messages/m9',
          '/webhooks/test-app-id/interaction-token/messages/@original',
        ]),
      );
      expect(patches[0].body.components).toEqual([]);
      expect(patches[1].body).toEqual({ components: [] });
    } finally {
      await bridge.teardown();
      await closeDb();
    }
  });
});

describe('escapeDiscordCardText', () => {
  it('breaks masked links, mentions and spoilers, and leaves host wording and escaped values alone', () => {
    expect(escapeDiscordCardText('[Admin](https://x.co) <@1> ||hidden||')).toBe(
      '[Admin]\u2060(https://x.co) <\u2060@1> |\u2060|\u2060hidden|\u2060|\u2060',
    );
    for (const pipes of ['||', '|||', '||||']) {
      expect(escapeDiscordCardText(`${pipes}hidden${pipes}`)).not.toContain('||');
    }
    const host = '*Action:* Post a comment\n*Where:* \\[a\\]\\(b\\)';
    expect(escapeDiscordCardText(host)).toBe(host);
  });

  it('keeps a clicker name from posing as a link or another user on the resolved card', async () => {
    registerQuestionRenderResolver((id) =>
      id === 'q-name'
        ? {
            title: 'Approve',
            question: 'Run it?',
            options: [{ label: 'Approve', selectedLabel: 'Approved', value: 'approve' }],
          }
        : undefined,
    );
    await runMigrations(await initTestDb());
    const bridge = (await registrations.get('discord')!.factory())!;
    await bridge.setup({
      onInbound: () => {},
      onInboundEvent: () => {},
      onMetadata: () => {},
      onAction: async () => 'accepted' as const,
    });
    try {
      const response = await realFetch(gateway.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-discord-gateway-token': 'test-bot-token' },
        body: JSON.stringify({
          type: 'GATEWAY_INTERACTION_CREATE',
          data: {
            type: 3,
            id: 'i1',
            token: 'interaction-token',
            application_id: 'test-app-id',
            guild_id: 'g1',
            channel_id: 'c1',
            data: { custom_id: 'ncq:q-name:0\napprove' },
            member: { user: { id: 'u1', username: 'u1', global_name: '[Admin](https://x.co) <@1>' } },
            message: { id: 'm9', embeds: [{ title: 'Approve', description: 'Run it?' }] },
          },
        }),
      });
      expect(response.status).toBe(200);
      // The card edit, not the interaction's button removal.
      const edits = () => patches.filter((patch) => patch.url.endsWith('/channels/c1/messages/m9'));
      await vi.waitFor(() => expect(edits()).toHaveLength(1));
      const [embed] = edits()[0].body.embeds as Array<{ description: string }>;
      expect(embed.description).toContain('Approved by [Admin]\u2060(https://x.co) <\u2060@1>');
    } finally {
      await bridge.teardown();
      await closeDb();
    }
  });
});
