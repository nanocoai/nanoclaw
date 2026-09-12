/**
 * Tools-only delivery.
 *
 * In a tools-only group the only thing that reaches a destination is an
 * explicit outbound tool call. Everything the agent writes — envelopes, markup
 * that looks like a tool call, plain prose, provider error text — is
 * scratchpad. A turn someone is waiting on that delivers nothing is corrected
 * once and then answered with a placeholder rather than left silent; a wake
 * nobody is waiting on may end with nothing at all.
 *
 * The envelope contract is the default and is asserted here to be untouched.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getDeliveriesSince, getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import { buildCompactInstructions } from './compact-instructions.js';
import { buildSystemPromptAddendum } from './destinations.js';
import { extractRouting, isUserChannelTrigger, replyTargetsFor, type RoutingContext } from './formatter.js';
import {
  buildToolsOnlyNudge,
  dispatchResultText,
  looksLikeToolMarkup,
  processQuery,
  runPollLoop,
  TOOLS_ONLY_ERROR_NOTICE,
  TOOLS_ONLY_PLACEHOLDER,
} from './poll-loop.js';
import type { AgentProvider, AgentQuery, ProviderEvent } from './providers/types.js';

/** A person is waiting on this one. */
const CHAT_ROUTING: RoutingContext = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
  replyTargets: [{ platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' }],
};

/** A wake with no human endpoint at all — a webhook, a context-only row. */
const UNPROMPTED_ROUTING: RoutingContext = { ...CHAT_ROUTING, replyTargets: [] };

/** A host notice or peer message: a correspondent, but no human endpoint. */
const AGENT_WAKE_ROUTING: RoutingContext = { ...CHAT_ROUTING, replyTargets: [], agentWake: true };

const TASK_ROUTING: RoutingContext = {
  platformId: null,
  channelType: null,
  threadId: 'system:tasks:ser-1',
  inReplyTo: 't1',
  taskRun: true,
};

beforeEach(() => {
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
});

/** Stub query yielding init + the given results in order, recording pushes. */
function makeQuery(...results: Array<string | { text: string; isError: boolean; error?: string }>): {
  query: AgentQuery;
  pushes: string[];
} {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 's1' };
    for (const r of results) {
      yield typeof r === 'string'
        ? { type: 'result', text: r }
        : { type: 'result', text: r.text, isError: r.isError, error: r.error };
    }
  }
  return {
    pushes,
    query: {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    },
  };
}

/** Everything the host would hand to a user, in seq order. */
function userTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat' || m.kind === 'chat-sdk')
    .map((m) => JSON.parse(m.content).text as string);
}

function insertChat(
  id: string,
  text: string,
  opts?: { channelType?: string | null; trigger?: 0 | 1; threadId?: string },
): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, 'chan-1', ?, ?, ?)`,
    )
    .run(
      id,
      opts?.trigger ?? 1,
      opts?.channelType === undefined ? 'discord' : opts.channelType,
      opts?.threadId ?? null,
      JSON.stringify({ sender: 'A', text }),
    );
}

async function runToolsOnly(query: AgentQuery, routing: RoutingContext = CHAT_ROUTING): Promise<void> {
  await processQuery(query, routing, ['m1'], 'mock', undefined, 'prompt', undefined, 'tools-only');
}

// ── Final text never delivers ──

describe('tools-only turns deliver nothing from final text', () => {
  it('leaves an envelope inert even when it carries deliverable prose', async () => {
    const { query, pushes } = makeQuery('<message to="discord-test">The build is green.</message>');

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('block');
    expect(pushes[0]).toContain('send_message');
  });

  it('keeps streamed envelopes inert for a mid-turn-delivery provider', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'text', text: '<message to="discord-test">The build is green.</message>' };
      yield { type: 'result', text: '<message to="discord-test">The build is green.</message>' };
    }
    const query: AgentQuery = {
      push: (text) => pushes.push(text),
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined, true, 'tools-only');

    expect(userTexts()).toEqual([]);
    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('send_message');
  });

  it('never surfaces thinking that leaked inside an envelope body', async () => {
    const { query } = makeQuery(
      '<message to="discord-test"><internal>the user sounds annoyed, keep it short</internal>All set.</message>',
    );

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
  });

  it('corrects an internal-only turn instead of letting it pass as silence', async () => {
    const { query, pushes } = makeQuery('<internal>nothing here needs a reply</internal>');

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
    expect(pushes[0]).toContain('private scratchpad');
  });

  it('names tool-call-shaped markup as the failure — XML style', async () => {
    const { query, pushes } = makeQuery('<tool_call>{"name": "send_message", "to": "discord-test"}</tool_call>');

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
    expect(pushes[0]).toContain('shaped like a tool call');
  });

  it('names tool-call-shaped markup as the failure — function-call style', async () => {
    const { query, pushes } = makeQuery(
      '<call:mcp__nanoclaw__ask_user_question(title="Mock Approval", options=["yes","no"])</call:mcp__nanoclaw__ask_user_question>',
    );

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
    expect(pushes[0]).toContain('shaped like a tool call');
  });

  it('handles a turn that mixes prose with the markup', async () => {
    const { query, pushes } = makeQuery('On it — pulling the numbers now.\n<call:bash(command="ls -la")</call:bash>');

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
    expect(pushes[0]).toContain('shaped like a tool call');
  });

  it('names the destination when the envelope addressed one that does not exist', async () => {
    const { query, pushes } = makeQuery('<message to="typo-channel">hello?</message>');

    await runToolsOnly(query);

    expect(userTexts()).toEqual([]);
    expect(pushes[0]).toContain('"typo-channel"');
    expect(pushes[0]).toContain('is not a destination');
  });
});

// ── What counts as an answer ──

describe('delivery accounting', () => {
  it('accepts a turn that answered through a tool, whatever the final text says', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      writeMessageOut({
        id: 'tool-1',
        in_reply_to: 'm1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        thread_id: null,
        content: JSON.stringify({ text: 'The build is green.' }),
      });
      // …and the model then echoes the same caption as an envelope.
      yield { type: 'result', text: '<message to="discord-test">The build is green.</message>' };
    }
    const pushes: string[] = [];
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(userTexts()).toEqual(['The build is green.']);
    expect(pushes).toHaveLength(0);
  });

  it('counts a card, a question or a file sent during the turn as an answer', async () => {
    // send_card and ask_user_question write `chat-sdk`; send_file writes a
    // `chat` row carrying an attachment. All three answer the person.
    for (const row of [
      { id: 'card-1', kind: 'chat-sdk', content: { text: 'Pick one', options: ['a', 'b'] } },
      { id: 'file-1', kind: 'chat', content: { text: '', files: ['report.pdf'] } },
    ]) {
      initTestSessionDb();
      const pushes: string[] = [];
      async function* events(): AsyncGenerator<ProviderEvent> {
        yield { type: 'init', continuation: 's1' };
        writeMessageOut({
          id: row.id,
          kind: row.kind,
          platform_id: 'chan-1',
          channel_type: 'discord',
          content: JSON.stringify(row.content),
        });
        yield { type: 'result', text: 'sent it' };
      }
      const query: AgentQuery = {
        push: (m: string) => {
          pushes.push(m);
        },
        end: () => {},
        events: events(),
        abort: () => {},
      };

      await runToolsOnly(query);

      expect(pushes).toHaveLength(0);
      expect(userTexts()).toHaveLength(1);
    }
  });

  it('does not credit a delivery that predates the turn', async () => {
    writeMessageOut({
      id: 'older',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'from an earlier turn' }),
    });
    expect(getDeliveriesSince(0).maxSeq).toBeGreaterThan(0);

    const { query, pushes } = makeQuery('done');
    await runToolsOnly(query);

    expect(pushes).toHaveLength(1);
  });

  it('does not count a reaction or an edit as an answer', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // add_reaction and edit_message both write `chat` rows that only annotate
      // an existing message — neither puts new content in front of anyone.
      writeMessageOut({
        id: 'react-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ operation: 'reaction', messageId: 'p-1', emoji: '👍' }),
      });
      writeMessageOut({
        id: 'edit-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ operation: 'edit', messageId: 'p-1', text: 'fixed' }),
      });
      yield { type: 'result', text: 'reacted, nothing else to say' };
      yield { type: 'result', text: 'still nothing' };
    }
    const pushes: string[] = [];
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    // A turn that only reacted still owes an answer.
    expect(pushes).toHaveLength(1);
    expect(userTexts()).toContain(TOOLS_ONLY_PLACEHOLDER);
  });

  it('does not count a task_log or a system row as an answer', () => {
    writeMessageOut({ id: 'log-1', kind: 'task_log', content: JSON.stringify({ text: 'ran' }) });
    writeMessageOut({ id: 'sys-1', kind: 'system', content: JSON.stringify({ action: 'cli_request' }) });

    expect(getDeliveriesSince(0).maxSeq).toBe(0);
  });

  it('reads the window above a baseline, so one call answers both questions', async () => {
    const first = await writeMessageOut({
      id: 'd-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'one' }),
    });

    // Below the baseline: invisible. Above: reported — and the reported value
    // IS the next baseline, so no second read can absorb a racing write.
    expect(getDeliveriesSince(first).maxSeq).toBe(0);
    expect(getDeliveriesSince(first - 1).maxSeq).toBe(first);

    const second = await writeMessageOut({
      id: 'd-2',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'two' }),
    });
    expect(getDeliveriesSince(first).maxSeq).toBe(second);
  });

  it('reports nothing when everything above the baseline is an annotation', () => {
    const base = writeMessageOut({
      id: 'd-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'one' }),
    });
    writeMessageOut({
      id: 'r-1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      content: JSON.stringify({ operation: 'reaction', messageId: 'p', emoji: '\u{1F44D}' }),
    });

    expect(getDeliveriesSince(base).maxSeq).toBe(0);
  });

  it('reports the address and the stamp of every delivery, oldest first', async () => {
    await writeMessageOut({
      id: 'to-human',
      in_reply_to: 'm1',
      kind: 'chat',
      platform_id: 'chan-1',
      channel_type: 'discord',
      content: JSON.stringify({ text: 'for the human' }),
    });
    await writeMessageOut({
      id: 'to-peer',
      kind: 'chat',
      platform_id: 'peer-group',
      channel_type: 'agent',
      content: JSON.stringify({ text: 'for the peer' }),
    });

    const { deliveries } = getDeliveriesSince(0);

    expect(deliveries.map((d) => ({ ...d, seq: undefined }))).toEqual([
      { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1', seq: undefined },
      { platformId: 'peer-group', channelType: 'agent', threadId: null, inReplyTo: null, seq: undefined },
    ]);
    expect(deliveries[0].seq).toBeLessThan(deliveries[1].seq);
  });
});

// ── The judgment cycle ──

describe('turn-end judgment', () => {
  it('corrects once, then delivers the placeholder on a second dry judgment', async () => {
    const { query, pushes } = makeQuery('still thinking about it', 'yeah, still thinking');

    await runToolsOnly(query);

    expect(pushes).toHaveLength(1);
    expect(userTexts()).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('does not let a send_message to a peer agent discharge a human\u2019s question', async () => {
    // The human asked. The agent answers a PEER instead — an agent-channel row
    // is `kind: 'chat'` like any other, so an address-blind accounting would
    // call the question answered and leave the human with silence.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      await writeMessageOut({
        id: 'peer-1',
        kind: 'chat',
        platform_id: 'peer-group',
        channel_type: 'agent',
        content: JSON.stringify({ text: 'hey peer, any idea?' }),
      });
      yield { type: 'result', text: 'asked the other agent' };
      yield { type: 'result', text: 'still waiting on them' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    // The human's obligation survived the peer send: corrected once, then answered.
    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    const toHuman = getUndeliveredMessages().filter((m) => m.channel_type === 'discord');
    expect(toHuman.map((m) => JSON.parse(m.content).text)).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('does not let a send to one destination discharge another destination\u2019s question', async () => {
    const routing: RoutingContext = {
      ...CHAT_ROUTING,
      replyTargets: [
        { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' },
        { platformId: 'chan-2', channelType: 'slack', threadId: null, inReplyTo: 'm2' },
      ],
    };
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      await writeMessageOut({
        id: 'slack-1',
        kind: 'chat',
        platform_id: 'chan-2',
        channel_type: 'slack',
        content: JSON.stringify({ text: 'answered slack' }),
      });
      yield { type: 'result', text: 'told slack' };
      yield { type: 'result', text: 'nothing more' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query, routing);

    // Discord was never reached: it keeps its correction and its placeholder.
    // Slack was answered and is not chased with a second message.
    const byChannel = (ch: string) =>
      getUndeliveredMessages()
        .filter((m) => m.channel_type === ch)
        .map((m) => JSON.parse(m.content).text as string);
    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    expect(byChannel('discord')).toEqual([TOOLS_ONLY_PLACEHOLDER]);
    expect(byChannel('slack')).toEqual(['answered slack']);
  });

  it('never falls back to raw agent text', async () => {
    const { query } = makeQuery('unaddressed rambling', 'more unaddressed rambling');

    await runToolsOnly(query);

    const texts = userTexts();
    expect(texts.some((t) => t.includes('rambling'))).toBe(false);
    expect(texts).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('treats a textless result with no tool call as a dry judgment', async () => {
    const { query, pushes } = makeQuery('', '');

    await runToolsOnly(query);

    expect(pushes).toHaveLength(1);
    expect(userTexts()).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('stops chasing after the placeholder — a wedged model is not nudged in a loop', async () => {
    const { query, pushes } = makeQuery('dry one', 'dry two', 'dry three', 'dry four');

    await runToolsOnly(query);

    // One correction, one placeholder, then silence: no further pushes.
    expect(pushes).toHaveLength(1);
    expect(userTexts()).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('counts a send that landed before an interleaved follow-up push', async () => {
    // The send and the push race. Re-snapshotting the baseline at push time
    // would erase the send and produce a bogus "you delivered nothing".
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      writeMessageOut({
        id: 'tool-1',
        in_reply_to: 'm1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answered already' }),
      });
      insertChat('m2', 'another question');
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('another question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      yield { type: 'result', text: 'that is all from me' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(0);
    expect(userTexts()).toEqual(['answered already']);
  });

  it('does not credit a late unjudged send to the next question', async () => {
    // Q1 and Q2 are both outstanding when the first send lands, so that result
    // clears the queue. Q2's own send then lands with nobody formally waiting.
    // Its seq must still advance the baseline; otherwise a later dry Q3 turn
    // inherits Q2's send and incorrectly skips its correction.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      insertChat('m2', 'second question');
      let deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('second question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      writeMessageOut({
        id: 'tool-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answer one' }),
      });
      yield { type: 'result', text: 'sent one' };
      writeMessageOut({
        id: 'tool-2',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answer two' }),
      });
      yield { type: 'result', text: 'sent two' };
      insertChat('m3', 'image question');
      deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('image question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      yield { type: 'result', text: 'private image description' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(userTexts()).toEqual(['answer one', 'answer two']);
    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
  });

  it('reaches the placeholder within two judgments despite an interleaved push', async () => {
    // Steady message flow must not postpone the placeholder forever.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'dry judgment one' };
      insertChat('m2', 'a fresh question');
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('a fresh question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      yield { type: 'result', text: 'dry judgment two' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    expect(userTexts()).toEqual([TOOLS_ONLY_PLACEHOLDER]);
  });

  it('leaves task runs on the task path', async () => {
    const { query, pushes } = makeQuery('<message to="discord-test">digest ready</message>');

    await processQuery(query, TASK_ROUTING, ['t1'], 'mock', undefined, 'prompt', undefined, 'tools-only');

    expect(pushes).toHaveLength(1);
    expect(pushes[0]).toContain('If and only if');
    const logs = getOutboundDb().prepare("SELECT content FROM messages_out WHERE kind = 'task_log'").all();
    expect(logs).toHaveLength(1);
    expect(userTexts()).toEqual([]);
  });
});

// ── Wakes nobody is waiting on ──

describe('unprompted wakes', () => {
  it('lets a dry wake end silently — no correction, no placeholder', async () => {
    const { query, pushes } = makeQuery('nothing about this needs announcing', 'still nothing');

    await runToolsOnly(query, UNPROMPTED_ROUTING);

    expect(pushes).toHaveLength(0);
    expect(userTexts()).toEqual([]);
  });

  it('starts judging once a real question arrives mid-stream', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'webhook handled, nothing to say' };
      insertChat('m2', 'hey, are you there?');
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('are you there')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      yield { type: 'result', text: 'still saying nothing' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query, UNPROMPTED_ROUTING);

    // The first result was unprompted and passed; the second owed an answer.
    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
  });

  it('classifies which inbound rows put someone on the hook', () => {
    insertChat('c1', 'a real question');
    insertChat('c2', 'peer traffic', { channelType: 'agent' });
    insertChat('c3', 'context only', { trigger: 0 });
    insertChat('c4', 'no channel', { channelType: null });
    const byId = Object.fromEntries(getPendingMessages().map((m) => [m.id, m]));

    expect(isUserChannelTrigger(byId.c1)).toBe(true);
    expect(isUserChannelTrigger(byId.c2)).toBe(false);
    expect(isUserChannelTrigger(byId.c3)).toBe(false);
    expect(isUserChannelTrigger(byId.c4)).toBe(false);
  });

  it('marks an agent-channel-only batch as a correctable wake with no endpoint', () => {
    insertChat('c1', 'approval granted', { channelType: 'agent' });
    const routing = extractRouting(getPendingMessages());

    expect(routing.replyTargets).toEqual([]);
    expect(routing.agentWake).toBe(true);
  });

  it('marks a webhook batch as neither — nothing owed at all', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('w1', 'webhook', datetime('now'), 'pending', 1, 'chan-1', 'github', ?)`,
      )
      .run(JSON.stringify({ source: 'github', event: 'push', payload: {} }));
    const routing = extractRouting(getPendingMessages());

    expect(routing.replyTargets).toEqual([]);
    expect(routing.agentWake).toBe(false);
  });
});

// ── P1: emissions target the newest waiting user row ──

describe('reply targeting', () => {
  it('yields one target per user row, in arrival order, skipping agent rows', () => {
    insertChat('a1', 'host notice', { channelType: 'agent' });
    insertChat('u1', 'first question', { threadId: 'thread-old' });
    insertChat('u2', 'second question', { threadId: 'thread-new' });

    expect(replyTargetsFor(getPendingMessages())).toEqual([
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old', inReplyTo: 'u1' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new', inReplyTo: 'u2' },
    ]);
  });

  it('never picks an agent row, wherever it sits', () => {
    insertChat('u1', 'a question');
    insertChat('a1', 'host notice arriving after', { channelType: 'agent' });

    expect(replyTargetsFor(getPendingMessages()).map((t) => t.inReplyTo)).toEqual(['u1']);
  });

  it('routes the placeholder to that row, thread and in_reply_to included', async () => {
    insertChat('a1', 'host notice', { channelType: 'agent' });
    insertChat('u1', 'are you there?', { threadId: 'thread-7' });
    const routing = extractRouting(getPendingMessages());

    const { query } = makeQuery('dry', 'still dry');
    await processQuery(query, routing, ['a1'], 'mock', undefined, 'prompt', undefined, 'tools-only');

    const rows = getUndeliveredMessages().filter((m) => m.kind === 'chat');
    expect(rows).toHaveLength(1);
    // Not the batch address (the agent row came first) — the waiting user.
    expect(rows[0].channel_type).toBe('discord');
    expect(rows[0].thread_id).toBe('thread-7');
    expect(rows[0].in_reply_to).toBe('u1');
  });
});

// ── P2: host wakes over the agent channel ──

describe('agent-channel wakes', () => {
  it('corrects once and then stays silent — nothing written to the agent channel', async () => {
    const { query, pushes } = makeQuery('dry one', 'dry two', 'dry three');

    await runToolsOnly(query, AGENT_WAKE_ROUTING);

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it.each([
    ['approval outcome', 'Your cli_command request was rejected by admin.'],
    ['container restart', 'Your container was restarted to apply new settings.'],
    ['self-modification', 'Your configuration was updated and applied.'],
  ])('nudges but never writes back for a %s wake', async (_label, text) => {
    // All three host producers write kind=chat / channel_type=agent into the
    // user's own session, so they must classify as correctable-but-mute.
    insertChat('h1', text, { channelType: 'agent' });
    const routing = extractRouting(getPendingMessages());
    expect(routing.agentWake).toBe(true);

    const { query, pushes } = makeQuery('acknowledged internally', 'still nothing to send');
    await processQuery(query, routing, ['h1'], 'mock', undefined, 'prompt', undefined, 'tools-only');

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('does not emit an error notice into an agent channel either', async () => {
    const { query } = makeQuery({ text: 'gateway exploded', isError: true });

    await runToolsOnly(query, AGENT_WAKE_ROUTING);

    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

// ── P3: one correction budget per outstanding question ──

describe('outstanding questions are a queue', () => {
  it('gives a question queued behind a placeholder its own correction', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      // Q1 dry → its correction.
      yield { type: 'result', text: 'dry for question one' };
      insertChat('m2', 'second question');
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('second question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // Q1 dry again → placeholder for Q1, Q2 moves up untouched.
      yield { type: 'result', text: 'still dry for question one' };
      // Q2's own turn: it has never been corrected, so it earns a correction —
      // not an immediate second placeholder.
      yield { type: 'result', text: 'dry for question two' };
      // And only now does Q2 get its placeholder.
      yield { type: 'result', text: 'still dry for question two' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(2);
    expect(userTexts()).toEqual([TOOLS_ONLY_PLACEHOLDER, TOOLS_ONLY_PLACEHOLDER]);
  });

  it('does not discard the queued question when the one ahead is closed out', async () => {
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'dry one' };
      insertChat('m2', 'queued behind');
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('queued behind')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      yield { type: 'result', text: 'dry two' };
      // Q1 is now closed. Q2 must still be judged rather than early-returned.
      yield { type: 'result', text: 'dry three' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    // Two corrections: Q2 was judged, not dropped.
    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(2);
  });

  it('chases two questions from the SAME batch independently', async () => {
    // One poll batch, two people waiting. Collapsing them to a single entry
    // would leave the second structurally unanswerable.
    insertChat('u1', 'first question');
    insertChat('u2', 'second question', { threadId: 'thread-2' });
    const routing = extractRouting(getPendingMessages());
    expect(routing.replyTargets).toHaveLength(2);

    const { query, pushes } = makeQuery('dry', 'dry', 'dry', 'dry');
    await processQuery(query, routing, ['u1', 'u2'], 'mock', undefined, 'prompt', undefined, 'tools-only');

    // Both went dry at the same result, so one correction covers both — a
    // second would only re-run the same turn — but each is closed out with its
    // own placeholder, at its own address, and nothing is chased afterwards.
    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    const rows = getUndeliveredMessages().filter((m) => m.kind === 'chat');
    expect(rows.map((r) => r.in_reply_to)).toEqual(['u1', 'u2']);
    expect(rows.map((r) => r.thread_id)).toEqual([null, 'thread-2']);
  });

  it('keeps a correction to the requests that went dry at its own result', async () => {
    // Q1 is dry and corrected. Q2 arrives while the correction is queued. The
    // correction's result answers Q1 only: Q2's prompt has not run yet, so it
    // is neither settled nor chased there — its own result judges it.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'dry for question one' };
      insertChat('m2', 'second question', { threadId: 'thread-2' });
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('second question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      // The correction's result: Q1 gets its placeholder. Q2 untouched.
      yield { type: 'result', text: 'still dry for question one' };
      // Q2's own turn answers it.
      writeMessageOut({
        id: 'tool-1',
        in_reply_to: 'm2',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answer two' }),
      });
      yield { type: 'result', text: 'sent two' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    const rows = getUndeliveredMessages().filter((m) => m.kind === 'chat');
    expect(rows.map((r) => JSON.parse(r.content).text)).toEqual([TOOLS_ONLY_PLACEHOLDER, 'answer two']);
    expect(rows.map((r) => r.in_reply_to)).toEqual(['m1', 'm2']);
  });

  it('settles each question by the turn that answered it, then stops chasing', async () => {
    // Q1's correction sends; Q2, pushed behind it, has not run yet, so that
    // reply is Q1's alone. Q2's own turn answers Q2. Nothing is owed after
    // that, so a further dry result is not chased.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: 'dry one' };
      insertChat('m2', 'another question');
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('another question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      writeMessageOut({
        id: 'tool-1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answer one' }),
      });
      yield { type: 'result', text: 'sent it' };
      writeMessageOut({
        id: 'tool-2',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'answer two' }),
      });
      yield { type: 'result', text: 'sent two' };
      yield { type: 'result', text: 'idle chatter' };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(pushes.filter((p) => p.includes('Nothing from your last turn'))).toHaveLength(1);
    expect(userTexts()).toEqual(['answer one', 'answer two']);
  });
});

// ── Provider errors ──

describe('provider errors', () => {
  it('masks a provider exception thrown before any result event', async () => {
    const diagnostic = 'OpenCode prompt failed: upstream secret sk-live-abc';
    insertChat('m1', 'make a request');
    const controller = new AbortController();
    const provider: AgentProvider = {
      query: () => {
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 's1' };
          throw new Error(diagnostic);
        }
        return { push: () => {}, end: () => {}, events: events(), abort: () => {} };
      },
      isSessionInvalid: () => false,
    };
    setTimeout(() => controller.abort(), 50);

    await runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/workspace/agent',
      deliveryMode: 'tools-only',
      signal: controller.signal,
    });

    expect(userTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE]);
    expect(userTexts()[0]).not.toContain('sk-live-abc');
  });

  it('does not add a thrown-provider notice after the tool already answered', async () => {
    insertChat('m1', 'make a request');
    const controller = new AbortController();
    const provider: AgentProvider = {
      query: () => {
        async function* events(): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 's1' };
          await writeMessageOut({
            id: 'tool-1',
            in_reply_to: 'm1',
            kind: 'chat',
            platform_id: 'chan-1',
            channel_type: 'discord',
            content: JSON.stringify({ text: 'already answered' }),
          });
          throw new Error('provider failed after the send');
        }
        return { push: () => {}, end: () => {}, events: events(), abort: () => {} };
      },
      isSessionInvalid: () => false,
    };
    setTimeout(() => controller.abort(), 50);

    await runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/workspace/agent',
      deliveryMode: 'tools-only',
      signal: controller.signal,
    });

    expect(userTexts()).toEqual(['already answered']);
  });

  it('never forwards the provider error text, and says something instead', async () => {
    const leaky = 'Upstream said: <internal>key sk-live-abc</internal> <call:retry()</call:retry>';
    const { query, pushes } = makeQuery({
      text: leaky,
      isError: true,
      error: 'Provider says to paste a credential into chat.',
    });

    await runToolsOnly(query);

    expect(userTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE]);
    expect(userTexts()[0]).not.toContain('sk-live-abc');
    expect(userTexts()[0]).not.toContain('<internal>');
    expect(userTexts()[0]).not.toContain('credential');
    // An error result must not re-hammer the failing turn.
    expect(pushes).toHaveLength(0);
  });

  it.each([
    ['null text', null],
    ['empty text', ''],
  ])('routes a %s error result through the notice, never the dry-turn judge', async (_label, text) => {
    // The SDK surfaces a failed turn as a result whose text may be absent
    // entirely. Such a turn must not be nudged (that re-hammers a failing
    // provider) and must not answer with the wrong message.
    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      yield { type: 'result', text: text as string | null, isError: true };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await runToolsOnly(query);

    expect(pushes).toHaveLength(0);
    expect(userTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE]);
  });

  it('reaches a real user even when an agent wake sits at the head of the queue', async () => {
    // A targetless entry in front must not swallow the notification. The
    // question arrives while the wake's turn is live, so it is queued behind
    // it: the wake's error is the wake's alone (no endpoint, no notice), and
    // the question is noticed at its own failing result.
    insertChat('a1', 'host notice', { channelType: 'agent' });
    const routing = extractRouting(getPendingMessages());
    expect(routing.agentWake).toBe(true);

    const pushes: string[] = [];
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      insertChat('u1', 'a real question', { threadId: 'thread-9' });
      const deadline = Date.now() + 5000;
      while (!pushes.some((p) => p.includes('a real question')) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      yield { type: 'result', text: null, isError: true };
      yield { type: 'result', text: null, isError: true };
    }
    const query: AgentQuery = {
      push: (m: string) => {
        pushes.push(m);
      },
      end: () => {},
      events: events(),
      abort: () => {},
    };

    await processQuery(query, routing, ['a1'], 'mock', undefined, 'prompt', undefined, 'tools-only');

    const rows = getUndeliveredMessages().filter((m) => m.kind === 'chat');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].content).text).toBe(TOOLS_ONLY_ERROR_NOTICE);
    expect(rows[0].in_reply_to).toBe('u1');
    expect(rows[0].thread_id).toBe('thread-9');
  });

  it('leaves no stale entry behind to draw a placeholder afterwards', async () => {
    // Two questions outstanding, then the turn errors. Popping only one would
    // leave the other judged against a baseline already past the notice,
    // producing a placeholder over a question the notice already answered.
    insertChat('u1', 'first question');
    insertChat('u2', 'second question');
    const routing = extractRouting(getPendingMessages());

    const { query, pushes } = makeQuery({ text: 'boom', isError: true }, 'dry after the error', 'still dry');
    await processQuery(query, routing, ['u1', 'u2'], 'mock', undefined, 'prompt', undefined, 'tools-only');

    expect(userTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE]);
    expect(pushes).toHaveLength(0);
  });

  it('does not double up when the turn had already delivered', async () => {
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 's1' };
      writeMessageOut({
        id: 'tool-1',
        in_reply_to: 'm1',
        kind: 'chat',
        platform_id: 'chan-1',
        channel_type: 'discord',
        content: JSON.stringify({ text: 'here you go' }),
      });
      yield { type: 'result', text: 'then everything fell over', isError: true };
    }
    const query: AgentQuery = { push: () => {}, end: () => {}, events: events(), abort: () => {} };

    await runToolsOnly(query);

    expect(userTexts()).toEqual(['here you go']);
  });

  it('stays quiet when nobody was waiting', async () => {
    const { query } = makeQuery({ text: 'background job blew up', isError: true });

    await runToolsOnly(query, UNPROMPTED_ROUTING);

    expect(userTexts()).toEqual([]);
  });

  it('does not then also send the placeholder for the same turn', async () => {
    const { query, pushes } = makeQuery({ text: 'boom', isError: true }, 'and nothing after that');

    await runToolsOnly(query);

    expect(userTexts()).toEqual([TOOLS_ONLY_ERROR_NOTICE]);
    expect(pushes).toHaveLength(0);
  });

  it('delivers only the provider-owned error under the envelope default', async () => {
    const budget = 'Spending limit reached. Add your own key at https://example.com/keys';
    const { query } = makeQuery({ text: 'raw provider diagnostic', isError: true, error: budget });

    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);

    expect(userTexts()).toEqual([budget]);
  });
});

// ── The envelope contract is untouched ──

describe('envelope mode is the default and is unchanged', () => {
  it('delivers a final-text envelope when no mode is passed', async () => {
    const { query, pushes } = makeQuery('<message to="discord-test">The build is green.</message>');

    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);

    expect(userTexts()).toEqual(['The build is green.']);
    expect(pushes).toHaveLength(0);
  });

  it('still strips leaked thinking out of a delivered envelope body', async () => {
    const { query } = makeQuery('<message to="discord-test"><internal>keep it short</internal>All set.</message>');

    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);

    expect(userTexts()).toEqual(['All set.']);
  });

  it('nudges an unwrapped turn once and then stays silent — no raw-text fallback', async () => {
    // The never-silent guarantee belongs to tools-only mode. Envelope mode
    // nudges once and leaves an unwrapped turn in the scratchpad, which is
    // what every existing group is on and what main does.
    const { query, pushes } = makeQuery('forgot to wrap', 'forgot again');

    await processQuery(query, CHAT_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);

    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(1);
    expect(userTexts()).toEqual([]);
  });

  it('ignores the reply-target machinery entirely — an agent wake nudges and sends nothing', async () => {
    const { query, pushes } = makeQuery('forgot to wrap', 'forgot again');

    await processQuery(query, AGENT_WAKE_ROUTING, ['m1'], 'mock', undefined, 'prompt', undefined);

    expect(pushes.filter((p) => p.includes('was not delivered'))).toHaveLength(1);
    expect(userTexts()).toEqual([]);
  });

  it('writes nothing outbound for a persistently unwrapped turn, whatever the reply targets say', async () => {
    const { query } = makeQuery('forgot to wrap', 'forgot again');
    const routing: RoutingContext = {
      ...CHAT_ROUTING,
      threadId: 'batch-thread',
      replyTargets: [{ platformId: 'other', channelType: 'slack', threadId: 'other-thread', inReplyTo: 'zz' }],
    };

    await processQuery(query, routing, ['m1'], 'mock', undefined, 'prompt', undefined);

    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });
});

// ── Dispatch-level behavior ──

describe('dispatchResultText', () => {
  it('reports tools-only envelopes as inert without an unwrapped-text warning', async () => {
    const result = await dispatchResultText('<message to="discord-test">hi</message>', CHAT_ROUTING, 'tools-only');

    expect(result.sent).toBe(0);
    expect(result.hasUnwrapped).toBe(false);
    expect(result.taskBlocks).toEqual([{ to: 'discord-test', body: 'hi', unknownDestination: false }]);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('flags an envelope addressed to a name that does not resolve', async () => {
    const result = await dispatchResultText('<message to="nope">hi</message>', CHAT_ROUTING, 'tools-only');

    expect(result.taskBlocks[0].unknownDestination).toBe(true);
  });

  it('never reports bare tools-only text as unwrapped', async () => {
    const result = await dispatchResultText('just thinking out loud', CHAT_ROUTING, 'tools-only');

    expect(result.hasUnwrapped).toBe(false);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('delivers the same envelope under the default mode', async () => {
    const result = await dispatchResultText('<message to="discord-test">hi</message>', CHAT_ROUTING);

    expect(result.sent).toBe(1);
    expect(userTexts()).toEqual(['hi']);
  });
});

// ── Correction wording ──

describe('correction wording', () => {
  it('recognizes the markup shapes an agent writes instead of calling a tool', () => {
    expect(looksLikeToolMarkup('<tool_call>{"name":"send_message"}</tool_call>')).toBe(true);
    expect(looksLikeToolMarkup('<call:bash(command="ls")</call:bash>')).toBe(true);
    expect(looksLikeToolMarkup('<invoke name="send_message">')).toBe(true);
    expect(looksLikeToolMarkup('<function_call>{}</function_call>')).toBe(true);
    expect(looksLikeToolMarkup('<x-y mcp__nanoclaw__send_message />')).toBe(true);
    expect(looksLikeToolMarkup('I will call send_message next.')).toBe(false);
    expect(looksLikeToolMarkup('<message to="discord-test">hi</message>')).toBe(false);
  });

  it('counts the inert blocks it saw', () => {
    const one = buildToolsOnlyNudge('', [{ to: 'a', body: 'x' }], 'a');
    const two = buildToolsOnlyNudge(
      '',
      [
        { to: 'a', body: 'x' },
        { to: 'b', body: 'y' },
      ],
      'a, b',
    );

    expect(one).toContain('a <message');
    expect(two).toContain('2 <message');
  });

  it('escapes destination names into the prompt', () => {
    expect(buildToolsOnlyNudge('', [], 'ops & "friends"')).toContain('ops &amp; &quot;friends&quot;');
  });

  it('says so plainly when the group has no destinations at all', () => {
    const nudge = buildToolsOnlyNudge('nothing sent', [], '');

    expect(nudge).toContain('(none configured)');
    expect(nudge).not.toContain('destinations: .');
  });
});

// ── Prompt contract, both places ──

describe('prompt contract', () => {
  it('teaches tools-only delivery in the system prompt addendum', () => {
    const prompt = buildSystemPromptAddendum('Casa', { kind: 'chat' }, 'tools-only');

    expect(prompt).toContain('private scratchpad');
    expect(prompt).toContain('send_message');
    expect(prompt).not.toContain('Wrap each delivered message');
  });

  it('still teaches the contract to a group with no destinations wired yet', () => {
    getInboundDb().prepare('DELETE FROM destinations').run();
    const prompt = buildSystemPromptAddendum('Casa', { kind: 'chat' }, 'tools-only');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).toContain('private scratchpad');
    expect(prompt).toContain('send_message');
  });

  it('keeps the envelope wording by default, including with no destinations', () => {
    expect(buildSystemPromptAddendum('Casa')).toContain('Wrap each delivered message');

    getInboundDb().prepare('DELETE FROM destinations').run();
    const empty = buildSystemPromptAddendum('Casa');
    expect(empty).toContain('no configured destinations');
    expect(empty).not.toContain('private scratchpad');
  });

  it('does not re-teach envelopes through the compaction reminder', () => {
    const instructions = buildCompactInstructions(['discord-test'], null, 'tools-only');

    expect(instructions).not.toContain('MUST wrap all responses');
    expect(instructions).toContain('private scratchpad');
    expect(instructions).toContain('`discord-test`');
  });

  it('keeps the envelope reminder by default', () => {
    expect(buildCompactInstructions(['discord-test'], null)).toContain('MUST wrap all responses');
  });

  it('keeps the task-run reminder in either mode', () => {
    for (const mode of ['envelope', 'tools-only'] as const) {
      const instructions = buildCompactInstructions(['discord-test'], 'daily-digest-a1b2', mode);
      expect(instructions).toContain('isolated task run');
      expect(instructions).toContain('tasks/daily-digest-a1b2.md');
    }
  });
});
