/**
 * Discord card limit against the real @chat-adapter/discord: only fetch is
 * stubbed, so the test sees the exact embed the adapter posts. Discord rejects
 * an embed description over 4,096.
 */
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

import { gatewayApprovalPresentation } from '../gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from '../gateway-providers/gateway-provider-registry.js';
import { CardTooLongError } from './ask-question.js';
import { escapeDiscordCardText } from './discord.js';

const posts: Array<{ embeds: Array<{ title?: string; description?: string }>; components?: unknown[] }> = [];
const patches: Array<{ url: string; body: Record<string, unknown> }> = [];

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

  // One plain character, not one more pipe: a pipe adds two and would skip 4,001.
  it('refuses a card one character longer and posts nothing', async () => {
    await expect(ask('Approve', '|'.repeat(1996) + 'x')).rejects.toBeInstanceOf(CardTooLongError);
    expect(posts).toHaveLength(0);
  });

  it('refuses a long gateway card instead of cutting it', async () => {
    const { title, question } = longGatewayCard();
    await expect(ask(title, question)).rejects.toBeInstanceOf(CardTooLongError);
    expect(posts).toHaveLength(0);
  });
});

describe('escapeDiscordCardText', () => {
  it('keeps copyable shell code and lone pipes byte-for-byte', () => {
    for (const fence of ['`', '``', '```']) {
      const code = fence + '\ncat <input | sed "s/](//"\n' + fence;
      expect(escapeDiscordCardText(code)).toBe(code);
    }
    expect(escapeDiscordCardText('cat input | sort')).toBe('cat input | sort');
    expect(escapeDiscordCardText('\\`<@1>\\`')).toContain('<\u2060@1>');
  });

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
});

describe('parent Discord resolved-card size budget', () => {
  it.each([
    ['request', true],
    ['q'.repeat(3987), false],
  ] as const)('keeps request text only when the full edit fits', async (question, keepsRequest) => {
    const bridge = (await registrations.get('discord')!.factory())!;
    const resolution = 'Approved by ' + 'n'.repeat(100);
    await bridge.deliver('discord:g1:c1', null, {
      kind: 'chat-sdk',
      content: {
        operation: 'edit',
        messageId: 'card',
        terminalCard: { title: 'Review', question, resolution },
      },
    });
    expect(patches).toHaveLength(1);
    const embed = (patches[0].body.embeds as Array<{ description: string }>)[0];
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.description).toContain(resolution);
    expect(embed.description.includes(question)).toBe(keepsRequest);
  });
  it('refuses a decision that cannot fit even without the request', async () => {
    const bridge = (await registrations.get('discord')!.factory())!;
    await expect(
      bridge.deliver('discord:g1:c1', null, {
        kind: 'chat-sdk',
        content: {
          operation: 'edit',
          messageId: 'card',
          terminalCard: { title: 'Review', question: 'Allow?', resolution: 'n'.repeat(4200) },
        },
      }),
    ).rejects.toBeInstanceOf(CardTooLongError);
    expect(patches).toHaveLength(0);
  });
});

describe('Discord prose that CommonMark treats as code', () => {
  it.each(['    ', '~~~\n', '```\n'])('escapes active syntax after %j', (prefix) => {
    const result = escapeDiscordCardText(prefix + '[Admin](https://evil.test) <@1> ||hidden||');
    expect(result).toContain(']\u2060(');
    expect(result).toContain('<\u2060@1>');
    expect(result).not.toContain('||');
  });
  it('escapes tilde-fenced text even with a closing fence', () => {
    expect(escapeDiscordCardText('~~~\n<@1>\n~~~')).toContain('<\u2060@1>');
  });
  // Discord ends the block at the inner ```, or pairs a stray ``` with the fence.
  it.each([
    '```\nx ``` [Admin](https://evil.test) <@1> ||hidden||\n```',
    '````\n```\n[Admin](https://evil.test) <@1> ||hidden||\n```\n````',
    'x ``` y\n```\n[Admin](https://evil.test) <@1> ||hidden||\n```',
  ])('escapes text Discord shows as prose in %j', (text) => {
    const result = escapeDiscordCardText(text);
    expect(result).toContain(']\u2060(');
    expect(result).toContain('<\u2060@1>');
    expect(result).not.toContain('||');
  });
  it('keeps a ``` fence with single backticks inside byte-for-byte', () => {
    const code = '```sh\ncat <input; echo `date` ``x``\n```';
    expect(escapeDiscordCardText(code)).toBe(code);
  });
});
