/**
 * Discord card fit against the real @chat-adapter/discord: only fetch is
 * stubbed, so the test sees the exact embed the adapter posts. Discord rejects
 * an embed title over 256 characters, a description over 4,096 or a button
 * label over 80.
 */
import { cardToDiscordPayload, createDiscordAdapter } from '@chat-adapter/discord';
import { Actions, Button, Card, CardText, type CardChild, type CardElement } from 'chat';
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
import { clearButtonsOnCardEdits, escapeDiscordCardText, fitsDiscordEmbed } from './discord.js';
import { registerQuestionRenderResolver } from './question-render-registry.js';

const posts: Array<{ embeds: Array<{ title?: string; description?: string }>; components?: unknown[] }> = [];
const patches: Array<{ url: string; body: Record<string, unknown> }> = [];
const realFetch = globalThis.fetch;

vi.stubGlobal(
  'fetch',
  vi.fn(async (url: string, init: { method?: string; body?: string }) => {
    if (init.method === 'PATCH') patches.push({ url, body: JSON.parse(init.body!) });
    else posts.push(JSON.parse(init.body!));
    return new Response(JSON.stringify({ id: `m${posts.length}`, channel_id: 'c1' }), { status: 200 });
  }),
);

afterAll(() => {
  vi.unstubAllGlobals();
});

beforeEach(() => {
  posts.length = 0;
  patches.length = 0;
});

const adapter = createDiscordAdapter({
  botToken: 'test-bot-token',
  publicKey: 'a'.repeat(64),
  applicationId: 'test-app-id',
});
const approve = Actions([Button({ id: 'ncq:q:0', label: 'Approve' })]);
const card = (blocks: string[], rest: CardChild[] = [approve], title = 'Approve') =>
  Card({ title, children: [...blocks.map((block) => CardText(block)), ...rest] });

async function postedEmbed(c: CardElement) {
  posts.length = 0;
  await adapter.postMessage('discord:g1:c1', { card: c });
  return posts[0].embeds[0];
}

describe('fitsDiscordEmbed', () => {
  it('accepts a description of exactly 4,096 across blocks, which the adapter posts whole', async () => {
    // Blocks join with a blank line: 2,000 + 2 + 2,094.
    const c = card(['a'.repeat(2000), 'b'.repeat(2094)]);
    expect(fitsDiscordEmbed(c)).toBe(true);
    expect((await postedEmbed(c)).description).toBe(`${'a'.repeat(2000)}\n\n${'b'.repeat(2094)}`);
  });

  it('rejects one character more, which Discord would refuse', async () => {
    const c = card(['a'.repeat(2000), 'b'.repeat(2095)]);
    expect(fitsDiscordEmbed(c)).toBe(false);
    expect((await postedEmbed(c)).description).toHaveLength(4097);
  });

  it('rejects blocks that fit joined by line breaks but not by the blank lines the embed uses', async () => {
    const blocks = ['a'.repeat(2000), 'b'.repeat(1047), 'c'.repeat(1046)];
    expect(blocks.join('\n')).toHaveLength(4095);
    const c = card(blocks);
    expect(fitsDiscordEmbed(c)).toBe(false);
    expect((await postedEmbed(c)).description).toHaveLength(4097);
  });

  it('counts the styling the adapter adds to a decided card', async () => {
    // A muted resolution is wrapped in *...*, two characters plain text misses.
    const resolution = 'Approved by admin';
    const room = 4096 - 2 - (resolution.length + 2);
    const fits = card(['a'.repeat(room)], [CardText(resolution, { style: 'muted' })]);
    const over = card(['a'.repeat(room + 1)], [CardText(resolution, { style: 'muted' })]);
    expect(fitsDiscordEmbed(fits)).toBe(true);
    expect((await postedEmbed(fits)).description).toHaveLength(4096);
    expect(fitsDiscordEmbed(over)).toBe(false);
  });

  it('rejects a title over 256 characters or a button label over 80', () => {
    expect(fitsDiscordEmbed(card(['Approve?'], [approve], 'T'.repeat(256)))).toBe(true);
    expect(fitsDiscordEmbed(card(['Approve?'], [approve], 'T'.repeat(257)))).toBe(false);
    const longLabel = Actions([Button({ id: 'ncq:q:0', label: 'L'.repeat(81) })]);
    expect(fitsDiscordEmbed(card(['Approve?'], [longLabel]))).toBe(false);
  });

  it('rejects more than 5 rows of buttons', () => {
    // The adapter puts 5 buttons in a row.
    const options = (n: number) =>
      Actions(Array.from({ length: n }, (_, i) => Button({ id: `ncq:q:${i}`, label: `Option ${i}` })));
    expect(cardToDiscordPayload(card(['Pick one'], [options(26)])).components).toHaveLength(6);
    expect(fitsDiscordEmbed(card(['Pick one'], [options(25)]))).toBe(true);
    expect(fitsDiscordEmbed(card(['Pick one'], [options(26)]))).toBe(false);
  });
});

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

describe('Discord approval cards through the bridge', () => {
  let bridge: ChannelAdapter;
  const hasButtons = (post: (typeof posts)[number]) => (post.components?.length ?? 0) > 0;
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

  it('posts a long gateway card in full across parts, then a short card with the buttons', async () => {
    const { title, question } = longGatewayCard();
    expect(question.length).toBeGreaterThan(4096);
    await ask(title, question);

    const parts = posts.slice(0, -1);
    expect(parts.length).toBeGreaterThan(1);
    for (const post of posts) expect(post.embeds[0].description!.length).toBeLessThanOrEqual(4096);
    for (const part of parts) expect(hasButtons(part)).toBe(false);
    expect(hasButtons(posts.at(-1)!)).toBe(true);
    expect(posts.at(-1)!.embeds[0].description).toContain('appr-long-1');
    const shown = parts.map((part) => part.embeds[0].description).join('\n');
    for (let i = 0; i < 6; i++) expect(shown).toContain(`D${i}${'v'.repeat(596)}E${i}`);
    expect(shown).toContain('Approve once to allow this action.');
  });

  it('posts nothing when the request needs more parts than a card may have', async () => {
    await expect(ask('Approve', 'x'.repeat(100000))).rejects.toBeInstanceOf(CardTooLongError);
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
