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
 */
import type { SlackAdapter } from '@chat-adapter/slack';
import { describe, it, expect, vi } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import { resolveSlackConversation } from './slack.js';
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
