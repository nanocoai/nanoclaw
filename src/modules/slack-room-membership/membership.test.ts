/**
 * Unit tests for the slack-room-membership handler (generic membership-seam
 * consumer).
 *
 * Every collaborator is mocked at its import seam: the slack-lib Web API
 * client, the vendored env-file reader, channel-approval / sender-approval /
 * router / session-manager / destination projection, and — because this
 * channels-based branch predates the trunk hooks this module composes with
 * (instance-aware messaging-group lookup, migration 021 detached_at
 * accessors, decline_notify, the card interceptor) — the central-DB accessor
 * modules themselves, replaced by in-memory fakes that mirror the composed
 * trunk accessors' semantics. The release-branch suite ran the same cases
 * against a real in-memory DB; that composed run is re-established once the
 * trunk hooks forward-merge into this branch. Every test drives
 * handleSlackMembershipEvent with joinRecheckDelayMs: 0.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockApi,
  mockEnv,
  mockRequestChannelApproval,
  mockWriteSessionMessage,
  mockProject,
  mockRouteInbound,
  mockDeclineAndNotify,
  mockRecordDropped,
  fakeDb,
} = vi.hoisted(() => {
  const mockApi = {
    slackAuthTest: vi.fn(),
    slackConversationsInfo: vi.fn(),
    slackConversationsMembers: vi.fn(),
    slackPostMessage: vi.fn().mockResolvedValue(undefined),
  };
  const mockEnv = {
    readEnvValue: vi.fn(),
    appendToEnvList: vi.fn().mockReturnValue(true),
  };

  // ── In-memory central-DB fake ──
  // Semantics mirror the composed trunk accessors: createMessagingGroup
  // defaults `instance` to channel_type; the three-arg
  // getMessagingGroupByPlatform is exact-only on a set instance and resolves
  // default-instance-first (then lexically-first named instance) when unset;
  // detached_at is a nullable stamp with set/is accessors (migration 021).
  /* eslint-disable @typescript-eslint/no-explicit-any */
  const state = {
    messagingGroups: [] as any[],
    wirings: [] as any[],
    agentGroups: [] as any[],
    sessions: [] as any[],
    roles: [] as any[],
  };
  const fakeDb = {
    reset(): void {
      state.messagingGroups = [];
      state.wirings = [];
      state.agentGroups = [];
      state.sessions = [];
      state.roles = [];
    },
    // messaging-groups
    createMessagingGroup(group: any): void {
      state.messagingGroups.push({
        denied_at: null,
        detached_at: null,
        ...group,
        instance: group.instance ?? group.channel_type,
      });
    },
    getMessagingGroup(id: string): any {
      return state.messagingGroups.find((m) => m.id === id);
    },
    getMessagingGroupByPlatform(channelType: string, platformId: string, instance?: string): any {
      const hits = state.messagingGroups.filter((m) => m.channel_type === channelType && m.platform_id === platformId);
      if (instance !== undefined) return hits.find((m) => m.instance === instance);
      return hits.sort(
        (a, b) =>
          Number(b.instance === b.channel_type) - Number(a.instance === a.channel_type) ||
          String(a.instance).localeCompare(String(b.instance)),
      )[0];
    },
    getAllMessagingGroups(): any[] {
      return [...state.messagingGroups];
    },
    updateMessagingGroup(id: string, patch: Record<string, unknown>): void {
      const row = state.messagingGroups.find((m) => m.id === id);
      if (row) Object.assign(row, patch);
    },
    setMessagingGroupDeniedAt(id: string, deniedAt: string | null): void {
      const row = state.messagingGroups.find((m) => m.id === id);
      if (row) row.denied_at = deniedAt;
    },
    setMessagingGroupDetachedAt(id: string, detachedAt: string | null): void {
      const row = state.messagingGroups.find((m) => m.id === id);
      if (row) row.detached_at = detachedAt;
    },
    isMessagingGroupDetached(id: string): boolean {
      return state.messagingGroups.find((m) => m.id === id)?.detached_at != null;
    },
    createMessagingGroupAgent(mga: any): void {
      state.wirings.push({ threads: mga.threads ?? null, ...mga });
    },
    getMessagingGroupAgents(messagingGroupId: string): any[] {
      return state.wirings.filter((w) => w.messaging_group_id === messagingGroupId);
    },
    getMessagingGroupAgentByPair(messagingGroupId: string, agentGroupId: string): any {
      return state.wirings.find((w) => w.messaging_group_id === messagingGroupId && w.agent_group_id === agentGroupId);
    },
    // agent-groups
    createAgentGroup(group: any): void {
      state.agentGroups.push(group);
    },
    getAgentGroup(id: string): any {
      return state.agentGroups.find((g) => g.id === id);
    },
    // sessions
    createSession(session: any): void {
      state.sessions.push(session);
    },
    getSessionsByAgentGroup(agentGroupId: string): any[] {
      return state.sessions.filter((s) => s.agent_group_id === agentGroupId);
    },
    // user-roles
    grantRole(row: any): void {
      state.roles.push(row);
    },
    getOwners(): any[] {
      return state.roles.filter((r) => r.role === 'owner');
    },
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */

  return {
    mockApi,
    mockEnv,
    mockRequestChannelApproval: vi.fn().mockResolvedValue(undefined),
    mockWriteSessionMessage: vi.fn(),
    mockProject: vi.fn().mockResolvedValue(undefined),
    mockRouteInbound: vi.fn().mockResolvedValue(undefined),
    mockDeclineAndNotify: vi.fn().mockResolvedValue(undefined),
    mockRecordDropped: vi.fn(),
    fakeDb,
  };
});

vi.mock('../../channels/slack-lib.js', async (importOriginal) => ({
  // botTokenKeyForInstance (and SlackApiError) stay real — only the four
  // network-touching calls are mocked. Tests never hit the Slack API.
  ...(await importOriginal<Record<string, unknown>>()),
  ...mockApi,
}));
vi.mock('./env-file.js', () => mockEnv);
vi.mock('../permissions/channel-approval.js', () => ({
  requestChannelApproval: (...a: unknown[]) => mockRequestChannelApproval(...a),
}));
vi.mock('../permissions/sender-approval.js', () => ({
  declineAndNotify: (...a: unknown[]) => mockDeclineAndNotify(...a),
}));
vi.mock('../../router.js', () => ({
  routeInbound: (...a: unknown[]) => mockRouteInbound(...a),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockWriteSessionMessage(...a),
}));
vi.mock('../../cli/resources/destinations.js', () => ({
  projectDestinationsToSessions: (...a: unknown[]) => mockProject(...a),
}));
// Mirrors the release suite's registered TEST_SLACK_DEFAULTS declaration
// (group: request_approval, dm: strict) without the channel registry.
vi.mock('../../channels/channel-defaults.js', () => ({
  resolveUnknownSenderPolicy: (_instance: string, isGroup: boolean) => (isGroup ? 'request_approval' : 'strict'),
}));
vi.mock('../../db/dropped-messages.js', () => ({
  recordDroppedMessage: (...a: unknown[]) => mockRecordDropped(...a),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  createMessagingGroup: fakeDb.createMessagingGroup,
  getMessagingGroup: fakeDb.getMessagingGroup,
  getMessagingGroupByPlatform: fakeDb.getMessagingGroupByPlatform,
  getAllMessagingGroups: fakeDb.getAllMessagingGroups,
  updateMessagingGroup: fakeDb.updateMessagingGroup,
  setMessagingGroupDeniedAt: fakeDb.setMessagingGroupDeniedAt,
  setMessagingGroupDetachedAt: fakeDb.setMessagingGroupDetachedAt,
  isMessagingGroupDetached: fakeDb.isMessagingGroupDetached,
  createMessagingGroupAgent: fakeDb.createMessagingGroupAgent,
  getMessagingGroupAgents: fakeDb.getMessagingGroupAgents,
  getMessagingGroupAgentByPair: fakeDb.getMessagingGroupAgentByPair,
}));
vi.mock('../../db/agent-groups.js', () => ({
  createAgentGroup: fakeDb.createAgentGroup,
  getAgentGroup: fakeDb.getAgentGroup,
}));
vi.mock('../../db/sessions.js', () => ({
  createSession: fakeDb.createSession,
  getSessionsByAgentGroup: fakeDb.getSessionsByAgentGroup,
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  grantRole: fakeDb.grantRole,
  getOwners: fakeDb.getOwners,
}));

import { createAgentGroup } from '../../db/agent-groups.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getAllMessagingGroups,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  isMessagingGroupDetached,
  setMessagingGroupDeniedAt,
  setMessagingGroupDetachedAt,
} from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { InboundEvent } from '../../channels/adapter.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import {
  clearOwnBotIdCache,
  handleSlackMembershipEvent,
  slackChannelCardInterceptor,
  type MembershipEvent,
} from './membership.js';

const OWN_BOT = 'U0OWNBOT';
const PIXEL_BOT = 'U0PIXELBOT';
const OPERATOR = 'U0OPERATOR';

const now = () => new Date().toISOString();

async function mg(
  partial: Partial<MessagingGroup> & Pick<MessagingGroup, 'id' | 'platform_id'>,
): Promise<MessagingGroup> {
  const row: MessagingGroup = {
    channel_type: 'slack',
    instance: 'slack',
    name: null,
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: now(),
    ...partial,
  };
  await createMessagingGroup(row);
  return row;
}

async function wire(
  mgId: string,
  agentGroupId: string,
  partial: Partial<MessagingGroupAgent> = {},
): Promise<MessagingGroupAgent> {
  const row: MessagingGroupAgent = {
    id: `mga-${mgId}-${agentGroupId}`,
    messaging_group_id: mgId,
    agent_group_id: agentGroupId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
    ...partial,
  };
  await createMessagingGroupAgent(row);
  return row;
}

async function session(id: string, agentGroupId: string, messagingGroupId: string | null): Promise<Session> {
  const s: Session = {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: messagingGroupId,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
  await createSession(s);
  return s;
}

function joinEvent(partial: Partial<MembershipEvent> = {}): MembershipEvent {
  return {
    instance: 'slack',
    channelType: 'slack',
    channelId: 'C0NEW',
    userId: OWN_BOT,
    ...partial,
  };
}

async function handle(event: MembershipEvent): Promise<void> {
  await handleSlackMembershipEvent(event, { joinRecheckDelayMs: 0, rootDir: '/fake-root' });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearOwnBotIdCache();
  fakeDb.reset();
  await createAgentGroup({ id: 'ag-andy', name: 'Andy', folder: 'andy', agent_provider: null, created_at: now() });
  await createAgentGroup({ id: 'ag-pixel', name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: now() });

  // Token table: default instance + pixel sibling. auth.test maps token → bot id.
  mockEnv.readEnvValue.mockImplementation((_root: string, key: string) => {
    if (key === 'SLACK_BOT_TOKEN') return 'xoxb-own';
    if (key === 'SLACK_BOT_TOKEN_PIXEL') return 'xoxb-pixel';
    if (key === 'SLACK_A2A_ROOMS') return '';
    return undefined;
  });
  mockApi.slackAuthTest.mockImplementation(async (token: string) => ({
    userId: token === 'xoxb-own' ? OWN_BOT : PIXEL_BOT,
  }));
  mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false });
  mockApi.slackConversationsMembers.mockResolvedValue([]);
});

describe('own-bot join — adopt flow (case 1)', () => {
  it('unknown channel: creates the mg row (router shape) and fires the approval card with a synthesized greeting', async () => {
    await handle(joinEvent({ inviterId: OPERATOR }));

    const created = await getMessagingGroupByPlatform('slack', 'slack:C0NEW', 'slack');
    expect(created).toMatchObject({
      channel_type: 'slack',
      is_group: 1,
      unknown_sender_policy: 'request_approval', // group context of the declared defaults
      name: null,
    });

    expect(mockRequestChannelApproval).toHaveBeenCalledTimes(1);
    const input = mockRequestChannelApproval.mock.calls[0]![0] as {
      messagingGroupId: string;
      event: {
        channelType: string;
        instance: string;
        platformId: string;
        message: { isMention?: boolean; isGroup?: boolean; kind: string; content: string };
      };
    };
    expect(input.messagingGroupId).toBe(created!.id);
    expect(input.event).toMatchObject({ channelType: 'slack', instance: 'slack', platformId: 'slack:C0NEW' });
    // Replayable greeting: routes like a mention, carries invited-by context.
    expect(input.event.message.isMention).toBe(true);
    expect(input.event.message.isGroup).toBe(true);
    const content = JSON.parse(input.event.message.content) as Record<string, unknown>;
    expect(content.text).toContain(`<@${OPERATOR}> invited the bot`);
    expect(content.senderId).toBe(OPERATOR);
  });

  it.each([
    ['slack:C0NEW:', 'C0NEW'],
    ['slack:G0NEW:', 'G0NEW'],
    ['slack:C0NEW:1724264405.531769', 'C0NEW'],
  ])('normalizes encoded channel id %s and reuses the router-created messaging group', async (encoded, raw) => {
    const existing = await mg({
      id: `mg-router-${raw}`,
      platform_id: `slack:${raw}`,
      unknown_sender_policy: 'request_approval',
    });

    await handle(joinEvent({ channelId: encoded, inviterId: OPERATOR }));

    expect(await getAllMessagingGroups()).toHaveLength(1);
    expect(mockApi.slackConversationsInfo).toHaveBeenCalledWith('xoxb-own', raw, 'membership');
    expect(mockRequestChannelApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestChannelApproval).toHaveBeenCalledWith({
      messagingGroupId: existing.id,
      event: expect.objectContaining({ platformId: `slack:${raw}`, threadId: null }),
    });
  });

  it('SAF-004 regression: encoded channel id with NO pre-existing row creates exactly one canonical row', async () => {
    // The literal launch-blocking shape: bot invited before any message ever
    // routed, so no router-created row exists. The encoded id must collapse
    // to the raw channel id BEFORE the row is created — the pre-fix code
    // persisted a malformed `slack:slack:C0NEW:` row here.
    await handle(joinEvent({ channelId: 'slack:C0NEW:', inviterId: OPERATOR }));

    const all = await getAllMessagingGroups();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ channel_type: 'slack', platform_id: 'slack:C0NEW', instance: 'slack' });
    expect(await getMessagingGroupByPlatform('slack', 'slack:slack:C0NEW:', 'slack')).toBeUndefined();
    expect(mockRequestChannelApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestChannelApproval).toHaveBeenCalledWith({
      messagingGroupId: all[0]!.id,
      event: expect.objectContaining({ platformId: 'slack:C0NEW' }),
    });
  });

  it('rejects a double-prefixed channel id instead of persisting dead wiring', async () => {
    await handle(joinEvent({ channelId: 'slack:slack:C0NEW:' }));

    expect(await getAllMessagingGroups()).toHaveLength(0);
    expect(mockApi.slackAuthTest).not.toHaveBeenCalled();
    expect(mockApi.slackConversationsInfo).not.toHaveBeenCalled();
    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
  });

  it('Slackbot-created shadow channel (canvas container): ignored — no mg row, no card', async () => {
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, name: 'Untitled', creator: 'USLACKBOT' });

    await handle(joinEvent({}));

    expect(await getMessagingGroupByPlatform('slack', 'slack:C0NEW', 'slack')).toBeUndefined();
    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
  });

  it('denied tombstone holds: no card, no new rows', async () => {
    const denied = await mg({ id: 'mg-denied', platform_id: 'slack:C0NEW', unknown_sender_policy: 'request_approval' });
    await setMessagingGroupDeniedAt(denied.id, now());

    await handle(joinEvent({ inviterId: OPERATOR }));

    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
    expect(await getAllMessagingGroups()).toHaveLength(1);
  });

  it('already-wired channel: silent, and a rejoin clears detached_at', async () => {
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0NEW' });
    await wire(room.id, 'ag-andy');
    await setMessagingGroupDetachedAt(room.id, now());

    await handle(joinEvent());

    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
    expect(await isMessagingGroupDetached(room.id)).toBe(false);
  });

  it('no bot token for the instance: treated as a foreign member, no adopt', async () => {
    mockEnv.readEnvValue.mockReturnValue(undefined);

    await handle(joinEvent());

    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
    expect(await getAllMessagingGroups()).toHaveLength(0);
  });
});

describe('own-bot join — MPIM-fork carry-over (case 2)', () => {
  async function seedOldRoom(): Promise<{ oldDefault: MessagingGroup; oldPixel: MessagingGroup }> {
    // Old wired room G0OLD, two instances (default + pixel sibling).
    const oldDefault = await mg({ id: 'mg-old-slack', platform_id: 'slack:G0OLD', name: 'Pixel room' });
    const oldPixel = await mg({
      id: 'mg-old-pixel',
      platform_id: 'slack:G0OLD',
      instance: 'slack-pixel',
      name: 'Pixel room',
    });
    await wire(oldDefault.id, 'ag-andy', {
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
      threads: 1,
    });
    await wire(oldPixel.id, 'ag-pixel', { engage_mode: 'mention', ignored_message_policy: 'accumulate' });
    return { oldDefault, oldPixel };
  }

  beforeEach(() => {
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: true });
    mockApi.slackConversationsMembers.mockImplementation(async (_token: string, channelId: string) => {
      if (channelId === 'G0OLD') return [OPERATOR, OWN_BOT, PIXEL_BOT];
      if (channelId === 'G0NEW') return [OPERATOR, OWN_BOT, PIXEL_BOT, 'U0NEWHUMAN'];
      return [];
    });
  });

  it('superset MPIM: mirrors every instance row + wiring, carries the allowlist, posts the moved note, no card', async () => {
    await seedOldRoom();
    mockEnv.readEnvValue.mockImplementation((_root: string, key: string) => {
      if (key === 'SLACK_BOT_TOKEN') return 'xoxb-own';
      if (key === 'SLACK_BOT_TOKEN_PIXEL') return 'xoxb-pixel';
      if (key === 'SLACK_A2A_ROOMS') return 'G0OLD';
      return undefined;
    });

    await handle(joinEvent({ channelId: 'G0NEW' }));

    // No approval card — carry-over replaced it.
    expect(mockRequestChannelApproval).not.toHaveBeenCalled();

    // Mirrored rows for BOTH instances, same agent groups, same engage values.
    const newDefault = await getMessagingGroupByPlatform('slack', 'slack:G0NEW', 'slack');
    const newPixel = await getMessagingGroupByPlatform('slack', 'slack:G0NEW', 'slack-pixel');
    expect(newDefault).toMatchObject({ is_group: 1, unknown_sender_policy: 'public', name: 'Pixel room' });
    expect(newPixel).toMatchObject({ is_group: 1, unknown_sender_policy: 'public', name: 'Pixel room' });
    expect(await getMessagingGroupAgentByPair(newDefault!.id, 'ag-andy')).toMatchObject({
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
      threads: 1,
    });
    expect(await getMessagingGroupAgentByPair(newPixel!.id, 'ag-pixel')).toMatchObject({
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
    });

    // Old room untouched.
    expect(await getMessagingGroupAgents('mg-old-slack')).toHaveLength(1);
    expect((await getMessagingGroup('mg-old-slack'))!.denied_at ?? null).toBeNull();

    // Allowlist carried, destinations projected, note posted as the bot.
    expect(mockEnv.appendToEnvList).toHaveBeenCalledWith('/fake-root', 'SLACK_A2A_ROOMS', 'G0NEW');
    expect(mockProject).toHaveBeenCalledWith('ag-andy');
    expect(mockProject).toHaveBeenCalledWith('ag-pixel');
    expect(mockApi.slackPostMessage).toHaveBeenCalledWith('xoxb-own', 'G0NEW', expect.stringContaining('Room moved'));
  });

  it('old room not allowlisted: wiring carries over but SLACK_A2A_ROOMS is untouched', async () => {
    await seedOldRoom();

    await handle(joinEvent({ channelId: 'G0NEW' }));

    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
    expect(mockEnv.appendToEnvList).not.toHaveBeenCalled();
  });

  it('non-superset member set: falls through to the adopt card', async () => {
    await seedOldRoom();
    mockApi.slackConversationsMembers.mockImplementation(async (_token: string, channelId: string) => {
      if (channelId === 'G0OLD') return [OPERATOR, OWN_BOT, PIXEL_BOT];
      if (channelId === 'G0NEW') return [OPERATOR, OWN_BOT, 'U0STRANGER']; // pixel bot missing
      return [];
    });

    await handle(joinEvent({ channelId: 'G0NEW' }));

    expect(mockRequestChannelApproval).toHaveBeenCalledTimes(1);
    expect(await getMessagingGroupByPlatform('slack', 'slack:G0NEW', 'slack-pixel')).toBeUndefined();
  });

  it('non-MPIM channel: no fork check, straight to the adopt card', async () => {
    await seedOldRoom();
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false });

    await handle(joinEvent({ channelId: 'C0CHANNEL' }));

    expect(mockApi.slackConversationsMembers).not.toHaveBeenCalled();
    expect(mockRequestChannelApproval).toHaveBeenCalledTimes(1);
  });
});

describe('own-bot left (case 3)', () => {
  it('wired channel: marks the mg detached', async () => {
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0NEW' });
    await wire(room.id, 'ag-andy');

    await handle(joinEvent({ left: true }));

    expect(await isMessagingGroupDetached(room.id)).toBe(true);
  });

  it('unknown channel: no-op', async () => {
    await handle(joinEvent({ left: true }));
    expect(await getAllMessagingGroups()).toHaveLength(0);
  });
});

describe('non-bot membership change in a wired room (case 4)', () => {
  it('human joined: system-sender note (trigger 0, channel_type agent) into every wired room session', async () => {
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0NEW' });
    const elsewhere = await mg({ id: 'mg-elsewhere', platform_id: 'slack:D0DM', is_group: 0 });
    await wire(room.id, 'ag-andy');
    await wire(room.id, 'ag-pixel');
    await session('sess-andy-room', 'ag-andy', room.id);
    await session('sess-andy-dm', 'ag-andy', elsewhere.id); // different mg — no note
    await session('sess-pixel-room', 'ag-pixel', room.id);

    await handle(joinEvent({ userId: 'U0NEWHUMAN', inviterId: OPERATOR }));

    expect(mockRequestChannelApproval).not.toHaveBeenCalled();
    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(2);
    const targets = mockWriteSessionMessage.mock.calls.map((c) => [c[0], c[1]]);
    expect(targets).toContainEqual(['ag-andy', 'sess-andy-room']);
    expect(targets).toContainEqual(['ag-pixel', 'sess-pixel-room']);
    const msg = mockWriteSessionMessage.mock.calls[0]![2] as {
      kind: string;
      channelType: string;
      trigger: boolean;
      content: string;
    };
    // kind 'chat' + sender 'system' (container-restart's system-note shape):
    // the container poll loop filters kind 'system' rows out of agent batches.
    expect(msg).toMatchObject({ kind: 'chat', channelType: 'agent', trigger: false });
    const content = JSON.parse(msg.content) as { text: string; sender: string };
    expect(content.sender).toBe('system');
    expect(content.text).toContain('<@U0NEWHUMAN> joined this room');
    expect(content.text).toContain(`invited by <@${OPERATOR}>`);
  });

  it('foreign bot left: note says left, no inviter clause', async () => {
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0NEW' });
    await wire(room.id, 'ag-andy');
    await session('sess-andy-room', 'ag-andy', room.id);

    await handle(joinEvent({ userId: PIXEL_BOT, left: true }));

    expect(mockWriteSessionMessage).toHaveBeenCalledTimes(1);
    const content = JSON.parse((mockWriteSessionMessage.mock.calls[0]![2] as { content: string }).content) as {
      text: string;
    };
    expect(content.text).toContain(`<@${PIXEL_BOT}> left this room`);
    expect(content.text).not.toContain('invited by');
  });

  it('unwired or unknown channel: no notes', async () => {
    await handle(joinEvent({ userId: 'U0NEWHUMAN' }));
    expect(mockWriteSessionMessage).not.toHaveBeenCalled();
  });
});

describe('slack channel-card interceptor — owner-presence rule (B2/D24)', () => {
  function mentionEvent(
    platformId: string,
    partial: { isGroup?: boolean; senderId?: string; senderName?: string } = {},
  ): InboundEvent {
    return {
      channelType: 'slack',
      instance: 'slack',
      platformId,
      threadId: null,
      message: {
        id: `msg-${Math.random().toString(36).slice(2, 8)}`,
        kind: 'chat',
        timestamp: now(),
        isMention: true,
        isGroup: partial.isGroup ?? true,
        content: JSON.stringify({
          text: '@bot hello',
          senderId: partial.senderId ?? 'U0SOMEONE',
          senderName: partial.senderName ?? 'Someone',
        }),
      },
    };
  }

  /** Owner identity + the instance's DM wiring (what every per-agent
   *  instance has) — the two facts the interceptor resolves against. */
  async function seedOwnerAndInstanceDm(): Promise<void> {
    await grantRole({
      user_id: `slack:${OPERATOR}`,
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    const dm = await mg({ id: 'mg-dm-andy', platform_id: 'slack:D0ANDY', is_group: 0 });
    await wire(dm.id, 'ag-andy');
  }

  async function intercept(row: MessagingGroup, event: InboundEvent): Promise<'card' | 'handled'> {
    return slackChannelCardInterceptor(row, event, { rootDir: '/fake-root' });
  }

  it('owner present in the channel: auto-wires mention/accumulate, flips mg to public, replays — no card', async () => {
    await seedOwnerAndInstanceDm();
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: true, creator: OPERATOR });
    mockApi.slackConversationsMembers.mockResolvedValue([OPERATOR, OWN_BOT, 'U0STRANGER']);

    const event = mentionEvent('slack:C0ROOM');
    expect(await intercept(room, event)).toBe('handled');

    expect(await getMessagingGroup(room.id)).toMatchObject({ unknown_sender_policy: 'public' });
    expect(await getMessagingGroupAgentByPair(room.id, 'ag-andy')).toMatchObject({
      engage_mode: 'mention',
      ignored_message_policy: 'accumulate',
      sender_scope: 'all',
    });
    expect(mockProject).toHaveBeenCalledWith('ag-andy');
    expect(mockRouteInbound).toHaveBeenCalledTimes(1);
    expect(mockRouteInbound).toHaveBeenCalledWith(event);
    expect(mockDeclineAndNotify).not.toHaveBeenCalled();
  });

  it('owner absent in a channel: declines in-channel and FYIs the owner — no card, no wiring', async () => {
    await seedOwnerAndInstanceDm();
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, name: 'dogfood', creator: 'U0STRANGER' });
    mockApi.slackConversationsMembers.mockResolvedValue([OWN_BOT, 'U0STRANGER']);

    expect(await intercept(room, mentionEvent('slack:C0ROOM', { senderId: 'U0STRANGER', senderName: 'Dana' }))).toBe(
      'handled',
    );

    expect(mockDeclineAndNotify).toHaveBeenCalledTimes(1);
    const [call] = mockDeclineAndNotify.mock.calls[0] as [Record<string, unknown>];
    expect(call.messagingGroupId).toBe('mg-room');
    // Deduped per channel, not per sender: a second person mentioning the bot
    // in the same channel must not produce a second post.
    expect(call.dedupeKey).toBe('channel:requires-owner');
    expect(call.declineText).toContain('only be connected to a channel by my owner');
    expect(call.declineText).toContain('remove me from this channel');
    expect(call.fyiText).toContain('Dana');
    expect(call.fyiText).toContain('#dogfood');
    // Not a card, and nothing was wired or routed.
    expect(await getMessagingGroupAgents(room.id)).toHaveLength(0);
    expect(await getMessagingGroup(room.id)).toMatchObject({ unknown_sender_policy: 'request_approval' });
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('owner absent in an MPIM: still cards — a group DM invite stays an ask', async () => {
    await seedOwnerAndInstanceDm();
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: true, creator: 'U0STRANGER' });
    mockApi.slackConversationsMembers.mockResolvedValue([OWN_BOT, 'U0STRANGER']);

    expect(await intercept(room, mentionEvent('slack:C0ROOM'))).toBe('card');

    expect(mockDeclineAndNotify).not.toHaveBeenCalled();
    expect(await getMessagingGroupAgents(room.id)).toHaveLength(0);
    expect(await getMessagingGroup(room.id)).toMatchObject({ unknown_sender_policy: 'request_approval' });
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('owner absent but the conversation could not be classified: cards rather than guessing', async () => {
    await seedOwnerAndInstanceDm();
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });
    mockApi.slackConversationsInfo.mockRejectedValue(new Error('ratelimited'));
    mockApi.slackConversationsMembers.mockResolvedValue([OWN_BOT, 'U0STRANGER']);

    expect(await intercept(room, mentionEvent('slack:C0ROOM'))).toBe('card');
    expect(mockDeclineAndNotify).not.toHaveBeenCalled();
  });

  it('owner present but instance→agent-group resolution ambiguous: card', async () => {
    await seedOwnerAndInstanceDm();
    // A second DM wiring on the same instance to a different agent group.
    const dm2 = await mg({ id: 'mg-dm-pixel', platform_id: 'slack:D0PIXEL', is_group: 0 });
    await wire(dm2.id, 'ag-pixel');
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });
    mockApi.slackConversationsMembers.mockResolvedValue([OPERATOR, OWN_BOT]);

    expect(await intercept(room, mentionEvent('slack:C0ROOM'))).toBe('card');
    expect(await getMessagingGroupAgents(room.id)).toHaveLength(0);
  });

  it('no owner with a Slack identity: card (no members probe)', async () => {
    const dm = await mg({ id: 'mg-dm-andy', platform_id: 'slack:D0ANDY', is_group: 0 });
    await wire(dm.id, 'ag-andy');
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });

    expect(await intercept(room, mentionEvent('slack:C0ROOM'))).toBe('card');
    expect(mockApi.slackConversationsMembers).not.toHaveBeenCalled();
  });

  it('USLACKBOT-created shadow channel: silently handled — no wiring, no decline, no replay', async () => {
    await seedOwnerAndInstanceDm();
    const shadow = await mg({
      id: 'mg-shadow',
      platform_id: 'slack:C0SHADOW',
      unknown_sender_policy: 'request_approval',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, name: 'Untitled', creator: 'USLACKBOT' });

    expect(await intercept(shadow, mentionEvent('slack:C0SHADOW'))).toBe('handled');

    expect(await getMessagingGroupAgents(shadow.id)).toHaveLength(0);
    expect(mockRouteInbound).not.toHaveBeenCalled();
    expect(mockDeclineAndNotify).not.toHaveBeenCalled();
    expect(mockApi.slackConversationsMembers).not.toHaveBeenCalled();
  });

  it('stranger 1:1 DM with decline_notify policy: declines and notifies, no card', async () => {
    await seedOwnerAndInstanceDm();
    const dm = await mg({
      id: 'mg-dm-stranger',
      platform_id: 'slack:D0STRANGER',
      is_group: 0,
      unknown_sender_policy: 'decline_notify',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: 'U0STRANGER' });

    const event = mentionEvent('slack:D0STRANGER', { isGroup: false, senderId: 'U0STRANGER', senderName: 'Stranger' });
    expect(await intercept(dm, event)).toBe('handled');

    expect(mockDeclineAndNotify).toHaveBeenCalledTimes(1);
    expect(mockDeclineAndNotify).toHaveBeenCalledWith({
      messagingGroupId: dm.id,
      agentGroupId: 'ag-andy',
      senderIdentity: 'slack:U0STRANGER',
      senderName: 'Stranger',
      event,
      fyiText:
        'FYI: Stranger (slack:U0STRANGER) DMed your agent on Slack — I sent a polite decline. ' +
        "This agent's Slack DM is private to its paired user.",
    });
    expect(mockRecordDropped).toHaveBeenCalledTimes(1);
    expect(await getMessagingGroupAgents(dm.id)).toHaveLength(0);
    expect(mockRouteInbound).not.toHaveBeenCalled();
  });

  it('unpaired owner DM with decline_notify policy: declines, no card', async () => {
    await seedOwnerAndInstanceDm();
    const dm = await mg({
      id: 'mg-dm-owner',
      platform_id: 'slack:D0OWNER',
      is_group: 0,
      unknown_sender_policy: 'decline_notify',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: OPERATOR });

    const event = mentionEvent('slack:D0OWNER', { isGroup: false, senderId: OPERATOR, senderName: 'Gavriel' });
    expect(await intercept(dm, event)).toBe('handled');
    expect(mockDeclineAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({
        messagingGroupId: dm.id,
        agentGroupId: 'ag-andy',
        senderIdentity: `slack:${OPERATOR}`,
      }),
    );
  });

  it('unpaired admin DM: declines, no card', async () => {
    await seedOwnerAndInstanceDm();
    const admin = 'U0ADMIN';
    await grantRole({
      user_id: `slack:${admin}`,
      role: 'admin',
      agent_group_id: 'ag-andy',
      granted_by: null,
      granted_at: now(),
    });
    const dm = await mg({
      id: 'mg-dm-admin',
      platform_id: 'slack:D0ADMIN',
      is_group: 0,
      unknown_sender_policy: 'decline_notify',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: admin });

    const event = mentionEvent('slack:D0ADMIN', { isGroup: false, senderId: admin, senderName: 'Admin' });
    expect(await intercept(dm, event)).toBe('handled');
    expect(mockDeclineAndNotify).toHaveBeenCalledWith(
      expect.objectContaining({ messagingGroupId: dm.id, agentGroupId: 'ag-andy', senderIdentity: `slack:${admin}` }),
    );
  });

  it('unpaired known-member DM is declined, no card', async () => {
    await seedOwnerAndInstanceDm();
    const dm = await mg({
      id: 'mg-dm-member',
      platform_id: 'slack:D0MEMBER',
      is_group: 0,
      unknown_sender_policy: 'decline_notify',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: 'U0MEMBER' });

    const event = mentionEvent('slack:D0MEMBER', { isGroup: false, senderId: 'U0MEMBER', senderName: 'Member' });
    expect(await intercept(dm, event)).toBe('handled');
    expect(mockDeclineAndNotify).toHaveBeenCalledTimes(1);
    const fyi = (mockDeclineAndNotify.mock.calls[0][0] as { fyiText?: string }).fyiText ?? '';
    expect(fyi).toContain('private to its paired user');
    expect(await getMessagingGroupAgents(dm.id)).toHaveLength(0);
  });

  it('stranger 1:1 DM with the stale request_approval default: declines and stamps the row decline_notify', async () => {
    await seedOwnerAndInstanceDm();
    const dm = await mg({
      id: 'mg-dm-x',
      platform_id: 'slack:D0X',
      is_group: 0,
      unknown_sender_policy: 'request_approval',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: 'U0STRANGER' });

    const event = mentionEvent('slack:D0X', { isGroup: false, senderId: 'U0STRANGER', senderName: 'Stranger' });
    expect(await intercept(dm, event)).toBe('handled');

    expect(mockDeclineAndNotify).toHaveBeenCalledTimes(1);
    expect(mockDeclineAndNotify).toHaveBeenCalledWith({
      messagingGroupId: dm.id,
      agentGroupId: 'ag-andy',
      senderIdentity: 'slack:U0STRANGER',
      senderName: 'Stranger',
      event,
      fyiText: expect.stringContaining('private to its paired user'),
    });
    // The D24 flip is stamped onto the row so the DB matches the behavior.
    expect(await getMessagingGroup(dm.id)).toMatchObject({ unknown_sender_policy: 'decline_notify' });
  });

  it("unpaired 1:1 DM declines and stamps decline_notify despite a stored 'strict' or 'public' policy", async () => {
    await seedOwnerAndInstanceDm();
    for (const policy of ['strict', 'public'] as const) {
      const dm = await mg({
        id: `mg-dm-${policy}`,
        platform_id: `slack:D0${policy.toUpperCase()}`,
        is_group: 0,
        unknown_sender_policy: policy,
      });
      mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: 'U0STRANGER' });
      expect(await intercept(dm, mentionEvent(dm.platform_id, { isGroup: false, senderId: 'U0STRANGER' }))).toBe(
        'handled',
      );
      expect(await getMessagingGroup(dm.id)).toMatchObject({ unknown_sender_policy: 'decline_notify' });
    }
    expect(mockDeclineAndNotify).toHaveBeenCalledTimes(2);
  });

  it('unpaired 1:1 DM with ambiguous instance→agent-group resolution: declines, no card', async () => {
    await seedOwnerAndInstanceDm();
    // A second DM wiring on the same instance makes group resolution ambiguous,
    // but must not turn an unpaired DM into a registration card.
    const dm2 = await mg({ id: 'mg-dm-pixel', platform_id: 'slack:D0PIXEL', is_group: 0 });
    await wire(dm2.id, 'ag-pixel');
    const dm = await mg({
      id: 'mg-dm-ambig',
      platform_id: 'slack:D0AMBIG',
      is_group: 0,
      unknown_sender_policy: 'decline_notify',
    });
    mockApi.slackConversationsInfo.mockResolvedValue({ isMpim: false, creator: 'U0STRANGER' });

    expect(await intercept(dm, mentionEvent('slack:D0AMBIG', { isGroup: false, senderId: 'U0STRANGER' }))).toBe(
      'handled',
    );
    expect(mockDeclineAndNotify).toHaveBeenCalledWith(expect.objectContaining({ agentGroupId: null }));
    expect(mockRecordDropped).toHaveBeenCalledWith(expect.objectContaining({ agent_group_id: null }));
  });

  it('conversations.members failure: card fallback (never silent loss)', async () => {
    await seedOwnerAndInstanceDm();
    const room = await mg({ id: 'mg-room', platform_id: 'slack:C0ROOM', unknown_sender_policy: 'request_approval' });
    mockApi.slackConversationsMembers.mockRejectedValue(new Error('ratelimited'));

    expect(await intercept(room, mentionEvent('slack:C0ROOM'))).toBe('card');
    expect(await getMessagingGroupAgents(room.id)).toHaveLength(0);
  });
});
