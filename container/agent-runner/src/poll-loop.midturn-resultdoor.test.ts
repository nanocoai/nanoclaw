import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// Adversarial verification of the one-door contract for emitsMidTurnText
// providers: mid-turn streaming is the SINGLE content door. The result door
// NEVER writes content to messages_out (error results excepted) — its only
// other job is the nudge decision: a turn that delivered nothing (no door
// delivery, no DB-visible send like MCP send_message) whose result still
// carries content gets the wrap-nudge, so the model re-sends and the retry
// streams through the mid-turn door. Streaming-door misses (SDK drift, a
// destination appearing only after streaming) therefore degrade to
// nudge-and-retry — deliberately, never to a direct result-door send.
//
// The result text is an independent SDK field the provider cannot prove
// equal to streamed content (see providers/claude.ts result branch), which
// is why these divergence shapes are constructed and pinned here.

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

function removeDest(name: string): void {
  getInboundDb().prepare('DELETE FROM destinations WHERE name = ?').run(name);
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

function nudges(pushes: string[]): string[] {
  return pushes.filter((p) => p.includes('was not delivered'));
}

// ── The result door never delivers: streaming-door misses degrade to the nudge ──

describe('result door never delivers content — undelivered turns get the nudge', () => {
  it('SDK drift (capability=true, ZERO text events): the result block is NOT written, the nudge fires', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // The capability says text streams, but this turn emitted none — the
      // result is the only carrier of the reply. The result door still does
      // not send; the wrap-nudge asks the model to re-send, and the retry's
      // text events go through the mid-turn door.
      yield { type: 'result', text: '<message to="discord-main">Only exists in the result.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('streamed text WITHOUT deliverable blocks + result WITH a block: nothing written, nudge fires', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'thinking out loud, nothing wrapped yet' };
      yield { type: 'result', text: '<message to="discord-main">The reply.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('a nudged retry that re-streams the block delivers it through the mid-turn door (the recovery loop)', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Turn 1: drift — block only in the result. Nudge fires.
      yield { type: 'result', text: '<message to="discord-main">Lost in the drift.</message>' };
      // The retry turn streams properly — mid-turn door delivers.
      yield { type: 'text', text: '<message to="discord-main">Lost in the drift.</message>' };
      yield { type: 'result', text: '<message to="discord-main">Lost in the drift.</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Lost in the drift.']);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('the nudge decision resets per turn: a later drift turn nudges after an earlier delivered turn', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      // Turn 1: normal streaming — one delivery, no nudge.
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">turn one</message>' };
      yield { type: 'result', text: '<message to="discord-main">turn one</message>' };
      // Turn 2: drift — no text events. The per-turn state was reset at the
      // boundary, so this undelivered turn must nudge (and not deliver).
      yield { type: 'result', text: '<message to="discord-main">turn two</message>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['turn one']);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('a repeat of the mid-turn delivery in the result is inert: no second write, no nudge', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['The answer is 4.']);
    expect(pushes).toHaveLength(0);
  });
});

// ── Multi-segment turns: repeats in the result stay inert ──

describe('multi-segment turns: result overlap never re-delivers', () => {
  it('result repeating ALL segments blocks: each delivered once at the door, result inert', async () => {
    seedDest();
    const a = '<message to="discord-main">segment A</message>';
    const b = '<message to="discord-main">segment B</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: a };
      yield { type: 'text', text: b };
      yield { type: 'result', text: `${a}\n${b}` };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['segment A', 'segment B']);
    expect(pushes).toHaveLength(0);
  });

  it('result carrying only the LAST segment: earlier deliveries stand, the repeat is inert', async () => {
    seedDest();
    const a = '<message to="discord-main">segment A</message>';
    const b = '<message to="discord-main">segment B</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: a };
      yield { type: 'text', text: b };
      yield { type: 'result', text: b };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['segment A', 'segment B']);
    expect(pushes).toHaveLength(0);
  });
});

// ── Error and interrupted turns ──

describe('error and interrupted turns', () => {
  it('error result whose block never streamed (errors[] shape), nothing sent mid-turn: no write, nudge fires', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: 'partial progress narration, unwrapped' };
      // The claude provider builds error-result text from the SDK's errors[]
      // field — content that NEVER streamed. The result door still does not
      // send it as a block; with nothing delivered this turn the nudge asks
      // for a proper re-send instead.
      yield { type: 'result', text: '<message to="discord-main">Run aborted: quota.</message>', isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('a bare (blockless) error result still surfaces via deliverErrorResult — the errors exception', async () => {
    seedDest();
    const errText = 'Spending limit reached. Add your own key at https://example.com/keys';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: errText, isError: true };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([errText]);
    expect(pushes).toHaveLength(0);
  });

  it('a stream that throws after a mid-turn delivery: the delivered row survives, processQuery rejects', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Sent before the crash.</message>' };
      throw new Error('SDK stream died');
    }
    const { query } = makeStubQuery(events());

    await expect(
      processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow('SDK stream died');

    // The mid-turn write is durable — an interrupted turn cannot claw it back.
    expect(deliveredTexts()).toEqual(['Sent before the crash.']);
  });
});

// ── Destinations changing between stream time and result time ──

describe('destination set changes between stream time and result time', () => {
  it('dest unknown at stream time but present at result time, nothing else delivered: no write, nudge fires', async () => {
    // Destinations are live-queried from inbound.db (the host writes the
    // table on demand, mid-session). The result door does not deliver even
    // once the destination exists — the nudge coaxes a re-send, and the
    // retry's mid-turn scan sees the now-known destination.
    const block = '<message to="discord-main">Hello, new channel.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // door: unknown dest → skipped
      seedDest(); // host wires the destination mid-turn
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('KNOWN RESIDUAL (pinned): dest appears late while ANOTHER block already delivered — no delivery, no nudge', async () => {
    // Accepted bound of the one-door contract: the turn DID deliver, so the
    // nudge stays quiet, and the result door never sends — the late block is
    // lost for this turn. Reaching this shape requires a destination write
    // landing inside the sub-second window between the last streamed segment
    // and the result, in a turn that also delivered another block.
    seedDest('discord-main');
    const known = '<message to="discord-main">to the known channel</message>';
    const late = '<message to="late-dest">to the late channel</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: `${known}\n${late}` }; // known delivers; late skipped (unknown)
      seedDest('late-dest', 'discord', 'chan-2'); // appears inside the window
      yield { type: 'result', text: `${known}\n${late}` };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['to the known channel']);
    expect(nudges(pushes)).toHaveLength(0);
  });

  it('dest removed between stream and result: the delivered block is not re-sent and no nudge fires', async () => {
    seedDest();
    const block = '<message to="discord-main">delivered before removal</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // delivers
      removeDest('discord-main');
      yield { type: 'result', text: block }; // result-door: unknown dest → dropped-note; turn delivered → no nudge
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['delivered before removal']);
    expect(nudges(pushes)).toHaveLength(0);
  });
});

// ── Half-messages: never-closed fragments are the nudge's job ──
//
// Blocks split across text events are ASSEMBLED and delivered mid-turn (see
// poll-loop.midturn-assembly.test.ts). What assembly does NOT cover — a block
// that never closes anywhere — stays undeliverable, and the wrap-nudge is
// the recovery path when the turn delivered nothing.

describe('half-messages: never-closed fragments', () => {
  it('a block that NEVER closes anywhere: nothing delivered, the wrap-nudge fires (nudge owns this case)', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">this stays open forever' };
      // SDK premise: result = last assistant text = the same unclosed fragment.
      yield { type: 'result', text: '<message to="discord-main">this stays open forever' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });

  it('never-completed fragment alongside a delivered block: fragment dropped at turn end, no nudge, no loss of anything complete', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">complete reply</message>' };
      yield { type: 'text', text: '<message to="discord-main">opened but never closed…' };
      yield { type: 'result', text: '' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['complete reply']);
    expect(nudges(pushes)).toHaveLength(0);
  });
});

// ── Cross-segment echo guard (live-captured: SDK battery s03) ──
//
// The model, after a trailing tool call, often re-emits the ALREADY-SENT
// block verbatim as its final text — which streams as its own text event.
// The door consults the outbound DB over the frame-local seq window
// (turnStartSeq, segStartSeq] to recognize the repeat; no in-process content
// ledger. Intra-segment doubles and cross-turn repeats stay deliverable.

describe('cross-segment echo guard', () => {
  it('a later segment re-emitting the identical block delivers once (s03 recording shape)', async () => {
    seedDest();
    const block = '<message to="discord-main">✅ Deploy is done.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block }; // composed + delivered before the tool call
      yield { type: 'text', text: block }; // final text: verbatim echo after the tool call
      yield { type: 'result', text: block }; // result === last segment (live invariant)
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['✅ Deploy is done.']);
    expect(pushes).toHaveLength(0);
  });

  it('two identical blocks in ONE segment are an explicit double-send and both deliver (s09 shape)', async () => {
    seedDest();
    const twice =
      '<message to="discord-main">backup finished</message>\n\n<message to="discord-main">backup finished</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: twice };
      yield { type: 'result', text: twice };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['backup finished', 'backup finished']);
  });

  it('the same body to a DIFFERENT destination is not an echo', async () => {
    seedDest('discord-main');
    seedDest('ops-log', 'slack', 'chan-ops');
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">capture test</message>' };
      yield { type: 'text', text: '<message to="ops-log">capture test</message>' };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['capture test', 'capture test']);
  });

  it('the window closes at the turn boundary: the next turn may genuinely repeat the body', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer is 4.</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
      // Turn 2: same body again, on purpose. Must deliver.
      yield { type: 'text', text: block };
      yield { type: 'result', text: 'sent above' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['The answer is 4.', 'The answer is 4.']);
  });
});

// ── MCP sends count as same-turn deliveries for the nudge decision ──

describe('DB-visible sends gate the nudge', () => {
  it('a chat row written this turn outside the door (MCP send_message shape) suppresses the nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Simulate an MCP send_message call landing mid-turn: a chat row
      // appears in outbound.db without going through the mid-turn door.
      const { writeMessageOut } = await import('./db/messages-out.js');
      writeMessageOut({
        id: 'mcp-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        thread_id: null,
        content: JSON.stringify({ text: 'sent via tool' }),
      });
      // Final text is an unwrapped self-summary — with a DB-visible send
      // this turn, nudging would coax a redundant repeat.
      yield { type: 'result', text: 'Told them via the tool.' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['sent via tool']);
    expect(nudges(pushes)).toHaveLength(0);
  });
});

// ── Failure ordering — mid-turn outbound write fails ──

describe('mid-turn delivery write failure', () => {
  it('fails the turn loudly: processQuery rejects, the stream never reaches its result, nothing is silently dropped', async () => {
    seedDest();
    let reachedResult = false;
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Break the outbound DB before the delivery attempt — the next
      // writeMessageOut throws (fresh prepare per call, so the rename bites).
      getOutboundDb().exec('ALTER TABLE messages_out RENAME TO messages_out_broken');
      yield { type: 'text', text: '<message to="discord-main">will fail to write</message>' };
      reachedResult = true;
      yield { type: 'result', text: '<message to="discord-main">will fail to write</message>' };
    }
    const { query } = makeStubQuery(events());

    await expect(
      processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true),
    ).rejects.toThrow();

    // The turn died at the failed write: the result was never processed, and
    // the caller's error path (runPollLoop) surfaces the failure to the user.
    expect(reachedResult).toBe(false);
    getOutboundDb().exec('ALTER TABLE messages_out_broken RENAME TO messages_out');
    expect(deliveredTexts()).toEqual([]);
  });
});

// ── Door-skipped blocks keep base result-door handling ──

describe('capability=true keeps base result-door handling for door-skipped blocks', () => {
  it('unknown destination at both doors: dropped with the wrap-nudge, never silently swallowed', async () => {
    // No destination seeded at all.
    const block = '<message to="nobody-home">is anyone there?</message>';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: block };
      yield { type: 'result', text: block };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
    expect(nudges(pushes)).toHaveLength(1);
  });
});
