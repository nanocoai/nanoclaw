/**
 * Integration test for the slack channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs slack.ts's
 * top-level `registerChannelAdapter('slack', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './slack.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * Importing the barrel is safe: registration is a pure top-level call, and slack.ts
 * builds the SDK adapter / bridge only inside its factory (invoked at host startup),
 * never at import. It does require the adapter package to be installed, which holds
 * in a composed install: the skill's `pnpm install` step runs before this test.
 *
 * Note on the Chat SDK family: slack.ts also consumes a load-bearing *core* API —
 * `createChatSdkBridge(...)` from ./chat-sdk-bridge.js — with a specific options
 * shape. That core-consumption is a typed call, so the build/typecheck leg
 * (`pnpm run build`) guards it against upstream drift, not this test. Every Chat SDK
 * channel (discord, telegram, teams, gchat, webex, …) follows this same shape:
 * swap the channel name below and the adapter package in the build.
 *
 * This file also covers resolveSlackConversation — the adapter-level
 * conversation classifier (direct / group_dm / channel) that consumers like
 * approval cards render from. It is a pure function over an injected
 * SlackAdapter, so it is driven here with mocks; no live API is touched.
 *
 * It also covers postSlackCollapsibleCard — the bridge's postCard override
 * that posts send_card specs with collapsible sections as Block Kit
 * containers — against a mocked Web API client.
 */
import type { SlackAdapter } from '@chat-adapter/slack';
import { describe, it, expect, vi } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import {
  buildCollapsibleCardBlocks,
  postSlackCollapsibleCard,
  resolveSlackConversation,
  type SlackCardPoster,
} from './slack.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('slack channel registration', () => {
  it('registers slack via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('slack');
  });
});

describe('resolveSlackConversation', () => {
  it('preserves direct messages, channel names, and the API-failure fallback', async () => {
    const fetchThread = vi
      .fn()
      .mockResolvedValueOnce({ channelName: 'general', metadata: { channel: {} } })
      .mockRejectedValueOnce(new Error('slack unavailable'));
    const adapter = { fetchThread } as unknown as SlackAdapter;

    await expect(resolveSlackConversation(adapter, 'slack:D123')).resolves.toEqual({
      type: 'direct',
      name: null,
    });
    expect(fetchThread).not.toHaveBeenCalled();
    await expect(resolveSlackConversation(adapter, 'C123')).resolves.toEqual({
      type: 'channel',
      name: 'general',
    });
    expect(fetchThread).toHaveBeenLastCalledWith('slack:C123');
    // API failure resolves null so the caller falls through to its generic rendering.
    await expect(resolveSlackConversation(adapter, 'slack:C456')).resolves.toBeNull();
  });

  it('carries no participant arrays on direct and channel results', async () => {
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({ channelName: 'general', metadata: { channel: {} } }),
    } as unknown as SlackAdapter;

    const direct = await resolveSlackConversation(adapter, 'slack:D123');
    expect(direct).not.toHaveProperty('participantNames');
    expect(direct).not.toHaveProperty('participantIds');
    const channel = await resolveSlackConversation(adapter, 'slack:C123');
    expect(channel).not.toHaveProperty('participantNames');
    expect(channel).not.toHaveProperty('participantIds');
  });

  it('resolves MPDM human participants and keeps the type when member lookup fails', async () => {
    const members = vi
      .fn()
      .mockResolvedValueOnce({ members: ['U1', 'U2', 'UBOT'] })
      .mockRejectedValueOnce(new Error('missing scope'));
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({
        channelName: 'mpdm-avital--omri--avi-1',
        metadata: { channel: { is_mpim: true } },
      }),
      webClient: { conversations: { members } },
      getUser: vi.fn(async (id: string) => ({
        userName: id === 'U1' ? 'Avital' : id === 'U2' ? 'Omri' : 'Avi',
        fullName: id,
        isBot: id === 'UBOT',
        userId: id,
      })),
    } as unknown as SlackAdapter;

    await expect(resolveSlackConversation(adapter, 'slack:G123')).resolves.toEqual({
      type: 'group_dm',
      name: null,
      participantNames: ['Avital', 'Omri'],
      participantIds: ['U1', 'U2'],
    });
    expect(members).toHaveBeenCalledWith({ channel: 'G123', limit: 100 });
    await expect(resolveSlackConversation(adapter, 'G123')).resolves.toEqual({
      type: 'group_dm',
      name: null,
    });
  });

  // participantIds must be raw Slack ids ("U…"), same length and same order
  // as participantNames, with bots removed from BOTH arrays. A consumer
  // pairing the arrays positionally (e.g. excluding one participant by id)
  // breaks silently on a one-sided filter, so the invariant is pinned here.
  it('keeps participantIds parallel to participantNames when bots are filtered', async () => {
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({ metadata: { channel: { is_mpim: true } } }),
      webClient: {
        conversations: {
          members: vi.fn().mockResolvedValue({ members: ['UBOT1', 'U1', 'UBOT2', 'U2', 'U3'] }),
        },
      },
      getUser: vi.fn(async (id: string) => ({
        userName: `name-${id}`,
        fullName: id,
        isBot: id.startsWith('UBOT'),
        userId: id,
      })),
    } as unknown as SlackAdapter;

    const resolved = await resolveSlackConversation(adapter, 'slack:G777');
    expect(resolved?.type).toBe('group_dm');
    expect(resolved?.participantNames).toEqual(['name-U1', 'name-U2', 'name-U3']);
    expect(resolved?.participantIds).toEqual(['U1', 'U2', 'U3']);
    expect(resolved?.participantIds).toHaveLength(resolved?.participantNames?.length ?? -1);
  });

  it('drops a participant whose profile lookup fails from BOTH arrays', async () => {
    const adapter = {
      fetchThread: vi.fn().mockResolvedValue({ metadata: { channel: { is_mpim: true } } }),
      webClient: {
        conversations: { members: vi.fn().mockResolvedValue({ members: ['U1', 'UGONE', 'U3'] }) },
      },
      // UGONE's profile lookup fails (deactivated user / users:read gap) —
      // getUser resolves null. The member must vanish from names AND ids
      // together, never from just one array.
      getUser: vi.fn(async (id: string) =>
        id === 'UGONE' ? null : { userName: `name-${id}`, fullName: id, isBot: false, userId: id },
      ),
    } as unknown as SlackAdapter;

    const resolved = await resolveSlackConversation(adapter, 'slack:G888');
    expect(resolved).toEqual({
      type: 'group_dm',
      name: null,
      participantNames: ['name-U1', 'name-U3'],
      participantIds: ['U1', 'U3'],
    });
  });
});

describe('postSlackCollapsibleCard', () => {
  function poster(postMessage: (args: Record<string, unknown>) => Promise<{ ts?: string }>) {
    return {
      decodeThreadId: (threadId: string) => {
        const [, channel, threadTs = ''] = threadId.split(':');
        return { channel, threadTs };
      },
      webClient: { chat: { postMessage: vi.fn(postMessage) } },
    };
  }

  it('returns undefined without calling Slack when no child is collapsible', async () => {
    const slack = poster(async () => ({ ts: '1.1' }));
    const card = { title: 'Report', children: ['plain', { text: 'more' }] };

    await expect(
      postSlackCollapsibleCard(slack as unknown as SlackCardPoster, 'slack:C1:1.2', card, 'Report'),
    ).resolves.toBeUndefined();
    expect(slack.webClient.chat.postMessage).not.toHaveBeenCalled();
  });

  it('posts header, sections, a collapsed container, and link buttons in spec order', async () => {
    const slack = poster(async () => ({ ts: '1700000000.000100' }));
    const card = {
      title: 'Build failed',
      description: 'main branch',
      children: ['Step 3 of 5', { collapsible: true, title: 'Stack trace', text: 'Error: boom' }, { text: 'Retry?' }],
      actions: [{ label: 'Logs', url: 'https://example.com/logs', style: 'primary' }, { label: 'Broken' }],
    };

    const id = await postSlackCollapsibleCard(
      slack as unknown as SlackCardPoster,
      'slack:C1:1.2',
      card,
      'Build failed fallback',
    );

    expect(id).toBe('1700000000.000100');
    const args = slack.webClient.chat.postMessage.mock.calls[0][0];
    expect(args).toMatchObject({ channel: 'C1', thread_ts: '1.2', text: 'Build failed fallback' });
    const blocks = args.blocks as Array<Record<string, unknown>>;
    expect(blocks.map((b) => b.type)).toEqual(['header', 'section', 'section', 'container', 'section', 'actions']);
    expect(blocks[3]).toEqual({
      type: 'container',
      title: { type: 'plain_text', text: 'Stack trace' },
      is_collapsible: true,
      default_collapsed: true,
      child_blocks: [{ type: 'section', text: { type: 'mrkdwn', text: 'Error: boom' } }],
    });
    const buttons = blocks[5].elements as Array<Record<string, unknown>>;
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toMatchObject({ type: 'button', url: 'https://example.com/logs', style: 'primary' });
  });

  it('posts top-level when the thread id carries no thread ts', async () => {
    const slack = poster(async () => ({ ts: '1.1' }));
    await postSlackCollapsibleCard(
      slack as unknown as SlackCardPoster,
      'slack:D1',
      { children: [{ collapsible: true, title: 'Details', text: 'x' }] },
      'x',
    );
    expect(slack.webClient.chat.postMessage.mock.calls[0][0].thread_ts).toBeUndefined();
  });

  it('returns undefined when the Slack API call fails', async () => {
    const slack = poster(async () => {
      throw new Error('invalid_blocks');
    });
    const card = { title: 'T', children: [{ collapsible: true, title: 'Trace', text: 'boom' }] };

    await expect(
      postSlackCollapsibleCard(slack as unknown as SlackCardPoster, 'slack:C1', card, 'T'),
    ).resolves.toBeUndefined();
    expect(slack.webClient.chat.postMessage).toHaveBeenCalledOnce();
  });
});

describe('buildCollapsibleCardBlocks', () => {
  it('clips the container title and splits long text at newlines within the child-block limit', () => {
    const line = 'x'.repeat(99);
    const text = Array.from({ length: 400 }, () => line).join('\n');
    const blocks = buildCollapsibleCardBlocks({
      children: [{ collapsible: true, title: 't'.repeat(200), text }],
    });

    const container = blocks?.[0] as { title: { text: string }; child_blocks: Array<{ text: { text: string } }> };
    expect(container.title.text).toHaveLength(150);
    expect(container.title.text.endsWith('…')).toBe(true);
    expect(container.child_blocks.length).toBeGreaterThan(1);
    expect(container.child_blocks.length).toBeLessThanOrEqual(10);
    for (const block of container.child_blocks) expect(block.text.text.length).toBeLessThanOrEqual(3000);
    expect(container.child_blocks[0].text.text.startsWith(line)).toBe(true);
    expect(container.child_blocks[0].text.text.endsWith(line)).toBe(true);
  });

  it('marks text beyond the child-block limit as truncated', () => {
    const blocks = buildCollapsibleCardBlocks({
      children: [{ collapsible: true, title: 'Log', text: 'y'.repeat(40_000) }],
    });
    const container = blocks?.[0] as { child_blocks: Array<{ text: { text: string } }> };
    expect(container.child_blocks).toHaveLength(10);
    expect(container.child_blocks[9].text.text.endsWith('…')).toBe(true);
  });

  it('falls back to a generic title and skips empty collapsible sections', () => {
    const blocks = buildCollapsibleCardBlocks({
      children: [
        { collapsible: true, title: '  ', text: 'body' },
        { collapsible: true, title: 'Empty', text: '' },
      ],
    });
    expect(blocks).toHaveLength(1);
    expect((blocks?.[0] as { title: { text: string } }).title.text).toBe('Details');
  });

  it('returns null when the card exceeds the per-message block limit', () => {
    const children = Array.from({ length: 26 }, (_, i) => [
      `line ${i}`,
      { collapsible: true, title: `s${i}`, text: 'x' },
    ]).flat();
    expect(buildCollapsibleCardBlocks({ children })).toBeNull();
  });
});
