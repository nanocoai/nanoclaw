/**
 * A runtime may answer several pushed inputs in one turn with one `result`
 * (#4033). The Claude CLI does it whenever inputs wait together at a turn
 * boundary: with input A answering, B and C pushed, it answers A, then B and C
 * in one turn, and lists both on that turn's frames (user_message_uuids). The
 * poll-loop queued one turn per input and advanced one per result, so after a
 * fold every later reply in the query carried an earlier message's
 * `in_reply_to` — a quote of the wrong message on a channel, the wrong session
 * for an agent-to-agent reply. The provider's `consumed` event lets the queue
 * drop the absorbed inputs. The turn that absorbed them keeps its own routing,
 * as a batch of several messages answers under its first message's.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { randomUUID } from 'node:crypto';

import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { processQuery } from './poll-loop.js';
import type { RoutingContext } from './formatter.js';
import type { AgentQuery, ProviderEvent, ProviderExchange } from './providers/types.js';

const CHANNEL: RoutingContext = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

// The host writes inbound rows with even, increasing seq; lookups such as a
// destination's latest inbound row order by it.
let nextSeq = 2;

beforeEach(() => {
  initTestSessionDb();
  nextSeq = 2;
  getInboundDb().exec(
    `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id) VALUES
       ('main', 'main', 'channel', 'discord', 'chan-1', NULL),
       ('writer', 'writer', 'agent', NULL, NULL, 'ag-writer'),
       ('runner', 'runner', 'agent', NULL, NULL, 'ag-runner')`,
  );
});
afterEach(() => closeSessionDb());

function insertMessage(id: string, text: string, from?: { agent?: string; thread?: string }): void {
  const seq = nextSeq;
  nextSeq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, trigger, on_wake, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'pending', NULL, 1, 0, ?, ?, ?, ?)`,
    )
    .run(
      id,
      seq,
      new Date().toISOString(),
      from?.agent ?? 'chan-1',
      from?.agent ? 'agent' : 'discord',
      from?.thread ?? null,
      JSON.stringify({ sender: from?.agent ?? 'User', text }),
    );
}

type Push = { prompt: string; inputId?: string };
const SCRIPTED_FAILURE = 'scripted stream failure';
type Script = (ctx: {
  pushes: Push[];
  /** Insert a message and wait until the poll-loop has pushed it; returns its input id. */
  arrive: (id: string, text: string, from?: { agent?: string; thread?: string }) => Promise<string | undefined>;
}) => AsyncGenerator<ProviderEvent>;

async function run(
  script: Script,
  routing: RoutingContext = CHANNEL,
  first = 'm1',
  /** False: a provider whose push returns no id (cannot report `consumed`). */
  namesInputs = true,
): Promise<{
  stamps: Record<string, string | null>;
  rows: Array<{ text: string; threadId: string | null; inReplyTo: string | null }>;
  pushes: Push[];
  exchanges: ProviderExchange[];
}> {
  const pushes: Push[] = [];
  const exchanges: ProviderExchange[] = [];
  const arrive = async (id: string, text: string, from?: { agent?: string; thread?: string }) => {
    const before = pushes.length;
    insertMessage(id, text, from);
    const deadline = Date.now() + 5000;
    while (pushes.length === before) {
      if (Date.now() > deadline) throw new Error(`${id} was not pushed`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return pushes[pushes.length - 1].inputId;
  };
  const query: AgentQuery = {
    push: (prompt) => {
      const inputId = namesInputs ? randomUUID() : undefined;
      pushes.push({ prompt, inputId });
      return inputId;
    },
    end: () => {},
    events: script({ pushes, arrive }),
    abort: () => {},
  };
  try {
    await processQuery(query, routing, [first], 'claude', (e) => exchanges.push(e), 'prompt-1', undefined, true);
  } catch (err) {
    // Only the failure a script throws on purpose; anything else fails the test.
    if (!(err instanceof Error && err.message === SCRIPTED_FAILURE)) throw err;
  }
  const rows = getUndeliveredMessages().map((r) => ({
    text: JSON.parse(r.content).text as string,
    threadId: r.thread_id ?? null,
    inReplyTo: r.in_reply_to ?? null,
  }));
  const stamps = Object.fromEntries(rows.map((r) => [r.text, r.inReplyTo]));
  return { stamps, rows, pushes, exchanges };
}

const say = (text: string, to = 'main'): ProviderEvent => ({
  type: 'text',
  text: `<message to="${to}">${text}</message>`,
});
const result: ProviderEvent = { type: 'result', text: '' };
// The exchange hook only sees results that carry text; <internal> is neither delivered nor nudged.
const archivedResult: ProviderEvent = { type: 'result', text: '<internal>done</internal>' };

/** The CLI's shape: B and C wait behind A, then share one turn. */
function boundaryFold(reportConsumed: boolean, endTurn: ProviderEvent = result): Script {
  return async function* ({ arrive }) {
    yield { type: 'init', continuation: 's1' };
    const b = await arrive('m2', 'second question');
    const c = await arrive('m3', 'third question');
    yield say('answer to m1');
    yield endTurn;
    if (reportConsumed) yield { type: 'consumed', ids: [b!, c!] };
    yield say('answer to m2 and m3');
    yield endTurn;
    const d = await arrive('m4', 'fourth question');
    if (reportConsumed) yield { type: 'consumed', ids: [d!] };
    yield say('answer to m4');
    yield endTurn;
  };
}

describe('inputs answered together in one turn (#4033)', () => {
  it('a provider whose push returns no id keeps one result per input, whatever it reports', async () => {
    const { stamps } = await run(
      async function* ({ arrive }) {
        yield { type: 'init', continuation: 's1' };
        await arrive('m2', 'second question');
        yield { type: 'consumed', ids: ['anything'] };
        yield say('answer to m1');
        yield result;
        yield say('answer to m2');
        yield result;
      },
      CHANNEL,
      'm1',
      false,
    );
    expect(stamps).toEqual({ 'answer to m1': 'm1', 'answer to m2': 'm2' });
  });

  it('a boundary fold answers like a batch (first message), and the next turn no longer lags', async () => {
    const { stamps } = await run(boundaryFold(true));
    expect(stamps).toEqual({ 'answer to m1': 'm1', 'answer to m2 and m3': 'm2', 'answer to m4': 'm4' });
  });

  it('without the signal the queue stays one behind (the bug, kept for providers that cannot tell)', async () => {
    const { stamps } = await run(boundaryFold(false));
    expect(stamps).toEqual({ 'answer to m1': 'm1', 'answer to m2 and m3': 'm2', 'answer to m4': 'm3' });
  });

  it('a mid-turn fold: the running turn keeps its routing to the end; the next turn is its own', async () => {
    const { stamps } = await run(async function* ({ arrive }) {
      yield { type: 'init', continuation: 's1' };
      const b = await arrive('m2', 'second question');
      yield { type: 'consumed', ids: [b!] };
      // The model has read m2 but is still answering m1: never re-address it to m2.
      yield say('answer to m1, sent after reading m2');
      yield result;
      const c = await arrive('m3', 'third question');
      yield { type: 'consumed', ids: [c!] };
      yield say('answer to m3');
      yield result;
    });
    expect(stamps).toEqual({ 'answer to m1, sent after reading m2': 'm1', 'answer to m3': 'm3' });
  });

  it('ignores ids it does not know and repeats of ones already absorbed', async () => {
    const { stamps } = await run(async function* ({ arrive }) {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'consumed', ids: ['not-a-pushed-input'] };
      const b = await arrive('m2', 'second question');
      yield say('answer to m1');
      yield result;
      yield { type: 'consumed', ids: [b!] };
      yield { type: 'consumed', ids: [b!] };
      yield say('answer to m2');
      yield result;
    });
    expect(stamps).toEqual({ 'answer to m1': 'm1', 'answer to m2': 'm2' });
  });

  it('archives the folded prompts with the turn that answered them', async () => {
    const { exchanges } = await run(boundaryFold(true, archivedResult));
    expect(exchanges).toHaveLength(3);
    expect(exchanges[0].prompt).toBe('prompt-1');
    expect(exchanges[1].prompt).toContain('second question');
    expect(exchanges[1].prompt).toContain('third question');
    expect(exchanges[2].prompt).toContain('fourth question');
    expect(exchanges[2].prompt).not.toContain('third question');
  });

  it('a wrap-nudge retry absorbed by a follow-up’s turn: one nudge, the follow-up keeps its routing', async () => {
    const { stamps, pushes } = await run(async function* ({ arrive, pushes }) {
      yield { type: 'init', continuation: 's1' };
      const b = await arrive('m2', 'second question');
      // Unwrapped final text: the poll-loop pushes a wrap-nudge retry behind m2.
      yield { type: 'result', text: 'unwrapped answer to m1' };
      const retry = pushes[pushes.length - 1].inputId;
      yield { type: 'consumed', ids: [b!, retry!] };
      yield say('answer to m1 and m2');
      yield result;
      const c = await arrive('m3', 'third question');
      yield { type: 'consumed', ids: [c!] };
      yield say('answer to m3');
      yield result;
    });
    expect(pushes.filter((p) => p.prompt.includes('not delivered'))).toHaveLength(1);
    // The retry was pushed behind m2 but carries m1's routing; absorbing it must not take m2's answer back to m1.
    expect(stamps['answer to m1 and m2']).toBe('m2');
    expect(stamps['answer to m3']).toBe('m3');
  });

  it('absorbs by id: an input taken ahead of an earlier queued one leaves that one queued', async () => {
    const { stamps } = await run(async function* ({ arrive }) {
      yield { type: 'init', continuation: 's1' };
      await arrive('m2', 'second question');
      const c = await arrive('m3', 'third question');
      yield { type: 'consumed', ids: [c!] };
      yield say('answer to m1');
      yield result;
      yield say('answer to m2');
      yield result;
      const d = await arrive('m4', 'fourth question');
      yield { type: 'consumed', ids: [d!] };
      yield say('answer to m4');
      yield result;
    });
    expect(stamps).toEqual({ 'answer to m1': 'm1', 'answer to m2': 'm2', 'answer to m4': 'm4' });
  });

  it('a stream failure after absorbing still sends a notice to the absorbed input’s thread', async () => {
    const { rows, exchanges } = await run(
      async function* ({ arrive }) {
        yield { type: 'init', continuation: 's1' };
        const b = await arrive('m2', 'question in another thread', { thread: 't2' });
        yield { type: 'consumed', ids: [b!] };
        throw new Error(SCRIPTED_FAILURE);
      },
      { ...CHANNEL, threadId: 't1' },
    );
    expect(rows.map((r) => [r.threadId, r.inReplyTo]).sort()).toEqual([
      ['t1', 'm1'],
      ['t2', 'm2'],
    ]);
    // Absorbed, not still queued: its prompt failed with the running turn.
    expect(exchanges.at(-1)?.prompt).toContain('question in another thread');
  });

  it('an error result after absorbing sends a notice to the absorbed input’s thread', async () => {
    const { rows } = await run(
      async function* ({ arrive }) {
        yield { type: 'init', continuation: 's1' };
        const b = await arrive('m2', 'question in another thread', { thread: 't2' });
        yield { type: 'consumed', ids: [b!] };
        yield { type: 'result', text: null, isError: true, error: 'Provider unavailable.' };
      },
      { ...CHANNEL, threadId: 't1' },
    );
    expect(rows.map((r) => [r.threadId, r.inReplyTo, r.text]).sort()).toEqual([
      ['t1', 'm1', 'Provider unavailable.'],
      ['t2', 'm2', 'Provider unavailable.'],
    ]);
  });

  it('a running route that sends no notice does not stand in for an absorbed input on its thread', async () => {
    // The turn was woken only by a failure notice, so its own route gets none.
    const { rows } = await run(
      async function* ({ arrive }) {
        yield { type: 'init', continuation: 's1' };
        const b = await arrive('m2', 'real question', { thread: 't1' });
        yield { type: 'consumed', ids: [b!] };
        yield { type: 'result', text: null, isError: true, error: 'Provider unavailable.' };
      },
      { ...CHANNEL, threadId: 't1', failureNoticeWake: true },
    );
    expect(rows.map((r) => [r.threadId, r.inReplyTo, r.text])).toEqual([['t1', 'm2', 'Provider unavailable.']]);
  });

  it('a new message absorbed into a retry turn may still be nudged once', async () => {
    const { pushes } = await run(async function* ({ arrive }) {
      yield { type: 'init', continuation: 's1' };
      // m1's turn ends unwrapped: a wrap-nudge retry is pushed and becomes the running turn.
      yield { type: 'result', text: 'unwrapped answer to m1' };
      const b = await arrive('m2', 'second question');
      yield { type: 'consumed', ids: [b!] };
      // The retry turn, now also answering m2, ends unwrapped again: one more nudge.
      yield { type: 'result', text: 'unwrapped answer to m1 and m2' };
      // That nudge's own turn is guarded: no third nudge.
      yield { type: 'result', text: 'still unwrapped' };
    });
    expect(pushes.filter((p) => p.prompt.includes('not delivered'))).toHaveLength(2);
  });

  it('a second nudge in a retry chain still suppresses what the first nudged turn sent', async () => {
    const { rows, pushes } = await run(async function* ({ arrive }) {
      yield { type: 'init', continuation: 's1' };
      // m1's turn sends "Done" with a tool, then ends unwrapped: retry 1.
      await writeMessageOut({
        id: 'tool-send',
        in_reply_to: 'm1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        thread_id: null,
        content: JSON.stringify({ text: 'Done' }),
      });
      yield { type: 'result', text: 'unwrapped' };
      // Retry 1's turn absorbs m2, writes nothing and ends unwrapped: retry 2.
      const b = await arrive('m2', 'second question');
      yield { type: 'consumed', ids: [b!] };
      yield { type: 'result', text: 'unwrapped again' };
      // Retry 2's turn re-sends m1's "Done" and answers m2.
      yield say('Done');
      yield say('answer to m2');
      yield result;
    });
    expect(pushes.filter((p) => p.prompt.includes('not delivered'))).toHaveLength(2);
    expect(rows.filter((r) => r.text === 'Done')).toHaveLength(1);
    expect(rows.some((r) => r.text === 'answer to m2')).toBe(true);
  });

  it('a chained retry absorbed by a new message’s turn still suppresses the first nudged turn’s sends', async () => {
    const { rows } = await run(async function* ({ arrive, pushes }) {
      yield { type: 'init', continuation: 's1' };
      await writeMessageOut({
        id: 'tool-send',
        in_reply_to: 'm1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        thread_id: null,
        content: JSON.stringify({ text: 'Done' }),
      });
      yield { type: 'result', text: 'unwrapped' }; // retry 1 runs next
      const b = await arrive('m2', 'second question');
      yield { type: 'consumed', ids: [b!] };
      await arrive('m3', 'third question'); // queued behind retry 1's turn
      yield { type: 'result', text: 'unwrapped again' }; // retry 2 queued behind m3; m3 runs next
      const retry2 = pushes[pushes.length - 1].inputId;
      yield { type: 'consumed', ids: [retry2!] }; // m3's turn absorbs retry 2
      yield say('Done');
      yield say('answer to m2 and m3');
      yield result;
    });
    expect(rows.filter((r) => r.text === 'Done')).toHaveLength(1);
    expect(rows.some((r) => r.text === 'answer to m2 and m3')).toBe(true);
  });

  describe('an absorbed wrap-nudge retry’s echo window', () => {
    // Turn A (thread t1) sends "Done" with a tool, then ends unwrapped, so a
    // wrap-nudge retry is queued behind follow-up B, and B's turn absorbs it.
    function absorbedRetry(bThread: string): Script {
      return async function* ({ arrive, pushes }) {
        yield { type: 'init', continuation: 's1' };
        await writeMessageOut({
          id: 'tool-send',
          in_reply_to: 'm1',
          kind: 'chat',
          platform_id: 'chan-1',
          channel_type: 'discord',
          thread_id: 't1',
          content: JSON.stringify({ text: 'Done' }),
        });
        const b = await arrive('m2', 'second question', { thread: bThread });
        yield { type: 'result', text: 'unwrapped' };
        const retry = pushes[pushes.length - 1].inputId;
        yield { type: 'consumed', ids: [b!, retry!] };
        yield say('Done');
        yield result;
      };
    }
    const sendsOfDone = (rows: Array<{ text: string; threadId: string | null }>) =>
      rows.filter((r) => r.text === 'Done').map((r) => r.threadId);

    it('suppresses a repeat to the retry’s own thread', async () => {
      const { rows } = await run(absorbedRetry('t1'), { ...CHANNEL, threadId: 't1' });
      expect(sendsOfDone(rows)).toEqual(['t1']);
    });

    it('does not suppress the same text as a fresh reply in another thread', async () => {
      const { rows } = await run(absorbedRetry('t2'), { ...CHANNEL, threadId: 't1' });
      expect(sendsOfDone(rows).sort()).toEqual(['t1', 't2']);
    });
  });
});

describe('agent-to-agent: an answer to one session of a peer', () => {
  // A reviewer agent answers requests from two sessions of a writer agent. A
  // burst of notes from a job-runner agent folds into one turn; later a runner
  // note wakes the turn in which the review of session B's request goes out
  // unattached. Behind a stale queue it carried session A's answered request,
  // so the host routed it to session A and session B waited for ever (seen on
  // a downstream install).
  function incident(reportConsumed: boolean): Script {
    return async function* ({ arrive }) {
      yield { type: 'init', continuation: 's1' };
      const n1 = await arrive('runner-1', 'job done', { agent: 'ag-runner' });
      const n2 = await arrive('runner-2', 'next job queued', { agent: 'ag-runner' });
      const n3 = await arrive('runner-3', 'next job done', { agent: 'ag-runner' });
      yield result;
      if (reportConsumed) yield { type: 'consumed', ids: [n1!, n2!, n3!] };
      yield result;
      const a = await arrive('writer-A', 'review draft 1', { agent: 'ag-writer' });
      if (reportConsumed) yield { type: 'consumed', ids: [a!] };
      yield say('REVIEW draft 1', 'writer');
      yield result;
      const b = await arrive('writer-B', 'review draft 2', { agent: 'ag-writer' });
      if (reportConsumed) yield { type: 'consumed', ids: [b!] };
      yield say('reviewing draft 2 now', 'writer');
      yield result;
      const w = await arrive('runner-4', 'check finished', { agent: 'ag-runner' });
      if (reportConsumed) yield { type: 'consumed', ids: [w!] };
      yield say('REVIEW draft 2', 'writer');
      yield result;
    };
  }
  const RUNNER: RoutingContext = {
    platformId: 'ag-runner',
    channelType: 'agent',
    threadId: null,
    inReplyTo: 'runner-0',
    taskRun: false,
  };

  it('the verdict is no longer stamped with session A’s answered request', async () => {
    insertMessage('runner-0', 'job started', { agent: 'ag-runner' });
    const { stamps } = await run(incident(true), RUNNER, 'runner-0');
    expect(stamps['REVIEW draft 1']).toBe('writer-A');
    expect(stamps['REVIEW draft 2']).toBe('writer-B');
  });

  it('control: without the signal it is (the reported misroute)', async () => {
    insertMessage('runner-0', 'job started', { agent: 'ag-runner' });
    const { stamps } = await run(incident(false), RUNNER, 'runner-0');
    expect(stamps['REVIEW draft 2']).toBe('writer-A');
  });
});
