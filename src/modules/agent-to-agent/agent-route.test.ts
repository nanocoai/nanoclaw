import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { describe, expect, it, beforeEach, afterEach, vi } from 'vitest';

import { isSafeAttachmentName, routeAgentMessage } from './agent-route.js';
import { createDestination } from './db/agent-destinations.js';
import { initTestDb, closeDb, runMigrations, createAgentGroup } from '../../db/index.js';
import { createSession, updateSession } from '../../db/sessions.js';
import { initSessionFolder, inboundDbPath, sessionDir, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';

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

  beforeEach(() => {
    if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
    fs.mkdirSync(TEST_DIR, { recursive: true });

    const db = initTestDb();
    runMigrations(db);

    createAgentGroup({ id: A, name: 'A', folder: 'a', agent_provider: null, created_at: now() });
    createAgentGroup({ id: B, name: 'B', folder: 'b', agent_provider: null, created_at: now() });

    // S1 (older), S2 (newer) — both active sessions on A.
    S1 = {
      id: 'sess-A-old',
      agent_group_id: A,
      messaging_group_id: null,
      thread_id: null,
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
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-02-01T00:00:00.000Z',
    };
    SB = {
      id: 'sess-B',
      agent_group_id: B,
      messaging_group_id: null,
      thread_id: null,
      agent_provider: null,
      status: 'active',
      container_status: 'stopped',
      last_active: null,
      created_at: '2026-01-15T00:00:00.000Z',
    };
    createSession(S1);
    createSession(S2);
    createSession(SB);
    initSessionFolder(A, S1.id);
    initSessionFolder(A, S2.id);
    initSessionFolder(B, SB.id);

    createDestination({
      agent_group_id: A,
      local_name: 'b',
      target_type: 'agent',
      target_id: B,
      created_at: now(),
    });
    createDestination({
      agent_group_id: B,
      local_name: 'a',
      target_type: 'agent',
      target_id: A,
      created_at: now(),
    });
  });

  afterEach(() => {
    closeDb();
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

  it('fallback: a2a with no in_reply_to falls through to newest-session lookup', async () => {
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

    // Newest session wins (current heuristic, preserved).
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('peer-affinity fallback: with no in_reply_to, routes to most recent peer-source session', async () => {
    // A.S1 sends to B (establishing affinity: B's last contact from A was via S1).
    await routeAgentMessage(
      {
        id: 'msg-from-A-S1-pre',
        platform_id: B,
        content: JSON.stringify({ text: 'context-establishing' }),
        in_reply_to: null,
      },
      S1,
    );

    // B sends a follow-up but its container forgot to set in_reply_to (e.g.
    // emitted via an MCP tool path that doesn't thread the batch's in_reply_to
    // through). The host should still route this to S1 because S1 is the
    // session most recently in conversation with B — not the chronologically
    // newest session of A.
    await routeAgentMessage(
      {
        id: 'msg-from-B-followup',
        platform_id: A,
        content: JSON.stringify({ text: 'standing by' }),
        in_reply_to: null,
      },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    // Affinity wins: reply to S1, not the newer S2.
    expect(s1Rows).toHaveLength(1);
    expect(JSON.parse(s1Rows[0].content).text).toBe('standing by');
    expect(s2Rows).toHaveLength(0);
  });

  it('stale origin fallback: closed origin session falls through to newest active', async () => {
    // A.S1 sends to B, establishing source_session_id = S1.id on B's inbound.
    await routeAgentMessage(
      { id: 'msg-fwd', platform_id: B, content: JSON.stringify({ text: 'hello' }), in_reply_to: null },
      S1,
    );
    const bRows = readInbound(B, SB.id);
    const inboundId = bRows[0].id;

    // Close S1 — simulates session cleanup or channel disconnect.
    updateSession(S1.id, { status: 'closed' });

    // B replies. origin points to S1 (closed), should fall through to S2.
    await routeAgentMessage(
      { id: 'msg-reply-stale', platform_id: A, content: JSON.stringify({ text: 'reply' }), in_reply_to: inboundId },
      SB,
    );

    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(s1Rows).toHaveLength(0);
    expect(s2Rows).toHaveLength(1);
  });

  it('cross-agent-group guard: origin session belonging to wrong agent group is rejected', async () => {
    // Third agent group C sends to B, stamping source_session_id = SC on B's inbound.
    const C = 'ag-C';
    createAgentGroup({ id: C, name: 'C', folder: 'c', agent_provider: null, created_at: now() });
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
    createSession(SC);
    initSessionFolder(C, SC.id);
    createDestination({ agent_group_id: C, local_name: 'b', target_type: 'agent', target_id: B, created_at: now() });

    await routeAgentMessage(
      { id: 'msg-from-C', platform_id: B, content: JSON.stringify({ text: 'from C' }), in_reply_to: null },
      SC,
    );
    const bRows = readInbound(B, SB.id);
    const cInboundId = bRows.find((r) => r.platform_id === C)!.id;

    // B replies to A, but in_reply_to references the C-originated row.
    // Guard rejects (SC belongs to C, not A) → falls through to newest of A.
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
    expect(s2Rows).toHaveLength(1);
  });

  it('in_reply_to referencing a non-a2a row falls through to newest session', async () => {
    // Write a channel message into B's inbound (no source_session_id).
    writeSessionMessage(B, SB.id, {
      id: 'channel-msg-1',
      kind: 'chat',
      timestamp: now(),
      platformId: 'user-123',
      channelType: 'slack',
      threadId: null,
      content: 'hello from slack',
    });

    // B replies to A with in_reply_to pointing to the channel message.
    // source_session_id is null → peer-affinity finds nothing → newest of A.
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
    expect(s2Rows).toHaveLength(1);
  });

  it('self-message is allowed without a destination row', async () => {
    // A targets itself — no agent_destinations row exists for A→A.
    await routeAgentMessage(
      { id: 'self-msg', platform_id: A, content: JSON.stringify({ text: 'self-note' }), in_reply_to: null },
      S1,
    );

    // Lands in S2 (newest active session of A via resolveSession fallback).
    const s2Rows = readInbound(A, S2.id);
    expect(s2Rows).toHaveLength(1);
    expect(JSON.parse(s2Rows[0].content).text).toBe('self-note');
  });

  it('file forwarding: refuses to plant a persistent Claude skill through a symlinked target inbox root', async () => {
    const filename = 'SKILL.md';
    const skillBody = [
      '---',
      'name: planted-skill',
      'description: proves target inbox root symlink escape',
      '---',
      '',
      '# Planted skill',
      '',
      'INBOX_ROOT_SYMLINK_SKILL_CHAIN',
      '',
    ].join('\n');

    const outboxDir = path.join(sessionDir(A, S1.id), 'outbox', 'self-file-msg');
    fs.mkdirSync(outboxDir, { recursive: true });
    fs.writeFileSync(path.join(outboxDir, filename), skillBody);

    const skillsDir = path.join(TEST_DIR, 'v2-sessions', A, '.claude-shared', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    for (const targetSession of [S1, S2]) {
      const inboxRoot = path.join(sessionDir(A, targetSession.id), 'inbox');
      fs.rmSync(inboxRoot, { recursive: true, force: true });
      fs.symlinkSync('../.claude-shared/skills', inboxRoot, 'dir');
    }

    await routeAgentMessage(
      {
        id: 'self-file-msg',
        platform_id: A,
        content: JSON.stringify({ text: 'self file', files: [filename] }),
        in_reply_to: null,
      },
      S1,
    );

    const plantedSkillFiles = fs
      .readdirSync(skillsDir, { recursive: true })
      .filter((entry) => entry.toString().endsWith('/SKILL.md'));
    expect(plantedSkillFiles).toEqual([]);
  });

  it('BUG: no volume cap on a2a routing — unbounded ping-pong is allowed (#2063)', async () => {
    // Two agents can exchange unlimited messages with no rate limit or loop
    // detection. This test documents the gap — it should FAIL once #2063 lands.
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
    const s1Rows = readInbound(A, S1.id);
    const s2Rows = readInbound(A, S2.id);
    expect(errors).toHaveLength(0);
    expect(bRows).toHaveLength(20);
    expect(s1Rows.length + s2Rows.length).toBe(20);
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
});
