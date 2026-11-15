/**
 * `ncl sessions history` handler tests: merge/format, limit, and — the
 * critical one — self-scoping (custom ops bypass the dispatcher's generic
 * scope filter, so cross-group agents must get "session not found" here).
 */
import fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual<typeof import('../../config.js')>('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-cross-session-history' };
});

import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession } from '../../db/sessions.js';
import { initSessionFolder, writeOutboundDirect, writeSessionMessage } from '../../session-manager.js';
import type { CallerContext } from '../../cli/frame.js';
import {
  ECHO_CHANNEL_TYPE,
  ECHO_SIBLING_SURFACE,
  ECHO_TASK_SURFACE,
  ECHO_TEXT_MAX_CHARS,
  ECHO_TIMELINE_SURFACE,
} from './config.js';
import { capEchoText } from './fan.js';
import { formatHistoryLines, HISTORY_TEXT_MAX_CHARS, sessionHistory } from './history.js';

const TEST_DIR = '/tmp/nanoclaw-test-cross-session-history';
const AG = 'ag-hist';
const SESS = 'sess-hist';

const HOST: CallerContext = { caller: 'host' };
const OWN_AGENT: CallerContext = { caller: 'agent', sessionId: 'sess-x', agentGroupId: AG, messagingGroupId: 'mg-x' };
const FOREIGN_AGENT: CallerContext = {
  caller: 'agent',
  sessionId: 'sess-y',
  agentGroupId: 'ag-other',
  messagingGroupId: 'mg-y',
};

async function writeInbound(id: string, timestamp: string, text: string, sender = 'Alex'): Promise<void> {
  await writeSessionMessage(AG, SESS, {
    id,
    kind: 'chat',
    timestamp,
    platformId: 'D1',
    channelType: 'slack',
    threadId: null,
    content: JSON.stringify({ text, sender, senderId: 'slack:U1' }),
  });
}

beforeEach(async () => {
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = await initTestDb();
  await runMigrations(db);
  await createAgentGroup({
    id: AG,
    name: 'Pixel',
    folder: 'pixel',
    agent_provider: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  await createSession({
    id: SESS,
    agent_group_id: AG,
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: '2026-08-01T00:00:00.000Z',
  });
  initSessionFolder(AG, SESS);
});

afterEach(async () => {
  await closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true });
});

describe('sessionHistory', () => {
  it('merges inbound + outbound chronologically as structured rows (ISO timestamps)', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'hello there');
    await writeInbound('in-2', '2026-08-01T10:02:00.000Z', 'second message');
    // writeOutboundDirect stamps now() — always sorts after the fixed 2026 stamps.
    await writeOutboundDirect(AG, SESS, {
      id: 'out-1',
      kind: 'chat',
      platformId: 'D1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'agent reply' }),
    });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toEqual({
      timestamp: '2026-08-01T10:00:00.000Z',
      direction: 'in',
      kind: 'chat',
      sender: 'Alex',
      text: 'hello there',
    });
    expect(rows[1].text).toBe('second message');
    expect(rows[2].direction).toBe('out');
    expect(rows[2].kind).toBe('chat');
    expect(rows[2].sender).toBe('Pixel'); // agent group name as outbound sender
    expect(rows[2].text).toBe('agent reply');
  });

  it('formatHistoryLines renders pipe lines with localized stamps and capped cells', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'hello there');
    const lines = formatHistoryLines(await sessionHistory({ id: SESS }, HOST), 'UTC').split('\n');
    expect(lines).toEqual(['2026-08-01 10:00|in|chat|Alex|hello there']);
    // A non-UTC install timezone shifts the human stamp; data stays ISO.
    const berlin = formatHistoryLines(await sessionHistory({ id: SESS }, HOST), 'Europe/Berlin');
    expect(berlin.startsWith('2026-08-01 12:00|')).toBe(true);
  });

  it('applies --limit keeping the NEWEST rows', async () => {
    for (let i = 0; i < 5; i++) {
      await writeInbound(`in-${i}`, `2026-08-01T10:0${i}:00.000Z`, `msg ${i}`);
    }
    const rows = await sessionHistory({ id: SESS, limit: 2 }, HOST);
    expect(rows).toHaveLength(2);
    expect(rows[0].text).toBe('msg 3');
    expect(rows[1].text).toBe('msg 4');
  });

  it('sanitizes newlines and pipes in the human rendering only — rows keep the raw text', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'line one\nline two | with pipe');
    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0].text).toBe('line one\nline two | with pipe');
    const line = formatHistoryLines(rows, 'UTC');
    expect(line.split('\n')).toHaveLength(1);
    expect(line.endsWith('line one line two / with pipe')).toBe(true);
  });

  it('self-scopes: a cross-group agent gets "session not found", same as a bogus id', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'private');
    await expect(sessionHistory({ id: SESS }, FOREIGN_AGENT)).rejects.toThrow(`session not found: ${SESS}`);
    await expect(sessionHistory({ id: 'sess-nope' }, FOREIGN_AGENT)).rejects.toThrow('session not found: sess-nope');
    await expect(sessionHistory({ id: 'sess-nope' }, HOST)).rejects.toThrow('session not found: sess-nope');
  });

  it('allows the owning agent group and the host', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'visible');
    expect((await sessionHistory({ id: SESS }, OWN_AGENT))[0].text).toBe('visible');
    expect((await sessionHistory({ id: SESS }, HOST))[0].text).toBe('visible');
  });
});

describe('sessionHistory — cross-session copies (session-echo rows)', () => {
  const SIBLING = 'sess-sibling';

  /**
   * An echo row with fan.ts's shape: capEchoText for the text and the
   * truncated flag, the real surface constants, the source session, trigger=0.
   */
  async function writeEcho(
    id: string,
    timestamp: string,
    text: string,
    opts: { self?: boolean; sender?: string; surface?: string; label?: string; source?: string | null } = {},
  ) {
    const capped = capEchoText(text);
    await writeSessionMessage(AG, SESS, {
      id: `${id}:echo:${SESS}`,
      kind: 'chat',
      timestamp,
      platformId: 'D1',
      channelType: ECHO_CHANNEL_TYPE,
      threadId: null,
      content: JSON.stringify({
        text: capped.text,
        sender: opts.sender ?? 'Pixel',
        senderId: opts.self ? AG : 'slack:U1',
        ...(opts.self ? { self: true } : {}),
        echo: {
          surface: opts.surface ?? ECHO_SIBLING_SURFACE,
          label: opts.label ?? 'another thread with Alex',
          ...(capped.truncated ? { truncated: true } : {}),
        },
      }),
      trigger: false,
      sourceSessionId: opts.source === undefined ? SIBLING : opts.source,
    });
  }

  it("marks a copy of a sibling session's delivered reply, so it does not read as an unanswered message", async () => {
    await writeEcho('out-sib-1', '2026-08-01T10:00:00.000Z', 'The answer is 42.', { self: true });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0]).toEqual({
      timestamp: '2026-08-01T10:00:00.000Z',
      direction: 'in',
      kind: 'chat',
      sender: 'Pixel',
      text: 'The answer is 42.',
      echo: { fromSession: SIBLING, label: 'another thread with Alex', self: true, delivered: true, truncated: false },
    });
    expect(formatHistoryLines(rows, 'UTC')).toBe(
      `2026-08-01 10:00|in|chat|Pixel|[copy of your message, already delivered — ${SIBLING}, another thread with Alex] The answer is 42.`,
    );
  });

  it('marks a copy of a message that arrived in a sibling session', async () => {
    await writeEcho('in-sib-1', '2026-08-01T10:00:00.000Z', 'hi from the other thread', { sender: 'Alex' });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0].echo).toMatchObject({ fromSession: SIBLING, self: false, delivered: false, truncated: false });
    expect(formatHistoryLines(rows, 'UTC')).toBe(
      `2026-08-01 10:00|in|chat|Alex|[copy of a message received — ${SIBLING}, another thread with Alex] hi from the other thread`,
    );
  });

  it('treats a task-run delivery as delivered too', async () => {
    await writeEcho('out-task-1', '2026-08-01T10:00:00.000Z', 'Reminder: bins tonight', {
      self: true,
      surface: ECHO_TASK_SURFACE,
      label: 'a scheduled task',
      source: 'sess-task',
    });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0].echo).toMatchObject({ fromSession: 'sess-task', delivered: true });
  });

  it('says a copy was cut, from the flag the writer recorded, and where the full text is', async () => {
    await writeEcho('out-sib-2', '2026-08-01T10:00:00.000Z', 'x'.repeat(ECHO_TEXT_MAX_CHARS + 100), { self: true });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0].echo).toMatchObject({ delivered: true, truncated: true });
    expect(formatHistoryLines(rows, 'UTC')).toContain(
      `[copy of your message, already delivered — ${SIBLING}, another thread with Alex; cut, full text in ${SIBLING}'s history]`,
    );
  });

  it("describes a backfilled catch-up copy by its label: no session to name, and never 'delivered'", async () => {
    // backfill.ts: no source session, a timeline surface, and the newest entry cut without '…'.
    await writeSessionMessage(AG, SESS, {
      id: `${SESS}:backfill:batch:0`,
      kind: 'chat',
      timestamp: '2026-08-01T10:00:00.000Z',
      platformId: null,
      channelType: ECHO_CHANNEL_TYPE,
      threadId: null,
      content: JSON.stringify({
        text: 'z'.repeat(40),
        sender: 'Pixel',
        senderId: AG,
        self: true,
        echo: { surface: ECHO_TIMELINE_SURFACE, label: 'this DM, while this conversation was idle', truncated: true },
      }),
      trigger: false,
      sourceSessionId: null,
    });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows[0].echo).toEqual({
      fromSession: null,
      label: 'this DM, while this conversation was idle',
      self: true,
      delivered: false,
      truncated: true,
    });
    expect(formatHistoryLines(rows, 'UTC')).toContain(
      '[copy of an earlier message of yours — this DM, while this conversation was idle; cut] zzz',
    );
  });

  it('keeps the marker outside the text cap, so a copy shows as much text as any other row', async () => {
    await writeEcho('out-sib-3', '2026-08-01T10:00:00.000Z', 'w'.repeat(300), { self: true });

    const line = formatHistoryLines(await sessionHistory({ id: SESS }, HOST), 'UTC');
    expect(line.endsWith(`] ${'w'.repeat(HISTORY_TEXT_MAX_CHARS)}`)).toBe(true);
  });

  it('leaves ordinary inbound and outbound rows unmarked', async () => {
    await writeInbound('in-1', '2026-08-01T10:00:00.000Z', 'real message');
    await writeEcho('out-sib-1', '2026-08-01T10:01:00.000Z', 'copied reply', { self: true });
    await writeOutboundDirect(AG, SESS, {
      id: 'out-1',
      kind: 'chat',
      platformId: 'D1',
      channelType: 'slack',
      threadId: null,
      content: JSON.stringify({ text: 'agent reply' }),
    });

    const rows = await sessionHistory({ id: SESS }, HOST);
    expect(rows.map((r) => r.echo !== undefined)).toEqual([false, true, false]);
    expect('echo' in rows[0]).toBe(false);
    expect('echo' in rows[2]).toBe(false);
  });
});
