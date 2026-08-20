/**
 * Cross-session context fan-out tests.
 *
 * Drives the real fan entries against real session folders on disk plus an
 * in-memory central DB, and the pure audience rule directly.
 */
import fs from 'fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-fan' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession } from '../../db/sessions.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { MessagingGroup, Session } from '../../types.js';
import {
  buildDeliveredEchoLabel,
  buildEchoLabel,
  buildSiblingEchoLabel,
  fanInboundMessage,
  fanOutboundMessage,
  selectEchoTargets,
  truncateEchoText,
} from './fan.js';
import { ECHO_CHANNEL_TYPE, ECHO_SIBLING_SURFACE, ECHO_TASK_SURFACE, ECHO_TEXT_MAX_CHARS } from './config.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-fan';
const AG = 'ag-1';
const NOW = new Date().toISOString();

function mg(id: string, platformId: string, isGroup: number, name: string | null): MessagingGroup {
  return {
    id,
    channel_type: 'slack',
    platform_id: platformId,
    instance: 'slack',
    name,
    is_group: isGroup,
    unknown_sender_policy: 'public',
    denied_at: null,
    created_at: NOW,
  };
}

function session(
  id: string,
  agentGroupId: string,
  mgId: string | null,
  threadId: string | null,
  status: 'active' | 'closed' = 'active',
): Session {
  return {
    id,
    agent_group_id: agentGroupId,
    messaging_group_id: mgId,
    thread_id: threadId,
    agent_provider: null,
    status,
    container_status: 'stopped',
    last_active: null,
    created_at: NOW,
  };
}

const ROOM_MG = mg('mg-room', 'C123', 1, 'pixel-room');
const DM_MG = mg('mg-dm', 'D456', 0, 'Gavriel');
const ROOM2_MG = mg('mg-room2', 'C789', 1, null);
const DM2_MG = mg('mg-dm2', 'D999', 0, 'Someone');

const SRC_ROOM = session('s-room', AG, 'mg-room', null);
const SRC_DM = session('s-dm', AG, 'mg-dm', null);
// Sibling conversation-thread of the SAME DM (agent-mode per-thread session).
const DM_SIBLING = session('s-dm-t2', AG, 'mg-dm', '1723456.789');
const TASK_SESS = session('s-task', AG, null, 'system:tasks:daily-1');

function readEchoRows(sessionId: string): Array<Record<string, unknown>> {
  const dbPath = inboundDbPath(AG, sessionId);
  if (!fs.existsSync(dbPath)) return [];
  const db = new Database(dbPath, { readonly: true });
  try {
    return db.prepare('SELECT * FROM messages_in WHERE channel_type = ? ORDER BY seq').all(ECHO_CHANNEL_TYPE) as Array<
      Record<string, unknown>
    >;
  } finally {
    db.close();
  }
}

function chatContent(text: string): string {
  return JSON.stringify({ text, sender: 'Gavriel', senderId: 'slack:U1' });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({ id: AG, name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: NOW });
  await createAgentGroup({ id: 'ag-2', name: 'Other', folder: 'other', agent_provider: null, created_at: NOW });
  for (const m of [ROOM_MG, DM_MG, ROOM2_MG, DM2_MG]) await createMessagingGroup(m);
  await createSession(SRC_ROOM);
  await createSession(SRC_DM);
  await createSession(DM_SIBLING);
  await createSession(TASK_SESS);
  await createSession(session('s-room2', AG, 'mg-room2', null));
  await createSession(session('s-dm2', AG, 'mg-dm2', null));
  await createSession(session('s-dm-closed', AG, 'mg-dm', 'closed-thread', 'closed'));
  await createSession(session('s-a2a', AG, null, null));
  await createSession(session('s-other-group', 'ag-2', 'mg-dm', null));
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('selectEchoTargets (same-conversation audience rule)', () => {
  const candidates = [
    { id: 's-src', status: 'active', messaging_group_id: 'mg-room' },
    { id: 's-room-t2', status: 'active', messaging_group_id: 'mg-room' },
    { id: 's-dm', status: 'active', messaging_group_id: 'mg-dm' },
    { id: 's-dm-t2', status: 'active', messaging_group_id: 'mg-dm' },
    { id: 's-dm2', status: 'active', messaging_group_id: 'mg-dm2' },
    { id: 's-room2', status: 'active', messaging_group_id: 'mg-room2' },
    { id: 's-task', status: 'active', messaging_group_id: null },
    { id: 's-a2a', status: 'active', messaging_group_id: null },
    { id: 's-closed', status: 'closed', messaging_group_id: 'mg-dm' },
  ];

  it('targets ONLY active same-mg siblings: never other conversations, task/a2a sessions, closed, or the source', async () => {
    const ids = selectEchoTargets(candidates, 's-dm', 'mg-dm').map((s) => s.id);
    expect(ids.sort()).toEqual(['s-dm-t2']);
  });

  it('room thread siblings are same-mg and therefore targets', async () => {
    const ids = selectEchoTargets(candidates, 's-src', 'mg-room').map((s) => s.id);
    expect(ids.sort()).toEqual(['s-room-t2']);
  });

  it('an unresolved source conversation fans nowhere', async () => {
    expect(selectEchoTargets(candidates, 's-dm', null)).toEqual([]);
  });
});

describe('fanInboundMessage', () => {
  it('fans a DM trigger into same-mg sibling threads ONLY — never rooms, other DMs, or task sessions', async () => {
    const written = await fanInboundMessage({
      session: SRC_DM,
      mg: DM_MG,
      messageId: 'msg-2:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: chatContent('private note'),
      timestamp: NOW,
    });
    expect(written).toBe(1);

    // Sibling thread of the SAME DM gets the sibling-flavored echo with the
    // contract row shape.
    const sibRows = readEchoRows('s-dm-t2');
    expect(sibRows).toHaveLength(1);
    expect(sibRows[0].id).toBe('msg-2:ag-1:echo:s-dm-t2');
    expect(sibRows[0].kind).toBe('chat');
    expect(sibRows[0].trigger).toBe(0);
    expect(sibRows[0].thread_id).toBeNull();
    expect(sibRows[0].platform_id).toBe('D456');
    expect(sibRows[0].source_session_id).toBe('s-dm');
    const sibContent = JSON.parse(sibRows[0].content as string);
    expect(sibContent.text).toBe('private note');
    expect(sibContent.sender).toBe('Gavriel');
    expect(sibContent.senderId).toBe('slack:U1');
    expect(sibContent.echo).toEqual({
      surface: ECHO_SIBLING_SURFACE,
      label: 'another conversation with Gavriel',
    });

    // Nothing else in the group hears it: not task sessions, not rooms, not
    // other DMs, not a2a/closed/other-group sessions.
    expect(readEchoRows('s-task')).toHaveLength(0);
    expect(readEchoRows('s-room')).toHaveLength(0);
    expect(readEchoRows('s-room2')).toHaveLength(0);
    expect(readEchoRows('s-dm2')).toHaveLength(0);
    expect(readEchoRows('s-a2a')).toHaveLength(0);
    expect(readEchoRows('s-dm-closed')).toHaveLength(0);
    expect(fs.existsSync(inboundDbPath('ag-2', 's-other-group'))).toBe(false);
    // Source session itself never receives its own echo.
    expect(readEchoRows('s-dm')).toHaveLength(0);
  });

  it('a room trigger reaches same-mg room thread siblings only — room→DM and room→task are retired', async () => {
    await createSession(session('s-room-t2', AG, 'mg-room', 'room-thread-2'));
    const written = await fanInboundMessage({
      session: SRC_ROOM,
      mg: ROOM_MG,
      messageId: 'msg-1:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: chatContent('hello from the room'),
      timestamp: NOW,
    });
    expect(written).toBe(1);
    const rows = readEchoRows('s-room-t2');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content as string).echo).toEqual({
      surface: ECHO_SIBLING_SURFACE,
      label: 'another conversation in #pixel-room room',
    });
    // The retired v1 targets stay silent.
    expect(readEchoRows('s-dm')).toHaveLength(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
    expect(readEchoRows('s-dm2')).toHaveLength(0);
    expect(readEchoRows('s-task')).toHaveLength(0);
  });

  it('a DM sibling-thread source fans back to the original DM session (symmetric)', async () => {
    const written = await fanInboundMessage({
      session: DM_SIBLING,
      mg: DM_MG,
      messageId: 'msg-2b:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: chatContent('from the other thread'),
      timestamp: NOW,
    });
    expect(written).toBe(1);
    const rows = readEchoRows('s-dm');
    expect(rows).toHaveLength(1);
    expect(rows[0].source_session_id).toBe('s-dm-t2');
    expect(JSON.parse(rows[0].content as string).echo.surface).toBe(ECHO_SIBLING_SURFACE);
    // Sibling source never echoes to itself.
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
  });

  it('truncates text to 500 chars head with … appended', async () => {
    const long = 'x'.repeat(ECHO_TEXT_MAX_CHARS + 100);
    await fanInboundMessage({
      session: SRC_DM,
      mg: DM_MG,
      messageId: 'msg-3:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: chatContent(long),
      timestamp: NOW,
    });
    const content = JSON.parse(readEchoRows('s-dm-t2')[0].content as string);
    expect(content.text).toBe('x'.repeat(ECHO_TEXT_MAX_CHARS) + '…');
    expect(content.text.length).toBe(ECHO_TEXT_MAX_CHARS + 1);
  });

  it('never fans echo rows, a2a rows, non-chat kinds, or empty text', async () => {
    const base = {
      session: SRC_ROOM,
      mg: ROOM_MG,
      messageId: 'msg-4:ag-1',
      content: chatContent('hi'),
      timestamp: NOW,
    };
    expect(await fanInboundMessage({ ...base, kind: 'chat', channelType: ECHO_CHANNEL_TYPE })).toBe(0);
    expect(await fanInboundMessage({ ...base, kind: 'chat', channelType: 'agent' })).toBe(0);
    expect(await fanInboundMessage({ ...base, kind: 'task', channelType: 'slack' })).toBe(0);
    expect(await fanInboundMessage({ ...base, kind: 'system', channelType: 'slack' })).toBe(0);
    expect(
      await fanInboundMessage({ ...base, kind: 'chat', channelType: 'slack', content: JSON.stringify({ text: '' }) }),
    ).toBe(0);
    expect(readEchoRows('s-dm')).toHaveLength(0);
    expect(readEchoRows('s-task')).toHaveLength(0);
  });

  it('never fans from a task session (task sessions are not a source)', async () => {
    const written = await fanInboundMessage({
      session: TASK_SESS,
      mg: ROOM_MG,
      messageId: 'msg-5:ag-1',
      kind: 'chat',
      channelType: 'slack',
      content: chatContent('task chatter'),
      timestamp: NOW,
    });
    expect(written).toBe(0);
    expect(readEchoRows('s-dm')).toHaveLength(0);
  });
});

describe('fanOutboundMessage', () => {
  const agentGroup = { id: AG, name: 'Pixel', folder: 'pixel', agent_provider: null, created_at: NOW };

  it('fans a delivered DM reply into same-mg sibling threads ONLY, with the agent as sender', async () => {
    const written = await fanOutboundMessage(
      {
        id: 'out-2',
        kind: 'chat',
        platform_id: 'D456',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'dm reply' }),
      },
      SRC_DM,
      agentGroup,
    );
    expect(written).toBe(1);
    // Retired v1 targets stay silent.
    expect(readEchoRows('s-task')).toHaveLength(0);
    expect(readEchoRows('s-room')).toHaveLength(0);
    expect(readEchoRows('s-dm2')).toHaveLength(0);
    const sibRows = readEchoRows('s-dm-t2');
    expect(sibRows).toHaveLength(1);
    expect(sibRows[0].id).toBe('out-2:echo:s-dm-t2');
    const sibContent = JSON.parse(sibRows[0].content as string);
    expect(sibContent.sender).toBe('Pixel');
    expect(sibContent.senderId).toBe(AG);
    expect(sibContent.echo).toEqual({
      surface: ECHO_SIBLING_SURFACE,
      label: 'another conversation with Gavriel',
    });
  });

  it('a delivered room reply reaches same-mg room siblings only — never the group DMs or task sessions', async () => {
    await createSession(session('s-room-t2', AG, 'mg-room', 'room-thread-2'));
    const written = await fanOutboundMessage(
      {
        id: 'out-1',
        kind: 'chat',
        platform_id: 'C123',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'agent answer' }),
      },
      SRC_ROOM,
      agentGroup,
    );
    expect(written).toBe(1);
    expect(readEchoRows('s-room-t2')).toHaveLength(1);
    expect(readEchoRows('s-dm')).toHaveLength(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
    expect(readEchoRows('s-task')).toHaveLength(0);
  });

  it("resolves the sender's own instance, not a lexically-first sibling, when instances share a platform address", async () => {
    // Two sibling messaging groups share one platform address (e.g. two bot
    // identities in the same multi-bot conversation) but belong to different
    // adapter instances. "alpha" sorts before "zulu", so a plain by-platform
    // lookup with no instance hint would pick "alpha" — the wrong sibling
    // for this sender.
    const dmAlpha = { ...mg('mg-dm-alpha', 'D-multi', 0, 'Shared DM'), instance: 'alpha' };
    const dmZulu = { ...mg('mg-dm-zulu', 'D-multi', 0, 'Shared DM'), instance: 'zulu' };
    await createMessagingGroup(dmAlpha);
    await createMessagingGroup(dmZulu);

    // The sender is only authorized against (and only reaches Slack through)
    // its "zulu" sibling.
    await createDestination({
      agent_group_id: AG,
      local_name: 'shared-dm',
      target_type: 'channel',
      target_id: 'mg-dm-zulu',
      created_at: NOW,
    });

    // Two candidate sibling sessions, one per instance's row — only the one
    // on the sender's own ("zulu") row should count as "the same DM".
    await createSession(session('s-sib-zulu', AG, 'mg-dm-zulu', 'thread-zulu'));
    await createSession(session('s-sib-alpha', AG, 'mg-dm-alpha', 'thread-alpha'));

    // Source is a room session (not the origin of "D-multi"), so resolution
    // falls into the non-origin, sibling-collision-prone branch.
    const written = await fanOutboundMessage(
      {
        id: 'out-shared-dm',
        kind: 'chat',
        platform_id: 'D-multi',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'heads up' }),
      },
      SRC_ROOM,
      agentGroup,
    );

    // Fans into exactly the sender's own sibling — never the "alpha" sibling
    // it isn't wired to, and never task sessions. This is a cross-
    // conversation send (source is the room session), so the echo carries
    // the delivered flavor, not the sibling-thread one.
    expect(readEchoRows('s-sib-zulu')).toHaveLength(1);
    expect(readEchoRows('s-sib-alpha')).toHaveLength(0);
    expect(JSON.parse(readEchoRows('s-sib-zulu')[0].content as string).echo).toEqual({
      surface: ECHO_SIBLING_SURFACE,
      label: 'this DM, posted by you from another conversation',
    });
    expect(readEchoRows('s-task')).toHaveLength(0);
    expect(written).toBe(1);
  });

  it('skips system/task_log/agent/echo/unrouted messages', async () => {
    const content = JSON.stringify({ text: 'x' });
    const base = { id: 'out-3', platform_id: 'C123', channel_type: 'slack', content };
    expect(await fanOutboundMessage({ ...base, kind: 'system' }, SRC_ROOM, agentGroup)).toBe(0);
    expect(await fanOutboundMessage({ ...base, kind: 'task_log' }, SRC_ROOM, agentGroup)).toBe(0);
    expect(await fanOutboundMessage({ ...base, kind: 'chat', channel_type: 'agent' }, SRC_ROOM, agentGroup)).toBe(0);
    expect(
      await fanOutboundMessage({ ...base, kind: 'chat', channel_type: ECHO_CHANNEL_TYPE }, SRC_ROOM, agentGroup),
    ).toBe(0);
    expect(await fanOutboundMessage({ ...base, kind: 'chat', platform_id: null }, SRC_ROOM, agentGroup)).toBe(0);
    // task_log from a task session (series bookkeeping) still never fans.
    expect(await fanOutboundMessage({ ...base, kind: 'task_log' }, TASK_SESS, agentGroup)).toBe(0);
    expect(readEchoRows('s-dm')).toHaveLength(0);
    expect(readEchoRows('s-task')).toHaveLength(0);
  });

  it("a task-session DM send fans ONLY into that DM's sessions, with the task-delivery shape", async () => {
    // A second task session proves task sessions are excluded as targets for
    // task-delivery fans (the source itself is excluded by id).
    await createSession(session('s-task2', AG, null, 'system:tasks:weekly-1'));
    const written = await fanOutboundMessage(
      {
        id: 'out-task-dm',
        kind: 'chat',
        platform_id: 'D456',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'daily digest' }),
      },
      TASK_SESS,
      agentGroup,
    );
    // Exactly the two sessions of mg-dm (the delivered-to conversation).
    expect(written).toBe(2);
    for (const sid of ['s-dm', 's-dm-t2']) {
      const rows = readEchoRows(sid);
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(`out-task-dm:echo:${sid}`);
      expect(rows[0].trigger).toBe(0);
      expect(rows[0].source_session_id).toBe('s-task');
      const content = JSON.parse(rows[0].content as string);
      expect(content.text).toBe('daily digest');
      expect(content.sender).toBe('Pixel');
      expect(content.echo).toEqual({
        surface: ECHO_TASK_SURFACE,
        label: 'this DM, posted by your scheduled task',
      });
    }
    // Never other DMs, rooms, or task sessions.
    expect(readEchoRows('s-dm2')).toHaveLength(0);
    expect(readEchoRows('s-room')).toHaveLength(0);
    expect(readEchoRows('s-task2')).toHaveLength(0);
  });

  it("a task-session room send fans only into that room's sessions — never the DM fan the room rule would give", async () => {
    const written = await fanOutboundMessage(
      {
        id: 'out-task-room',
        kind: 'chat',
        platform_id: 'C123',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'nightly report' }),
      },
      TASK_SESS,
      agentGroup,
    );
    expect(written).toBe(1);
    const rows = readEchoRows('s-room');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content as string).echo).toEqual({
      surface: ECHO_TASK_SURFACE,
      label: 'this room, posted by your scheduled task',
    });
    expect(readEchoRows('s-dm')).toHaveLength(0);
    expect(readEchoRows('s-dm-t2')).toHaveLength(0);
    expect(readEchoRows('s-dm2')).toHaveLength(0);
  });
});

describe('label + truncation helpers', () => {
  it('buildEchoLabel renders room and DM labels', async () => {
    expect(buildEchoLabel({ name: 'pixel-room', platform_id: 'C1', is_group: 1 })).toBe('#pixel-room room');
    expect(buildEchoLabel({ name: null, platform_id: 'C1', is_group: 1 })).toBe('#C1 room');
    expect(buildEchoLabel({ name: null, platform_id: 'D1', is_group: 0 }, 'Gavriel')).toBe('DM with Gavriel');
    expect(buildEchoLabel({ name: null, platform_id: 'D1', is_group: 0 }, null)).toBe('DM (D1)');
  });

  it('buildSiblingEchoLabel renders same-DM sibling labels with sensible fallbacks', async () => {
    expect(buildSiblingEchoLabel({ name: 'Gavriel', platform_id: 'D1', is_group: 0 })).toBe(
      'another conversation with Gavriel',
    );
    expect(buildSiblingEchoLabel({ name: null, platform_id: 'D1', is_group: 0 }, 'Gav')).toBe(
      'another conversation with Gav',
    );
    expect(buildSiblingEchoLabel({ name: null, platform_id: 'D1', is_group: 0 }, null)).toBe(
      'another conversation in DM (D1)',
    );
    // Defensive room shape (siblings are only selected for DM sources today).
    expect(buildSiblingEchoLabel({ name: 'pixel-room', platform_id: 'C1', is_group: 1 })).toBe(
      'another conversation in #pixel-room room',
    );
  });

  it("buildDeliveredEchoLabel names the delivered-to surface from the receiver's perspective", async () => {
    expect(buildDeliveredEchoLabel({ is_group: 0 }, true)).toBe('this DM, posted by your scheduled task');
    expect(buildDeliveredEchoLabel({ is_group: 1 }, true)).toBe('this room, posted by your scheduled task');
    expect(buildDeliveredEchoLabel({ is_group: 0 }, false)).toBe('this DM, posted by you from another conversation');
    expect(buildDeliveredEchoLabel({ is_group: 1 }, false)).toBe('this room, posted by you from another conversation');
  });

  it('truncateEchoText leaves short text untouched', async () => {
    expect(truncateEchoText('short')).toBe('short');
  });
});
