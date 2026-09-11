/**
 * End-to-end tests for the slack-agent-flow wrapped create_agent action.
 *
 * Drives the REAL guard-wrapped delivery entry (getDeliveryAction) over a real
 * in-memory central DB; Slack/broker traffic is a recorded fetch stub and the
 * optional-module seam (slack-deps.js) is a recorded fake — no network, no
 * skill-installed channel files. rootDir is process.cwd(), so each test runs
 * chdir'd into its own tmpdir (vitest's default forks pool allows chdir).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelDefaults } from '../../channels/adapter.js';
import type { Session } from '../../types.js';

const ORIGIN_BOT_TOKEN = 'xoxb-origin-secret-token';
const NEW_BOT_TOKEN = 'xoxb-new-bot-secret-token';
const NEW_APP_TOKEN = 'xapp-new-app-secret-token';
const REGISTRY_TOKEN = 'nct-registry-secret-token';

// vi.hoisted: the module import below runs before this file's const
// initializers, and the mock factories close over this state.
const {
  mockNotifyWrite,
  mockRequestApproval,
  mockInitGroupFilesystem,
  mockWriteDestinations,
  mockCreateRoomCanvas,
  mockWireCanvasComments,
  mockAssertSlackInstancesModuleInstalled,
  fakeDeps,
} = vi.hoisted(() => ({
  mockNotifyWrite: vi.fn(),
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockInitGroupFilesystem: vi.fn(),
  mockWriteDestinations: vi.fn(),
  mockCreateRoomCanvas: vi.fn(),
  mockWireCanvasComments: vi.fn(),
  mockAssertSlackInstancesModuleInstalled: vi.fn().mockResolvedValue(undefined),
  fakeDeps: {
    slackInstanceBridgeFactory: vi.fn().mockReturnValue(null),
    SLACK_DEFAULTS: undefined as unknown, // assigned in beforeEach (TEST_SLACK_DEFAULTS)
    registerChannelAdapter: vi.fn(),
    startChannelAdapter: vi.fn().mockResolvedValue('started'),
  },
}));

// The optional-module seam — the only door to skill-installed channel files.
vi.mock('./slack-deps.js', () => ({
  loadSlackChannelDeps: async () => fakeDeps,
  assertSlackInstancesModuleInstalled: (...a: unknown[]) => mockAssertSlackInstancesModuleInstalled(...a),
}));
// Room canvas (contract C2) — non-throwing, returns the canvas id or undefined.
// wireCanvasComments (shadow-channel wiring) rides in the same module.
vi.mock('./room-canvas.js', () => ({
  createRoomCanvas: (...a: unknown[]) => mockCreateRoomCanvas(...a),
  wireCanvasComments: (...a: unknown[]) => mockWireCanvasComments(...a),
}));
// notifyAgent writes to the session inbound.db + wakes the container; stub both.
// delivery.ts pulls more session-manager exports at import time.
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
vi.mock('../../group-init.js', () => ({
  initGroupFilesystem: (...a: unknown[]) => mockInitGroupFilesystem(...a),
}));
vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
// The approvals barrel drags in the response handler + OneCLI bridge; the
// wrapper only needs these three. notifyAgent stays REAL (from primitive.js)
// so notify texts flow through the mocked writeSessionMessage above.
vi.mock('../approvals/index.js', async () => {
  const primitive = await vi.importActual<typeof import('../approvals/primitive.js')>('../approvals/primitive.js');
  return {
    requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
    notifyAgent: primitive.notifyAgent,
    registerApprovalHandler: vi.fn(),
  };
});

// Registers the wrapped create_agent delivery action — the path under test.
// Deliberately NOT src/modules/index.ts: the upstream a2a barrel stays unloaded.
import './index.js';
import { ensureAgentRoom, finishSlackAgentFlow } from './orchestrate.js';
import { SlackFlowError } from './types.js';
import { getDeliveryAction } from '../../delivery.js';
import { log } from '../../log.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { closeDb, initTestDb } from '../../db/connection.js';
import { runMigrations } from '../../db/migrations/index.js';
import { createAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../db/container-configs.js';
import {
  createMessagingGroup,
  getAllMessagingGroups,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';

// Mirrors the shape the Slack adapter declares (SLACK_DEFAULTS): the dm
// context carries the B7 agent-DM declaration (sessionMode 'per-thread';
// resolveWiringDefaults derives the threads=1 stamp from it) — S8 stamps
// whatever the declaration resolves, so the per-thread/threads:1 pins below
// exercise the declaration-driven path, not a hardcode.
const TEST_SLACK_DEFAULTS: ChannelDefaults = {
  dm: {
    engageMode: 'pattern',
    engagePattern: '.',
    threads: true,
    sessionMode: 'per-thread',
    unknownSenderPolicy: 'strict',
  },
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
/** .env content snapshotted at each chat.postMessage — proves S10 ran before S13. */
let postMessageEnvSnapshots: string[] = [];
let brokerStatus = 200;
let tmpDir = '';
/** null → the workspace refused auto-install; POST /v1/apps answers with a link instead. */
let brokerBotToken: string | null = NEW_BOT_TOKEN;
let brokerInstallUrl = '';
/** Successive GET /v1/apps/{id} answers; the last one repeats. `http` overrides the status code. */
let appStateQueue: Array<{ status?: string; bot_token?: string; http?: number }> = [];
let appStateReads = 0;

function jsonResponse(obj: unknown, status = 200): Response {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json' } });
}

function fakeFetch(
  input: unknown,
  init?: { method?: string; headers?: Record<string, string>; body?: unknown },
): Promise<Response> {
  const url = String(input);
  const auth = String(init?.headers?.Authorization ?? '');
  const token = auth.replace(/^Bearer\s+/i, '');
  const body = typeof init?.body === 'string' ? init.body : String(init?.body ?? '');
  fetchCalls.push({ url, token, body });

  if (url.endsWith('/v1/avatars')) {
    // Pre-create avatar job: dispatched...
    return Promise.resolve(jsonResponse({ avatar_id: 'av-test', status: 'pending' }, 202));
  }
  if (url.includes('/v1/avatars/')) {
    // ...and ready on the first poll, so the bot is born wearing its face.
    return Promise.resolve(jsonResponse({ avatar_id: 'av-test', status: 'ready' }));
  }
  if (url.includes('/v1/apps/')) {
    const state = appStateQueue[Math.min(appStateReads, appStateQueue.length - 1)];
    appStateReads++;
    if (!state) return Promise.resolve(jsonResponse({ error: 'not_found' }, 404));
    return Promise.resolve(jsonResponse(state, state.http ?? 200));
  }
  if (url.endsWith('/v1/apps')) {
    if (brokerStatus !== 200) return Promise.resolve(jsonResponse({ message: 'boom' }, brokerStatus));
    return Promise.resolve(
      jsonResponse({
        appId: 'A0TEST',
        appToken: NEW_APP_TOKEN,
        ...(brokerBotToken ? { botToken: brokerBotToken } : {}),
        ...(brokerInstallUrl ? { installUrl: brokerInstallUrl } : {}),
      }),
    );
  }
  if (url.includes('/api/auth.test')) {
    const userId = token === ORIGIN_BOT_TOKEN ? 'U0ORIGINBOT' : 'U0NEWBOT';
    return Promise.resolve(
      jsonResponse({
        ok: true,
        user_id: userId,
        team_id: 'T0TEST',
        team: 'NanoCo Test',
        url: 'https://nanoco-test.slack.com/',
      }),
    );
  }
  if (url.includes('/api/conversations.open')) {
    const users = String((JSON.parse(body) as { users?: string }).users ?? '');
    return Promise.resolve(jsonResponse({ ok: true, channel: { id: users.includes(',') ? 'G0ROOM' : 'D0NEWDM' } }));
  }
  if (url.includes('/api/chat.postMessage')) {
    const envPath = path.join(tmpDir, '.env');
    postMessageEnvSnapshots.push(fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '');
    return Promise.resolve(jsonResponse({ ok: true }));
  }
  return Promise.reject(new Error(`unexpected fetch: ${url}`));
}

// ── harness ──

const originalCwd = process.cwd();
let logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

function notifyTexts(): string[] {
  return mockNotifyWrite.mock.calls.map((c) => JSON.parse((c[2] as { content: string }).content).text as string);
}

async function runCreateAgent(content: Record<string, unknown>, session: Session = SLACK_SESSION): Promise<void> {
  const wrapped = getDeliveryAction('create_agent');
  expect(wrapped).toBeDefined();
  await wrapped!(content, session);
}

function assertNoTokenLeak(): void {
  const everything = JSON.stringify([notifyTexts(), logSpies.map((s) => s.mock.calls)]);
  for (const secret of [ORIGIN_BOT_TOKEN, NEW_BOT_TOKEN, NEW_APP_TOKEN, REGISTRY_TOKEN]) {
    expect(everything).not.toContain(secret);
  }
}

beforeEach(async () => {
  vi.clearAllMocks();
  fakeDeps.SLACK_DEFAULTS = TEST_SLACK_DEFAULTS;
  fakeDeps.startChannelAdapter.mockResolvedValue('started');
  // Degraded default (free workspace / canvases off): C2 returns undefined —
  // the flow must tolerate it (no canvas, no link line). Canvas tests opt in.
  mockCreateRoomCanvas.mockResolvedValue(undefined);
  fetchCalls = [];
  postMessageEnvSnapshots = [];
  brokerStatus = 200;
  brokerBotToken = NEW_BOT_TOKEN;
  brokerInstallUrl = '';
  appStateQueue = [];
  appStateReads = 0;
  vi.stubGlobal('fetch', fakeFetch);
  logSpies = [
    vi.spyOn(log, 'debug').mockImplementation(() => {}),
    vi.spyOn(log, 'info').mockImplementation(() => {}),
    vi.spyOn(log, 'warn').mockImplementation(() => {}),
    vi.spyOn(log, 'error').mockImplementation(() => {}),
  ];

  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'slack-agent-flow-'));
  process.chdir(tmpDir);
  fs.writeFileSync(path.join(tmpDir, '.env'), `SLACK_BOT_TOKEN=${ORIGIN_BOT_TOKEN}\n`);
  process.env.NANOCLAW_REGISTRY_TOKEN = REGISTRY_TOKEN; // broker mode, no account.json / .env lookup

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
  // Declared platform defaults so resolveWiringDefaults / validate see slack's
  // real shape (group: mention-sticky + threads) for the dead named instance.
  registerChannelAdapter('slack', { factory: () => null, defaults: TEST_SLACK_DEFAULTS });
});

afterEach(async () => {
  process.chdir(originalCwd);
  delete process.env.NANOCLAW_REGISTRY_TOKEN;
  delete process.env.SLACK_INSTALL_WAIT_MS;
  delete process.env.SLACK_INSTALL_POLL_MS;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('slack-aware create_agent — happy path (Slack-origin session)', () => {
  it('creates the group, provisions the bot, wires DM + room, posts intros in order', async () => {
    await runCreateAgent({ name: 'Research', instructions: 'dig deep' });

    // Upstream leg: group + scaffold + bidirectional a2a destinations.
    const newGroup = await getAgentGroupByFolder('research');
    expect(newGroup).toBeDefined();
    expect(mockInitGroupFilesystem).toHaveBeenCalledTimes(1);
    const dest = await getDestinationByName(SRC_GROUP, 'research');
    expect(dest).toMatchObject({ target_type: 'agent', target_id: newGroup!.id });
    expect(await getDestinationByName(newGroup!.id, 'parent')).toMatchObject({
      target_type: 'agent',
      target_id: SRC_GROUP,
    });

    // Env keys (values themselves never asserted into messages/logs).
    const env = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
    expect(env).toMatch(/^SLACK_BOT_TOKEN_RESEARCH=/m);
    expect(env).toMatch(/^SLACK_APP_TOKEN_RESEARCH=/m);
    expect(env).toMatch(/^SLACK_INSTANCES=.*research/m);
    expect(env).toMatch(/^SLACK_A2A_ROOMS=.*G0ROOM/m);

    // Hot-add through the seam.
    expect(fakeDeps.registerChannelAdapter).toHaveBeenCalledWith(
      'slack-research',
      expect.objectContaining({ defaults: TEST_SLACK_DEFAULTS }),
    );
    expect(fakeDeps.startChannelAdapter).toHaveBeenCalledWith('slack-research');

    // DM row + wiring on the NEW instance. Agent-view is the default variant
    // so the DM gets thread-per-conversation sessions:
    // session_mode 'per-thread' + explicit threads:1.
    const dmMg = await getMessagingGroupByPlatform('slack', 'slack:D0NEWDM', 'slack-research');
    expect(dmMg).toMatchObject({ is_group: 0, unknown_sender_policy: 'strict', name: 'Research DM' });
    expect(await getMessagingGroupAgentByPair(dmMg!.id, newGroup!.id)).toMatchObject({
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'per-thread',
      threads: 1,
      priority: 0,
    });

    // Room: one row PER instance, policy 'public', mention/accumulate wirings
    // (D4 — flow-created rooms only; mention-sticky is gone from the flow).
    const roomOrigin = await getMessagingGroupByPlatform('slack', 'slack:G0ROOM', 'slack');
    const roomNew = await getMessagingGroupByPlatform('slack', 'slack:G0ROOM', 'slack-research');
    expect(roomOrigin).toMatchObject({ is_group: 1, unknown_sender_policy: 'public' });
    expect(roomNew).toMatchObject({ is_group: 1, unknown_sender_policy: 'public' });
    expect(await getMessagingGroupAgentByPair(roomOrigin!.id, SRC_GROUP)).toMatchObject({
      engage_mode: 'mention',
      engage_pattern: null,
      ignored_message_policy: 'accumulate',
    });
    expect(await getMessagingGroupAgentByPair(roomNew!.id, newGroup!.id)).toMatchObject({
      engage_mode: 'mention',
      engage_pattern: null,
      ignored_message_policy: 'accumulate',
    });

    // Projections pushed into the live source session.
    expect(mockWriteDestinations).toHaveBeenCalledWith(SRC_GROUP, 'sess-1');

    // No room-contract post: the only chat.postMessage is the DM intro,
    // and SLACK_A2A_ROOMS was in .env before it.
    const posts = fetchCalls.filter((c) => c.url.includes('chat.postMessage'));
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body) as { channel: string }).channel).toBe('D0NEWDM');
    expect(posts[0]!.token).toBe(NEW_BOT_TOKEN);
    expect(postMessageEnvSnapshots).toHaveLength(1);
    expect(postMessageEnvSnapshots[0]).toMatch(/^SLACK_A2A_ROOMS=.*G0ROOM/m);

    // The ORIGIN agent authors the room intro — exactly one
    // instruction-shaped nudge written into the origin session, tagging the
    // new bot and addressing the room by its projected destination name.
    const nudges = notifyTexts().filter((t) => t.includes('introduction'));
    expect(nudges).toHaveLength(1);
    const nudgeCall = mockNotifyWrite.mock.calls.find((c) =>
      String((c[2] as { content: string }).content).includes('introduction'),
    )!;
    expect(nudgeCall[0]).toBe(SRC_GROUP);
    expect(nudgeCall[1]).toBe('sess-1');
    // notifyAgent leaves `trigger` unset — writeSessionMessage defaults it
    // to 1, so the nudge wakes the origin agent.
    expect((nudgeCall[2] as { trigger?: number }).trigger).toBeUndefined();
    expect(nudges[0]).toContain('<@U0NEWBOT>');
    expect(nudges[0]).toContain('send_message({ to: "research-room"');
    expect(nudges[0]).toContain('no mechanics, no member lists');
    // No explicit purpose was provided — the creation prompt must NOT leak
    // into the nudge (no fallback — creation prompts are private).
    expect(nudges[0]).not.toContain('dig deep');
    // No canvas id → no shadow channel to wire.
    expect(mockWireCanvasComments).not.toHaveBeenCalled();

    // MPIM opened as the new bot with operator + origin bot.
    const opens = fetchCalls.filter((c) => c.url.includes('conversations.open'));
    expect(opens).toHaveLength(2);
    expect(JSON.parse(opens[1]!.body)).toMatchObject({ users: 'U0OPERATOR,U0ORIGINBOT' });
    expect(opens[1]!.token).toBe(NEW_BOT_TOKEN);

    // Requester heard ONLY the Slack success notify — the upstream "created —
    // you can now message it" text is suppressed on the Slack path (it fires
    // before provisioning and would report "done" ~a minute early).
    const texts = notifyTexts();
    expect(texts.some((t) => t.includes('Agent "research" created'))).toBe(false);
    expect(texts.at(-1)).toContain('is live on Slack');
    expect(texts.at(-1)).toContain('G0ROOM');

    assertNoTokenLeak();
  });
});

describe('slack-aware create_agent — manifest variants', () => {
  it('allow_guests: broker gets allow_guests:true, DM wiring keeps the plain defaults', async () => {
    await runCreateAgent({ name: 'Guesty', instructions: 'help the guests', allow_guests: true });

    const appBody = JSON.parse(fetchCalls.find((c) => c.url.endsWith('/v1/apps'))!.body) as Record<string, unknown>;
    expect(appBody.allow_guests).toBe(true);

    const newGroup = await getAgentGroupByFolder('guesty');
    const dmMg = await getMessagingGroupByPlatform('slack', 'slack:D0NEWDM', 'slack-guesty');
    const dmWiring = (await getMessagingGroupAgentByPair(dmMg!.id, newGroup!.id))!;
    expect(dmWiring).toMatchObject({ session_mode: 'shared' });
    expect(dmWiring.threads ?? null).toBeNull();
  });

  it('default (agent-view): broker body carries no allow_guests flag', async () => {
    await runCreateAgent({ name: 'Research', instructions: 'dig deep' });
    const appBody = JSON.parse(fetchCalls.find((c) => c.url.endsWith('/v1/apps'))!.body) as Record<string, unknown>;
    expect(appBody.allow_guests).toBeUndefined();
  });
});

describe("slack-aware create_agent — room:'none'", () => {
  it('skips the room half entirely: DM only, no MPIM, no a2a entry, no canvas, no intro nudge', async () => {
    mockCreateRoomCanvas.mockResolvedValue('F0CANVAS');

    await runCreateAgent({ name: 'Research', instructions: 'dig deep', room: 'none' });

    expect(await getAgentGroupByFolder('research')).toBeDefined();
    // Only the operator-DM conversations.open — no MPIM.
    const opens = fetchCalls.filter((c) => c.url.includes('conversations.open'));
    expect(opens).toHaveLength(1);
    expect(JSON.parse(opens[0]!.body)).toMatchObject({ users: 'U0OPERATOR' });
    // No room rows on any instance, no a2a allowlist, no canvas, no shadow wiring.
    expect((await getAllMessagingGroups()).filter((m) => m.platform_id === 'slack:G0ROOM')).toHaveLength(0);
    expect(fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')).not.toContain('SLACK_A2A_ROOMS');
    expect(mockCreateRoomCanvas).not.toHaveBeenCalled();
    expect(mockWireCanvasComments).not.toHaveBeenCalled();
    // The DM intro still posts; the origin agent gets NO intro nudge.
    const posts = fetchCalls.filter((c) => c.url.includes('chat.postMessage'));
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body) as { channel: string }).channel).toBe('D0NEWDM');
    expect(notifyTexts().filter((t) => t.includes('introduction'))).toHaveLength(0);
    // Success text is the no-room variant pointing at create_room.
    const success = notifyTexts().at(-1)!;
    expect(success).toContain("room:'none'");
    expect(success).toContain('create_room');
    expect(success).not.toContain('G0ROOM');

    assertNoTokenLeak();
  });

  it("hold payload carries room:'none' through to the approved replay (confined group)", async () => {
    await updateContainerConfigScalars(SRC_GROUP, { cli_scope: 'group' });

    await runCreateAgent({ name: 'Research', instructions: 'dig deep', room: 'none' });

    // Held — nothing created yet; the replay payload must preserve room:'none'.
    expect(await getAgentGroupByFolder('research')).toBeUndefined();
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const opts = mockRequestApproval.mock.calls[0]![0] as { action: string; payload: Record<string, unknown> };
    expect(opts.action).toBe('create_agent');
    expect(opts.payload).toMatchObject({ name: 'Research', room: 'none' });
  });
});

describe('slack-aware create_agent — room canvas contract', () => {
  it('canvas available: called with the contract data (plain agent names), all participants wired', async () => {
    mockCreateRoomCanvas.mockResolvedValue('F0CANVAS');

    await runCreateAgent({ name: 'Research', instructions: 'dig deep' });

    // The canvas carries the room contract: purpose, creator, members. Agent
    // members travel as PLAIN NAMES — never bot user ids (the de-mention rule).
    expect(mockCreateRoomCanvas).toHaveBeenCalledWith(NEW_BOT_TOKEN, 'G0ROOM', {
      roomName: 'Research room',
      purpose: 'Research room',
      creatorUserId: 'U0OPERATOR',
      agentNames: ['Andy', 'Research'],
    });
    // Shadow-channel wiring rides on canvas success: EVERY participant —
    // creator identified separately from the full list.
    const newGroup = (await getAgentGroupByFolder('research'))!;
    expect(mockWireCanvasComments).toHaveBeenCalledTimes(1);
    expect(mockWireCanvasComments).toHaveBeenCalledWith(
      'F0CANVAS',
      expect.objectContaining({ instanceKey: 'slack-research', agentGroupId: newGroup.id }),
      [
        expect.objectContaining({ instanceKey: 'slack', agentGroupId: SRC_GROUP }),
        expect.objectContaining({ instanceKey: 'slack-research', agentGroupId: newGroup.id }),
      ],
      'Research room',
    );
    // Still no room post: the canvas tab IS the pinned surface — no link
    // message either.
    const posts = fetchCalls.filter((c) => c.url.includes('chat.postMessage'));
    expect(posts).toHaveLength(1);
    expect((JSON.parse(posts[0]!.body) as { channel: string }).channel).toBe('D0NEWDM');
  });
});

describe('ensureAgentRoom — N-bot rooms', () => {
  it('opens the MPIM with every participating bot, wires each instance, and makes destinations pairwise', async () => {
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-new', name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: now });
    await createAgentGroup({ id: 'ag-third', name: 'Devin', folder: 'devin', agent_provider: null, created_at: now });
    const participants = [
      { instanceKey: 'slack', botUserId: 'U0ORIGINBOT', agentGroupId: SRC_GROUP, agentGroupName: 'Andy' },
      { instanceKey: 'slack-devin', botUserId: 'U0THIRD', agentGroupId: 'ag-third', agentGroupName: 'Devin' },
      { instanceKey: 'slack-pixel', botUserId: 'U0NEWBOT', agentGroupId: 'ag-new', agentGroupName: 'Pixel' },
    ];

    const result = await ensureAgentRoom({
      creator: participants[2]!,
      creatorBotToken: NEW_BOT_TOKEN,
      operatorUserId: 'U0OPERATOR',
      participants,
      roomName: 'Pixel room',
      purpose: 'coordinate the redesign',
      rootDir: tmpDir,
    });
    expect(result).toMatchObject({ roomChannelId: 'G0ROOM', created: true });

    // MPIM opened as the creator with operator + every OTHER participating bot.
    const open = fetchCalls.find((c) => c.url.includes('conversations.open'))!;
    expect(open.token).toBe(NEW_BOT_TOKEN);
    expect(JSON.parse(open.body)).toMatchObject({ users: 'U0OPERATOR,U0ORIGINBOT,U0THIRD' });

    // One mg row + mention/accumulate wiring PER participating instance.
    for (const p of participants) {
      const mg = await getMessagingGroupByPlatform('slack', 'slack:G0ROOM', p.instanceKey);
      expect(mg).toMatchObject({ is_group: 1, unknown_sender_policy: 'public', name: 'Pixel room' });
      expect(await getMessagingGroupAgentByPair(mg!.id, p.agentGroupId)).toMatchObject({
        engage_mode: 'mention',
        engage_pattern: null,
        ignored_message_policy: 'accumulate',
      });
    }

    // Destinations symmetry: every distinct agent-group pair, both directions.
    expect(await getDestinationByName(SRC_GROUP, 'devin')).toMatchObject({
      target_type: 'agent',
      target_id: 'ag-third',
    });
    expect(await getDestinationByName(SRC_GROUP, 'pixel')).toMatchObject({
      target_type: 'agent',
      target_id: 'ag-new',
    });
    expect(await getDestinationByName('ag-third', 'andy')).toMatchObject({
      target_type: 'agent',
      target_id: SRC_GROUP,
    });
    expect(await getDestinationByName('ag-third', 'pixel')).toMatchObject({
      target_type: 'agent',
      target_id: 'ag-new',
    });
    expect(await getDestinationByName('ag-new', 'andy')).toMatchObject({
      target_type: 'agent',
      target_id: SRC_GROUP,
    });
    expect(await getDestinationByName('ag-new', 'devin')).toMatchObject({
      target_type: 'agent',
      target_id: 'ag-third',
    });

    // Allowlisted for a2a. No room-contract post: ensureAgentRoom
    // itself posts nothing — the origin agent authors the intro, and
    // the contract data lives on the canvas.
    expect(fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')).toMatch(/^SLACK_A2A_ROOMS=.*G0ROOM/m);
    expect(fetchCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(0);

    // The canvas gets the contract data — every agent by plain name.
    expect(mockCreateRoomCanvas).toHaveBeenCalledWith(NEW_BOT_TOKEN, 'G0ROOM', {
      roomName: 'Pixel room',
      purpose: 'coordinate the redesign',
      creatorUserId: 'U0OPERATOR',
      agentNames: ['Andy', 'Devin', 'Pixel'],
    });
  });

  it('is idempotent: a second call creates nothing new and grows no second canvas', async () => {
    const now = new Date().toISOString();
    await createAgentGroup({ id: 'ag-new', name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: now });
    const participants = [
      { instanceKey: 'slack', botUserId: 'U0ORIGINBOT', agentGroupId: SRC_GROUP, agentGroupName: 'Andy' },
      { instanceKey: 'slack-pixel', botUserId: 'U0NEWBOT', agentGroupId: 'ag-new', agentGroupName: 'Pixel' },
    ];
    const args = {
      creator: participants[1]!,
      creatorBotToken: NEW_BOT_TOKEN,
      operatorUserId: 'U0OPERATOR',
      participants,
      roomName: 'Pixel room',
      rootDir: tmpDir,
    };

    await ensureAgentRoom(args);
    const mgCountAfterFirst = (await getAllMessagingGroups()).length;

    const second = await ensureAgentRoom(args);
    expect(second).toMatchObject({ roomChannelId: 'G0ROOM', created: false });
    expect((await getAllMessagingGroups()).length).toBe(mgCountAfterFirst);
    expect(fetchCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(0);
    expect(mockCreateRoomCanvas).toHaveBeenCalledTimes(1);
  });
});

describe('slack-aware create_agent — non-Slack parity', () => {
  it('non-slack session: behaves exactly as upstream, zero Slack side effects', async () => {
    await createMessagingGroup({
      id: 'mg-tg',
      channel_type: 'telegram',
      platform_id: 'tg:123',
      name: 'TG DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: new Date().toISOString(),
    });
    const tgSession: Session = { ...SLACK_SESSION, id: 'sess-tg', messaging_group_id: 'mg-tg' };
    await createSession(tgSession);
    const envBefore = fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
    const mgCountBefore = (await getAllMessagingGroups()).length;

    await runCreateAgent({ name: 'Helper' }, tgSession);

    expect(await getAgentGroupByFolder('helper')).toBeDefined(); // upstream leg ran
    expect(fetchCalls).toHaveLength(0);
    expect(fakeDeps.startChannelAdapter).not.toHaveBeenCalled();
    expect(fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8')).toBe(envBefore);
    expect((await getAllMessagingGroups()).length).toBe(mgCountBefore);
  });

  it('null messaging_group_id (task/a2a session): skips the Slack leg', async () => {
    const bareSession: Session = { ...SLACK_SESSION, id: 'sess-bare', messaging_group_id: null };
    await createSession(bareSession);

    await runCreateAgent({ name: 'Helper' }, bareSession);

    expect(await getAgentGroupByFolder('helper')).toBeDefined();
    expect(fetchCalls).toHaveLength(0);
    expect(fakeDeps.startChannelAdapter).not.toHaveBeenCalled();
  });
});

describe('slack-aware create_agent — failure and retry', () => {
  it('broker failure: group still exists, failure notify carries the finish command', async () => {
    brokerStatus = 500;

    await runCreateAgent({ name: 'Research' });

    const newGroup = await getAgentGroupByFolder('research');
    expect(newGroup).toBeDefined();
    expect(fetchCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(0);

    const failure = notifyTexts().at(-1)!;
    expect(failure).toContain("failed at step 'broker'");
    expect(failure).toContain('scripts/slack-agent-flow-finish.ts');
    expect(failure).toContain(`--group ${newGroup!.id}`);
    expect(failure).toContain('--name research');
    expect(failure).toContain(`--source-group ${SRC_GROUP}`);
    expect(failure).toContain('send_message({ to: "research", ... })');

    assertNoTokenLeak();
  });

  it('double invocation: upstream collision short-circuits — no duplicate rows, apps, posts, or nudges', async () => {
    await runCreateAgent({ name: 'Research' });
    const fetchCountAfterFirst = fetchCalls.length;
    const mgCountAfterFirst = (await getAllMessagingGroups()).length;

    await runCreateAgent({ name: 'Research' });

    expect(fetchCalls.length).toBe(fetchCountAfterFirst);
    expect((await getAllMessagingGroups()).length).toBe(mgCountAfterFirst);
    expect(fetchCalls.filter((c) => c.url.endsWith('/v1/apps'))).toHaveLength(1);
    expect(fetchCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(1);
    expect(notifyTexts().filter((t) => t.includes('introduction'))).toHaveLength(1);
    expect(notifyTexts().at(-1)).toContain('already have a destination named "research"');
  });

  it('finish-path retry after success: rows exist, so no second canvas, no posts, no intro nudge', async () => {
    mockCreateRoomCanvas.mockResolvedValue('F0CANVAS');
    await runCreateAgent({ name: 'Research' });
    const newGroup = (await getAgentGroupByFolder('research'))!;
    const postCountAfterFirst = fetchCalls.filter((c) => c.url.includes('chat.postMessage')).length;
    const notifyCountAfterFirst = mockNotifyWrite.mock.calls.length;

    // Operator re-runs the finish script — the S8/S11 created-gates hold.
    await finishSlackAgentFlow({ slug: 'research', sourceGroupId: SRC_GROUP, newAgentGroupId: newGroup.id });

    expect(fetchCalls.filter((c) => c.url.includes('chat.postMessage'))).toHaveLength(postCountAfterFirst);
    expect(mockCreateRoomCanvas).toHaveBeenCalledTimes(1);
    expect(mockWireCanvasComments).toHaveBeenCalledTimes(1);
    expect(mockNotifyWrite.mock.calls.length).toBe(notifyCountAfterFirst);
    expect(notifyTexts().filter((t) => t.includes('introduction'))).toHaveLength(1);
  });

  it('finish path aborts before wiring DB rows if the multi-instance module is missing', async () => {
    // Group exists (S1-S4 already ran) but the Slack leg never completed —
    // same starting state as the "broker failure" case above.
    brokerStatus = 500;
    await runCreateAgent({ name: 'Research' });
    const newGroup = (await getAgentGroupByFolder('research'))!;
    brokerStatus = 200; // retry succeeds at the broker step this time
    const mgCountBefore = (await getAllMessagingGroups()).length;

    mockAssertSlackInstancesModuleInstalled.mockRejectedValueOnce(
      new SlackFlowError(
        'adapter-start',
        'Slack channel payloads not installed — apply add-slack and slack-multi-instance first',
      ),
    );

    await expect(
      finishSlackAgentFlow({ slug: 'research', sourceGroupId: SRC_GROUP, newAgentGroupId: newGroup.id }),
    ).rejects.toThrow(/multi-instance/);

    // S6-S8 must not have run: no DM messaging group got wired for an
    // instance the runtime still can't start.
    expect((await getAllMessagingGroups()).length).toBe(mgCountBefore);
  });
});

describe('slack-aware create_agent — workspace install approval', () => {
  const INSTALL_URL = 'https://slack.com/oauth/v2/authorize?client_id=1.2&state=signed-state';

  /** Auto-install refused: the app is real, but the workspace must approve it. */
  function refuseAutoInstall(): void {
    brokerBotToken = null;
    brokerInstallUrl = INSTALL_URL;
    process.env.SLACK_INSTALL_POLL_MS = '1';
    process.env.SLACK_INSTALL_WAIT_MS = '120';
  }

  function env(): string {
    return fs.readFileSync(path.join(tmpDir, '.env'), 'utf-8');
  }

  function postedTexts(): string[] {
    return fetchCalls
      .filter((c) => c.url.includes('chat.postMessage'))
      .map((c) => (JSON.parse(c.body) as { text: string }).text);
  }

  it('tells the operator what to approve, then finishes the flow on the token the approval releases', async () => {
    refuseAutoInstall();
    appStateQueue = [{ status: 'pending_install' }, { status: 'installed', bot_token: NEW_BOT_TOKEN }];

    await runCreateAgent({ name: 'Research', instructions: 'dig deep' });

    // The heads-up goes out as the ORIGIN bot, in the conversation the create
    // was asked for — the origin agent's own reply could not be delivered
    // while this handler still holds the session.
    const notice = postedTexts()[0];
    expect(notice).toContain('needs an admin to approve');
    expect(notice).toContain(INSTALL_URL);
    const noticeCall = fetchCalls.find((c) => c.url.includes('chat.postMessage'))!;
    expect(noticeCall.token).toBe(ORIGIN_BOT_TOKEN);
    expect((JSON.parse(noticeCall.body) as { channel: string }).channel).toBe('D0OPDM');

    // From the token onward the flow is the ordinary one: adapter hot-add,
    // DM row + wiring, room, welcome DM.
    expect(env()).toMatch(/^SLACK_BOT_TOKEN_RESEARCH=/m);
    expect(env()).toMatch(/^SLACK_INSTANCES=.*research/m);
    expect(fakeDeps.startChannelAdapter).toHaveBeenCalledWith('slack-research');
    const newGroup = (await getAgentGroupByFolder('research'))!;
    const dmMg = await getMessagingGroupByPlatform('slack', 'slack:D0NEWDM', 'slack-research');
    expect(await getMessagingGroupAgentByPair(dmMg!.id, newGroup.id)).toBeDefined();
    expect(postedTexts().some((t) => t.includes("I'm Research, your new agent"))).toBe(true);

    // Exactly one app, and the consumed install link is retired.
    expect(fetchCalls.filter((c) => c.url.endsWith('/v1/apps'))).toHaveLength(1);
    expect(env()).toMatch(/^SLACK_INSTALL_URL_RESEARCH=$/m);

    const success = notifyTexts().at(-1)!;
    expect(success).toContain('is live on Slack');
    expect(success).toContain('approved the install');
    assertNoTokenLeak();
  });

  it('parks the app when the approval never lands, keeping every part of it for a resume', async () => {
    refuseAutoInstall();
    appStateQueue = [{ status: 'pending_install' }];

    await runCreateAgent({ name: 'Research' });

    // Nothing to re-create: app token, app id and the link are all on record.
    expect(env()).toMatch(/^SLACK_APP_TOKEN_RESEARCH=/m);
    expect(env()).toMatch(/^SLACK_APP_ID_RESEARCH=A0TEST$/m);
    expect(env()).toContain(`SLACK_INSTALL_URL_RESEARCH=${INSTALL_URL}`);
    expect(env()).not.toMatch(/^SLACK_BOT_TOKEN_RESEARCH=./m);
    // The wait really ran rather than falling straight through.
    expect(appStateReads).toBeGreaterThan(1);

    const failure = notifyTexts().at(-1)!;
    expect(failure).toContain("failed at step 'install-wait'");
    expect(failure).toContain('still waiting on a workspace install approval');
    expect(failure).toContain('nothing needs re-creating');
    expect(failure).toContain('finish setting up Research');
    assertNoTokenLeak();
  });

  it('asking again after a park resumes the parked app instead of provisioning a second one', async () => {
    refuseAutoInstall();
    appStateQueue = [{ status: 'pending_install' }];
    await runCreateAgent({ name: 'Research' });
    const groupCountAfterPark = (await getAgentGroupByFolder('research'))!.id;
    const postsAfterPark = postedTexts().length;

    // The operator approves the install, then asks for the same agent again.
    appStateQueue = [{ status: 'installed', bot_token: NEW_BOT_TOKEN }];
    appStateReads = 0;
    await runCreateAgent({ name: 'Research' });

    // One Slack app, one agent group — the second ask finished the first.
    expect(fetchCalls.filter((c) => c.url.endsWith('/v1/apps'))).toHaveLength(1);
    expect((await getAgentGroupByFolder('research'))!.id).toBe(groupCountAfterPark);
    expect(await getAgentGroupByFolder('research-2')).toBeUndefined();
    // Upstream's name-collision answer must not be what the user hears.
    expect(notifyTexts().at(-1)).not.toContain('already have a destination');
    expect(notifyTexts().at(-1)).toContain('is live on Slack');

    // A resume checks before it sleeps, so the standing approval is picked up
    // on the first read.
    expect(appStateReads).toBe(1);
    expect(postedTexts()[postsAfterPark]).toContain('Still waiting on your workspace');
    expect(env()).toMatch(/^SLACK_BOT_TOKEN_RESEARCH=/m);
    expect(await getMessagingGroupByPlatform('slack', 'slack:D0NEWDM', 'slack-research')).toBeDefined();
  });

  it('SLACK_INSTALL_WAIT_MS=0 parks immediately — a slow approval queue need not hold delivery open', async () => {
    refuseAutoInstall();
    process.env.SLACK_INSTALL_WAIT_MS = '0';
    appStateQueue = [{ status: 'pending_install' }];

    await runCreateAgent({ name: 'Research' });

    expect(appStateReads).toBe(0);
    // The operator still gets the link — the flow declines to wait, not to ask.
    expect(postedTexts()[0]).toContain(INSTALL_URL);
    expect(notifyTexts().at(-1)).toContain("failed at step 'install-wait'");
    expect(env()).toMatch(/^SLACK_APP_ID_RESEARCH=A0TEST$/m);
  });

  it('a refusal with no install link keeps the hand-finish instructions — there is nothing to wait for', async () => {
    brokerBotToken = null;
    brokerInstallUrl = '';
    process.env.SLACK_INSTALL_POLL_MS = '1';
    process.env.SLACK_INSTALL_WAIT_MS = '120';

    await runCreateAgent({ name: 'Research' });

    expect(appStateReads).toBe(0);
    expect(postedTexts()).toHaveLength(0);
    const failure = notifyTexts().at(-1)!;
    expect(failure).toContain("failed at step 'broker'");
    expect(failure).toContain('SLACK_BOT_TOKEN_RESEARCH');
  });

  it('polls through a service hiccup instead of treating it as a refusal', async () => {
    refuseAutoInstall();
    appStateQueue = [
      { http: 502, status: 'bad_gateway' },
      { status: 'installed', bot_token: NEW_BOT_TOKEN },
    ];

    await runCreateAgent({ name: 'Research' });

    expect(appStateReads).toBe(2);
    expect(notifyTexts().at(-1)).toContain('is live on Slack');
  });

  it('stops on a credential the service refuses — no later poll can change that answer', async () => {
    refuseAutoInstall();
    process.env.SLACK_INSTALL_WAIT_MS = '5000'; // never reached
    appStateQueue = [{ http: 401, status: 'unauthorized' }];

    await runCreateAgent({ name: 'Research' });

    expect(appStateReads).toBe(1);
    const failure = notifyTexts().at(-1)!;
    expect(failure).toContain("failed at step 'install-wait'");
    expect(failure).toContain('refused this install');
    assertNoTokenLeak();
  });

  it('a token released to someone else stops the wait rather than burning the whole budget', async () => {
    refuseAutoInstall();
    process.env.SLACK_INSTALL_WAIT_MS = '5000'; // never reached
    appStateQueue = [{ status: 'installed' }];

    await runCreateAgent({ name: 'Research' });

    expect(appStateReads).toBe(1);
    expect(notifyTexts().at(-1)).toContain("failed at step 'install-wait'");
  });
});
