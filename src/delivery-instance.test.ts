/**
 * Multi-instance outbound routing.
 *
 * When several adapter instances serve the same platform address — three
 * Telegram bots DMing one human, so three messaging groups share
 * (channel_type, platform_id) and differ only by `instance` — the host has to
 * decide which instance an outbound row belongs to.
 *
 * It cannot ask the container: `instance` is host-internal and appears in
 * neither the projected `destinations` table nor `messages_out`. A normal chat
 * session recovers it from its origin messaging group. A task/system session
 * has messaging_group_id = NULL and has no origin, so it must be resolved from
 * the sending agent's own destination rows.
 *
 * Regression: task sends previously fell through to the by-platform lookup,
 * which resolves the DEFAULT instance. For any agent whose chat is not on the
 * default instance that is a different agent group's chat, so the permission
 * check rejected the send and the message was marked failed after 3 attempts —
 * while the agent's own run log reported it sent successfully.
 *
 * Note a passing "task message was delivered" assertion is NOT enough to catch
 * this: an agent that happens to sit on the default instance routes correctly
 * either way. The instance itself has to be asserted.
 */
import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  killContainer: vi.fn(),
  buildAgentGroupImage: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('./config.js', async () => {
  const actual = await vi.importActual<typeof import('./config.js')>('./config.js');
  return {
    ...actual,
    DATA_DIR: '/tmp/nanoclaw-test-delivery-instance',
    GROUPS_DIR: '/tmp/nanoclaw-test-delivery-instance/groups',
  };
});

const TEST_DIR = '/tmp/nanoclaw-test-delivery-instance';

import {
  initTestDb,
  closeDb,
  runMigrations,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
} from './db/index.js';
import { resolveSession, resolveTaskSession, outboundDbPath } from './session-manager.js';
import { deliverSessionMessages, setDeliveryAdapter } from './delivery.js';

/** The one address all three bots share — the human's Telegram id. */
const ADDR = 'telegram:974949487';

function now(): string {
  return new Date().toISOString();
}

/** An agent group wired to `addr` on `instance`, with the auto-created destination row. */
function seedAgentOnInstance(agentId: string, mgId: string, instance: string): void {
  createAgentGroup({ id: agentId, name: agentId, folder: agentId, agent_provider: null, created_at: now() });
  createMessagingGroup({
    id: mgId,
    channel_type: 'telegram',
    platform_id: ADDR,
    instance,
    name: `${agentId} DM`,
    is_group: 0,
    unknown_sender_policy: 'public',
    created_at: now(),
  });
  // Wiring inserts the agent_destinations row, which is what pins the instance.
  createMessagingGroupAgent({
    id: `mga-${agentId}`,
    messaging_group_id: mgId,
    agent_group_id: agentId,
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'shared',
    priority: 0,
    created_at: now(),
  });
}

function insertOutbound(agentGroupId: string, sessionId: string, msgId: string): void {
  const db = new Database(outboundDbPath(agentGroupId, sessionId));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat', ?, 'telegram', ?)`,
  ).run(msgId, now(), ADDR, JSON.stringify({ text: 'briefing' }));
  db.close();
}

/** Capture the instance each delivery went out on. */
function captureInstances(): string[] {
  const seen: string[] = [];
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, _content, _files, instance) {
      seen.push(instance ?? '<undefined>');
      return 'plat-msg-1';
    },
  });
  return seen;
}

beforeEach(() => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  runMigrations(initTestDb());
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('task-session delivery with sibling instances on one address', () => {
  it('routes through the agent’s own instance, not the default one', async () => {
    seedAgentOnInstance('ag-default', 'mg-default', 'telegram');
    seedAgentOnInstance('ag-labs', 'mg-labs', 'telegram-labs');

    const { session } = resolveTaskSession('ag-labs', 'daily-briefing-08bd');
    expect(session.messaging_group_id).toBeNull();
    insertOutbound('ag-labs', session.id, 'out-labs');

    const seen = captureInstances();
    await deliverSessionMessages(session);

    // Pre-fix this array was empty: resolution picked mg-default, the
    // permission check rejected it, and the adapter was never called.
    expect(seen).toEqual(['telegram-labs']);
  });

  it('still routes a default-instance agent through the default instance', async () => {
    seedAgentOnInstance('ag-default', 'mg-default', 'telegram');
    seedAgentOnInstance('ag-labs', 'mg-labs', 'telegram-labs');

    const { session } = resolveTaskSession('ag-default', 'default-series');
    insertOutbound('ag-default', session.id, 'out-default');

    const seen = captureInstances();
    await deliverSessionMessages(session);

    expect(seen).toEqual(['telegram']);
  });

  it('still refuses an agent that holds no destination for the address', async () => {
    // The fix resolves *through* the ACL table, so it must not become a way to
    // reach a chat the agent was never wired to.
    seedAgentOnInstance('ag-labs', 'mg-labs', 'telegram-labs');
    createAgentGroup({
      id: 'ag-outsider',
      name: 'Outsider',
      folder: 'outsider',
      agent_provider: null,
      created_at: now(),
    });

    const { session } = resolveTaskSession('ag-outsider', 'sneaky-series');
    insertOutbound('ag-outsider', session.id, 'out-sneaky');

    const seen = captureInstances();
    await deliverSessionMessages(session);

    expect(seen).toEqual([]);
  });

  it('keeps origin-session-first precedence for ordinary chat sessions', async () => {
    // A normal session on a non-default instance already worked via its origin
    // row; the new destination lookup must not preempt that.
    seedAgentOnInstance('ag-default', 'mg-default', 'telegram');
    seedAgentOnInstance('ag-labs', 'mg-labs', 'telegram-labs');

    const { session } = resolveSession('ag-labs', 'mg-labs', null, 'shared');
    insertOutbound('ag-labs', session.id, 'out-chat');

    const seen = captureInstances();
    await deliverSessionMessages(session);

    expect(seen).toEqual(['telegram-labs']);
  });
});
