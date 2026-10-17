/**
 * Regression test: `ncl messaging-groups create` must satisfy the NOT NULL
 * `instance` column without an operator-supplied `--instance`. The column has
 * no CLI flag at the operator's altitude (the default instance IS the channel
 * type), so the generic CRUD insert defaults it to `channel_type` — matching
 * `createMessagingGroup`'s `instance ?? channel_type` fallback on the router
 * path. Delete the `instance` column / `defaultFrom` wiring in
 * `messaging-groups.ts` and this goes red: the insert fails the NOT NULL.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cli-msggroups' };
});

const TEST_DIR = '/tmp/nanoclaw-test-cli-msggroups';

import type { ChannelDefaults } from '../../channels/adapter.js';
import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup, getDb } from '../../db/index.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder } from '../../session-manager.js';
import { dispatch } from '../dispatch.js';
import { projectDestinationsToSessions } from './destinations.js';
// Side-effect import: registers the `messaging-groups-*` commands.
import './messaging-groups.js';

// Registration-tier declaration (no live adapter) — the environment `ncl`
// sees for offline instances and setup scripts.
const declared: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};
registerChannelAdapter('declchan-mg', { factory: () => null, defaults: declared });

describe('messaging-groups CLI create defaults instance to channel_type', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('create without --instance sets instance = channel_type', async () => {
    // caller: 'host' is the post-approval re-entry path for create (approval op).
    const resp = await dispatch(
      {
        id: 'req-1',
        command: 'messaging-groups-create',
        args: { channel_type: 'telegram', platform_id: '12345' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    const row = await getMessagingGroupByPlatform('telegram', '12345');
    expect(row).toBeDefined();
    expect(row?.instance).toBe('telegram');
  });

  it('create with an explicit --instance keeps that value', async () => {
    const resp = await dispatch(
      {
        id: 'req-2',
        command: 'messaging-groups-create',
        args: { channel_type: 'telegram', platform_id: '67890', instance: 'work' },
      },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('telegram', '67890', 'work'))?.instance).toBe('work');
  });
});

describe('messaging-groups CLI create resolves unknown_sender_policy from the channel declaration', () => {
  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  const create = (args: Record<string, unknown>, id: string) =>
    dispatch({ id, command: 'messaging-groups-create', args }, { caller: 'host' });

  it('DM context takes the declared dm policy', async () => {
    const resp = await create({ channel_type: 'declchan-mg', platform_id: 'dm-1' }, 'req-d1');
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('declchan-mg', 'dm-1'))?.unknown_sender_policy).toBe('public');
  });

  it('group context takes the declared group policy', async () => {
    const resp = await create({ channel_type: 'declchan-mg', platform_id: 'g-1', is_group: '1' }, 'req-d2');
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('declchan-mg', 'g-1'))?.unknown_sender_policy).toBe('request_approval');
  });

  it('explicit --unknown-sender-policy wins over the declaration', async () => {
    const resp = await create(
      { channel_type: 'declchan-mg', platform_id: 'dm-2', unknown_sender_policy: 'strict' },
      'req-d3',
    );
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('declchan-mg', 'dm-2'))?.unknown_sender_policy).toBe('strict');
  });

  it("undeclared channels keep the legacy static 'strict' default (back-compat)", async () => {
    const resp = await create({ channel_type: 'stalechan-mg', platform_id: 's-1' }, 'req-d4');
    expect(resp.ok).toBe(true);
    expect((await getMessagingGroupByPlatform('stalechan-mg', 's-1'))?.unknown_sender_policy).toBe('strict');
  });
});

describe('messaging-groups CLI delete cascades dependent rows', () => {
  const AG = 'ag-mg-del';
  const MG = 'mg-target';
  const OTHER = 'mg-other';
  const UID = 'tg:42';
  const now = () => new Date().toISOString();
  const count = async (sql: string, ...params: unknown[]) => (await getDb().get<{ c: number }>(sql, ...params))!.c;

  /** One session plus every kind of row that points at the messaging group or that session. */
  async function seed(mgId: string, channelType: string, sessionId: string): Promise<void> {
    const db = getDb();
    await db.run(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, 'chat', 1, 'strict', ?)`,
      mgId,
      channelType,
      `${mgId}-platform`,
      channelType,
      now(),
    );
    await createSession({
      id: sessionId,
      agent_group_id: AG,
      messaging_group_id: mgId,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: now(),
    });
    await db.run(
      `INSERT INTO pending_questions (question_id, session_id, message_out_id, title, options_json, created_at)
       VALUES (?, ?, 'mout-1', 'q', '[]', ?)`,
      `q-${sessionId}`,
      sessionId,
      now(),
    );
    await db.run(
      `INSERT INTO pending_approvals (approval_id, session_id, request_id, action, payload, created_at, agent_group_id, status, title, options_json)
       VALUES (?, ?, 'req-1', 'cli_command', '{}', ?, ?, 'pending', '', '[]')`,
      `pa-${sessionId}`,
      sessionId,
      now(),
      AG,
    );
    await db.run(`INSERT INTO session_claims (session_id, incarnation, updated_at) VALUES (?, 1, ?)`, sessionId, now());
    await db.run(
      `INSERT INTO delivery_attempts (message_id, session_id, attempts) VALUES (?, ?, 1)`,
      `out-${sessionId}`,
      sessionId,
    );
    await db.run(
      `INSERT INTO wake_signals (id, session_id, reason, created_at) VALUES (?, ?, 'mail', ?)`,
      `wake-${sessionId}`,
      sessionId,
      now(),
    );
    await db.run(
      `INSERT INTO agent_destinations (agent_group_id, local_name, target_type, target_id, created_at)
       VALUES (?, ?, 'channel', ?, ?)`,
      AG,
      `dest-${mgId}`,
      mgId,
      now(),
    );
    await db.run(
      `INSERT INTO user_dms (user_id, channel_type, messaging_group_id, resolved_at) VALUES (?, ?, ?, ?)`,
      UID,
      channelType,
      mgId,
      now(),
    );
    await db.run(
      `INSERT INTO pending_sender_approvals (id, messaging_group_id, agent_group_id, sender_identity, sender_name, original_message, approver_user_id, created_at)
       VALUES (?, ?, ?, 'tg:99', 'them', '{}', ?, ?)`,
      `psa-${mgId}`,
      mgId,
      AG,
      UID,
      now(),
    );
    await db.run(
      `INSERT INTO pending_channel_approvals (messaging_group_id, agent_group_id, original_message, approver_user_id, created_at)
       VALUES (?, ?, '{}', ?, ?)`,
      mgId,
      AG,
      UID,
      now(),
    );
    await db.run(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
       VALUES (?, ?, ?, 'mention', 'all', 'drop', 'shared', 0, ?)`,
      `mga-${mgId}`,
      mgId,
      AG,
      now(),
    );
  }

  /** Rows still pointing at a messaging group or its session, keyed like the delete's `removed`. */
  async function remaining(mgId: string, sessionId: string): Promise<Record<string, number>> {
    const bySession = (table: string) => count(`SELECT COUNT(*) AS c FROM ${table} WHERE session_id = ?`, sessionId);
    return {
      pending_questions: await bySession('pending_questions'),
      pending_approvals: await bySession('pending_approvals'),
      session_claims: await bySession('session_claims'),
      delivery_attempts: await bySession('delivery_attempts'),
      wake_signals: await bySession('wake_signals'),
      sessions: await count('SELECT COUNT(*) AS c FROM sessions WHERE messaging_group_id = ?', mgId),
      agent_destinations: await count(
        "SELECT COUNT(*) AS c FROM agent_destinations WHERE target_type = 'channel' AND target_id = ?",
        mgId,
      ),
      user_dms: await count('SELECT COUNT(*) AS c FROM user_dms WHERE messaging_group_id = ?', mgId),
      pending_sender_approvals: await count(
        'SELECT COUNT(*) AS c FROM pending_sender_approvals WHERE messaging_group_id = ?',
        mgId,
      ),
      pending_channel_approvals: await count(
        'SELECT COUNT(*) AS c FROM pending_channel_approvals WHERE messaging_group_id = ?',
        mgId,
      ),
      messaging_group_agents: await count(
        'SELECT COUNT(*) AS c FROM messaging_group_agents WHERE messaging_group_id = ?',
        mgId,
      ),
    };
  }

  const allOnes = {
    pending_questions: 1,
    pending_approvals: 1,
    session_claims: 1,
    delivery_attempts: 1,
    wake_signals: 1,
    sessions: 1,
    agent_destinations: 1,
    user_dms: 1,
    pending_sender_approvals: 1,
    pending_channel_approvals: 1,
    messaging_group_agents: 1,
  };

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    await runMigrations(await initTestDb());
    await createAgentGroup({ id: AG, name: 'mg-del', folder: 'mg-del', agent_provider: null, created_at: now() });
    await getDb().run(
      `INSERT INTO users (id, kind, display_name, created_at) VALUES (?, 'telegram', 'someone', ?)`,
      UID,
      now(),
    );
    await seed(MG, 'telegram', 'sess-target');
    await seed(OTHER, 'discord', 'sess-other');
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('deletes a messaging group with dependents and leaves an unrelated group untouched', async () => {
    // Foreign keys are enforced: the old one-row delete fails on these dependents.
    await expect(getDb().run('DELETE FROM messaging_groups WHERE id = ?', MG)).rejects.toThrow(/FOREIGN KEY/);

    const resp = await dispatch(
      { id: 'req-mg-del', command: 'messaging-groups-delete', args: { id: MG } },
      { caller: 'host' },
    );

    expect(resp).toEqual({ id: 'req-mg-del', ok: true, data: { deleted: MG, removed: allOnes } });
    expect(await count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MG)).toBe(0);
    expect(Object.values(await remaining(MG, 'sess-target')).every((n) => n === 0)).toBe(true);

    expect(await count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', OTHER)).toBe(1);
    expect(await remaining(OTHER, 'sess-other')).toEqual(allOnes);
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', AG)).toBe(1);
    expect(await count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
  });

  it("drops the deleted chat from a surviving session's inbound.db destinations", async () => {
    const projected = () => {
      const db = new Database(inboundDbPath(AG, 'sess-other'), { readonly: true });
      const names = (db.prepare('SELECT name FROM destinations ORDER BY name').all() as Array<{ name: string }>).map(
        (row) => row.name,
      );
      db.close();
      return names;
    };
    initSessionFolder(AG, 'sess-other');
    await projectDestinationsToSessions(AG);
    expect(projected()).toEqual([`dest-${OTHER}`, `dest-${MG}`]);

    const resp = await dispatch(
      { id: 'req-mg-del-proj', command: 'messaging-groups-delete', args: { id: MG } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect(projected()).toEqual([`dest-${OTHER}`]);
  });

  it('returns a handler error for an unknown messaging group id', async () => {
    const resp = await dispatch(
      { id: 'req-mg-missing', command: 'messaging-groups-delete', args: { id: 'mg-does-not-exist' } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(false);
    expect((resp as { ok: false; error: { code: string; message: string } }).error).toMatchObject({
      code: 'handler-error',
      message: expect.stringMatching(/not found/i),
    });
  });
});
