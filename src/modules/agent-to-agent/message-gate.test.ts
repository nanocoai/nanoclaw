import Database from 'better-sqlite3';
import fs from 'fs';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import './guard.js'; // register the a2a.send catalog entry (incl. the policy hold)
import { routeAgentMessage } from './agent-route.js';
import { createDestination, deleteDestination, deleteAllDestinationsTouching } from './db/agent-destinations.js';
import { getMessagePolicy, removeMessagePolicy, setMessagePolicy } from './db/agent-message-policies.js';
import { applyA2aMessageGate } from './message-gate.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { createPendingApproval, createSession, deletePendingApproval, getPendingApproval } from '../../db/sessions.js';
import { requestApproval } from '../approvals/index.js';
import { initSessionFolder, inboundDbPath } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../approvals/index.js', async (importActual) => {
  const actual = await importActual<typeof import('../approvals/index.js')>();
  return { ...actual, requestApproval: vi.fn().mockResolvedValue(undefined) };
});

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-a2a-gate' };
});

const TEST_DIR = '/tmp/nanoclaw-test-a2a-gate';
const A = 'ag-A';
const B = 'ag-B';

function now(): string {
  return new Date().toISOString();
}

function policyCount(): number {
  return (getDb().prepare('SELECT COUNT(*) AS n FROM agent_message_policies').get() as { n: number }).n;
}

function readInbound(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db.prepare('SELECT id, platform_id, content FROM messages_in ORDER BY seq').all() as Array<{
    id: string;
    platform_id: string | null;
    content: string;
  }>;
  db.close();
  return rows;
}

function makeSession(id: string, agentGroupId: string): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: now(),
  };
}

/** Seed a live a2a hold row (what requestApproval writes) and return it as the grant. */
function seedA2aHold(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  createPendingApproval({
    approval_id: approvalId,
    session_id: 'sess-A',
    request_id: approvalId,
    action: 'a2a_message_gate',
    payload: JSON.stringify(payload),
    created_at: now(),
    agent_group_id: A,
    title: 'Message approval',
    options_json: '[]',
    approver_user_id: 'telegram:dana',
  });
  return getPendingApproval(approvalId)!;
}

describe('agent message policies', () => {
  let SA: Session;
  let SB: Session;

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });
    const db = initTestDb();
    runMigrations(db);
    vi.mocked(requestApproval).mockClear();

    createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });
    SA = makeSession('sess-A', A);
    SB = makeSession('sess-B', B);
    createSession(SA);
    createSession(SB);
    initSessionFolder(A, SA.id);
    initSessionFolder(B, SB.id);
    // A→B connection wired.
    createDestination({ agent_group_id: A, local_name: 'b', target_type: 'agent', target_id: B, created_at: now() });
  });

  afterEach(() => {
    closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  // ── policy table round-trip ──

  it('set / get / remove round-trip, incl. approver', () => {
    expect(getMessagePolicy(A, B)).toBeUndefined();

    setMessagePolicy(A, B, 'telegram:sam', now());
    expect(getMessagePolicy(A, B)).toMatchObject({
      from_agent_group_id: A,
      to_agent_group_id: B,
      approver: 'telegram:sam',
    });
    expect(policyCount()).toBe(1);

    // Upsert updates the approver without inserting a duplicate row.
    setMessagePolicy(A, B, 'telegram:dana', now());
    expect(getMessagePolicy(A, B)!.approver).toBe('telegram:dana');
    expect(policyCount()).toBe(1);

    expect(removeMessagePolicy(A, B)).toBe(true);
    expect(getMessagePolicy(A, B)).toBeUndefined();
    expect(removeMessagePolicy(A, B)).toBe(false);
  });

  // ── gate behavior in routeAgentMessage ──

  it('no policy → routes normally, no approval requested', async () => {
    await routeAgentMessage(
      { id: 'm1', platform_id: B, content: JSON.stringify({ text: 'hi B' }), in_reply_to: null },
      SA,
    );
    expect(readInbound(B, SB.id)).toHaveLength(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('policy present → holds the message and requests approval from the policy approver', async () => {
    setMessagePolicy(A, B, 'telegram:dana', now());

    await routeAgentMessage(
      { id: 'm2', platform_id: B, content: JSON.stringify({ text: 'sensitive' }), in_reply_to: null },
      SA,
    );

    // Held: nothing routed to B.
    expect(readInbound(B, SB.id)).toHaveLength(0);
    // One approval requested, to the policy's approver.
    expect(requestApproval).toHaveBeenCalledTimes(1);
    const opts = vi.mocked(requestApproval).mock.calls[0][0];
    expect(opts.action).toBe('a2a_message_gate');
    expect(opts.approverUserId).toBe('telegram:dana');
    expect(opts.payload).toMatchObject({ id: 'm2', platform_id: B });
    expect(JSON.parse(String(opts.payload.content)).text).toBe('sensitive');
  });

  it('self-message is never gated even if a policy row somehow exists', async () => {
    setMessagePolicy(A, A, 'telegram:dana', now()); // pathological, but must be ignored
    await routeAgentMessage(
      { id: 'self', platform_id: A, content: JSON.stringify({ text: 'note' }), in_reply_to: null },
      SA,
    );
    expect(requestApproval).not.toHaveBeenCalled();
    expect(readInbound(A, SA.id)).toHaveLength(1);
  });

  it('ghost policy (policy row, no destination row) still denies — deny beats the policy hold', async () => {
    deleteDestination(A, 'b'); // removes A→B — the destination ACL now denies
    setMessagePolicy(A, B, 'telegram:dana', now()); // ...but a stale policy row remains

    await expect(
      routeAgentMessage({ id: 'ghost', platform_id: B, content: JSON.stringify({ text: 'x' }), in_reply_to: null }, SA),
    ).rejects.toThrow(/unauthorized agent-to-agent/);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(readInbound(B, SB.id)).toHaveLength(0);
  });

  // ── approve handler re-enters the guarded route with the grant ──

  it('applyA2aMessageGate delivers the held message to the target (valid grant)', async () => {
    setMessagePolicy(A, B, 'telegram:dana', now());
    const payload = { id: 'held-1', platform_id: B, content: JSON.stringify({ text: 'approved!' }), in_reply_to: null };
    const approval = seedA2aHold('appr-a2a-1', payload);

    const notify = vi.fn();
    await applyA2aMessageGate({ session: SA, userId: 'telegram:dana', notify, payload, approval });

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(JSON.parse(bRows[0].content).text).toBe('approved!');
    expect(notify).not.toHaveBeenCalled();
    // The hold is satisfied by the grant — no second card.
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it('destination revoked between hold and approve → refused cleanly, requester told, nothing delivered', async () => {
    setMessagePolicy(A, B, 'telegram:dana', now());
    const payload = { id: 'held-2', platform_id: B, content: JSON.stringify({ text: 'stale' }), in_reply_to: null };
    const approval = seedA2aHold('appr-a2a-2', payload);

    deleteDestination(A, 'b'); // revoke A→B while the card is pending

    const notify = vi.fn();
    // An expected policy refusal — resolves (no throw), so the response
    // handler never records it as a handler crash.
    await applyA2aMessageGate({ session: SA, userId: 'telegram:dana', notify, payload, approval });

    expect(readInbound(B, SB.id)).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/not delivered.*no destination for/));
  });

  it('mismatched grant (held for another target) refuses the replay cleanly', async () => {
    setMessagePolicy(A, B, 'telegram:dana', now());
    // Grant was approved for a message to A (different target than the replay).
    const approval = seedA2aHold('appr-a2a-3', { id: 'other', platform_id: A, content: '{}', in_reply_to: null });
    const payload = { id: 'held-3', platform_id: B, content: JSON.stringify({ text: 'swap' }), in_reply_to: null };

    const notify = vi.fn();
    await applyA2aMessageGate({ session: SA, userId: 'telegram:dana', notify, payload, approval });

    expect(readInbound(B, SB.id)).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/not delivered.*invalid or mismatched grant/));
  });

  it('a grant only works while its row is live (executes once)', async () => {
    setMessagePolicy(A, B, 'telegram:dana', now());
    const payload = { id: 'held-4', platform_id: B, content: JSON.stringify({ text: 'once' }), in_reply_to: null };
    const approval = seedA2aHold('appr-a2a-4', payload);

    deletePendingApproval(approval.approval_id); // resolution already consumed the row

    const notify = vi.fn();
    await applyA2aMessageGate({ session: SA, userId: 'telegram:dana', notify, payload, approval });

    expect(readInbound(B, SB.id)).toHaveLength(0);
    expect(notify).toHaveBeenCalledWith(expect.stringMatching(/not delivered.*invalid or mismatched grant/));
  });

  // ── ghost-gate cleanup ──

  it('deleting the connection drops its policy', () => {
    setMessagePolicy(A, B, 'telegram:dana', now());
    deleteDestination(A, 'b'); // removes the A→B agent destination
    expect(getMessagePolicy(A, B)).toBeUndefined();
  });

  it('deleteAllDestinationsTouching drops policies on both sides', () => {
    setMessagePolicy(A, B, 'telegram:dana', now());
    setMessagePolicy(B, A, 'telegram:dana', now());
    deleteAllDestinationsTouching(A);
    expect(getMessagePolicy(A, B)).toBeUndefined();
    expect(getMessagePolicy(B, A)).toBeUndefined();
  });
});
