/**
 * Binding a sandbox to its surface: one provider open per group, the
 * binding row, the messaging group in the PROVIDER'S spelling of the surface
 * + the wiring in session mode 'sandbox', adoption of a row the adapter
 * created first (its pending registration retired, no duplicate), the
 * coding session's default outbound route, what a repeat and a re-bind
 * after an archive do, a provider that has nothing to give, and the
 * onSandboxBound hook.
 */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../cli/resources/destinations.js', () => ({
  projectDestinationsToSessions: vi.fn(async () => {}),
}));
vi.mock('../../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../config.js')>();
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-session-surface-binding/data' };
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
import { SANDBOX_HOOKS_SEAM, onSandboxBound, resetSandboxHooksForTesting, type BoundSurface } from '../hooks.js';
import { bindSessionSurface } from './binding.js';
import { getSessionSurfaceByGroup, updateSessionSurface } from './db.js';
import type { SessionSurfaceProvider, SurfaceHandle, SurfaceSpelling } from './types.js';
import '../index.js';

const TEST_ROOT = '/tmp/nanoclaw-test-session-surface-binding';
const GROUP = { id: 'ag-bind-1', name: 'box', folder: 'box' };

/** The adapter's spelling, as a chat adapter encodes a conversation: `<adapter>:<conversation>`. */
const spell = async (surfaceId: string): Promise<SurfaceSpelling> => ({
  platformId: `chat:${surfaceId}`,
  instance: 'chat',
});

type OpenCall = { sandbox: string; title?: string; terminalAddress?: string };

function fakeProvider(over: Partial<Pick<SessionSurfaceProvider, 'open' | 'spell'>> = {}) {
  const opens: OpenCall[] = [];
  let n = 0;
  const provider = {
    spell,
    open: vi.fn(async (sandbox: { id: string }, options: { title?: string; terminalAddress?: string }) => {
      opens.push({ sandbox: sandbox.id, ...options });
      n += 1;
      return { surfaceId: `S${n}`, sessionId: sandbox.id } as SurfaceHandle;
    }),
    ...over,
  };
  return { provider, opens };
}

function bind(extra: Partial<Parameters<typeof bindSessionSurface>[0]> = {}, over = {}) {
  const { provider, opens } = fakeProvider(over);
  return {
    opens,
    provider,
    run: () => bindSessionSurface({ group: GROUP, channelType: 'chat', provider, ...extra }),
  };
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
  resetSandboxHooksForTesting();
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('bindSessionSurface', () => {
  it("opens the surface once, stores the row, and wires the group under the provider's spelling", async () => {
    const { run, opens } = bind();
    const bound = await run();
    expect(bound?.created).toBe(true);
    expect(opens).toEqual([{ sandbox: 'ag-bind-1', title: 'box' }]);

    const row = await getSessionSurfaceByGroup(GROUP.id);
    expect(row).toMatchObject({
      provider: 'chat',
      surface_id: 'S1',
      session_id: 'ag-bind-1',
      title: 'box',
      last_status: null,
      stopped_at: null,
      last_turn_seq: 0,
      archived_at: null,
    });

    // Exactly one messaging group, in the adapter's form — never a bare id.
    const rows = await getMessagingGroupsByChannel('chat');
    expect(rows.map((r) => r.platform_id)).toEqual(['chat:S1']);
    const mg = rows[0];
    expect(mg).toMatchObject({ instance: 'chat', is_group: 1, unknown_sender_policy: 'public', name: 'box' });
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
    const { run } = bind({}, { spell: async (id: string) => ({ platformId: `chat:${id}`, instance: 'chat-second' }) });
    await run();
    expect(await getMessagingGroupByPlatform('chat', 'chat:S1', 'chat-second')).toBeTruthy();
    expect(await getMessagingGroupByPlatform('chat', 'chat:S1', 'chat')).toBeUndefined();
  });

  it('is idempotent: a second bind returns the same row without a second open or wiring', async () => {
    const { run, opens } = bind();
    const first = await run();
    const second = await run();
    expect(second?.created).toBe(false);
    expect(second?.row.surface_id).toBe(first?.row.surface_id);
    expect(opens).toHaveLength(1);
    expect(await getMessagingGroupsByChannel('chat')).toHaveLength(1);
    expect(await getMessagingGroupAgents(first!.row.messaging_group_id!)).toHaveLength(1);
    expect(projectDestinationsToSessions).toHaveBeenCalledTimes(1);
  });

  it("a message on the wired surface resolves to the group's coding session, not a chat session", async () => {
    const { run } = bind();
    const bound = await run();
    const { session } = await resolveSession(GROUP.id, bound!.row.messaging_group_id, null, 'sandbox');
    expect(session.thread_id).toBe(SANDBOX_SYSTEM_THREAD_ID);
    expect(session.messaging_group_id).toBeNull();
    const again = await resolveSession(GROUP.id, bound!.row.messaging_group_id, 'some-thread', 'sandbox');
    expect(again.session.id).toBe(session.id);
  });

  it('after an archive a new bind opens a fresh surface', async () => {
    const { run, opens } = bind();
    await run();
    await updateSessionSurface(GROUP.id, { archived_at: '2026-09-11T12:00:00.000Z' });

    const rebound = await run();
    expect(rebound?.created).toBe(true);
    expect(opens).toHaveLength(2);
    const row = await getSessionSurfaceByGroup(GROUP.id);
    expect(row).toMatchObject({ surface_id: 'S2', archived_at: null });
    const mg2 = await getMessagingGroupByPlatform('chat', 'chat:S2', 'chat');
    expect(await getMessagingGroupAgents(mg2!.id)).toHaveLength(1);
  });

  it('a title override and a terminal address ride the open; the sandbox name is the default title', async () => {
    const { run, opens } = bind({ title: 'Status page', terminalAddress: 'box.example.test' });
    await run();
    expect(opens[0]).toEqual({ sandbox: 'ag-bind-1', title: 'Status page', terminalAddress: 'box.example.test' });
    expect((await getSessionSurfaceByGroup(GROUP.id))!.title).toBe('Status page');
  });

  it('a provider with nothing to give (null, or a throw) leaves a plain sandbox: no row, no wiring', async () => {
    const { run } = bind({}, { open: async () => null });
    expect(await run()).toBeNull();
    const { run: failing } = bind(
      {},
      {
        open: async () => {
          throw new Error('platform down');
        },
      },
    );
    expect(await failing()).toBeNull();
    expect(await getSessionSurfaceByGroup(GROUP.id)).toBeUndefined();
    expect(await getMessagingGroupsByChannel('chat')).toHaveLength(0);
  });

  it('a sandbox already bound on another platform refuses a second surface — the first binding stays', async () => {
    const { run } = bind();
    const first = await run();
    const other = fakeProvider();
    const second = await bindSessionSurface({ group: GROUP, channelType: 'other-chat', provider: other.provider });
    expect(second).toBeNull();
    expect(other.provider.open).not.toHaveBeenCalled();
    expect(await getSessionSurfaceByGroup(GROUP.id)).toMatchObject({
      provider: 'chat',
      surface_id: first!.row.surface_id,
    });
    expect(await getMessagingGroupsByChannel('other-chat')).toHaveLength(0);
  });

  it('fires onSandboxBound once the row and the wiring exist', async () => {
    const seen: BoundSurface[] = [];
    onSandboxBound('t', (_group, surface) => void seen.push(surface), { seam: SANDBOX_HOOKS_SEAM });
    const { run } = bind();
    const bound = await run();
    expect(seen).toEqual([
      { channelType: 'chat', surfaceId: 'S1', sessionId: 'ag-bind-1', messagingGroupId: bound!.row.messaging_group_id },
    ]);
    await run();
    expect(seen).toHaveLength(1); // a repeat bind is not a new binding
  });
});

describe('bindSessionSurface — adopting the adapter-created conversation', () => {
  it('a row the adapter already wrote for the surface is wired, not duplicated, and its registration card retired', async () => {
    // The bot was invited and spoke before the host bound: the router
    // auto-created the row (name null, request_approval) and raised a card.
    await createMessagingGroup({
      id: 'mg-adapter',
      channel_type: 'chat',
      platform_id: 'chat:S1',
      instance: 'chat',
      name: null,
      is_group: 1,
      unknown_sender_policy: 'request_approval',
      created_at: new Date().toISOString(),
    });
    await getDb().run(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at, title, question, options_json)
       VALUES ('mg-adapter', 'ag-bind-1', '{}', 'chat:U1', '2026-09-12T00:00:00.000Z', 'New channel', 'Connect?', '[]')`,
    );

    const { run } = bind();
    const bound = await run();
    expect(bound?.row.messaging_group_id).toBe('mg-adapter');
    expect(await getMessagingGroupsByChannel('chat')).toHaveLength(1);
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
    expect(second?.row.messaging_group_id).toBe(first?.row.messaging_group_id);
    expect(await getMessagingGroupsByChannel('chat')).toHaveLength(1);
    expect(await getMessagingGroupAgents(first!.row.messaging_group_id!)).toHaveLength(1);
  });
});

describe('bindSessionSurface — the default outbound route', () => {
  const SURFACE_ROUTE = { channel_type: 'chat', platform_id: 'chat:S1', thread_id: null };

  it("points the coding session's routing at the surface, thread null (top level)", async () => {
    // As `sandboxes new` does: the coding session exists before the bind.
    await resolveSandboxSession(GROUP.id);
    const { run } = bind();
    await run();
    expect(await sandboxRouting()).toEqual(SURFACE_ROUTE);
  });

  it('an existing sandbox session gets the route too, and a repeat bind keeps it', async () => {
    const { session } = await resolveSandboxSession(GROUP.id);
    expect(routingOf(session.id)).toBeUndefined(); // no chat of its own yet
    const { run } = bind();
    await run();
    expect(routingOf(session.id)).toEqual(SURFACE_ROUTE);
    await run();
    expect(await sandboxRouting()).toEqual(SURFACE_ROUTE);
  });
});
