/**
 * The backfill reads the conversation's recorded top-level talk, not its
 * siblings' mailboxes.
 *
 * Live (customer Host just restarted, remote mailbox): a new Slack DM thread's
 * first message waited 12 to 23 s before it was written, because the backfill
 * opened up to eight hot sibling sessions whole, and a session not in the
 * Host's memory is read from the store record by record. Here a sibling's
 * mailbox open never answers, as a cold remote store under load: the backfill
 * still seeds the new session with each sibling's root and top-level post, and
 * opens no sibling.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const opened: string[] = [];
const written: Array<{ sessionId: string; content: string }> = [];

vi.mock('../../session-manager.js', () => ({
  // A sibling's mailbox: the open never answers (cold remote store).
  withExistingMailboxSession: (_g: string, sessionId: string) => {
    opened.push(sessionId);
    return new Promise(() => {});
  },
  // The new session's own mailbox: takes the seeded rows.
  withMailboxSession: async (_g: string, sessionId: string, fn: (mailbox: unknown) => unknown) =>
    fn({
      insertMessage: async (msg: { content: string }) => {
        written.push({ sessionId, content: msg.content });
      },
    }),
}));

const { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } =
  await import('../../db/index.js');
const { createSession } = await import('../../db/sessions.js');
const { backfillSession } = await import('./backfill.js');
const { recordConversationRoot, recordTopLevelPost } = await import('./timeline.js');

const AG = { id: 'ag-1', name: 'Pete', folder: 'pete', agent_provider: null, created_at: '2026-01-01T00:00:00.000Z' };
const MG = {
  id: 'mg-dm',
  channel_type: 'slack',
  platform_id: 'slack:D1',
  name: 'dm',
  is_group: 0,
  unknown_sender_policy: 'strict',
  created_at: '2026-01-01T00:00:00.000Z',
} as never;

function session(id: string, threadId: string, lastActive: string | null) {
  return {
    id,
    agent_group_id: AG.id,
    messaging_group_id: 'mg-dm',
    thread_id: threadId,
    agent_provider: null,
    status: 'active' as const,
    container_status: 'stopped' as const,
    last_active: lastActive,
    created_at: '2026-01-01T00:00:00.000Z',
  };
}

const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

/** The backfill's answer within two seconds, or 'held'. */
async function within2s(work: Promise<void>): Promise<'done' | 'held'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const held = new Promise<'held'>((resolve) => (timer = setTimeout(() => resolve('held'), 2_000)));
  const outcome = await Promise.race([work.then(() => 'done' as const), held]);
  clearTimeout(timer);
  return outcome;
}

beforeEach(async () => {
  opened.length = 0;
  written.length = 0;
  await runMigrations(await initTestDb());
  await createAgentGroup(AG as never);
  await createMessagingGroup(MG);
});

afterEach(async () => {
  await closeDb();
});

describe('backfill from the recorded timeline', () => {
  it('seeds a new thread from its siblings without opening their mailboxes', async () => {
    const a = session('sess-a', 'slack:D1:100.1', minutesAgo(30));
    const b = session('sess-b', 'slack:D1:200.1', minutesAgo(10));
    const fresh = session('sess-new', 'slack:D1:300.1', null);
    for (const s of [a, b, fresh]) await createSession(s);

    await recordConversationRoot(a, {
      kind: 'chat-sdk',
      channelType: 'slack',
      content: JSON.stringify({ text: 'can you look at the deck?', sender: 'Alex', senderId: 'U1', id: '100.1' }),
      timestamp: minutesAgo(30),
    });
    await recordTopLevelPost(
      b,
      'Pete',
      {
        id: 'out-1',
        kind: 'chat',
        channelType: 'slack',
        threadId: null,
        content: JSON.stringify({ text: 'Want a tour?' }),
      },
      '200.5',
      minutesAgo(9),
    );

    const outcome = await within2s(backfillSession(AG as never, fresh, MG, { created: true }));

    expect(outcome).toBe('done');
    expect(opened).toEqual([]);
    const seeded = written.map(
      (w) => JSON.parse(w.content) as { text: string; self?: boolean; platformMessageId?: string },
    );
    expect(seeded.map((r) => r.text)).toEqual(['can you look at the deck?', 'Want a tour?']);
    expect(seeded[1]).toMatchObject({ self: true, platformMessageId: '200.5' });
    expect(written.every((w) => w.sessionId === 'sess-new')).toBe(true);
  });
});
