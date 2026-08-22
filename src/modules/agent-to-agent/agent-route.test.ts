import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { forwardAttachedFiles, isSafeAttachmentName, routeAgentMessage } from './agent-route.js';
import { log } from '../../log.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { a2aThreadId, createSession, getSessionsByAgentGroup, taskThreadId, updateSession } from '../../db/sessions.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { initSessionFolder, resolveA2aSession, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

/** The dedicated a2a session `agentGroupId` uses for `peerAgentGroupId`, if one exists yet. */
async function findDedicatedA2aSession(agentGroupId: string, peerAgentGroupId: string): Promise<Session | undefined> {
  const threadId = a2aThreadId(peerAgentGroupId);
  const sessions = await getSessionsByAgentGroup(agentGroupId);
  return sessions.find((s) => s.messaging_group_id === null && s.thread_id === threadId);
}

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-a2a-route' };
});

const TEST_DIR = '/tmp/nanoclaw-test-a2a-route';

function now(): string {
  return new Date().toISOString();
}

function readInbound(agentGroupId: string, sessionId: string) {
  const db = new Database(inboundDbPath(agentGroupId, sessionId), { readonly: true });
  const rows = db
    .prepare('SELECT id, platform_id, channel_type, content, source_session_id FROM messages_in ORDER BY seq')
    .all() as Array<{
    id: string;
    platform_id: string | null;
    channel_type: string | null;
    content: string;
    source_session_id: string | null;
  }>;
  db.close();
  return rows;
}

describe('isSafeAttachmentName', () => {
  it('accepts plain filenames', () => {
    expect(isSafeAttachmentName('baby-duck.png')).toBe(true);
    expect(isSafeAttachmentName('file with spaces.pdf')).toBe(true);
    expect(isSafeAttachmentName('report.v2.docx')).toBe(true);
    expect(isSafeAttachmentName('.hidden')).toBe(true);
  });

  it('rejects empty / sentinel values', () => {
    expect(isSafeAttachmentName('')).toBe(false);
    expect(isSafeAttachmentName('.')).toBe(false);
    expect(isSafeAttachmentName('..')).toBe(false);
  });

  it('rejects path separators', () => {
    expect(isSafeAttachmentName('../evil.png')).toBe(false);
    expect(isSafeAttachmentName('/etc/passwd')).toBe(false);
    expect(isSafeAttachmentName('nested/file.txt')).toBe(false);
    expect(isSafeAttachmentName('windows\\path.exe')).toBe(false);
  });

  it('rejects NUL bytes', () => {
    expect(isSafeAttachmentName('clean\0.png')).toBe(false);
  });

  it('rejects anything path.basename would strip', () => {
    expect(isSafeAttachmentName('a/b')).toBe(false);
    expect(isSafeAttachmentName('./thing')).toBe(false);
  });

  it('rejects non-string input', () => {
    expect(isSafeAttachmentName(null as unknown as string)).toBe(false);
    expect(isSafeAttachmentName(undefined as unknown as string)).toBe(false);
  });
});

/**
 * Return-path routing: when an a2a reply targets an agent group with multiple
 * sessions, it must land in the *originating* session — not the newest one.
 *
 * Setup: agent A has two active sessions S1 (older) + S2 (newer).
 * Agent B is the peer A talks to. Bidirectional destinations wired.
 */
describe('routeAgentMessage return-path', () => {
  const A = 'ag-A';
  const B = 'ag-B';
  let S1: Session;
  let S2: Session;
  let SB: Session;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);

    await createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    await createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });

    // S1 (older), S2 (newer) — both active sessions on A.
    S1 = {
      id: 'sess-A-old',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: 'test:old',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    S2 = {
      id: 'sess-A-new',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: 'test:new',
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-02-01T00:00:00.000Z',
    };
    // B's dedicated a2a-with-A session — pre-created with exactly the shape
    // resolveA2aSession(B, A) would find/reuse, so existing tests that
    // assert fresh A→B traffic lands "in B's session" keep working: under
    // the new isolation-safe design that destination IS the dedicated
    // session, never a generic/arbitrary one.
    SB = {
      id: 'sess-B',
      agent_group_id: B,
      messaging_group_id: null,
      thread_id: a2aThreadId(A),
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-15T00:00:00.000Z',
    };
    await createSession(S1);
    await createSession(S2);
    await createSession(SB);
    initSessionFolder(A, S1.id);
    initSessionFolder(A, S2.id);
    initSessionFolder(B, SB.id);

    await createDestination({
      agent_group_id: A,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
    });
    await createDestination({
      agent_group_id: B,
      local_name: 'a',
      target_type: 'agent',
      target_id: A,
      created_at: now(),
    });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('forward direction: stamps source_session_id on the target inbound row', async () => {
    // A.S1 emits an outbound a2a to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'hello B' }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(bRows[0].platform_id).toBe(A);
    expect(bRows[0].source_session_id).toBe(S1.id); // <- the return address
  });

  it('reply direction: routes back to the originating session, not the newest', async () => {
    // A.S1 sends to B.
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1',
        platform_id: B,
        content: JSON.stringify({ text: 'ping' }),
        in_reply_to: null,
      },
      S1,
    );

    // Capture the synthetic id the host stamped on B's inbound — that's what
    // B's container would reference as `in_reply_to` when replying.
    const bRows = readInbound(B, SB.id);
    const yId = bRows[0].id;

    // B replies to that message.
    await routeAgentMessage(
      {
        id: 'msg-from-B',
        platform_id: A,
        content: JSON.stringify({ text: 'pong' }),
        in_reply_to: yId,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);

    // The reply lands in S1 (originator) even though S2 is newer.
    expect(s1Rows).toHaveLength(1);
    expect(s1Rows[0].platform_id).toBe(B);
    expect(JSON.parse(s1Rows[0].content).text).toBe('pong');
    expect(s2Rows).toHaveLength(0);
  });

  it('fresh a2a with no in_reply_to and no prior history creates the dedicated peer session, not S1/S2', async () => {
    // No prior conversation. B initiates an a2a to A out of the blue.
    await routeAgentMessage(
      {
        id: 'msg-from-B-fresh',
        platform_id: A,
        content: JSON.stringify({ text: 'unsolicited' }),
        in_reply_to: null,
      },
      SB,
    );

    // Never the generic "newest active session" heuristic — neither of A's
    // two ordinary sessions receives it.
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);

    // It lands in a freshly created, dedicated system:a2a:<B> session.
    const dedicated = await findDedicatedA2aSession(A, B);
    expect(dedicated).toBeDefined();
    expect(dedicated!.messaging_group_id).toBeNull();
    const dRows = readInbound(A, dedicated!.id);
    expect(dRows).toHaveLength(1);
    expect(JSON.parse(dRows[0].content).text).toBe('unsolicited');
  });

  it("peer-affinity fallback: with no in_reply_to, reuses the peer's own existing dedicated a2a session (both directions)", async () => {
    // A.S1 sends to B with no reply context. S1 is not B's dedicated a2a
    // session, so Tier 3 fires — but SB is pre-seeded to already BE B's
    // dedicated system:a2a:A session, so it's reused rather than creating a
    // second one (this is also the "forward direction" test's premise).
    await routeAgentMessage(
      { id: 'msg-from-A-S1-pre', platform_id: B, content: JSON.stringify({ text: 'context-establishing' }), in_reply_to: null },
      S1,
    );
    expect(readInbound(B, SB.id)).toHaveLength(1);

    // B replies from SB with no in_reply_to. Peer-affinity checks SB's own
    // inbound for "most recent from A" -> finds S1 -> S1 is NOT A's dedicated
    // session with B (thread_id mismatch) -> Tier 2 rejects it -> Tier 3
    // creates A's own dedicated system:a2a:B session.
    await routeAgentMessage(
      { id: 'msg-from-B-followup', platform_id: A, content: JSON.stringify({ text: 'standing by' }), in_reply_to: null },
      SB,
    );
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    const aDedicated = await findDedicatedA2aSession(A, B);
    expect(aDedicated).toBeDefined();
    expect(readInbound(A, aDedicated!.id)).toHaveLength(1);

    // A, now from ITS OWN dedicated session, sends again to B with no
    // in_reply_to. Peer-affinity checks A's dedicated session's inbound for
    // "most recent from B" -> finds SB -> SB IS B's dedicated session with A
    // -> Tier 2 accepts -> reused, no second B-side session created.
    await routeAgentMessage(
      { id: 'msg-from-A-dedicated-2', platform_id: B, content: JSON.stringify({ text: 'still here' }), in_reply_to: null },
      aDedicated!,
    );
    expect(readInbound(B, SB.id)).toHaveLength(2);
    expect(JSON.parse(readInbound(B, SB.id)[1].content).text).toBe('still here');
    const allB = await getSessionsByAgentGroup(B);
    expect(allB.filter((s) => s.thread_id === a2aThreadId(A))).toHaveLength(1);
    const allA = await getSessionsByAgentGroup(A);
    expect(allA.filter((s) => s.thread_id === a2aThreadId(B))).toHaveLength(1);
  });

  it('peer-affinity is rejected when the only prior contact was channel-bound (not the dedicated a2a session)', async () => {
    // A worker-group-shaped session for A — channel-bound, real messaging_group_id.
    await createMessagingGroup({
      id: 'mg-A-worker',
      channel_type: 'telegram',
      platform_id: 'telegram:-100worker',
      instance: 'telegram',
      name: 'A worker group',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    const AWorkerGroup: Session = {
      id: 'sess-A-worker-group',
      agent_group_id: A,
      messaging_group_id: 'mg-A-worker',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-10T00:00:00.000Z',
    };
    await createSession(AWorkerGroup);
    initSessionFolder(A, AWorkerGroup.id);

    // A's worker-group session sends to B with no reply context — its
    // source_session_id becomes the peer-affinity signal for B's replies.
    await routeAgentMessage(
      {
        id: 'msg-from-A-workergroup',
        platform_id: B,
        content: JSON.stringify({ text: 'from the worker group' }),
        in_reply_to: null,
      },
      AWorkerGroup,
    );

    // B replies with no in_reply_to. Peer-affinity finds AWorkerGroup, but it
    // is channel-bound (messaging_group_id set) — Tier 2 must reject it and
    // fall through to the dedicated peer session instead.
    await routeAgentMessage(
      {
        id: 'msg-from-B-to-workergroup',
        platform_id: A,
        content: JSON.stringify({ text: 'reply' }),
        in_reply_to: null,
      },
      SB,
    );

    const workerRows = readInbound(A, AWorkerGroup.id);
    expect(workerRows).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(A, B);
    expect(dedicated).toBeDefined();
    const dRows = readInbound(A, dedicated!.id);
    expect(dRows).toHaveLength(1);
    expect(JSON.parse(dRows[0].content).text).toBe('reply');
  });

  it('stale origin fallback: closed origin session falls through to the dedicated peer session, never a channel session', async () => {
    // A.S1 sends to B, establishing source_session_id = S1.id on B's inbound.
    await routeAgentMessage(
      { id: 'msg-fwd', platform_id: B, content: JSON.stringify({ text: 'hello' }), in_reply_to: null },
      S1,
    );
    const bRows = readInbound(B, SB.id);
    const inboundId = bRows[0].id;

    // Close S1 — simulates session cleanup or channel disconnect.
    await updateSession(S1.id, { status: 'closed' });

    // B replies. Origin points to S1 (closed) — Tier 1's active-status check
    // fails, so this must NOT silently fall to "newest active" (S2); it must
    // fall all the way to the dedicated peer session.
    await routeAgentMessage(
      { id: 'msg-reply-stale', platform_id: A, content: JSON.stringify({ text: 'reply' }), in_reply_to: inboundId },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(A, B);
    expect(dedicated).toBeDefined();
    expect(readInbound(A, dedicated!.id)).toHaveLength(1);
  });

  it('cross-agent-group guard: origin session belonging to wrong agent group is rejected', async () => {
    // Third agent group C sends to B, stamping source_session_id = SC on B's inbound.
    const C = 'ag-C';
    await createAgentGroup({ id: C, name: 'C', folder: 'c', agent_provider: null, created_at: now() });
    const SC: Session = {
      id: 'sess-C',
      agent_group_id: C,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-03-01T00:00:00.000Z',
    };
    await createSession(SC);
    initSessionFolder(C, SC.id);
    await createDestination({
      agent_group_id: C,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
    });

    // Tamper: plant a row directly in SB's own inbound (the session that
    // will originate the reply below) whose source_session_id points at
    // SC — simulating an in_reply_to that resolves to a real row but one
    // that was stamped by the wrong agent group's session.
    const cInboundId = 'tampered-c-row';
    await writeSessionMessage(B, SB.id, {
      id: cInboundId,
      kind: 'chat',
      timestamp: now(),
      platformId: C,
      channelType: 'agent',
      content: JSON.stringify({ text: 'from C' }),
      sourceSessionId: SC.id,
    });

    // B replies to A, but in_reply_to references the C-originated row.
    // Guard rejects (SC belongs to C, not A) → must fall through to the
    // dedicated peer session, never "newest active" of A.
    await routeAgentMessage(
      {
        id: 'msg-reply-tamper',
        platform_id: A,
        content: JSON.stringify({ text: 'misdirected' }),
        in_reply_to: cInboundId,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(A, B);
    expect(dedicated).toBeDefined();
    expect(readInbound(A, dedicated!.id)).toHaveLength(1);
  });

  it('in_reply_to referencing a non-a2a row falls through to the dedicated peer session', async () => {
    // Write a channel message into B's inbound (no source_session_id).
    await writeSessionMessage(B, SB.id, {
      id: 'channel-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'user-123',
      channelType: 'slack',
      threadId: null,
      content: 'hello from slack',
    });

    // B replies to A with in_reply_to pointing to the channel message.
    // source_session_id is null → peer-affinity finds nothing either →
    // dedicated peer session, never "newest" of A.
    await routeAgentMessage(
      {
        id: 'msg-reply-channel',
        platform_id: A,
        content: JSON.stringify({ text: 'response' }),
        in_reply_to: 'channel-msg-1',
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(A, B);
    expect(dedicated).toBeDefined();
    expect(readInbound(A, dedicated!.id)).toHaveLength(1);
  });

  it('self-message is allowed without a destination row, and lands in a dedicated self-a2a session', async () => {
    // A targets itself — no agent_destinations row exists for A→A.
    await routeAgentMessage(
      { id: 'self-msg', platform_id: A, content: JSON.stringify({ text: 'self-note' }), in_reply_to: null },
      S1,
    );

    // Never S2 (no more "newest active session" fallback) — lands in A's own
    // dedicated system:a2a:A session.
    const s2Rows = readInbound(A, S2.id);
    expect(s2Rows).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(A, A);
    expect(dedicated).toBeDefined();
    const dRows = readInbound(A, dedicated!.id);
    expect(dRows).toHaveLength(1);
    expect(JSON.parse(dRows[0].content).text).toBe('self-note');
  });

  it('BUG: no volume cap on a2a routing — unbounded ping-pong is allowed (#2063)', async () => {
    // Two agents can exchange unlimited messages with no rate limit or loop
    // detection. This test documents the gap — it should FAIL once #2063 lands.
    // Unaffected by the session-isolation fix: still no cap, just a different
    // (now dedicated, isolated) session receiving the traffic.
    const errors: string[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        await routeAgentMessage(
          { id: `ping-${i}`, platform_id: B, content: JSON.stringify({ text: `ping ${i}` }), in_reply_to: null },
          S1,
        );
        await routeAgentMessage(
          { id: `pong-${i}`, platform_id: A, content: JSON.stringify({ text: `pong ${i}` }), in_reply_to: null },
          SB,
        );
      } catch (e) {
        errors.push((e as Error).message);
        break;
      }
    }
    // BUG: all 40 messages go through — no cap, no throttle.
    // Once loop prevention lands, this should throw or reject after a threshold.
    const bRows = readInbound(B, SB.id);
    const dedicated = await findDedicatedA2aSession(A, B);
    expect(dedicated).toBeDefined();
    const dRows = readInbound(A, dedicated!.id);
    expect(errors).toHaveLength(0);
    expect(bRows).toHaveLength(20);
    expect(dRows).toHaveLength(20);
    // Confirms isolation held throughout: S1/S2 never received any of it.
    expect(readInbound(A, S1.id)).toHaveLength(0);
    expect(readInbound(A, S2.id)).toHaveLength(0);
  });

  it('file forwarding: copies bytes from source outbox to target inbox', async () => {
    // Place a file in S1's outbox for the message.
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-file');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'report.pdf'), 'fake-pdf-bytes');

    await routeAgentMessage(
      {
        id: 'msg-with-file',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['report.pdf'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('report.pdf');
    expect(parsed.attachments[0].type).toBe('file');

    // Verify actual file bytes were copied to the target inbox.
    const targetPath = path.join(sessionDir(B, SB.id), parsed.attachments[0].localPath);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('fake-pdf-bytes');
  });

  it('file forwarding: skips symlinked source files', async () => {
    const secretPath = path.join(TEST_DIR, 'host-secret.txt');
    fs.writeFileSync(secretPath, 'host-secret-bytes');

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-with-symlink');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.symlinkSync(secretPath, path.join(outboxDir, 'safe-name.txt'));

    await routeAgentMessage(
      {
        id: 'msg-with-symlink',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['safe-name.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(0);
  });

  // #2828 — target-side symlink containment. A compromised target agent can
  // write inside its own session dir; these tests prove it cannot redirect a
  // forwarded attachment outside the session sandbox via a pre-placed symlink.

  it('file forwarding (#2828): skips a symlinked target inbox dir, writes nothing outside', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const canaryDir = path.join(TEST_DIR, 'canary-outside-inbox');
    fs.mkdirSync(canaryDir, { recursive: true });

    // Source has a real attachment to forward.
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-evil-inbox');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'pwn.txt'), 'attacker-bytes');

    // Target pre-places its whole `inbox` as a symlink pointing outside.
    const targetInbox = path.join(sessionDir(B, SB.id), 'inbox');
    fs.rmSync(targetInbox, { recursive: true, force: true });
    fs.symlinkSync(canaryDir, targetInbox);

    await routeAgentMessage(
      {
        id: 'msg-evil-inbox',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['pwn.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    // Message still routes — just with no attachments.
    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    expect(JSON.parse(bRows[0].content).attachments).toHaveLength(0);

    // Nothing was written through the symlink to the canary location.
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('file forwarding (#2828): skips a symlinked inbox/<msgId> subdir, writes nothing outside', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const canaryDir = path.join(TEST_DIR, 'canary-outside-subdir');
    fs.mkdirSync(canaryDir, { recursive: true });

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-evil-subdir');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'pwn.txt'), 'attacker-bytes');

    // The forwarded a2a msg id generated inside routeAgentMessage is random, so
    // a symlink can't be pre-placed at inbox/<that-id>. Drive forwardAttachedFiles
    // directly with a fixed target message id and plant the symlink at that path.
    const targetMsgId = 'evil-subdir-msg';
    const realInbox = path.join(sessionDir(B, SB.id), 'inbox');
    fs.mkdirSync(realInbox, { recursive: true });
    fs.symlinkSync(canaryDir, path.join(realInbox, targetMsgId));

    const attachments = forwardAttachedFiles(
      { agentGroupId: A, sessionId: S1.id, messageId: 'msg-evil-subdir', filenames: ['pwn.txt'] },
      { agentGroupId: B, sessionId: SB.id, messageId: targetMsgId },
    );

    expect(attachments).toHaveLength(0);
    expect(fs.readdirSync(canaryDir)).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('file forwarding (#2828): refuses a pre-existing symlinked dst file (COPYFILE_EXCL)', async () => {
    const warnSpy = vi.spyOn(log, 'warn');
    const canaryFile = path.join(TEST_DIR, 'canary-dst-target.txt');
    fs.writeFileSync(canaryFile, 'original-canary');

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-evil-dst');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'doc.txt'), 'attacker-bytes');

    // inbox/<msgId>/ is a real dir, but contains a pre-placed symlink named
    // exactly like the incoming attachment, pointing at the canary file.
    // We can only do this once we know the a2a msg id, which is generated
    // inside routeAgentMessage. So we instead drive forwardAttachedFiles
    // directly with a fixed target message id.
    const targetMsgId = 'fixed-evil-dst';
    const realInboxSubdir = path.join(sessionDir(B, SB.id), 'inbox', targetMsgId);
    fs.mkdirSync(realInboxSubdir, { recursive: true });
    fs.symlinkSync(canaryFile, path.join(realInboxSubdir, 'doc.txt'));

    const attachments = forwardAttachedFiles(
      { agentGroupId: A, sessionId: S1.id, messageId: 'msg-evil-dst', filenames: ['doc.txt'] },
      { agentGroupId: B, sessionId: SB.id, messageId: targetMsgId },
    );

    // The exclusive write failed → nothing forwarded.
    expect(attachments).toHaveLength(0);
    // Canary file untouched (symlink not followed/overwritten).
    expect(fs.readFileSync(canaryFile, 'utf-8')).toBe('original-canary');
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('file forwarding (#2828 regression): a normal forward still works end-to-end', async () => {
    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'msg-ok-file');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, 'ok.txt'), 'legit-bytes');

    await routeAgentMessage(
      {
        id: 'msg-ok-file',
        platform_id: B,
        content: JSON.stringify({ text: 'see attached', files: ['ok.txt'] }),
        in_reply_to: null,
      },
      S1,
    );

    const bRows = readInbound(B, SB.id);
    expect(bRows).toHaveLength(1);
    const parsed = JSON.parse(bRows[0].content);
    expect(parsed.attachments).toHaveLength(1);
    expect(parsed.attachments[0].name).toBe('ok.txt');
    const targetPath = path.join(sessionDir(B, SB.id), parsed.attachments[0].localPath);
    expect(fs.existsSync(targetPath)).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf-8')).toBe('legit-bytes');
  });
});

/**
 * Regression coverage for the real Pepper ↔ Maintenance Coordinator bug:
 * a fresh private a2a request could land in MC's real worker-group session
 * because the old fallback picked "newest active session" and never
 * distinguished a dedicated a2a session from a channel-bound one.
 */
describe('routeAgentMessage — dedicated peer session separation (Pepper ↔ Maintenance Coordinator)', () => {
  const PEPPER = 'ag-pepper';
  const MC = 'ag-maintenance-coordinator';
  const OTHER_PEER = 'ag-other-peer';

  let pepperDm: Session;
  let mcWorkerGroup: Session;
  let mcTaskSession: Session;

  beforeEach(async () => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = await initTestDb();
    await runMigrations(db);

    await createAgentGroup({ id: PEPPER, name: 'Pepper', folder: 'pepper', agent_provider: null, created_at: now() });
    await createAgentGroup({
      id: MC,
      name: 'Maintenance Coordinator',
      folder: 'maintenance-coordinator',
      agent_provider: null,
      created_at: now(),
    });
    await createAgentGroup({
      id: OTHER_PEER,
      name: 'Other Peer',
      folder: 'other-peer',
      agent_provider: null,
      created_at: now(),
    });

    // Kirk's real, existing private Telegram DM session with Pepper — channel-bound.
    await createMessagingGroup({
      id: 'mg-kirk-telegram-dm',
      channel_type: 'telegram',
      platform_id: 'telegram:8855929473',
      instance: 'telegram',
      name: 'Kirk DM',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    pepperDm = {
      id: 'sess-pepper-kirk-dm',
      agent_group_id: PEPPER,
      messaging_group_id: 'mg-kirk-telegram-dm',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-01T00:00:00.000Z',
    };
    await createSession(pepperDm);
    initSessionFolder(PEPPER, pepperDm.id);

    // Maintenance Coordinator's real, existing worker-group Telegram session — channel-bound.
    await createMessagingGroup({
      id: 'mg-mc-worker-telegram',
      channel_type: 'telegram',
      platform_id: 'telegram:-100mcworker',
      instance: 'telegram',
      name: 'Maintenance',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now(),
    });
    mcWorkerGroup = {
      id: 'sess-mc-worker-group',
      agent_group_id: MC,
      messaging_group_id: 'mg-mc-worker-telegram',
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-02T00:00:00.000Z',
    };
    await createSession(mcWorkerGroup);
    initSessionFolder(MC, mcWorkerGroup.id);

    // A scheduled-task session under MC — system:tasks:<seriesId>, isolated
    // from both the worker group and any a2a conversation.
    mcTaskSession = {
      id: 'sess-mc-task',
      agent_group_id: MC,
      messaging_group_id: null,
      thread_id: taskThreadId('nightly-digest'),
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-03T00:00:00.000Z',
    };
    await createSession(mcTaskSession);
    initSessionFolder(MC, mcTaskSession.id);

    await createDestination({ agent_group_id: PEPPER, local_name: 'mc', target_type: 'agent', target_id: MC, created_at: now() });
    await createDestination({ agent_group_id: MC, local_name: 'pepper', target_type: 'agent', target_id: PEPPER, created_at: now() });
  });

  afterEach(async () => {
    await closeDb();
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  });

  it('1. Pepper → MC creates/reuses the dedicated A2A session, not the worker-group session', async () => {
    await routeAgentMessage(
      {
        id: 'msg-pepper-to-mc-1',
        platform_id: MC,
        content: JSON.stringify({ text: 'Kirk wants to know if 317 Wilfred is on the schedule today' }),
        in_reply_to: null,
      },
      pepperDm,
    );

    expect(readInbound(MC, mcWorkerGroup.id)).toHaveLength(0);
    expect(readInbound(MC, mcTaskSession.id)).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    expect(dedicated).toBeDefined();
    expect(dedicated!.messaging_group_id).toBeNull();
    const dRows = readInbound(MC, dedicated!.id);
    expect(dRows).toHaveLength(1);
    expect(JSON.parse(dRows[0].content).text).toContain('317 Wilfred');
  });

  it("2. MC reply via explicit in_reply_to returns to Pepper's existing private DM session and creates no new Pepper session", async () => {
    await routeAgentMessage(
      { id: 'msg-pepper-to-mc-2', platform_id: MC, content: JSON.stringify({ text: 'status?' }), in_reply_to: null },
      pepperDm,
    );
    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    const mcRows = readInbound(MC, dedicated!.id);
    const inboundId = mcRows[0].id;

    const sessionsForPepperBefore = (await getSessionsByAgentGroup(PEPPER)).length;

    await routeAgentMessage(
      {
        id: 'msg-mc-to-pepper-reply',
        platform_id: PEPPER,
        content: JSON.stringify({ text: 'Yes, on the schedule — Elehazar is on it.' }),
        in_reply_to: inboundId,
      },
      dedicated!,
    );

    // Lands in Kirk's existing real DM session — channel-bound, accepted
    // because it's an explicit reply (Tier 1), never rejected for being
    // channel-bound.
    const dmRows = readInbound(PEPPER, pepperDm.id);
    expect(dmRows).toHaveLength(1);
    expect(JSON.parse(dmRows[0].content).text).toContain('Elehazar');

    // No new session was created under Pepper's agent group.
    expect(await getSessionsByAgentGroup(PEPPER)).toHaveLength(sessionsForPepperBefore);
  });

  it('3. A stale MC worker-group/channel session is rejected as A2A affinity — never captures a private request', async () => {
    // Simulate the exact historical bug: MC's own worker-group session has
    // some prior a2a history with Pepper's agent group (e.g. from a much
    // earlier code path) — peer-affinity must still reject it for being
    // channel-bound, even though it's technically "the most recent contact."
    await routeAgentMessage(
      { id: 'msg-mc-worker-to-pepper', platform_id: PEPPER, content: JSON.stringify({ text: 'fyi' }), in_reply_to: null },
      mcWorkerGroup,
    );
    // Pepper replies with no in_reply_to — peer-affinity would naively find
    // mcWorkerGroup as "the last MC session that contacted me."
    await routeAgentMessage(
      { id: 'msg-pepper-followup', platform_id: MC, content: JSON.stringify({ text: 'got it' }), in_reply_to: null },
      pepperDm,
    );

    expect(readInbound(MC, mcWorkerGroup.id)).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    expect(dedicated).toBeDefined();
    expect(readInbound(MC, dedicated!.id)).toHaveLength(1);
  });

  it('4. A task/wake session is rejected as A2A affinity', async () => {
    // MC's task session sends an a2a message to Pepper (edge case: a task
    // run reporting out via send_message) — establishes affinity from
    // Pepper's side pointing at the task session.
    await routeAgentMessage(
      { id: 'msg-mc-task-to-pepper', platform_id: PEPPER, content: JSON.stringify({ text: 'nightly digest done' }), in_reply_to: null },
      mcTaskSession,
    );
    await routeAgentMessage(
      { id: 'msg-pepper-to-mc-after-task', platform_id: MC, content: JSON.stringify({ text: 'thanks' }), in_reply_to: null },
      pepperDm,
    );

    expect(readInbound(MC, mcTaskSession.id)).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    expect(dedicated).toBeDefined();
    expect(readInbound(MC, dedicated!.id)).toHaveLength(1);
  });

  it("5. Another peer's A2A session cannot be selected for Pepper", async () => {
    // MC already has its own dedicated a2a session with a THIRD agent group.
    const { session: mcOtherPeerSession } = await resolveA2aSession(MC, OTHER_PEER);

    await routeAgentMessage(
      { id: 'msg-pepper-to-mc-5', platform_id: MC, content: JSON.stringify({ text: 'hi' }), in_reply_to: null },
      pepperDm,
    );

    expect(readInbound(MC, mcOtherPeerSession.id)).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    expect(dedicated).toBeDefined();
    expect(dedicated!.id).not.toBe(mcOtherPeerSession.id);
    expect(readInbound(MC, dedicated!.id)).toHaveLength(1);
  });

  it('6. Worker-group traffic remains fully isolated from the private A2A session', async () => {
    await routeAgentMessage(
      { id: 'msg-pepper-to-mc-6', platform_id: MC, content: JSON.stringify({ text: 'private question' }), in_reply_to: null },
      pepperDm,
    );

    // A real worker message lands in the worker-group session via the
    // ordinary channel-inbound path — writeSessionMessage, unrelated to a2a.
    await writeSessionMessage(MC, mcWorkerGroup.id, {
      id: 'worker-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'telegram:worker-1',
      channelType: 'telegram',
      threadId: null,
      content: JSON.stringify({ text: 'Elehazar: estoy en 114 cecil Street' }),
    });

    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    expect(readInbound(MC, dedicated!.id)).toHaveLength(1);
    expect(readInbound(MC, mcWorkerGroup.id)).toHaveLength(1);
    // Neither session's content leaked into the other.
    expect(JSON.parse(readInbound(MC, dedicated!.id)[0].content).text).toContain('private question');
    expect(JSON.parse(readInbound(MC, mcWorkerGroup.id)[0].content).text).toContain('cecil Street');
  });

  it('7. Scheduled/task traffic remains in its own task session, untouched by A2A routing', async () => {
    await routeAgentMessage(
      { id: 'msg-pepper-to-mc-7', platform_id: MC, content: JSON.stringify({ text: 'hi' }), in_reply_to: null },
      pepperDm,
    );

    expect(readInbound(MC, mcTaskSession.id)).toHaveLength(0);
    const dedicated = await findDedicatedA2aSession(MC, PEPPER);
    expect(dedicated!.id).not.toBe(mcTaskSession.id);
    expect(dedicated!.thread_id).not.toBe(mcTaskSession.thread_id);
  });
});
