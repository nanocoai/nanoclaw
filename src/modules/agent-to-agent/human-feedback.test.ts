import Database from 'better-sqlite3';
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-a2a-human-feedback' };
});

import { createAgentGroup, createMessagingGroup, initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createPendingApproval, createSession, getPendingApproval } from '../../db/sessions.js';
import { deliverSessionMessages, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder, withMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { finalizeReject } from '../approvals/finalize.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { registerApprovalHandler } from '../approvals/primitive.js';
import { applyA2aMessageGate } from './message-gate.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import { upsertUser } from '../permissions/db/users.js';
import { routeAgentMessage } from './agent-route.js';
import { createDestination, deleteDestination } from './db/agent-destinations.js';
import { setMessagePolicy } from './db/agent-message-policies.js';
import { notifySource } from './notify-source.js';

const TEST_DIR = '/tmp/nanoclaw-test-a2a-human-feedback';

interface TestPair {
  sourceId: string;
  targetId: string;
  sourceSession: Session;
  targetSession: Session;
  originChannel: string;
  originPlatform: string;
}

interface OutboundRow {
  id: string;
  platform_id: string | null;
  channel_type: string | null;
  content: string;
}

function now(): string {
  return new Date().toISOString();
}

async function setupPair(prefix: string, attachedChat = true): Promise<TestPair> {
  const sourceId = `ag-${prefix}-source`;
  const targetId = `ag-${prefix}-target`;
  const sourceSessionId = `sess-${prefix}-source`;
  const targetSessionId = `sess-${prefix}-target`;
  const originMessagingGroupId = `mg-${prefix}-origin`;
  const originChannel = 'slack';
  const originPlatform = `C-${prefix}`;

  await createAgentGroup({
    id: sourceId,
    name: 'helper',
    folder: `${prefix}-helper`,
    agent_provider: null,
    created_at: now(),
  });
  await createAgentGroup({
    id: targetId,
    name: 'researcher',
    folder: `${prefix}-researcher`,
    agent_provider: null,
    created_at: now(),
  });
  await createMessagingGroup({
    id: originMessagingGroupId,
    channel_type: originChannel,
    platform_id: originPlatform,
    name: 'Helper chat',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });

  const sourceSession: Session = {
    id: sourceSessionId,
    agent_group_id: sourceId,
    messaging_group_id: attachedChat ? originMessagingGroupId : null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  const targetSession: Session = {
    ...sourceSession,
    id: targetSessionId,
    agent_group_id: targetId,
    messaging_group_id: null,
  };
  await createSession(sourceSession);
  await createSession(targetSession);
  initSessionFolder(sourceId, sourceSessionId);
  initSessionFolder(targetId, targetSessionId);

  return { sourceId, targetId, sourceSession, targetSession, originChannel, originPlatform };
}

function connect(sourceId: string, targetId: string, localName: string): Promise<void> {
  return createDestination({
    agent_group_id: sourceId,
    local_name: localName,
    target_type: 'agent',
    target_id: targetId,
    created_at: now(),
  });
}

function readHumanNotes(pair: TestPair): OutboundRow[] {
  const db = new Database(outboundDbPath(pair.sourceId, pair.sourceSession.id), { readonly: true });
  const rows = db
    .prepare("SELECT id, platform_id, channel_type, content FROM messages_out WHERE id LIKE 'a2a-human-%' ORDER BY seq")
    .all() as OutboundRow[];
  db.close();
  return rows;
}

function noteText(row: OutboundRow): string {
  return (JSON.parse(row.content) as { text: string }).text;
}

function insertAgentOutbound(
  pair: TestPair,
  id: string,
  targetId: string | null = pair.targetId,
  content = JSON.stringify({ text: 'hello' }),
): void {
  const db = new Database(outboundDbPath(pair.sourceId, pair.sourceSession.id));
  db.prepare(
    `INSERT INTO messages_out (id, timestamp, kind, platform_id, channel_type, content)
     VALUES (?, ?, 'chat', ?, 'agent', ?)`,
  ).run(id, now(), targetId, content);
  db.close();
}

beforeEach(async () => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  setDeliveryAdapter({
    async deliver() {
      return 'platform-message';
    },
  });
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('agent-to-agent human feedback', () => {
  it('notifies only the agent when its session has no attached chat', async () => {
    const pair = await setupPair('agent-only', false);
    await createDestination({
      agent_group_id: pair.sourceId,
      local_name: 'human-chat',
      target_type: 'channel',
      target_id: 'mg-agent-only-origin',
      created_at: now(),
    });

    expect(await notifySource(pair.sourceSession.id, 'Message delivery failed.')).toBe(true);
    expect(readHumanNotes(pair)).toHaveLength(0);
    const db = new Database(inboundDbPath(pair.sourceId, pair.sourceSession.id), { readonly: true });
    const rows = db.prepare('SELECT content FROM messages_in').all() as Array<{ content: string }>;
    db.close();
    expect(rows.map((row) => JSON.parse(row.content))).toEqual([
      { text: 'Message delivery failed.', sender: 'system', senderId: 'system' },
    ]);
  });

  it('consumes a denied row and writes the direct remediation note with the real ncl flags', async () => {
    const pair = await setupPair('deny');
    insertAgentOutbound(pair, 'out-denied');

    await deliverSessionMessages(pair.sourceSession);

    const delivered = await withMailboxSession(pair.sourceId, pair.sourceSession.id, (mailbox) =>
      mailbox.getDeliveredIds(),
    );
    expect(delivered.has('out-denied')).toBe(true);
    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ platform_id: pair.originPlatform, channel_type: pair.originChannel });
    expect(noteText(notes[0])).toBe(
      `helper tried to send a message to "researcher", but it was blocked: helper does not have "researcher" in its destinations. To allow this, an admin can run: ncl destinations add --agent-group-id ${pair.sourceId} --local-name researcher --target-type agent --target-id ${pair.targetId}. After that, ask helper to resend.`,
    );
  });

  it('reports a nonexistent target without suggesting a destination command', async () => {
    const pair = await setupPair('missing-target');
    insertAgentOutbound(pair, 'out-missing-target', 'ag-does-not-exist');

    await deliverSessionMessages(pair.sourceSession);

    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(noteText(notes[0])).toBe(
      'helper tried to send a message to "ag-does-not-exist", but no agent with that ID exists, so nothing was delivered.',
    );
    expect(noteText(notes[0])).not.toContain('ncl destinations add');
  });

  it('omits unsafe values from destination remediation commands', async () => {
    const pair = await setupPair('unsafe-command');
    const unsafeTargetId = 'ag-target;unsafe';
    await createAgentGroup({
      id: unsafeTargetId,
      name: 'unsafe researcher',
      folder: 'unsafe-researcher',
      agent_provider: null,
      created_at: now(),
    });

    await routeAgentMessage(
      { id: 'unsafe-target', platform_id: unsafeTargetId, content: '{"text":"hello"}', in_reply_to: null },
      pair.sourceSession,
    );

    const text = noteText(readHumanNotes(pair)[0]);
    expect(text).toContain('an admin can add unsafe researcher as a destination for helper');
    expect(text).not.toContain('ncl destinations add');
    expect(text).not.toContain(';unsafe --');
  });

  it('consumes a missing-target row immediately and writes one invalid-target note', async () => {
    const pair = await setupPair('null-target');
    insertAgentOutbound(pair, 'out-null-target', null, '{not-json');

    await deliverSessionMessages(pair.sourceSession);
    await deliverSessionMessages(pair.sourceSession);

    const delivered = await withMailboxSession(pair.sourceId, pair.sourceSession.id, (mailbox) =>
      mailbox.getDeliveredIds(),
    );
    expect(delivered.has('out-null-target')).toBe(true);
    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(noteText(notes[0])).toBe(
      'helper tried to send an agent message, but it had no target agent ID, so nothing was delivered.',
    );
  });

  it('routes malformed A2A JSON once and wraps the raw payload as trusted string text', async () => {
    const pair = await setupPair('malformed-content');
    await connect(pair.sourceId, pair.targetId, 'researcher');
    await connect(pair.targetId, pair.sourceId, 'helper');
    insertAgentOutbound(pair, 'out-malformed-content', pair.targetId, '{not-json');

    await deliverSessionMessages(pair.sourceSession);

    const targetDb = new Database(inboundDbPath(pair.targetId, pair.targetSession.id), { readonly: true });
    const row = targetDb
      .prepare("SELECT platform_id, channel_type, content FROM messages_in WHERE channel_type = 'agent'")
      .get() as { platform_id: string; channel_type: string; content: string };
    targetDb.close();
    expect(row).toEqual({
      platform_id: pair.sourceId,
      channel_type: 'agent',
      content: JSON.stringify({ text: '{not-json', sender: 'helper', senderId: `agent:${pair.sourceId}` }),
    });
  });

  it('reports the approval wait and a later refusal if the destination is revoked', async () => {
    const pair = await setupPair('hold');
    await connect(pair.sourceId, pair.targetId, 'researcher');
    await setMessagePolicy(pair.sourceId, pair.targetId, 'slack:alice', now());
    await upsertUser({ id: 'slack:alice', kind: 'slack', display_name: 'Alice', created_at: now() });
    await createMessagingGroup({
      id: 'mg-hold-approver',
      channel_type: 'slack',
      platform_id: 'D-alice',
      name: 'Alice DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    await upsertUserDm({
      user_id: 'slack:alice',
      channel_type: 'slack',
      messaging_group_id: 'mg-hold-approver',
      resolved_at: now(),
    });

    await routeAgentMessage(
      {
        id: 'held-message',
        platform_id: pair.targetId,
        content: JSON.stringify({ text: 'review me' }),
        in_reply_to: null,
      },
      pair.sourceSession,
    );

    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(noteText(notes[0])).toBe(
      "helper's message to researcher is waiting for approval from slack:alice. It will be delivered if approved.",
    );

    const pending = await getDb().get<{ approval_id: string }>('SELECT approval_id FROM pending_approvals');
    await deleteDestination(pair.sourceId, 'researcher');
    registerApprovalHandler('a2a_message_gate', applyA2aMessageGate);
    await handleApprovalsResponse({
      questionId: pending!.approval_id,
      value: 'approve',
      userId: 'alice',
      channelType: 'slack',
      platformId: 'D-alice',
      threadId: null,
    });
    const updatedNotes = readHumanNotes(pair);
    expect(updatedNotes).toHaveLength(2);
    expect(noteText(updatedNotes[1])).toMatch(/not delivered.*no destination for/);
    expect(await getPendingApproval(pending!.approval_id)).toBeUndefined();
  });

  it('writes the approval-failure note when the approver has no reachable DM', async () => {
    const pair = await setupPair('hold-failure');
    await connect(pair.sourceId, pair.targetId, 'researcher');
    await setMessagePolicy(pair.sourceId, pair.targetId, 'slack:alice', now());

    await routeAgentMessage(
      {
        id: 'held-message-no-dm',
        platform_id: pair.targetId,
        content: JSON.stringify({ text: 'review me' }),
        in_reply_to: null,
      },
      pair.sourceSession,
    );

    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(noteText(notes[0])).toBe(
      "helper's message to researcher needs approval, but I couldn't reach an approver (no DM channel found for any eligible approver). The message was not delivered.",
    );
  });

  it('relays an A2A rejection reason directly to the source human', async () => {
    const pair = await setupPair('reject');
    const approvalId = 'appr-reject';
    await createPendingApproval({
      approval_id: approvalId,
      session_id: pair.sourceSession.id,
      request_id: approvalId,
      action: 'a2a_message_gate',
      payload: JSON.stringify({
        platform_id: pair.targetId,
        source_name: 'helper',
        target_name: 'researcher',
      }),
      created_at: now(),
      agent_group_id: pair.sourceId,
      title: 'Message approval',
      question: 'Approve?',
      options_json: '[]',
      approver_user_id: 'slack:alice',
    });
    const approval = (await getPendingApproval(approvalId))!;
    await upsertUser({ id: 'slack:alice', kind: 'slack', display_name: 'Alice', created_at: now() });

    await finalizeReject(approval, pair.sourceSession, 'slack:alice', 'needs a narrower scope');

    expect(noteText(readHumanNotes(pair)[0])).toBe(
      "Alice rejected helper's message to researcher. Reason: needs a narrower scope",
    );

    const ownerApprovalId = 'appr-reject-owner';
    await upsertUser({ id: 'slack:owner', kind: 'slack', display_name: null, created_at: now() });
    await grantRole({
      user_id: 'slack:owner',
      role: 'owner',
      agent_group_id: null,
      granted_by: null,
      granted_at: now(),
    });
    await createPendingApproval({
      ...approval,
      approval_id: ownerApprovalId,
      request_id: ownerApprovalId,
      approver_user_id: 'slack:owner',
    });
    await finalizeReject((await getPendingApproval(ownerApprovalId))!, pair.sourceSession, 'slack:owner');

    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(2);
    expect(noteText(notes[1])).toBe("An owner rejected helper's message to researcher.");
  });

  it('emits the one-way delivered note once per source session and target', async () => {
    const pair = await setupPair('one-way');
    await connect(pair.sourceId, pair.targetId, 'researcher');

    await routeAgentMessage(
      { id: 'one-way-1', platform_id: pair.targetId, content: JSON.stringify({ text: 'first' }), in_reply_to: null },
      pair.sourceSession,
    );
    await routeAgentMessage(
      { id: 'one-way-2', platform_id: pair.targetId, content: JSON.stringify({ text: 'second' }), in_reply_to: null },
      pair.sourceSession,
    );

    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(noteText(notes[0])).toBe(
      `Delivered to researcher. Note: researcher cannot reply — it does not have helper in its destinations. To enable replies, an admin can run: ncl destinations add --agent-group-id ${pair.targetId} --local-name helper --target-type agent --target-id ${pair.sourceId}.`,
    );
  });

  it('does not emit a one-way note when the reverse destination exists', async () => {
    const pair = await setupPair('two-way');
    await connect(pair.sourceId, pair.targetId, 'researcher');
    await connect(pair.targetId, pair.sourceId, 'helper');

    await routeAgentMessage(
      {
        id: 'two-way-1',
        platform_id: pair.targetId,
        content: JSON.stringify({ text: 'replyable' }),
        in_reply_to: null,
      },
      pair.sourceSession,
    );

    expect(readHumanNotes(pair)).toHaveLength(0);
    const targetDb = new Database(inboundDbPath(pair.targetId, pair.targetSession.id), { readonly: true });
    const deliveredToTarget = targetDb
      .prepare("SELECT COUNT(*) AS n FROM messages_in WHERE channel_type = 'agent'")
      .get() as {
      n: number;
    };
    targetDb.close();
    expect(deliveredToTarget.n).toBe(1);
  });

  it('suppresses the one-way note explicitly for self-sends without faking replyability', async () => {
    const pair = await setupPair('self-send');

    await routeAgentMessage(
      {
        id: 'self-send-1',
        platform_id: pair.sourceId,
        content: JSON.stringify({ text: 'private note' }),
        in_reply_to: null,
      },
      pair.sourceSession,
    );

    expect(readHumanNotes(pair)).toHaveLength(0);
  });

  it('writes the permanent-failure note after an agent row exhausts delivery attempts', async () => {
    const pair = await setupPair('permanent');
    insertAgentOutbound(pair, 'out-permanent-failure');
    await getDb().run('DROP TABLE agent_destinations');

    await deliverSessionMessages(pair.sourceSession);
    await deliverSessionMessages(pair.sourceSession);
    await deliverSessionMessages(pair.sourceSession);

    const delivered = await withMailboxSession(pair.sourceId, pair.sourceSession.id, (mailbox) =>
      mailbox.getDeliveredIds(),
    );
    expect(delivered.has('out-permanent-failure')).toBe(true);
    const notes = readHumanNotes(pair);
    expect(notes).toHaveLength(1);
    expect(noteText(notes[0])).toBe(
      'A message from helper to researcher could not be delivered after several attempts. Check the host logs for details.',
    );
  });
});
