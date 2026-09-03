import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// Two properties of the mid-turn delivery path that the skill's own guard
// tests do not cover, both carried over from the merge-based fix this design
// replaced:
//
//  - <internal>...</internal> is not-for-delivery scratchpad. A <message>
//    block quoted inside one is a DRAFT; promoting it to a real send was the
//    failure the exclusion exists to prevent.
//  - The incident shape itself: the model composes the wrapped reply, a tool
//    call rides after the composed message, and the turn's final text is
//    EMPTY. The reply reaches the user only if the mid-turn text event
//    delivered it.

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

function seedDest(name = 'discord-main'): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run(name, name);
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
  return getUndeliveredMessages().map((m) => (JSON.parse(m.content) as { text: string }).text);
}

describe('mid-turn <internal> exclusion', () => {
  it('never delivers a block quoted inside an <internal> span', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield {
        type: 'text',
        text: '<internal>draft: <message to="discord-main">not for sending</message></internal>',
      };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
  });

  it('excludes internal spans that carry attributes, in any case', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield {
        type: 'text',
        text: '<INTERNAL note="draft"><message to="discord-main">not for sending</message></Internal>',
      };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([]);
  });

  it('delivers a real block that shares its text segment with an internal draft', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield {
        type: 'text',
        text:
          '<internal>considering: <message to="discord-main">too blunt</message></internal>\n' +
          '<message to="discord-main">Here is the brief.</message>',
      };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Here is the brief.']);
  });

  it('an internal draft does not suppress the same body genuinely sent later in the turn', async () => {
    seedDest();
    const body = 'The answer is 4.';
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Drafted inside <internal> first, then genuinely sent in the same turn.
      // The draft must have left no trace that blocks the real send.
      yield { type: 'text', text: `<internal><message to="discord-main">${body}</message></internal>` };
      yield { type: 'text', text: `<message to="discord-main">${body}</message>` };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual([body]);
  });
});

describe('unwrapped final summary after a delivered reply', () => {
  it('does not fire the wrap-nudge or deliver the summary when a block already went out', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Real reply.</message>' };
      // Unwrapped self-summary as the final text — the live-observed shape
      // that used to trigger the wrap-nudge and a redundant second message.
      yield { type: 'result', text: 'Flagged it to Joe rather than guessing.' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Real reply.']);
    expect(pushes.filter((p) => p.includes('was not delivered'))).toEqual([]);
  });

  it('still nudges when nothing at all was delivered', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'plain unwrapped text, nothing sent' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(pushes.length).toBeGreaterThan(0);
  });
});

describe('mid-turn recovery when the final result is empty', () => {
  it('delivers the wrapped reply composed before a trailing tool call', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">Here is the brief: three pillars.</message>' };
      // A tool call rides after the composed message; final text is empty.
      yield { type: 'result', text: '' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['Here is the brief: three pillars.']);
    expect(pushes).toHaveLength(0);
  });

  it('does not re-deliver across turns when only the first turn composed a block', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-main">turn one</message>' };
      yield { type: 'result', text: '' };
      // Turn 2 composes nothing addressed and ends empty — nothing carried
      // across the turn boundary may resurrect turn 1's block.
      yield { type: 'text', text: 'just thinking' };
      yield { type: 'result', text: '' };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    expect(deliveredTexts()).toEqual(['turn one']);
  });
});

// The result door is still a live delivery path for providers that do NOT
// declare emitsMidTurnText — these run without the capability so the final
// text actually delivers, and the <internal> exclusion must hold there too.
describe('final-text <internal> exclusion (the result-door half of the guarantee)', () => {
  it('never delivers a block wrapped in <internal> in the FINAL result text', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield {
        type: 'result',
        text: '<internal>draft: <message to="discord-main">final-text secret</message></internal>',
      };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, false);

    expect(deliveredTexts()).toEqual([]);
  });

  it('delivers the real sibling block and drops only the internal draft', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield {
        type: 'result',
        text:
          '<internal>too blunt: <message to="discord-main">rejected draft</message></internal>\n' +
          '<message to="discord-main">Here is the final version.</message>',
      };
    }
    const { query } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, false);

    expect(deliveredTexts()).toEqual(['Here is the final version.']);
  });

  it('an internal-only final text does not fire the unwrapped nudge', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: '<internal>just thinking out loud</internal>' };
    }
    const { query, pushes } = makeStubQuery(events());

    await processQuery(query, CHAT_ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, false);

    expect(deliveredTexts()).toEqual([]);
    expect(pushes.filter((p) => p.includes('must be wrapped'))).toEqual([]);
  });
});
