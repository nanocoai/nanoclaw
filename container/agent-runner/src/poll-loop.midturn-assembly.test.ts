import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery, unresolvedTailStart } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// Cross-segment assembly: a frame-local parse buffer carries the unresolved
// tail of one text event into the next, so a <message> block opened in one
// assistant message and closed in a later one (live-captured: SDK battery
// s04b, a tool call riding between open and close) is assembled and
// delivered ONCE, mid-turn, when its close arrives. The buffer carries ONLY
// the unresolved tail — settled text is consumed exactly once, so delivered
// blocks never re-match — and dies at the turn boundary: a block that never
// closes anywhere is the wrap-nudge's job (see the resultdoor test file).

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const CHAT_ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

function seedDest(name = 'discord-main', channelType = 'discord', platformId = 'chan-1'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, name, channelType, platformId);
}

function makeStubQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events,
      abort: () => {},
    },
  };
}

function deliveredTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text: string }).text);
}

async function run(events: AsyncGenerator<ProviderEvent>): Promise<string[]> {
  const { query, pushes } = makeStubQuery(events);
  await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);
  return pushes;
}

describe('cross-segment block assembly', () => {
  it('a block split across two text events assembles and delivers once, with no nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">part one, ' };
      yield { type: 'text', text: 'part two</message>' };
      // SDK premise: result = last assistant text = the tail fragment.
      yield { type: 'result', text: 'part two</message>' };
    }
    const pushes = await run(events());

    expect(deliveredTexts()).toEqual(['part one, part two']);
    expect(pushes).toHaveLength(0);
  });

  it('a block split across THREE events (open / body / close) assembles once', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'On it.\n<message to="discord-main">step one done, ' };
      yield { type: 'text', text: 'step two done, ' };
      yield { type: 'text', text: 'all green.</message>' };
      yield { type: 'result', text: 'all green.</message>' };
    }
    const pushes = await run(events());

    expect(deliveredTexts()).toEqual(['step one done, step two done, all green.']);
    expect(pushes).toHaveLength(0);
  });

  it('an open tag literally split mid-token ("<mess" / "age to=…") reunites and the block delivers', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'prose before <mess' };
      yield { type: 'text', text: 'age to="discord-main">assembled across the wire</message>' };
      yield { type: 'result', text: '' };
    }
    const pushes = await run(events());

    expect(deliveredTexts()).toEqual(['assembled across the wire']);
    expect(pushes).toHaveLength(0);
  });

  it('a complete block delivers immediately even when the same event ends in a new unclosed open', async () => {
    seedDest();
    let deliveredAfterFirstEvent = -1;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield {
        type: 'text',
        text: '<message to="discord-main">first, complete</message>\n<message to="discord-main">second, still open ',
      };
      // The complete block must have gone out before the next event —
      // assembly defers only the unresolved tail, never settled content.
      deliveredAfterFirstEvent = getUndeliveredMessages().length;
      yield { type: 'text', text: 'and now closed</message>' };
      yield { type: 'result', text: '' };
    }
    await run(events());

    expect(deliveredAfterFirstEvent).toBe(1);
    expect(deliveredTexts()).toEqual(['first, complete', 'second, still open and now closed']);
  });

  it('the carried tail never re-matches the already-delivered block that preceded it', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // One event: complete block A, then an open fragment. If the buffer
      // carried more than the tail, block A could re-match on the next scan.
      yield { type: 'text', text: '<message to="discord-main">A</message><message to="discord-main">B' };
      yield { type: 'text', text: ' continued</message>' };
      yield { type: 'result', text: '' };
    }
    await run(events());

    expect(deliveredTexts()).toEqual(['A', 'B continued']);
  });

  it('echo-of-assembled: a later verbatim repeat of the assembled body is suppressed by the DB check', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">assembled ' };
      yield { type: 'text', text: 'once</message>' }; // assembled → delivered
      // Final text repeats the whole block verbatim in one segment — the
      // cross-segment echo guard must recognize the assembled delivery.
      yield { type: 'text', text: '<message to="discord-main">assembled once</message>' };
      yield { type: 'result', text: '<message to="discord-main">assembled once</message>' };
    }
    const pushes = await run(events());

    expect(deliveredTexts()).toEqual(['assembled once']);
    expect(pushes).toHaveLength(0);
  });

  it('an <internal> span split across events must not promote a quoted draft via assembly', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // The internal span opens in event 1 and closes in event 2; the draft
      // block inside completes ACROSS the boundary. Assembly must defer
      // judgment until the span closes, then exclude the draft.
      yield { type: 'text', text: '<internal>draft: <message to="discord-main">not for sending' };
      yield { type: 'text', text: '</message></internal>\n<message to="discord-main">the real one</message>' };
      yield { type: 'result', text: '' };
    }
    await run(events());

    expect(deliveredTexts()).toEqual(['the real one']);
  });

  it('a block opened before an unclosed <internal> assembles correctly once both close', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // The block opens first, then an internal span opens inside it —
      // the unresolved region must start at the BLOCK open (earliest), so
      // the whole construct is carried and the internal content is excluded
      // from the delivered body.
      yield { type: 'text', text: '<message to="discord-main">body <internal>note to self' };
      yield { type: 'text', text: '</internal> rest</message>' };
      yield { type: 'result', text: '' };
    }
    await run(events());

    expect(deliveredTexts()).toEqual(['body  rest']);
  });

  it('the buffer dies at the turn boundary: a fragment is not resurrected by the next turn', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1 ends with an unclosed fragment (delivered nothing → nudge).
      yield { type: 'text', text: '<message to="discord-main">turn-one fragment' };
      yield { type: 'result', text: '<message to="discord-main">turn-one fragment' };
      // Turn 2 emits text that would CLOSE the fragment if the buffer
      // leaked across turns — it must instead be plain scratchpad prose.
      yield { type: 'text', text: 'stray text</message>' };
      yield { type: 'result', text: '' };
    }
    const pushes = await run(events());

    expect(deliveredTexts()).toEqual([]);
    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(1);
  });

  it('task runs never buffer: fragments across events stay inert', async () => {
    seedDest();
    const TASK_ROUTING = {
      platformId: null,
      channelType: null,
      threadId: 'system:tasks:ser-1',
      inReplyTo: 't1',
      taskRun: true,
    };
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">split in a ' };
      yield { type: 'text', text: 'task run</message>' };
      yield { type: 'result', text: 'run finished' };
    }
    const { query } = makeStubQuery(events());
    await processQuery(query, TASK_ROUTING, ['t1'], 'claude', undefined, 'prompt', undefined, true);

    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });
});

describe('unresolvedTailStart', () => {
  it('fully settled text returns input.length', () => {
    for (const s of ['plain prose', '<message to="x">done</message>', 'a < b and 5 > 4', '']) {
      expect(unresolvedTailStart(s)).toBe(s.length);
    }
  });

  it('an unclosed <message open starts the tail', () => {
    const s = 'settled <message to="x">still open';
    expect(unresolvedTailStart(s)).toBe('settled '.length);
  });

  it('an open with a close AFTER it is settled even when malformed', () => {
    // No to="…" attribute — MESSAGE_RE will never match it, but it is
    // finished text, not a growing block: buffering it would swallow
    // everything after it for the rest of the turn.
    const s = '<message bad>text</message> trailing prose';
    expect(unresolvedTailStart(s)).toBe(s.length);
  });

  it('a bare tag prefix at the end starts the tail (mid-token split)', () => {
    expect(unresolvedTailStart('prose <mess')).toBe('prose '.length);
    expect(unresolvedTailStart('prose <')).toBe('prose '.length);
    expect(unresolvedTailStart('prose <inter')).toBe('prose '.length);
  });

  it('an unclosed <internal span starts the tail even before a later <message open', () => {
    const s = 'ok <internal>hmm <message to="x">draft';
    expect(unresolvedTailStart(s)).toBe('ok '.length);
  });

  it('an unclosed <message before a later unclosed <internal wins (earliest unresolved)', () => {
    const s = '<message to="x">body <internal>note';
    expect(unresolvedTailStart(s)).toBe(0);
  });

  it('constructs inside COMPLETE internal spans are settled garbage, not buffer triggers', () => {
    const s = '<internal>quoting: <message to="x">unclosed draft</internal> after';
    expect(unresolvedTailStart(s)).toBe(s.length);
  });
});
