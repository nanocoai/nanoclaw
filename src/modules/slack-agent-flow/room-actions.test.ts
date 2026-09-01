/**
 * Tests for the agent-facing room actions: create_room and
 * add_to_room, driven through the REAL guard-wrapped delivery entries
 * (getDeliveryAction) over a real in-memory central DB. Slack traffic is a
 * recorded fetch stub (auth.test + conversations.open only — room actions
 * never provision apps); the canvas leg is mocked like orchestrate.test.ts.
 * rootDir is process.cwd(), so each test runs chdir'd into its own tmpdir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDefaults } from '../../channels/adapter.js';
import type { Session } from '../../types.js';

const ANDY_BOT_TOKEN = 'xoxb-andy-secret-token';
const PIXEL_BOT_TOKEN = 'xoxb-pixel-secret-token';
const DEVIN_BOT_TOKEN = 'xoxb-devin-secret-token';

const { mockNotifyWrite, mockRequestApproval, mockWriteDestinations, mockCreateRoomCanvas, mockWireCanvasComments } =
  vi.hoisted(() => ({
    mockNotifyWrite: vi.fn(),
    mockRequestApproval: vi.fn().mockResolvedValue(undefined),
    mockWriteDestinations: vi.fn(),
    mockCreateRoomCanvas: vi.fn(),
    mockWireCanvasComments: vi.fn(),
  }));

// Room canvas (contract C2) — non-throwing, returns the canvas id or undefined.
vi.mock('./room-canvas.js', () => ({
  createRoomCanvas: (...a: unknown[]) => mockCreateRoomCanvas(...a),
  wireCanvasComments: (...a: unknown[]) => mockWireCanvasComments(...a),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: (...a: unknown[]) => mockNotifyWrite(...a),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nowhere/inbound.db'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
vi.mock('../../group-init.js', () => ({ initGroupFilesystem: vi.fn() }));
vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
// The approvals barrel drags in the response handler + OneCLI bridge; the
// room actions only need these three. notifyAgent stays REAL (primitive.js)
// so notify texts flow through the mocked writeSessionMessage above.
vi.mock('../approvals/index.js', async () => {
  const primitive = await vi.importActual<typeof import('../approvals/primitive.js')>('../approvals/primitive.js');
  return {
    requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
    notifyAgent: primitive.notifyAgent,
    registerApprovalHandler: vi.fn(),
  };
});

// Registers the create_room / add_to_room delivery actions — the path under
// test. Deliberately NOT src/modules/index.ts: the upstream a2a barrel stays
// unloaded.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';
import { listGuardedActions } from '../../guard/index.js';
import { log } from '../../log.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getAllMessagingGroups,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { createDestination, getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';

const TEST_SLACK_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

const SRC_GROUP = 'ag-src';
const SLACK_SESSION: Session = {
  id: 'sess-1',
  agent_group_id: SRC_GROUP,
  messaging_group_id: 'mg-origin',
  thread_id: null,
  agent_provider: null,
  status: 'active',
  container_status: 'stopped',
  last_active: null,
  created_at: '2026-01-01T00:00:00.000Z',
};

// ── fetch stub ──

interface RecordedFetch {
  url: string;
  token: string;
  body: string;
}
let fetchCalls: RecordedFetch[] = [];
let tmpDir = '';
// conversations.members response for the add_to_room source-room read.
let sourceRoomMembers: string[] = [];
let membersFail = false;

const BOT_IDS: Record<string, string> = {
  [ANDY_BOT_TOKEN]: 'U0ANDYBOT',
  [PIXEL_BOT_TOKEN]: 'U0PIXELBOT',
  [DEVIN_BOT_TOKEN]: 'U0DEVINBOT',
};

function jsonResponse(obj: unknown): Response {
  return new Response(JSON.stringify(obj), { status: 200, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(
  input: unknown,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  const url = String(input);
  const token = String(init?.headers?.Authorization ?? '').replace(/^Bearer\s+/i, '');
  const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
  fetchCalls.push({ url, token, body });

  if (url.includes('/api/auth.test')) {
    const userId = BOT_IDS[token];
    if (!userId) return Promise.resolve(jsonResponse({ ok: false, error: 'invalid_auth' }));
    return Promise.resolve(jsonResponse({ ok: true, user_id: userId, team_id: 'T0TEST' }));
  }
  if (url.includes('/api/conversations.members')) {
    if (membersFail) return Promise.resolve(jsonResponse({ ok: false, error: 'fetch_members_failed' }));
    return Promise.resolve(jsonResponse({ ok: true, members: sourceRoomMembers }));
  }
  if (url.includes('/api/conversations.open')) {
    // add_to_room opens the superset AS the newly added agent (Devin in
    // these tests) — that open forks; every other open is the original room.
    return Promise.resolve(
      jsonResponse({ ok: true, channel: { id: token === DEVIN_BOT_TOKEN ? 'G0FORK' : 'G0TEAM' } }),
    );
  }
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

// ── harness ──

const originalCwd = process.cwd();
let logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

function roomOpens(): RecordedFetch[] {
  return fetchCalls.filter((c) => c.url.includes('conversations.open'));
}

async function runAction(
  action: string,
  content: Record<string, unknown>,
  session: Session = SLACK_SESSION,
): Promise<void> {
  const wrapped = getDeliveryAction(action);
  expect(wrapped).toBeDefined();
  await wrapped!({ action, ...content }, session);
}

function assertNoTokenLeak(): void {
  const everything = JSON.stringify([notifyTexts(), logSpies.map((s) => s.mock.calls)]);
  for (const secret of [ANDY_BOT_TOKEN, PIXEL_BOT_TOKEN, DEVIN_BOT_TOKEN]) {
    expect(everything).not.toContain(secret);
  }
}

/** A provisioned sub-agent: group + DM wiring on its own instance + the
 *  caller's a2a destination for it (what create_agent leaves behind). */
async function seedSubAgent(name: string, groupId: string, instanceKey: string): Promise<void> {
  const now = new Date().toISOString();
  const localName = name.toLowerCase();
  await createAgentGroup({ id: groupId, name, folder: localName, agent_provider: null, created_at: now });
  const dmMgId = `mg-${localName}-dm`;
  await createMessagingGroup({
    id: dmMgId,
    channel_type: 'slack',
    platform_id: `slack:D0${name.toUpperCase()}DM`,
    instance: instanceKey,
    name: `${name} DM`,
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await createMessagingGroupAgent({
    id: `mga-${localName}-dm`,
    messaging_group_id: dmMgId,
    agent_group_id: groupId,
    engage_mode: 'pattern',
    engage_pattern: '.',
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now,
  });
  await createDestination({
    agent_group_id: SRC_GROUP,
    local_name: localName,
    target_type: 'agent',
    target_id: groupId,
    created_at: now,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockCreateRoomCanvas.mockResolvedValue(undefined);
  fetchCalls = [];
  // Faithful default: the source room holds exactly the operator + its bots.
  sourceRoomMembers = ['U0OPERATOR', 'U0ANDYBOT', 'U0PIXELBOT'];
  membersFail = false;
  vi.stubGlobal('fetch', fakeFetch);
  logSpies = [
    vi.spyOn(log, 'debug').mockImplementation(() => {}),
    vi.spyOn(log, 'info').mockImplementation(() => {}),
    vi.spyOn(log, 'warn').mockImplementation(() => {}),
    vi.spyOn(log, 'error').mockImplementation(() => {}),
  ];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-room-actions-'));
  process.chdir(tmpDir);
  fs.writeFileSync(
    path.join(tmpDir, '.env'),
    `SLACK_BOT_TOKEN=${ANDY_BOT_TOKEN}\nSLACK_BOT_TOKEN_PIXEL=${PIXEL_BOT_TOKEN}\nSLACK_BOT_TOKEN_DEVIN=${DEVIN_BOT_TOKEN}\n`,
  );

  const db = await initTestDb();
  await runMigrations(db);

  const now = new Date().toISOString();
  await createAgentGroup({ id: SRC_GROUP, name: 'Andy', folder: 'andy', agent_provider: null, created_at: now });
  await ensureContainerConfig(SRC_GROUP);
  await updateContainerConfigScalars(SRC_GROUP, { cli_scope: 'global' }); // guard allows without a hold
  await upsertUser({ id: 'slack:U0OPERATOR', kind: 'slack', display_name: 'Op', created_at: now });
  await grantRole({
    user_id: 'slack:U0OPERATOR',
    role: 'owner',
    agent_group_id: null,
    granted_by: null,
    granted_at: now,
  });
  await createMessagingGroup({
    id: 'mg-origin',
    channel_type: 'slack',
    platform_id: 'slack:D0OPDM',
    name: 'Op DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await createSession(SLACK_SESSION);
  registerChannelAdapter('slack', { factory: () => null, defaults: TEST_SLACK_DEFAULTS });

  await seedSubAgent('Pixel', 'ag-pixel', 'slack-pixel');
  await seedSubAgent('Devin', 'ag-devin', 'slack-devin');
});

afterEach(async () => {
  process.chdir(originalCwd);
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('guard wiring', () => {
  it('both room actions are in the guard catalog and their entries are guard-wrapped', () => {
    const actions = new Set(listGuardedActions().map((s) => s.action));
    expect(actions.has('rooms.create')).toBe(true);
    expect(actions.has('rooms.add_agent')).toBe(true);
    expect(getDeliveryAction('create_room')).toBeDefined();
    expect(getDeliveryAction('add_to_room')).toBeDefined();
  });

  it('confined (group-scope) caller: create_room holds for approval, nothing runs', async () => {
    await updateContainerConfigScalars(SRC_GROUP, { cli_scope: 'group' });

    await runAction('create_room', { name: 'Website Team', agents: ['Pixel', 'Devin'] });

    expect(fetchCalls).toHaveLength(0);
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const opts = mockRequestApproval.mock.calls[0]![0] as { action: string; payload: Record<string, unknown> };
    expect(opts.action).toBe('create_room');
    expect(opts.payload).toMatchObject({ name: 'Website Team', agents: ['Pixel', 'Devin'] });
  });

  it('confined (group-scope) caller: add_to_room holds for approval with the (room, agent) payload', async () => {
    await updateContainerConfigScalars(SRC_GROUP, { cli_scope: 'group' });

    await runAction('add_to_room', { room: 'Website Team', agent: 'Devin' });

    expect(fetchCalls).toHaveLength(0);
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const opts = mockRequestApproval.mock.calls[0]![0] as { action: string; payload: Record<string, unknown> };
    expect(opts.action).toBe('add_to_room');
    expect(opts.payload).toEqual({ room: 'Website Team', agent: 'Devin' });
  });
});

describe('create_room', () => {
  it('resolves names and hands ensureAgentRoom the full participant list (caller included)', async () => {
    mockCreateRoomCanvas.mockResolvedValue('F0CANVAS');

    await runAction('create_room', { name: 'Website Team', purpose: 'ship the new site', agents: ['Pixel', 'Devin'] });

    // MPIM opened AS the caller with the operator + every other bot.
    const opens = roomOpens();
    expect(opens).toHaveLength(1);
    expect(opens[0]!.token).toBe(ANDY_BOT_TOKEN);
    expect(JSON.parse(opens[0]!.body)).toMatchObject({ users: 'U0OPERATOR,U0PIXELBOT,U0DEVINBOT' });

    // One mg row + mention/accumulate wiring PER participating instance.
    for (const [instanceKey, groupId] of [
      ['slack', SRC_GROUP],
      ['slack-pixel', 'ag-pixel'],
      ['slack-devin', 'ag-devin'],
    ] as const) {
      const mg = await getMessagingGroupByPlatform('slack', 'slack:G0TEAM', instanceKey);
      expect(mg).toMatchObject({ is_group: 1, unknown_sender_policy: 'public', name: 'Website Team' });
      expect(await getMessagingGroupAgentByPair(mg!.id, groupId)).toMatchObject({
        engage_mode: 'mention',
        engage_pattern: null,
        ignored_message_policy: 'accumulate',
      });
    }

    // Pairwise a2a destinations between the sub-agents (caller already had both).
    expect(await getDestinationByName('ag-pixel', 'devin')).toMatchObject({
      target_type: 'agent',
      target_id: 'ag-devin',
    });
    expect(await getDestinationByName('ag-devin', 'pixel')).toMatchObject({
      target_type: 'agent',
      target_id: 'ag-pixel',
    });

    // Canvas gets the contract data — every agent by plain name, caller first.
    expect(mockCreateRoomCanvas).toHaveBeenCalledWith(ANDY_BOT_TOKEN, 'G0TEAM', {
      roomName: 'Website Team',
      purpose: 'ship the new site',
      creatorUserId: 'U0OPERATOR',
      agentNames: ['Andy', 'Pixel', 'Devin'],
    });

    // Allowlisted for a2a; success notify tells the CALLER to author the
    // intro via its projected room destination, tagging both bots.
    expect(fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')).toMatch(/^SLACK_A2A_ROOMS=.*G0TEAM/m);
    const success = notifyTexts().at(-1)!;
    expect(success).toContain('Room "Website Team" is live (G0TEAM)');
    expect(success).toContain('send_message({ to: "website-team"');
    expect(success).toContain('<@U0PIXELBOT>');
    expect(success).toContain('<@U0DEVINBOT>');
    expect(success).not.toContain('<@U0ANDYBOT>');
    expect(success).toContain('no mechanics, no member lists');

    assertNoTokenLeak();
  });

  it('include_me:false — first listed agent becomes creator, caller stays out', async () => {
    await runAction('create_room', { name: 'Duo', agents: ['Pixel', 'Devin'], include_me: false });

    const opens = roomOpens();
    expect(opens).toHaveLength(1);
    expect(opens[0]!.token).toBe(PIXEL_BOT_TOKEN);
    expect(JSON.parse(opens[0]!.body)).toMatchObject({ users: 'U0OPERATOR,U0DEVINBOT' });

    // No caller-instance row, no caller wiring.
    expect(await getMessagingGroupByPlatform('slack', 'slack:G0TEAM', 'slack')).toBeUndefined();
    const success = notifyTexts().at(-1)!;
    expect(success).toContain('You are not a member');
    expect(success).not.toContain('send_message');
  });

  it('unknown agent name surfaces as a failure notify before anything is opened', async () => {
    await runAction('create_room', { name: 'Website Team', agents: ['Ghost'] });

    expect(roomOpens()).toHaveLength(0);
    expect((await getAllMessagingGroups()).filter((m) => m.platform_id === 'slack:G0TEAM')).toHaveLength(0);
    expect(notifyTexts().at(-1)).toContain('create_room failed: unknown agent "Ghost"');
  });

  it('missing bot token surfaces as a failure notify naming the key, never the value', async () => {
    fs.writeFileSync(path.join(tmpDir, '.env'), `SLACK_BOT_TOKEN=${ANDY_BOT_TOKEN}\n`);

    await runAction('create_room', { name: 'Website Team', agents: ['Pixel'] });

    expect(roomOpens()).toHaveLength(0);
    const failure = notifyTexts().at(-1)!;
    expect(failure).toContain('create_room failed: no bot token in .env for agent "Pixel"');
    expect(failure).toContain('SLACK_BOT_TOKEN_PIXEL');
    assertNoTokenLeak();
  });

  it('malformed request (no agents) is answered by the precheck without a hold', async () => {
    await updateContainerConfigScalars(SRC_GROUP, { cli_scope: 'group' });

    await runAction('create_room', { name: 'Website Team', agents: [] });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(notifyTexts().at(-1)).toContain('agents must be a non-empty list');
  });
});

describe('add_to_room', () => {
  beforeEach(async () => {
    // An existing room: Andy + Pixel (+ operator), created through the real
    // primitive so the wiring shape matches production.
    await runAction('create_room', { name: 'Website Team', agents: ['Pixel'] });
    mockNotifyWrite.mockClear();
    fetchCalls = [];
  });

  it('opens the superset MPIM as the new agent and wires everyone onto the forked channel', async () => {
    await runAction('add_to_room', { room: 'Website Team', agent: 'Devin' });

    // Superset open AS Devin: operator + both existing bots → fork id.
    const opens = roomOpens();
    expect(opens).toHaveLength(1);
    expect(opens[0]!.token).toBe(DEVIN_BOT_TOKEN);
    const users = String((JSON.parse(opens[0]!.body) as { users: string }).users).split(',');
    expect(users).toHaveLength(3);
    expect(users).toContain('U0OPERATOR');
    expect(users).toContain('U0ANDYBOT');
    expect(users).toContain('U0PIXELBOT');

    // Every participant wired onto the NEW channel; the old room untouched.
    for (const [instanceKey, groupId] of [
      ['slack', SRC_GROUP],
      ['slack-pixel', 'ag-pixel'],
      ['slack-devin', 'ag-devin'],
    ] as const) {
      const mg = await getMessagingGroupByPlatform('slack', 'slack:G0FORK', instanceKey);
      expect(mg).toMatchObject({ is_group: 1, unknown_sender_policy: 'public', name: 'Website Team' });
      expect(await getMessagingGroupAgentByPair(mg!.id, groupId)).toMatchObject({
        engage_mode: 'mention',
        ignored_message_policy: 'accumulate',
      });
    }
    expect(await getMessagingGroupByPlatform('slack', 'slack:G0TEAM', 'slack')).toBeDefined();
    expect(await getMessagingGroupByPlatform('slack', 'slack:G0TEAM', 'slack-devin')).toBeUndefined();

    // The caller is a room member — the notify explains the fork and asks
    // for an intro of the new agent in the NEW conversation.
    const success = notifyTexts().at(-1)!;
    expect(success).toContain('Devin was added to room "Website Team"');
    expect(success).toContain('moved to a new conversation (G0FORK)');
    expect(success).toContain('<@U0DEVINBOT>');

    assertNoTokenLeak();
  });

  it('carries Slack-UI-added humans from the source room into the forked superset', async () => {
    // A colleague was added to the room via the Slack UI — they exist only
    // in the platform member list, never in wiring rows.
    sourceRoomMembers = ['U0OPERATOR', 'U0ANDYBOT', 'U0PIXELBOT', 'U0COLLEAGUE'];

    await runAction('add_to_room', { room: 'Website Team', agent: 'Devin' });

    const opens = roomOpens();
    expect(opens).toHaveLength(1);
    const users = String((JSON.parse(opens[0]!.body) as { users: string }).users).split(',');
    expect(users).toHaveLength(4);
    expect(users).toContain('U0COLLEAGUE');
    expect(notifyTexts().at(-1)).toContain('moved to a new conversation (G0FORK)');
  });

  it('source-room member read failure fails the action — never a fork that silently drops members', async () => {
    membersFail = true;

    await runAction('add_to_room', { room: 'Website Team', agent: 'Devin' });

    expect(roomOpens()).toHaveLength(0);
    expect(notifyTexts().at(-1)).toContain('add_to_room failed');
  });

  it('agent already in the room: says so, opens nothing', async () => {
    await runAction('add_to_room', { room: 'Website Team', agent: 'Pixel' });

    expect(roomOpens()).toHaveLength(0);
    expect(notifyTexts().at(-1)).toContain('already in room "Website Team"');
  });

  it('unknown room surfaces as a failure notify', async () => {
    await runAction('add_to_room', { room: 'Nope', agent: 'Devin' });

    expect(roomOpens()).toHaveLength(0);
    expect(notifyTexts().at(-1)).toContain('add_to_room failed: no wired Slack room named "Nope"');
  });
});
