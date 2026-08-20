/**
 * New-session backfill (the pull half of cross-session context): a just-born
 * session is seeded with its conversation's TOP-LEVEL timeline from sibling
 * sessions — each sibling's root user message + top-level agent posts
 * (welcome-style), never the interiors of other threads. DMs seed under the
 * dm-timeline surface, group conversations under channel-timeline. Live-hit
 * this guards against: the user replies to the welcome tour offer, the reply
 * roots a new thread, and the fresh session knows nothing about the offer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const written: Array<Record<string, unknown>> = [];
const inboundSql: string[] = [];
const outboundSql: string[] = [];

let inboundRows: Array<{ timestamp: string; content: string }> = [];
let outboundRows: Array<{ timestamp: string; content: string }> = [];
let siblingSessions: Array<{ id: string; status: string; messaging_group_id: string | null }> = [];

vi.mock('../../session-manager.js', () => ({
  withExistingMailboxSession: (_g: string, _s: string, fn: (mailbox: unknown) => unknown) =>
    fn({
      getConversationRoot: () => {
        inboundSql.push('getConversationRoot');
        return inboundRows[0];
      },
      getTopLevelOutbound: () => {
        outboundSql.push('getTopLevelOutbound');
        return outboundRows;
      },
    }),
  writeSessionMessage: async (agentGroupId: string, sessionId: string, msg: Record<string, unknown>) => {
    written.push({ agentGroupId, sessionId, ...msg });
  },
}));
vi.mock('../../db/sessions.js', () => ({
  getSessionsByAgentGroup: () => siblingSessions,
  isTaskThread: (t: string) => t.startsWith('system:tasks'),
}));

const { backfillNewSession, BACKFILL_LIMIT } = await import('./backfill.js');

const AG = { id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: '' } as never;
const DM_MG = { id: 'mg-dm', channel_type: 'slack', platform_id: 'slack:D1', is_group: 0 } as never;
const ROOM_MG = { id: 'mg-room', channel_type: 'slack', platform_id: 'slack:C1', is_group: 1 } as never;
const NEW_SESSION = {
  id: 'sess-new',
  agent_group_id: 'ag-1',
  messaging_group_id: 'mg-dm',
  thread_id: 'slack:D1:2.0',
} as never;

function chat(text: string, sender = 'Gavriel', senderId = 'U1'): string {
  return JSON.stringify({ text, sender, senderId });
}

beforeEach(() => {
  written.length = 0;
  inboundSql.length = 0;
  outboundSql.length = 0;
  inboundRows = [];
  outboundRows = [];
  siblingSessions = [{ id: 'sess-old', status: 'active', messaging_group_id: 'mg-dm' }];
});

describe('backfillNewSession', () => {
  it('seeds the new session with sibling roots + top-level agent posts, ordered by time', async () => {
    outboundRows = [
      { timestamp: '2026-08-01T19:14:00Z', content: JSON.stringify({ text: 'Hey Gavriel! I am Pete… tour?' }) },
    ];
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('hello there') }];

    await backfillNewSession(AG, NEW_SESSION, DM_MG);

    expect(written).toHaveLength(2);
    expect(written[0]).toMatchObject({
      sessionId: 'sess-new',
      kind: 'chat',
      channelType: 'session-echo',
      trigger: false,
    });
    const first = JSON.parse(written[0]!.content as string) as Record<string, unknown>;
    const second = JSON.parse(written[1]!.content as string) as Record<string, unknown>;
    expect(first.text).toBe('hello there');
    expect(second.text).toBe('Hey Gavriel! I am Pete… tour?');
    expect(second.sender).toBe('Pete');
    expect((second.echo as Record<string, unknown>).surface).toBe('dm-timeline');
    expect(second.self).toBe(true);
    expect(first.self).toBeUndefined();
  });

  it('reads the semantic conversation timeline operations', async () => {
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(inboundSql).toEqual(['getConversationRoot']);
    expect(outboundSql).toEqual(['getTopLevelOutbound']);
  });

  it('skips task sessions and sessions without siblings', async () => {
    await backfillNewSession(AG, { ...(NEW_SESSION as object), thread_id: 'system:tasks:t-1' } as never, DM_MG);
    siblingSessions = [];
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });

  it('seeds group-surface sessions with the channel timeline: channel-timeline surface + channel label', async () => {
    siblingSessions = [{ id: 'sess-room-t1', status: 'active', messaging_group_id: 'mg-room' }];
    inboundRows = [{ timestamp: '2026-08-01T19:10:00Z', content: chat('thread root msg') }];
    outboundRows = [{ timestamp: '2026-08-01T19:14:00Z', content: JSON.stringify({ text: 'top-level agent post' }) }];

    await backfillNewSession(AG, NEW_SESSION, ROOM_MG);

    expect(written).toHaveLength(2);
    const first = JSON.parse(written[0]!.content as string) as Record<string, unknown>;
    expect((first.echo as Record<string, unknown>).surface).toBe('channel-timeline');
    expect((first.echo as Record<string, unknown>).label).toBe('this channel, just before this conversation');
    const second = JSON.parse(written[1]!.content as string) as Record<string, unknown>;
    expect(second.self).toBe(true);
  });

  it('ignores system-sender roots and caps at BACKFILL_LIMIT newest rows', async () => {
    inboundRows = [{ timestamp: '2026-08-01T18:00:00Z', content: chat('Introduce yourself', 'system', 'system') }];
    outboundRows = Array.from({ length: 20 }, (_, i) => ({
      timestamp: `2026-08-01T19:${String(10 + i).padStart(2, '0')}:00Z`,
      content: JSON.stringify({ text: `post ${i}` }),
    }));

    await backfillNewSession(AG, NEW_SESSION, DM_MG);

    expect(written).toHaveLength(BACKFILL_LIMIT);
    const texts = written.map((w) => (JSON.parse(w.content as string) as { text: string }).text);
    expect(texts).not.toContain('Introduce yourself');
    expect(texts.at(-1)).toBe('post 19');
  });

  it('only considers siblings of the same messaging group', async () => {
    siblingSessions = [{ id: 'sess-other-dm', status: 'active', messaging_group_id: 'mg-other' }];
    await backfillNewSession(AG, NEW_SESSION, DM_MG);
    expect(written).toHaveLength(0);
  });
});
