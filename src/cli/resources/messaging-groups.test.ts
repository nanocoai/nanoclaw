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
import { bindUnboundSession, createSession, unbindSession } from '../../db/sessions.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import * as sessionManager from '../../session-manager.js';
import { initSessionFolder, resolveSession, writeSessionRouting } from '../../session-manager.js';
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
    await db.run(
      `INSERT INTO unregistered_senders (channel_type, platform_id, reason, messaging_group_id, first_seen, last_seen)
       VALUES (?, ?, 'no_agent_engaged', ?, ?, ?)`,
      channelType,
      `${mgId}-platform`,
      mgId,
      now(),
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
      unregistered_senders: await count(
        'SELECT COUNT(*) AS c FROM unregistered_senders WHERE messaging_group_id = ?',
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
    unregistered_senders: 1,
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
    vi.restoreAllMocks();
    vi.useRealTimers();
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

    expect(resp).toEqual({
      id: 'req-mg-del',
      ok: true,
      data: { deleted: MG, removed: allOnes, kept_sessions: [] },
    });
    expect(await count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', MG)).toBe(0);
    expect(Object.values(await remaining(MG, 'sess-target')).every((n) => n === 0)).toBe(true);

    expect(await count('SELECT COUNT(*) AS c FROM messaging_groups WHERE id = ?', OTHER)).toBe(1);
    expect(await remaining(OTHER, 'sess-other')).toEqual(allOnes);
    expect(await count('SELECT COUNT(*) AS c FROM agent_groups WHERE id = ?', AG)).toBe(1);
    expect(await count('SELECT COUNT(*) AS c FROM users WHERE id = ?', UID)).toBe(1);
  });

  describe('the session agent-shared chats reuse', () => {
    const SHARED_AG = 'ag-shared';
    const SHARED = 'sess-agent-shared';

    async function wire(mgId: string, mode: 'shared' | 'agent-shared'): Promise<void> {
      await getDb().run(
        `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, engage_mode, sender_scope, ignored_message_policy, session_mode, priority, created_at)
         VALUES (?, ?, ?, 'mention', 'all', 'drop', ?, 0, ?)`,
        `mga-shared-${mgId}`,
        mgId,
        SHARED_AG,
        mode,
        now(),
      );
    }

    async function session(id: string, threadId: string | null, createdAt: string): Promise<void> {
      await createSession({
        id,
        agent_group_id: SHARED_AG,
        messaging_group_id: MG,
        thread_id: threadId,
        agent_provider: null,
        status: 'active',
        container_status: 'stopped',
        last_active: null,
        created_at: createdAt,
      });
    }

    const deleteMg = async () => {
      const resp = await dispatch(
        { id: 'req-mg-del-shared', command: 'messaging-groups-delete', args: { id: MG } },
        { caller: 'host' },
      );
      expect(resp.ok).toBe(true);
      return (
        resp as {
          ok: true;
          data: {
            removed: Record<string, number>;
            kept_sessions: Array<{ id: string; messaging_group_id: string | null }>;
          };
        }
      ).data;
    };

    beforeEach(async () => {
      await createAgentGroup({
        id: SHARED_AG,
        name: 'shared',
        folder: 'shared',
        agent_provider: null,
        created_at: now(),
      });
    });

    it("moves it to the agent's other agent-shared chat, with its routing and its cards elsewhere", async () => {
      await wire(MG, 'agent-shared');
      await wire(OTHER, 'agent-shared');
      // Started in MG, so it carries MG's id while serving OTHER too.
      await session(SHARED, null, now());
      for (const [questionId, channelType, mgId] of [
        ['q-in-mg', 'telegram', MG],
        ['q-in-other', 'discord', OTHER],
      ]) {
        await getDb().run(
          `INSERT INTO pending_questions (question_id, session_id, message_out_id, platform_id, channel_type, title, options_json, created_at)
           VALUES (?, ?, 'mout', ?, ?, 'q', '[]', ?)`,
          questionId,
          SHARED,
          `${mgId}-platform`,
          channelType,
          now(),
        );
      }
      initSessionFolder(SHARED_AG, SHARED);
      await writeSessionRouting(SHARED_AG, SHARED);
      const routing = () => {
        const inbound = new Database(inboundDbPath(SHARED_AG, SHARED), { readonly: true });
        const row = inbound.prepare('SELECT channel_type, platform_id FROM session_routing').get();
        inbound.close();
        return row;
      };
      expect(routing()).toEqual({ channel_type: 'telegram', platform_id: `${MG}-platform` });

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: OTHER }]);
      expect(data.removed.sessions).toBe(1); // only the shared-mode sess-target
      expect(data.removed.pending_questions).toBe(2); // sess-target's, and the kept session's card in MG
      expect(await getDb().get('SELECT messaging_group_id, thread_id FROM sessions WHERE id = ?', SHARED)).toEqual({
        messaging_group_id: OTHER,
        thread_id: null,
      });
      expect(await getDb().all('SELECT question_id FROM pending_questions WHERE session_id = ?', SHARED)).toEqual([
        { question_id: 'q-in-other' },
      ]);
      // Cards follow the bound chat: they now go to OTHER, not the deleted chat.
      expect(routing()).toEqual({ channel_type: 'discord', platform_id: `${OTHER}-platform` });
      expect(await resolveSession(SHARED_AG, OTHER, null, 'agent-shared')).toMatchObject({
        created: false,
        session: { id: SHARED },
      });
    });

    it('keeps it with no chat when this was the only agent-shared chat; agent-to-agent still reuses it', async () => {
      await wire(MG, 'agent-shared');
      await session(SHARED, null, now());

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: null }]);
      expect(await resolveSession(SHARED_AG, null, null, 'agent-shared')).toMatchObject({
        created: false,
        session: { id: SHARED },
      });
    });

    it("keeps the session reuse picks even when this chat's own wiring is not agent-shared", async () => {
      await wire(MG, 'shared');
      await wire(OTHER, 'agent-shared');
      await session('sess-older', null, '2026-01-01T00:00:00.000Z');
      await session(SHARED, 'thread-1', '2026-01-02T00:00:00.000Z');
      expect((await resolveSession(SHARED_AG, OTHER, null, 'agent-shared')).session.id).toBe(SHARED);

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: OTHER }]);
      expect(await getDb().get('SELECT messaging_group_id, thread_id FROM sessions WHERE id = ?', SHARED)).toEqual({
        messaging_group_id: OTHER,
        thread_id: null,
      });
      expect(await count("SELECT COUNT(*) AS c FROM sessions WHERE id = 'sess-older'")).toBe(0);
    });

    it('moves it to a chat the bot is still in before an older detached one', async () => {
      await getDb().run(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES ('mg-third', 'slack', 'mg-third-platform', 'slack', 'third', 1, 'strict', ?)`,
        now(),
      );
      await getDb().run('UPDATE messaging_groups SET detached_at = ? WHERE id = ?', now(), OTHER);
      await wire(MG, 'agent-shared');
      await wire(OTHER, 'agent-shared');
      await wire('mg-third', 'agent-shared');
      await session(SHARED, null, now());

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: 'mg-third' }]);
    });

    /** A sent agent-to-agent message: the peer routes its replies back to this session (agent-route.ts). */
    function sendToPeer(sessionId: string, toAgentGroupId = 'ag-peer'): void {
      initSessionFolder(SHARED_AG, sessionId);
      const outbound = new Database(outboundDbPath(SHARED_AG, sessionId));
      outbound
        .prepare(
          `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
           VALUES (?, 1, ?, 'chat', ?, 'agent', '{}')`,
        )
        .run(`out-${sessionId}`, now(), toAgentGroupId);
      outbound.close();
    }

    /** A peer's assignment waiting in this session's inbox, as routeAgentMessage writes it. */
    function receiveFromPeer(sessionId: string): void {
      initSessionFolder(SHARED_AG, sessionId);
      const inbound = new Database(inboundDbPath(SHARED_AG, sessionId));
      inbound
        .prepare(
          `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, content, source_session_id)
           VALUES (?, 2, 'chat', ?, 'pending', 'ag-peer', 'agent', '{}', 'sess-on-peer')`,
        )
        .run(`in-${sessionId}`, now());
      inbound.close();
    }

    const routingOf = (sessionId: string) => {
      const inbound = new Database(inboundDbPath(SHARED_AG, sessionId), { readonly: true });
      const row = inbound.prepare('SELECT channel_type, platform_id FROM session_routing').get();
      inbound.close();
      return row;
    };

    it('keeps a session a peer agent still replies to, without its chat, under an ordinary wiring', async () => {
      await wire(MG, 'shared');
      await session(SHARED, null, now());
      sendToPeer(SHARED);

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: null }]);
      expect(data.removed.sessions).toBe(1); // only AG's sess-target, which has no peer conversation
      expect(
        await getDb().get('SELECT messaging_group_id, thread_id, status FROM sessions WHERE id = ?', SHARED),
      ).toEqual({ messaging_group_id: null, thread_id: null, status: 'active' });
    });

    /** Run `deliver` right after the peer scan has read SHARED's mailbox. */
    function afterScanOfShared(deliver: () => Promise<void>): { delivered: () => boolean } {
      const original = sessionManager.withExistingMailboxSession;
      let delivered = false;
      vi.spyOn(sessionManager, 'withExistingMailboxSession').mockImplementation(
        async (agentGroupId, sessionId, action) => {
          const result = await original(agentGroupId, sessionId, action);
          if (sessionId === SHARED && !delivered) {
            delivered = true;
            await deliver();
          }
          return result;
        },
      );
      return { delivered: () => delivered };
    }

    /** What routeAgentMessage writes, through the real inbox write and its last_active bump. */
    const deliverPeerMessage = () =>
      sessionManager.writeSessionMessage(SHARED_AG, SHARED, {
        id: 'a2a-late',
        kind: 'chat',
        timestamp: now(),
        platformId: 'ag-peer',
        channelType: 'agent',
        content: '{}',
        sourceSessionId: 'sess-on-peer',
      });

    it('keeps a session that receives a peer message after the peer scan read it', async () => {
      await wire(MG, 'shared');
      await session(SHARED, null, now());
      initSessionFolder(SHARED_AG, SHARED);
      const probe = afterScanOfShared(deliverPeerMessage);

      const data = await deleteMg();

      expect(probe.delivered()).toBe(true);
      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: null }]);
      expect(await count('SELECT COUNT(*) AS c FROM sessions WHERE id = ?', SHARED)).toBe(1);
    });

    it('keeps it when that write is stamped by a host whose clock runs behind', async () => {
      await wire(MG, 'shared');
      await session(SHARED, null, now());
      initSessionFolder(SHARED_AG, SHARED);
      const probe = afterScanOfShared(async () => {
        receiveFromPeer(SHARED);
        await getDb().run("UPDATE sessions SET last_active = '2000-01-01T00:00:00.000Z' WHERE id = ?", SHARED);
      });

      const data = await deleteMg();

      expect(probe.delivered()).toBe(true);
      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: null }]);
    });

    it('keeps it when that write lands in the same millisecond as the value the scan read', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(new Date('2026-10-20T12:00:00.000Z'));
      await wire(MG, 'shared');
      await session(SHARED, null, now());
      initSessionFolder(SHARED_AG, SHARED);
      await getDb().run('UPDATE sessions SET last_active = ? WHERE id = ?', now(), SHARED);
      const probe = afterScanOfShared(deliverPeerMessage);

      const data = await deleteMg();

      expect(probe.delivered()).toBe(true);
      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: null }]);
    });

    it('keeps a session holding a peer assignment it has not answered yet', async () => {
      await wire(MG, 'shared');
      await session(SHARED, null, now());
      receiveFromPeer(SHARED);

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([{ id: SHARED, messaging_group_id: null }]);
      expect(await count('SELECT COUNT(*) AS c FROM sessions WHERE id = ?', SHARED)).toBe(1);
    });

    it('does not keep a session whose only agent message went to its own agent', async () => {
      await wire(MG, 'shared');
      await session(SHARED, null, now());
      sendToPeer(SHARED, SHARED_AG);

      const data = await deleteMg();

      expect(data.kept_sessions).toEqual([]);
      expect(await count('SELECT COUNT(*) AS c FROM sessions WHERE id = ?', SHARED)).toBe(0);
    });

    it('keeps an older session with a peer conversation next to the one agent-shared chats reuse', async () => {
      await wire(MG, 'agent-shared');
      await wire(OTHER, 'agent-shared');
      await session('sess-peer', null, '2026-01-01T00:00:00.000Z');
      await session(SHARED, null, '2026-01-02T00:00:00.000Z');
      sendToPeer('sess-peer');

      const data = await deleteMg();

      expect(data.kept_sessions).toHaveLength(2);
      expect(data.kept_sessions).toEqual(
        expect.arrayContaining([
          { id: SHARED, messaging_group_id: OTHER },
          { id: 'sess-peer', messaging_group_id: null },
        ]),
      );
    });

    it('binds a kept session with no chat to the next agent-shared chat that resumes it', async () => {
      await wire(MG, 'agent-shared');
      await session(SHARED, null, now());
      initSessionFolder(SHARED_AG, SHARED);
      await deleteMg();
      await getDb().run(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES ('mg-new', 'slack', 'mg-new-platform', 'slack', 'new', 1, 'strict', ?)`,
        now(),
      );
      await wire('mg-new', 'agent-shared');

      const resumed = await resolveSession(SHARED_AG, 'mg-new', null, 'agent-shared');

      expect(resumed).toMatchObject({ created: false, session: { id: SHARED, messaging_group_id: 'mg-new' } });
      expect(await getDb().get('SELECT messaging_group_id FROM sessions WHERE id = ?', SHARED)).toEqual({
        messaging_group_id: 'mg-new',
      });
      // ask_user_question and send_card read this; null fields would drop them.
      expect(routingOf(SHARED)).toEqual({ channel_type: 'slack', platform_id: 'mg-new-platform' });
    });

    it('leaves the session unbound when its routing cannot be written, so the next resume retries', async () => {
      await wire(MG, 'agent-shared');
      await session(SHARED, null, now());
      initSessionFolder(SHARED_AG, SHARED);
      await deleteMg();
      await getDb().run(
        `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
         VALUES ('mg-new', 'slack', 'mg-new-platform', 'slack', 'new', 1, 'strict', ?)`,
        now(),
      );
      await wire('mg-new', 'agent-shared');
      const inbound = inboundDbPath(SHARED_AG, SHARED);
      fs.rmSync(inbound);
      fs.mkdirSync(inbound); // a mailbox that cannot be opened

      await expect(resolveSession(SHARED_AG, 'mg-new', null, 'agent-shared')).rejects.toThrow();
      expect(await getDb().get('SELECT messaging_group_id FROM sessions WHERE id = ?', SHARED)).toEqual({
        messaging_group_id: null,
      });

      fs.rmSync(inbound, { recursive: true });
      initSessionFolder(SHARED_AG, SHARED);
      await resolveSession(SHARED_AG, 'mg-new', null, 'agent-shared');
      expect(routingOf(SHARED)).toEqual({ channel_type: 'slack', platform_id: 'mg-new-platform' });
    });

    it('undoes a bind only while the session still has that chat', async () => {
      await getDb().run("UPDATE sessions SET messaging_group_id = NULL WHERE id = 'sess-target'");
      expect(await bindUnboundSession('sess-target', MG)).toBe(true);
      expect(await bindUnboundSession('sess-target', OTHER)).toBe(false);
      await getDb().run("UPDATE sessions SET messaging_group_id = ? WHERE id = 'sess-target'", OTHER);

      await unbindSession('sess-target', MG); // a stale undo after another rebind

      expect(await getDb().get("SELECT messaging_group_id FROM sessions WHERE id = 'sess-target'")).toEqual({
        messaging_group_id: OTHER,
      });
    });
  });

  it.each([['an older group id', 'mg-previous'] as const, ['no group id', null] as const])(
    "clears the chat's dropped-message row when it carries %s",
    async (_label, staleId) => {
      await getDb().run(
        'UPDATE unregistered_senders SET messaging_group_id = ? WHERE messaging_group_id = ?',
        staleId,
        MG,
      );

      const resp = await dispatch(
        { id: 'req-mg-del-dropped', command: 'messaging-groups-delete', args: { id: MG } },
        { caller: 'host' },
      );

      expect(resp.ok).toBe(true);
      expect((resp as { ok: true; data: { removed: Record<string, number> } }).data.removed.unregistered_senders).toBe(
        1,
      );
      expect(await count('SELECT COUNT(*) AS c FROM unregistered_senders')).toBe(1); // OTHER's row stays
    },
  );

  it("keeps the chat's dropped-message row when it names a surviving group of another adapter instance", async () => {
    await getDb().run(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES ('mg-twin', 'telegram', ?, 'telegram-work', 'twin', 1, 'strict', ?)`,
      `${MG}-platform`,
      now(),
    );
    await getDb().run(
      "UPDATE unregistered_senders SET messaging_group_id = 'mg-twin' WHERE messaging_group_id = ?",
      MG,
    );

    const resp = await dispatch(
      { id: 'req-mg-del-twin', command: 'messaging-groups-delete', args: { id: MG } },
      { caller: 'host' },
    );

    expect(resp.ok).toBe(true);
    expect((resp as { ok: true; data: { removed: Record<string, number> } }).data.removed.unregistered_senders).toBe(0);
    expect(await count("SELECT COUNT(*) AS c FROM unregistered_senders WHERE messaging_group_id = 'mg-twin'")).toBe(1);
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
