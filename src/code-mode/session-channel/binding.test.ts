/**
 * Binding a sandbox to its channel: one service create per group, the
 * binding row, the messaging group in the ADAPTER'S spelling of the channel
 * + the wiring in session mode 'sandbox', adoption of a row the adapter
 * created first (its pending registration retired, no duplicate), the
 * coding session's default outbound route, and what a repeat, a re-bind
 * after an archive, and the bot identity do.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/resources/destinations.js', () => ({
  projectDestinationsToSessions: vi.fn(async () => {}),
}));
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-channel-binding/data' };
});

import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  createMessagingGroup,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  getMessagingGroupsByChannel,
} from '../../db/messaging-groups.js';
import { SANDBOX_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSandboxSession, resolveSession } from '../../session-manager.js';
import { bindSessionChannel, type ChannelAddress } from './binding.js';
import type { ChannelRecord } from './client.js';
import { getSessionChannelByGroup, updateSessionChannel } from './db.js';
import '../index.js';

const TEST_ROOT = '/tmp/nanoclaw-test-session-channel-binding';
const GROUP = { id: 'ag-bind-1', name: 'box', folder: 'box' };
const CREDS = { serviceBase: 'https://slack.example.test', appId: 'A1' };

/** The adapter's spelling, as the Slack chat adapter encodes a channel: `<adapter>:<channel>`. */
const address = (channelId: string): ChannelAddress => ({ platformId: `slack:${channelId}`, instance: 'slack' });

type CreateInput = { appId: string; sessionId: string; title: string; botUserId?: string; teamId?: string };

function fakeCreate() {
  const calls: CreateInput[] = [];
  let n = 0;
  const client = {
    create: vi.fn(async (input: CreateInput) => {
      calls.push(input);
      n += 1;
      const channel: ChannelRecord = { channelId: `C${n}`, sessionId: input.sessionId, status: 'active' };
      return { channel, created: true };
    }),
  };
  return { client, calls };
}

function bind(extra: Partial<Parameters<typeof bindSessionChannel>[0]> = {}) {
  const { client, calls } = fakeCreate();
  return { calls, run: () => bindSessionChannel({ group: GROUP, credentials: CREDS, client, address, ...extra }) };
}

/** The default outbound route the host wrote into a session's mailbox (the row the runner's `outbox send` reads). */
function routingOf(sessionId: string): unknown {
  const db = new Database(inboundDbPath(GROUP.id, sessionId), { readonly: true });
  try {
    return db.prepare('SELECT channel_type, platform_id, thread_id FROM session_routing').get();
  } finally {
    db.close();
  }
}

async function sandboxRouting(): Promise<unknown> {
  const { session } = await resolveSandboxSession(GROUP.id);
  return routingOf(session.id);
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ ...GROUP, agent_provider: null, created_at: new Date().toISOString() });
  vi.mocked(projectDestinationsToSessions).mockClear();
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('bindSessionChannel', () => {
  it("creates the channel once, stores the row, and wires the group under the adapter's spelling", async () => {
    const { run, calls } = bind();
    const bound = await run();
    expect(bound.created).toBe(true);
    expect(calls).toEqual([{ appId: 'A1', sessionId: 'ag-bind-1', title: 'box' }]);

    const row = await getSessionChannelByGroup(GROUP.id);
    expect(row).toMatchObject({
      channel_id: 'C1',
      session_id: 'ag-bind-1',
      service_base: CREDS.serviceBase,
      app_id: 'A1',
      title: 'box',
      last_status: null,
      stopped_at: null,
      last_turn_seq: 0,
      archived_at: null,
    });

    // Exactly one messaging group, in the adapter's form — never a bare id.
    const rows = await getMessagingGroupsByChannel('slack');
    expect(rows.map((r) => r.platform_id)).toEqual(['slack:C1']);
    const mg = rows[0];
    expect(mg).toMatchObject({ instance: 'slack', is_group: 1, unknown_sender_policy: 'public', name: 'box' });
    expect(row!.messaging_group_id).toBe(mg.id);
    const wirings = await getMessagingGroupAgents(mg.id);
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({
      agent_group_id: GROUP.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      session_mode: 'sandbox',
      threads: 0,
    });
    expect(projectDestinationsToSessions).toHaveBeenCalledWith(GROUP.id);
  });

  it('uses the instance the adapter runs under, not the platform name', async () => {
    const { run } = bind({ address: (id) => ({ platformId: `slack:${id}`, instance: 'slack-second' }) });
    await run();
    expect(await getMessagingGroupByPlatform('slack', 'slack:C1', 'slack-second')).toBeTruthy();
    expect(await getMessagingGroupByPlatform('slack', 'slack:C1', 'slack')).toBeUndefined();
  });

  it('is idempotent: a second bind returns the same row without a second create or wiring', async () => {
    const { run, calls } = bind();
    const first = await run();
    const second = await run();
    expect(second.created).toBe(false);
    expect(second.row.channel_id).toBe(first.row.channel_id);
    expect(calls).toHaveLength(1);
    expect(await getMessagingGroupsByChannel('slack')).toHaveLength(1);
    expect(await getMessagingGroupAgents(first.row.messaging_group_id!)).toHaveLength(1);
    expect(projectDestinationsToSessions).toHaveBeenCalledTimes(1);
  });

  it("a message on the wired channel resolves to the group's coding session, not a chat session", async () => {
    const { run } = bind();
    const bound = await run();
    const { session } = await resolveSession(GROUP.id, bound.row.messaging_group_id, null, 'sandbox');
    expect(session.thread_id).toBe(SANDBOX_SYSTEM_THREAD_ID);
    expect(session.messaging_group_id).toBeNull();
    const again = await resolveSession(GROUP.id, bound.row.messaging_group_id, 'some-thread', 'sandbox');
    expect(again.session.id).toBe(session.id);
  });

  it('after an archive a new bind opens a fresh channel under a suffixed session id', async () => {
    const { run, calls } = bind();
    await run();
    const archivedAt = '2026-09-11T12:00:00.000Z';
    await updateSessionChannel(GROUP.id, { archived_at: archivedAt });

    const rebound = await run();
    expect(rebound.created).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].sessionId).toBe(`ag-bind-1.${Date.parse(archivedAt).toString(36)}`);
    const row = await getSessionChannelByGroup(GROUP.id);
    expect(row).toMatchObject({ channel_id: 'C2', archived_at: null, session_id: calls[1].sessionId });
    const mg2 = await getMessagingGroupByPlatform('slack', 'slack:C2', 'slack');
    expect(await getMessagingGroupAgents(mg2!.id)).toHaveLength(1);
  });

  it('a title override names the channel; the sandbox name is the default', async () => {
    const { run, calls } = bind({ title: 'Portal work' });
    await run();
    expect(calls[0].title).toBe('Portal work');
    expect((await getSessionChannelByGroup(GROUP.id))!.title).toBe('Portal work');
  });
});

describe('bindSessionChannel — adopting the adapter-created conversation', () => {
  it('a row the adapter already wrote for the channel is wired, not duplicated, and its registration card retired', async () => {
    // The bot was invited and spoke before the host bound: the router
    // auto-created the row (name null, request_approval) and raised a card.
    await createMessagingGroup({
      id: 'mg-adapter',
      channel_type: 'slack',
      platform_id: 'slack:C1',
      instance: 'slack',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });
    await getDb().run(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title, question, options_json)
       VALUES ('mg-adapter', 'ag-bind-1', '{}', 'slack:U1', '2026-09-12T00:00:00.000Z', 'New channel', 'Connect?', '[]')`,
    );

    const { run } = bind();
    const bound = await run();
    expect(bound.row.messaging_group_id).toBe('mg-adapter');
    expect(await getMessagingGroupsByChannel('slack')).toHaveLength(1);
    const wirings = await getMessagingGroupAgents('mg-adapter');
    expect(wirings).toHaveLength(1);
    expect(wirings[0]).toMatchObject({ agent_group_id: GROUP.id, session_mode: 'sandbox' });
    const pending = await getDb().get(
      'SELECT 1 AS x FROM pending_channel_approvals WHERE messaging_group_id = ?',
      'mg-adapter',
    );
    expect(pending).toBeUndefined();
  });

  it('re-binding once the row exists adopts it again: still one row, one wiring', async () => {
    const { run } = bind();
    const first = await run();
    const second = await run();
    expect(second.row.messaging_group_id).toBe(first.row.messaging_group_id);
    expect(await getMessagingGroupsByChannel('slack')).toHaveLength(1);
    expect(await getMessagingGroupAgents(first.row.messaging_group_id!)).toHaveLength(1);
  });
});

describe('bindSessionChannel — the default outbound route', () => {
  const CHANNEL_ROUTE = { channel_type: 'slack', platform_id: 'slack:C1', thread_id: null };

  it("points the coding session's routing at the channel, thread null (top level)", async () => {
    // As `sandboxes new` does: the coding session exists before the bind.
    await resolveSandboxSession(GROUP.id);
    const { run } = bind();
    await run();
    expect(await sandboxRouting()).toEqual(CHANNEL_ROUTE);
  });

  it('an existing sandbox session gets the route too, and a repeat bind keeps it', async () => {
    const { session } = await resolveSandboxSession(GROUP.id);
    expect(routingOf(session.id)).toBeUndefined(); // no chat of its own yet
    const { run } = bind();
    await run();
    expect(routingOf(session.id)).toEqual(CHANNEL_ROUTE);
    await run();
    expect(await sandboxRouting()).toEqual(CHANNEL_ROUTE);
  });
});

describe('bindSessionChannel — the bot identity on create', () => {
  it('a resolved identity rides the create as botUserId and teamId', async () => {
    const resolveBotIdentity = vi.fn(async () => ({ botUserId: 'U0BOT1', teamId: 'T0TEAM1' }));
    const { run, calls } = bind({ resolveBotIdentity });
    await run();
    expect(calls).toEqual([
      { appId: 'A1', sessionId: 'ag-bind-1', title: 'box', botUserId: 'U0BOT1', teamId: 'T0TEAM1' },
    ]);
  });

  it('an identity without a workspace sends only the user id', async () => {
    const { run, calls } = bind({ resolveBotIdentity: async () => ({ botUserId: 'U0BOT1' }) });
    await run();
    expect(calls[0]).toEqual({ appId: 'A1', sessionId: 'ag-bind-1', title: 'box', botUserId: 'U0BOT1' });
  });

  it('no identity (null) or a failing lookup falls back to the plain create and still binds', async () => {
    const { run, calls } = bind({ resolveBotIdentity: async () => null });
    const bound = await run();
    expect(bound.created).toBe(true);
    expect(calls[0]).toEqual({ appId: 'A1', sessionId: 'ag-bind-1', title: 'box' });

    await updateSessionChannel(GROUP.id, { archived_at: '2026-09-11T12:00:00.000Z' });
    const { run: rerun, calls: recalls } = bind({
      resolveBotIdentity: async () => {
        throw new Error('platform down');
      },
    });
    const rebound = await rerun();
    expect(rebound.created).toBe(true);
    expect(recalls[0]).not.toHaveProperty('botUserId');
  });

  it('an existing binding is returned without consulting the identity at all', async () => {
    const { run } = bind();
    await run();
    const resolveBotIdentity = vi.fn(async () => ({ botUserId: 'U0BOT1' }));
    const { run: again } = bind({ resolveBotIdentity });
    const result = await again();
    expect(result.created).toBe(false);
    expect(resolveBotIdentity).not.toHaveBeenCalled();
  });
});
