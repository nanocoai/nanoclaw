/**
 * Conversation timeline (timeline.ts) on a real central DB: what is recorded
 * (the rows the mailbox's conversation root and top-level outbound gave), how
 * the backfill reads it, and what clears it.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { createSession, deleteSession } from '../../db/sessions.js';
import type { Session } from '../../types.js';
import { ECHO_MAX_AGE_MS } from './config.js';
import {
  readConversationTimeline,
  recordConversationRoot,
  recordTopLevelPost,
  TIMELINE_TEXT_MAX_CHARS,
} from './timeline.js';

const NOW = Date.parse('2026-11-20T18:00:00.000Z');
const at = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();
const LONG_AGO = new Date(NOW - 10 * ECHO_MAX_AGE_MS).toISOString();

function session(id: string, mg: string | null = 'mg-dm'): Session {
  return {
    id,
    agent_group_id: 'ag-1',
    messaging_group_id: mg,
    thread_id: `slack:D1:${id}`,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: null,
    created_at: at(100),
  };
}

const chat = (text: string, extra: Record<string, string> = {}) =>
  JSON.stringify({ text, sender: 'Alex', senderId: 'U1', ...extra });
const root = (s: Session, content: string, minutesAgo = 10, kind = 'chat-sdk', channelType = 'slack') =>
  recordConversationRoot(s, { kind, channelType, content, timestamp: at(minutesAgo) });
const post = (s: Session, id: string, text: string, threadId: string | null = null, kind = 'chat', minutesAgo = 5) =>
  recordTopLevelPost(
    s,
    'Pete',
    { id, kind, channelType: 'slack', threadId, content: JSON.stringify({ text }) },
    `pm-${id}`,
    at(minutesAgo),
  );
const read = (ids: string[], since = LONG_AGO, limit = 12) =>
  readConversationTimeline('ag-1', 'mg-dm', ids, since, limit);

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

describe('recording', () => {
  it("records a session's root user message with its sender and platform id", async () => {
    const a = session('a');
    await root(a, chat('can you look at the deck?', { id: 'P0' }));
    expect(await read(['a'])).toEqual([
      {
        sessionId: 'a',
        timestamp: at(10),
        sender: 'Alex',
        senderId: 'U1',
        text: 'can you look at the deck?',
        self: false,
        platformMessageId: 'P0',
      },
    ]);
  });

  it('records no Host-injected instruction, no non-chat row, no echo or agent row, no empty text', async () => {
    const a = session('a');
    await root(a, JSON.stringify({ text: 'Introduce yourself', sender: 'system', senderId: 'system' }));
    await root(a, chat('System instruction: run /welcome'));
    await root(a, chat('a task'), 10, 'task');
    await root(a, chat('an echo'), 10, 'chat', 'session-echo');
    await root(a, chat('from an agent'), 10, 'chat', 'agent');
    await root(a, JSON.stringify({ sender: 'Alex' }));
    await root(session('no-chat', null), chat('no conversation'));
    expect(await read(['a', 'no-chat'])).toEqual([]);
  });

  it('records a top-level agent post (no thread, or a thread id naming only the chat), not a thread reply', async () => {
    const a = session('a');
    await post(a, 'o1', 'Welcome! Want a tour?');
    await post(a, 'o2', 'a DM top level', 'slack:D1:');
    await post(a, 'o3', 'inside a thread', 'slack:D1:100.1');
    await post(a, 'o4', 'a system row', null, 'system');
    await post(a, 'o5', 'a task log', null, 'task_log');
    const rows = await read(['a']);
    expect(rows.map((r) => [r.text, r.self, r.sender, r.platformMessageId])).toEqual([
      ['Welcome! Want a tour?', true, 'Pete', 'pm-o1'],
      ['a DM top level', true, 'Pete', 'pm-o2'],
    ]);
  });

  it('keeps one row per message when it is recorded again (a redelivery)', async () => {
    const a = session('a');
    await post(a, 'o1', 'once');
    await post(a, 'o1', 'once');
    await root(a, chat('first'));
    await root(a, chat('first'));
    expect(await read(['a'])).toHaveLength(2);
  });

  it('keeps at most the longest text the backfill writes', async () => {
    await post(session('a'), 'o1', 'x'.repeat(TIMELINE_TEXT_MAX_CHARS + 50));
    expect((await read(['a']))[0]!.text).toHaveLength(TIMELINE_TEXT_MAX_CHARS);
  });

  it("drops a conversation's rows past the horizon when it records its next row", async () => {
    const a = session('a');
    await root(a, chat('old'), ECHO_MAX_AGE_MS / 60_000 + 60);
    await post(a, 'o1', 'new', null, 'chat', 1);
    const all = await getDb().all<{ text: string }>('SELECT text FROM conversation_timeline');
    expect(all.map((r) => r.text)).toEqual(['new']);
  });
});

describe('reading', () => {
  it('gives the newest rows of the sessions asked for, newer than the floor, oldest first', async () => {
    const [a, b, c] = [session('a'), session('b'), session('c')];
    await root(a, chat('a root'), 30);
    await post(a, 'a1', 'a post', null, 'chat', 20);
    await root(b, chat('b root'), 25);
    await post(b, 'b1', 'b post', null, 'chat', 3);
    await root(c, chat('c root (not a source)'), 2);
    await root(session('other', 'mg-other'), chat('another conversation'), 1);

    expect((await read(['a', 'b'])).map((r) => r.text)).toEqual(['a root', 'b root', 'a post', 'b post']);
    expect((await read(['a', 'b'], at(22))).map((r) => r.text)).toEqual(['a post', 'b post']);
    expect((await read(['a', 'b'], LONG_AGO, 2)).map((r) => r.text)).toEqual(['a post', 'b post']);
    expect(await read([])).toEqual([]);
  });
});

describe('clearing', () => {
  it("deletes a session's rows with the session", async () => {
    await createAgentGroup({ id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: at(100) });
    await createMessagingGroup({
      id: 'mg-dm',
      channel_type: 'slack',
      platform_id: 'slack:D1',
      name: 'dm',
      is_group: 0,
      unknown_sender_policy: 'public',
      created_at: at(100),
    });
    const a = session('a');
    await createSession(a);
    await root(a, chat('gone with it'));
    await deleteSession('a');
    expect(await getDb().all('SELECT 1 FROM conversation_timeline')).toEqual([]);
  });
});
