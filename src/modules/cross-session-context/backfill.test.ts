/**
 * Session backfill (the pull half of cross-session context).
 *
 * A just-born session is seeded with its conversation's TOP-LEVEL timeline
 * from the HOT SET — each hot sibling's root user message + top-level agent
 * posts (welcome-style), never the interiors of other threads. DMs seed under
 * the dm-timeline surface, group conversations under channel-timeline. A
 * long-idle (cold) session catches up the same way, from the point it already
 * knows about; a hot session is left alone. Live-hit this guards against: the
 * user replies to the welcome tour offer, the reply roots a new thread, and
 * the fresh session knows nothing about the offer.
 */
import fs from 'fs';
import path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = { timestamp: string; content: string };
type Sibling = { root?: Row; outbound?: Row[] };

const written: Array<Record<string, unknown>> = [];
/** Mailbox sessions opened, by session id, in order. */
const opened: string[] = [];
const inboundSql: string[] = [];
const outboundSql: string[] = [];

let siblings: Record<string, Sibling> = {};
/** The target session's own inbound rows, newest first (getInboundHistory order). */
let targetHistory: Row[] = [];
let missingMailboxes = new Set<string>();
let brokenMailboxes = new Set<string>();
let recentSessions: Array<{
  id: string;
  status: string;
  messaging_group_id: string | null;
  thread_id: string | null;
  last_active: string | null;
}> = [];
let topLevelSession: (typeof recentSessions)[number] | undefined;

/** Real session folders for the attachment tests (the mailbox stays mocked). */
const SESSIONS_ROOT = '/tmp/nanoclaw-test-backfill-attachments';

vi.mock('../../session-manager.js', () => ({
  sessionDir: (agentGroupId: string, sessionId: string) => path.join(SESSIONS_ROOT, agentGroupId, sessionId),
  withExistingMailboxSession: async (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) => {
    if (missingMailboxes.has(sessionId)) return undefined;
    if (brokenMailboxes.has(sessionId)) throw new Error(`mailbox ${sessionId} is broken`);
    opened.push(sessionId);
    const sibling = siblings[sessionId];
    return fn({
      getConversationRoot: () => {
        inboundSql.push(`getConversationRoot:${sessionId}`);
        return sibling?.root;
      },
      getTopLevelOutbound: () => {
        outboundSql.push(`getTopLevelOutbound:${sessionId}`);
        return sibling?.outbound ?? [];
      },
      getInboundHistory: (limit: number) => targetHistory.slice(0, limit),
      insertMessage: async (msg: Record<string, unknown>) => {
        written.push({ sessionId, ...msg });
      },
    });
  },
}));
vi.mock('../../db/sessions.js', () => ({
  getRecentConversationSessions: async () => recentSessions,
  findSessionForAgent: async () => topLevelSession,
  isTaskThread: (t: string | null) => typeof t === 'string' && t.startsWith('system:tasks'),
}));

const { backfillSession, BACKFILL_LIMIT } = await import('./backfill.js');
const { ECHO_MAX_AGE_MS, HOT_SESSION_LIMIT } = await import('./config.js');

const NOW = Date.parse('2026-08-01T20:00:00.000Z');
const AG = { id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: '' } as never;
const DM_MG = { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', is_group: 0 } as never;
const ROOM_MG = { id: 'mg-room', channel_type: 'slack', platform_id: 'slack:C1', is_group: 1 } as never;

function sess(id: string, mg: string, threadId: string | null, lastActive: string | null = iso(NOW - 60_000)) {
  return { id, status: 'active', messaging_group_id: mg, thread_id: threadId, last_active: lastActive };
}
function iso(ms: number): string {
  return new Date(ms).toISOString();
}
function chat(text: string, sender = 'Alex', senderId = 'U1'): string {
  return JSON.stringify({ text, sender, senderId });
}
function post(text: string): string {
  return JSON.stringify({ text });
}
function texts(): string[] {
  return written.map((w) => (JSON.parse(w.content as string) as { text: string }).text);
}

const NEW_SESSION = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-dm',
  thread_id: 'slack:D1:2.0',
  status: 'active',
  last_active: null,
} as never;
const COLD_SESSION = {
  id: 'sess-cold',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-dm',
  thread_id: 'slack:D1:1.0',
  status: 'active',
  last_active: iso(NOW - 2 * 24 * 60 * 60 * 1000),
} as never;

beforeEach(() => {
  written.length = 0;
  opened.length = 0;
  inboundSql.length = 0;
  outboundSql.length = 0;
  targetHistory = [];
  missingMailboxes = new Set();
  brokenMailboxes = new Set();
  fs.rmSync(SESSIONS_ROOT, { recursive: true, force: true });
  siblings = {
    'sess-old': {
      root: { timestamp: iso(NOW - 50 * 60_000), content: chat('hello there') },
      outbound: [{ timestamp: iso(NOW - 46 * 60_000), content: post('Hey Alex! I am Pete… tour?') }],
    },
  };
  recentSessions = [sess('sess-old', 'mg-dm', null)];
  topLevelSession = recentSessions[0];
});

describe('backfillSession — new session', () => {
  it('seeds the new session with hot sibling roots + top-level agent posts, ordered by time, in ONE mailbox session', async () => {
    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      sessionId: 'sess-new',
      kind: 'chat',
      channelType: 'session-echo',
      trigger: false,
      threadId: null,
    });
    const first = JSON.parse(written[0]!.content as string) as Record<string, unknown>;
    const second = JSON.parse(written[1]!.content as string) as Record<string, unknown>;
    expect(first.text).toBe('hello there');
    expect(second.text).toBe('Hey Alex! I am Pete… tour?');
    expect(second.sender).toBe('Pete');
    expect((second.echo as Record<string, unknown>).surface).toBe('dm-timeline');
    expect((second.echo as Record<string, unknown>).label).toBe('this DM, just before this conversation');
    expect(second.self).toBe(true);
    expect(first.self).toBeUndefined();
    // One read session per source, one write session for the target — never one per row.
    expect(opened).toEqual(['sess-old', 'sess-new']);
  });

  it('reads the semantic conversation timeline operations', async () => {
    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });
    expect(inboundSql).toEqual(['getConversationRoot:sess-old']);
    expect(outboundSql).toEqual(['getTopLevelOutbound:sess-old']);
  });

  it('skips task sessions and sessions without hot siblings', async () => {
    await backfillSession(AG, { ...(NEW_SESSION as object), thread_id: 'system:tasks:t-1' } as never, DM_MG, {
      created: true,
      now: NOW,
    });
    recentSessions = [];
    topLevelSession = undefined;
    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });
    expect(written).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  it('seeds group-surface sessions with the channel timeline: channel-timeline surface + channel label', async () => {
    siblings = {
      'sess-room-t1': {
        root: { timestamp: iso(NOW - 50 * 60_000), content: chat('thread root msg') },
        outbound: [{ timestamp: iso(NOW - 46 * 60_000), content: post('top-level agent post') }],
      },
    };
    recentSessions = [sess('sess-room-t1', 'mg-room', 'slack:C1:1')];
    topLevelSession = undefined;

    await backfillSession(AG, { ...(NEW_SESSION as object), messaging_group_id: 'mg-room' } as never, ROOM_MG, {
      created: true,
      now: NOW,
    });

    expect(written).toHaveLength(2);
    const first = JSON.parse(written[0]!.content as string) as Record<string, unknown>;
    expect((first.echo as Record<string, unknown>).surface).toBe('channel-timeline');
    expect((first.echo as Record<string, unknown>).label).toBe('this channel, just before this conversation');
    const second = JSON.parse(written[1]!.content as string) as Record<string, unknown>;
    expect(second.self).toBe(true);
  });

  it('ignores system-sender roots and caps at BACKFILL_LIMIT newest rows', async () => {
    siblings['sess-old'] = {
      root: { timestamp: iso(NOW - 120 * 60_000), content: chat('Introduce yourself', 'system', 'system') },
      outbound: Array.from({ length: 20 }, (_, i) => ({
        timestamp: iso(NOW - (60 - i) * 60_000),
        content: post(`post ${i}`),
      })),
    };

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    expect(written).toHaveLength(BACKFILL_LIMIT);
    expect(texts()).not.toContain('Introduce yourself');
    expect(texts().at(-1)).toBe('post 19');
  });

  it('never reaches past the ambient horizon, even for a new session', async () => {
    siblings['sess-old'] = {
      root: { timestamp: iso(NOW - ECHO_MAX_AGE_MS - 60_000), content: chat('ancient opener') },
      outbound: [{ timestamp: iso(NOW - ECHO_MAX_AGE_MS + 60_000), content: post('recent post') }],
    };
    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });
    expect(texts()).toEqual(['recent post']);
  });

  it('reads only the hot set: siblings of other conversations are never sources, and at most K+1 are read', async () => {
    // The bounded query is the source of truth; the pure rule still filters
    // anything that slipped through (another conversation) and caps at K.
    recentSessions = [
      sess('sess-other-dm', 'mg-other', null),
      ...Array.from({ length: HOT_SESSION_LIMIT + 3 }, (_, i) =>
        sess(`sib-${i}`, 'mg-dm', `t-${i}`, iso(NOW - i * 1000)),
      ),
    ];
    topLevelSession = sess('sess-top', 'mg-dm', null, iso(NOW - 10 * 60_000));
    for (const s of recentSessions) siblings[s.id] = { root: { timestamp: iso(NOW - 60_000), content: chat(s.id) } };
    siblings['sess-top'] = { outbound: [{ timestamp: iso(NOW - 30_000), content: post('top post') }] };

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    const read = opened.filter((id) => id !== 'sess-new');
    expect(read).toHaveLength(HOT_SESSION_LIMIT + 1);
    expect(read).not.toContain('sess-other-dm');
    expect(read).toContain('sess-top');
    expect(read).toContain(`sib-${HOT_SESSION_LIMIT - 1}`);
    expect(read).not.toContain(`sib-${HOT_SESSION_LIMIT}`);
  });

  it('one broken sibling mailbox does not stop the others', async () => {
    siblings['sess-ok'] = { root: { timestamp: iso(NOW - 40 * 60_000), content: chat('still here') } };
    recentSessions = [sess('sess-broken', 'mg-dm', 't-1'), sess('sess-ok', 'mg-dm', 't-2')];
    topLevelSession = undefined;
    brokenMailboxes = new Set(['sess-broken']);

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });
    expect(texts()).toEqual(['still here']);
  });
});

describe('backfillSession — existing session', () => {
  it('leaves a hot session alone: one central lookup, no mailbox traffic', async () => {
    recentSessions = [sess('sess-old', 'mg-dm', null), { ...(COLD_SESSION as object), status: 'active' } as never];
    await backfillSession(AG, COLD_SESSION, DM_MG, { created: false, now: NOW });
    expect(opened).toEqual([]);
    expect(written).toHaveLength(0);
  });

  it('catches a cold session up from its newest row, with the idle label', async () => {
    targetHistory = [{ timestamp: iso(NOW - 48 * 60_000), content: chat('last thing I saw') }];
    siblings['sess-old'] = {
      root: { timestamp: iso(NOW - 50 * 60_000), content: chat('already known opener') },
      outbound: [
        { timestamp: iso(NOW - 49 * 60_000), content: post('already known post') },
        { timestamp: iso(NOW - 46 * 60_000), content: post('missed post') },
      ],
    };

    await backfillSession(AG, COLD_SESSION, DM_MG, { created: false, now: NOW });

    expect(texts()).toEqual(['missed post']);
    const echo = (JSON.parse(written[0]!.content as string) as { echo: Record<string, string> }).echo;
    expect(echo.surface).toBe('dm-timeline');
    expect(echo.label).toBe('this DM, while this conversation was idle');
    // since-read on the target, one read per source, one write session on the target.
    expect(opened).toEqual(['sess-cold', 'sess-old', 'sess-cold']);
  });

  it('a cold session with an empty mailbox gets the whole horizon; a missing mailbox gets nothing', async () => {
    targetHistory = [];
    await backfillSession(AG, COLD_SESSION, DM_MG, { created: false, now: NOW });
    expect(texts()).toEqual(['hello there', 'Hey Alex! I am Pete… tour?']);

    written.length = 0;
    opened.length = 0;
    missingMailboxes = new Set(['sess-cold']);
    await backfillSession(AG, COLD_SESSION, DM_MG, { created: false, now: NOW });
    expect(written).toHaveLength(0);
    expect(opened).toEqual([]);
  });

  it('gives each catch-up batch unique row ids', async () => {
    await backfillSession(AG, COLD_SESSION, DM_MG, { created: false, now: NOW });
    await backfillSession(AG, COLD_SESSION, DM_MG, { created: false, now: NOW + 1000 });
    const ids = written.map((w) => w.id as string);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids[0]).toMatch(/^sess-cold:backfill:.+:0$/);
  });
});

describe('backfillSession — attachments', () => {
  const SHOT = 'shot.png';
  const SRC_PATH = `inbox/root-1:ag-1/${SHOT}`;

  /** Stage a file in a sibling's inbox, as the inbound path does. */
  function stageInSibling(sessionId: string, relPath: string, bytes: string): void {
    const file = path.join(SESSIONS_ROOT, 'ag-1', sessionId, relPath);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
  }
  function rootWith(text: string, attachments: unknown[]): Row {
    return {
      timestamp: iso(NOW - 50 * 60_000),
      content: JSON.stringify({ text, sender: 'Alex', senderId: 'U1', attachments }),
    };
  }
  function rowAttachments(i = 0): Array<Record<string, unknown>> {
    return (
      (JSON.parse(written[i]!.content as string) as { attachments?: Array<Record<string, unknown>> }).attachments ?? []
    );
  }

  it("copies a sibling root's files into the new session and lists them on the history row", async () => {
    stageInSibling('sess-old', SRC_PATH, 'PNGBYTES');
    siblings['sess-old'] = {
      root: rootWith('see screenshot', [
        { type: 'image', name: SHOT, mimeType: 'image/png', size: 8, localPath: SRC_PATH },
      ]),
    };

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    expect(texts()).toEqual(['see screenshot']);
    const [att] = rowAttachments();
    expect(att).toMatchObject({ type: 'image', name: SHOT, mimeType: 'image/png' });
    // The copy lives in the TARGET session's own inbox (its /workspace), never the sibling's.
    expect(att!.localPath).toMatch(new RegExp(`^inbox/[^/]+/${SHOT}$`));
    expect(att!.localPath).not.toBe(SRC_PATH);
    const copied = path.join(SESSIONS_ROOT, 'ag-1', 'sess-new', att!.localPath as string);
    expect(fs.readFileSync(copied, 'utf8')).toBe('PNGBYTES');
  });

  it('backfills a media-only root (no text) instead of dropping it', async () => {
    stageInSibling('sess-old', SRC_PATH, 'PNGBYTES');
    siblings['sess-old'] = { root: rootWith('', [{ type: 'image', name: SHOT, localPath: SRC_PATH }]) };

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    expect(written).toHaveLength(1);
    expect(rowAttachments()[0]!.localPath).toMatch(/^inbox\//);
  });

  it('never follows a symlink planted in the sibling inbox; the file is still named', async () => {
    const secret = path.join(SESSIONS_ROOT, 'host-secret.txt');
    fs.mkdirSync(SESSIONS_ROOT, { recursive: true });
    fs.writeFileSync(secret, 'TOKEN');
    const link = path.join(SESSIONS_ROOT, 'ag-1', 'sess-old', SRC_PATH);
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(secret, link);
    siblings['sess-old'] = { root: rootWith('look', [{ type: 'image', name: SHOT, localPath: SRC_PATH }]) };

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    const [att] = rowAttachments();
    expect(att).toMatchObject({ type: 'image', name: SHOT });
    expect(att!.localPath).toBeUndefined();
    const targetInbox = path.join(SESSIONS_ROOT, 'ag-1', 'sess-new', 'inbox');
    const copies = fs.existsSync(targetInbox) ? fs.readdirSync(targetInbox, { recursive: true }) : [];
    expect(copies.filter((f) => String(f).endsWith(SHOT))).toEqual([]);
  });

  it('refuses a source path that leaves the sibling inbox', async () => {
    stageInSibling('sess-old', 'outbox/x/secret.png', 'NOPE');
    siblings['sess-old'] = {
      root: rootWith('look', [{ type: 'image', name: 'secret.png', localPath: 'inbox/../outbox/x/secret.png' }]),
    };

    await backfillSession(AG, NEW_SESSION, DM_MG, { created: true, now: NOW });

    expect(rowAttachments()[0]!.localPath).toBeUndefined();
  });
});
