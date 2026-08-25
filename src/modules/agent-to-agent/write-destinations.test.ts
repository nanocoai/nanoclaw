/**
 * Tests for reportUnreachableWiredChats.
 *
 * The failure class: an agent is wired to a chat but has no destination that
 * addresses it, so the replies it composes for that chat are dropped inside
 * the container and the turn is still acked. The container does log the drop,
 * but it reaches the host at `debug`, which a default `LOG_LEVEL=info` install
 * never prints.
 *
 * These pin the two properties that decide whether the report is worth
 * printing: it fires on the shapes that actually lose replies, and it stays
 * quiet on the shapes that never had a reply to lose. The unit under test is
 * the wiring-to-destination comparison — no session is involved, which is the
 * point: keying on any one session's `messaging_group_id` is what missed the
 * `agent-shared` case.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentDestination, MessagingGroup } from '../../types.js';

const { destinations, messagingGroups, wirings, agentGroups, logWarn } = vi.hoisted(() => ({
  destinations: new Map<string, AgentDestination[]>(),
  messagingGroups: new Map<string, MessagingGroup>(),
  wirings: new Map<string, string[]>(),
  agentGroups: new Map<string, { id: string; name: string }>(),
  logWarn: vi.fn(),
}));

vi.mock('./db/agent-destinations.js', () => ({
  getDestinations: async (agentGroupId: string) => destinations.get(agentGroupId) ?? [],
}));
vi.mock('../../db/messaging-groups.js', () => ({
  getMessagingGroup: async (id: string) => messagingGroups.get(id),
  getMessagingGroupsByAgentGroup: async (agentGroupId: string) =>
    (wirings.get(agentGroupId) ?? []).map((id) => messagingGroups.get(id)).filter(Boolean),
}));
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: async (id: string) => agentGroups.get(id),
}));
vi.mock('../../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: (...a: unknown[]) => logWarn(...a), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../../session-manager.js', () => ({
  withMailboxSession: async (_a: string, _s: string, fn: (db: unknown) => void) => fn({ replaceDestinations: vi.fn() }),
}));

import { reportUnreachableWiredChats } from './write-destinations.js';

function messagingGroup(id: string, overrides: Partial<MessagingGroup> = {}): MessagingGroup {
  return {
    id,
    channel_type: 'slack',
    platform_id: `platform-${id}`,
    instance: 'slack',
    name: id,
    is_group: 1,
    unknown_sender_policy: 'ignore',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  } as MessagingGroup;
}

function destinationRow(overrides: Partial<AgentDestination> = {}): AgentDestination {
  return {
    agent_group_id: 'ag-1',
    local_name: 'group',
    target_type: 'channel',
    target_id: 'mg-a',
    created_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

/**
 * The chats named by the single warn call, sorted. `getMessagingGroupsByAgentGroup`
 * is an unordered join, so only the set is a real guarantee.
 */
function reportedChatIds(): string[] {
  const [, data] = logWarn.mock.calls[0] as [string, { chats: Array<{ messagingGroupId: string }> }];
  return data.chats.map((c) => c.messagingGroupId).sort();
}

beforeEach(() => {
  destinations.clear();
  messagingGroups.clear();
  wirings.clear();
  agentGroups.clear();
  logWarn.mockClear();
  messagingGroups.set('mg-a', messagingGroup('mg-a'));
  messagingGroups.set('mg-b', messagingGroup('mg-b'));
  wirings.set('ag-1', ['mg-a']);
});

describe('reportUnreachableWiredChats', () => {
  it('reports a wired chat when the agent has no destinations at all', async () => {
    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).toHaveBeenCalledTimes(1);
    const [message] = logWarn.mock.calls[0] as [string];
    expect(message).toContain('no destination');
    expect(reportedChatIds()).toEqual(['mg-a']);
  });

  it('reports an uncovered chat when a sibling wiring is covered', async () => {
    // The shape a session-scoped check misses: under agent-shared one session
    // serves both chats while staying pinned to whichever created it, so the
    // covered chat would vouch for the uncovered one.
    wirings.set('ag-1', ['mg-a', 'mg-b']);
    destinations.set('ag-1', [destinationRow({ target_id: 'mg-a' })]);

    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(reportedChatIds()).toEqual(['mg-b']);
  });

  it('reports every uncovered chat in one call rather than one call each', async () => {
    wirings.set('ag-1', ['mg-a', 'mg-b']);

    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).toHaveBeenCalledTimes(1);
    expect(reportedChatIds()).toEqual(['mg-a', 'mg-b']);
  });

  it('reports a chat whose destination row points at a target that no longer resolves', async () => {
    destinations.set('ag-1', [destinationRow({ target_id: 'mg-deleted' })]);

    await reportUnreachableWiredChats('ag-1');

    expect(reportedChatIds()).toEqual(['mg-a']);
  });

  it('stays quiet when every wired chat has a destination', async () => {
    destinations.set('ag-1', [destinationRow({ target_id: 'mg-a' })]);

    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('accepts a destination on a sibling messaging group with the same address', async () => {
    // Migration 016 keyed uniqueness on `instance`, so two rows can name one
    // chat. Delivery resolves on (channel_type, platform_id), so either reaches
    // it — matching on messaging-group id would report a false failure here.
    messagingGroups.set('mg-a2', messagingGroup('mg-a2', { platform_id: 'platform-mg-a', instance: 'slack-2' }));
    destinations.set('ag-1', [destinationRow({ target_id: 'mg-a2' })]);

    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('still reports a chat carrying a stale denied_at, which the router ignores once wired', async () => {
    // `denied_at` only gates the router's no-wirings branch, and nothing clears
    // it when a wiring is later added — so skipping on it here would silence a
    // chat that does receive and does lose its replies.
    messagingGroups.set('mg-a', messagingGroup('mg-a', { denied_at: '2026-01-02T00:00:00.000Z' }));

    await reportUnreachableWiredChats('ag-1');

    expect(reportedChatIds()).toEqual(['mg-a']);
  });

  it('skips a detached chat', async () => {
    messagingGroups.set('mg-a', messagingGroup('mg-a', { detached_at: '2026-01-02T00:00:00.000Z' }));

    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('stays quiet for an agent with no wirings', async () => {
    wirings.set('ag-1', []);

    await reportUnreachableWiredChats('ag-1');

    expect(logWarn).not.toHaveBeenCalled();
  });

  it('uses a caller-supplied projection instead of resolving again', async () => {
    // The wake path hands over what it just wrote; the central rows are stale
    // here only to prove the argument is what gets used.
    destinations.set('ag-1', [destinationRow({ target_id: 'mg-a' })]);

    await reportUnreachableWiredChats('ag-1', []);

    expect(reportedChatIds()).toEqual(['mg-a']);
  });

  it('does not accept an agent-to-agent destination as covering a wired chat', async () => {
    agentGroups.set('ag-peer', { id: 'ag-peer', name: 'Peer' });
    destinations.set('ag-1', [destinationRow({ local_name: 'peer', target_type: 'agent', target_id: 'ag-peer' })]);

    await reportUnreachableWiredChats('ag-1');

    expect(reportedChatIds()).toEqual(['mg-a']);
  });
});
