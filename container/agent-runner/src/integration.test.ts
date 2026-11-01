import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import {
  getContinuation,
  getContinuationStartedAt,
  setContinuation,
  setContinuationStartedAt,
} from './db/session-state.js';
import { getSessionRouting } from './db/session-routing.js';
import { getAgentMailbox } from './mailbox/index.js';
import { computeRotationDate, evaluateRotation } from './session-rotation.js';
import { TIMEZONE } from './timezone.js';
import { MockProvider } from './providers/mock.js';
import type { ProviderExchange } from './providers/types.js';
import {
  runPollLoop,
  requestGracefulShutdown,
  requestInterruptShutdown,
  _resetShutdownStateForTests,
} from './poll-loop.js';
import { GENERIC_FAILURE_NOTICE } from './formatter.js';

const MOCK_PROVIDER_CONTRACT = {
  textDelivery: 'mid-turn-complete',
  commands: { formatting: 'xml' },
} as const;

beforeEach(() => {
  // Clear any shutdown latch leaked by a prior test whose loop hadn't fully
  // unwound (the abort()+catch pattern leaves runPollLoop running until a DB
  // error breaks it). Without this, a graceful-shutdown test's latch can make
  // the next test's loop exit immediately.
  _resetShutdownStateForTests();
  initTestSessionDb();
  // Seed a destination so output parsing can resolve "discord-test" → routing
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  _resetShutdownStateForTests();
});

function insertMessage(
  id: string,
  content: object,
  opts?: { platformId?: string; channelType?: string; threadId?: string },
) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?, ?, ?, ?)`,
    )
    .run(id, opts?.platformId ?? null, opts?.channelType ?? null, opts?.threadId ?? null, JSON.stringify(content));
}

describe('poll loop integration', () => {
  it('defaults only when the legacy session routing table is absent', () => {
    expect(getSessionRouting()).toEqual({ channel_type: null, platform_id: null, thread_id: null });

    getInboundDb().exec('CREATE VIEW session_routing AS SELECT * FROM missing_routing');
    expect(() => getSessionRouting()).toThrow(/missing_routing/);
  });

  it('should pick up a message, process it, and write a response', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'What is the meaning of life?' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">42</message>');

    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('42');
    expect(out[0].platform_id).toBe('chan-1');
    expect(out[0].channel_type).toBe('discord');
    expect(out[0].in_reply_to).toBe('m1');

    // Input message should be acked (not pending)
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it('keeps a chat turn open when accumulate-only follow-ups arrive before its first result', async () => {
    // Live repro: Fasting 2026-07-13. The addressed chat trigger started a
    // Codex turn, but ambient trigger=0 rows remained pending after the
    // initial context batch. The 500ms follow-up poll called query.end()
    // before Codex emitted its first result, so every host retry exited empty
    // and preserved the same trigger forever.
    insertMessage(
      'm-trigger',
      { sender: 'Alice', text: 'addressed question' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new DelayedResultProvider('<message to="discord-test">finished</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => provider.queries === 1, 1000);
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('m-ambient', 'chat', datetime('now'), 'pending', 0, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'Bob', text: 'ambient chatter' }));

    // Give the in-query follow-up poll enough time to observe m-ambient.
    await sleep(800);
    expect(provider.ends).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);

    provider.releaseResult();
    await waitFor(() => getUndeliveredMessages().length === 1, 1500);

    expect(JSON.parse(getUndeliveredMessages()[0].content).text).toBe('finished');
    expect(getPendingMessages().map((row) => row.id)).toEqual(['m-ambient']);

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('keeps acknowledged chat work alive when reflection arrives before its first result', async () => {
    // Live repro: New York Crew 2026-08-29. The agent acknowledged Teddy's
    // forecast request through send_message; that outbound immediately
    // scheduled a trigger=1 reflection task. The task-wake deferral called
    // query.end() before Codex's result, aborting the promised forecast work.
    // Teddy retried three hours later and the same sequence repeated.
    insertMessage(
      'm-forecast',
      { sender: 'Teddy', text: 'Check the Saturday rain forecast and adjust our itinerary' },
      { platformId: 'chan-1', channelType: 'whatsapp' },
    );

    const provider = new DelayedResultProvider('<message to="discord-test">rain-proof schedule</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000, 'codex');

    await waitFor(() => provider.queries === 1, 1000);
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, series_id, platform_id, channel_type, content)
         VALUES ('t-reflection', 'task', datetime('now'), 'pending', 1, 'reflection-test', 'chan-1', 'whatsapp', ?)`,
      )
      .run(JSON.stringify({ prompt: 'INTERNAL MAINTENANCE TASK — DO NOT MESSAGE THE USER.' }));

    await sleep(800);
    expect(provider.ends).toBe(0);
    expect(getUndeliveredMessages()).toHaveLength(0);

    provider.releaseResult();
    await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);
    expect(JSON.parse(getUndeliveredMessages().find((row) => row.kind === 'chat')!.content).text).toBe(
      'rain-proof schedule',
    );

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('delivers a Claude result that absorbed a same-sender follow-up', async () => {
    // Live repro: Danielle DM 2026-08-25. Claude absorbed "make me a meal
    // plan" into the pending result and generated the plan, but the Codex-
    // motivated supersede guard discarded it and Claude emitted no later
    // result for that push.
    insertMessage(
      'm-handout',
      { sender: 'Danielle', text: 'Here is the dietician handout' },
      { platformId: 'chan-1', channelType: 'telegram' },
    );

    const provider = new MergedFollowUpProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000, 'claude');

    await waitFor(() => provider.queries === 1, 1000);
    insertMessage(
      'm-plan',
      { sender: 'Danielle', text: 'based on this, can you make me a meal plan?' },
      { platformId: 'chan-1', channelType: 'telegram' },
    );

    await waitFor(() => provider.pushes === 1, 1500);
    provider.releaseResult();
    await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);

    const chat = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(chat).toHaveLength(1);
    expect(JSON.parse(chat[0].content).text).toBe('3-day meal plan');
    expect(provider.pushedPrompts[0]).not.toContain('was not delivered');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('suppresses a stale result when same-sender details arrive before completion', async () => {
    // Live repro: Nook Catering 2026-08-20. Janyce sent "create labels for
    // the following order", then the order four seconds later. Codex queues
    // push() as a second turn, so its first turn replied "details missing"
    // even though the order was already waiting for the next turn.
    insertMessage(
      'm-intro',
      { sender: 'Janyce', text: 'create labels for the following order' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new SupersededResultProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000, 'codex');

    await waitFor(() => provider.queries === 1, 1000);
    insertMessage(
      'm-details',
      { sender: 'Janyce', text: 'Maple Walnut Chicken, Glass Noodle, Mango Slaw' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    await waitFor(() => provider.pushes === 1, 1500);
    provider.releaseResults();
    await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);

    const chat = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(chat).toHaveLength(1);
    expect(JSON.parse(chat[0].content).text).toBe('labels created from the order details');
    expect(chat[0].in_reply_to).toBe('m-details');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  // Tico WhatsApp 2026-10-31: 8:41 request, the mid-turn ack asked which
  // card, 8:44 "Cobalt" arrived mid-run, and the run's 8:45 reply re-asked.
  const ticoRequest = { sender: 'Teddy', text: 'Book the 10:30 tee time for Saturday' };
  const ticoAnswer = { sender: 'Teddy', text: 'Cobalt' };
  const staleReask = '<message to="discord-test">Which card should I use for the deposit?</message>';
  const currentReply = '<message to="discord-test">Booked Saturday 10:30 on your Cobalt card.</message>';

  it('withholds a Pi reply drafted before a chat message queued behind it (no 8:45 re-ask)', async () => {
    insertMessage('m-0841', ticoRequest, { platformId: 'chan-1', channelType: 'whatsapp' });
    const provider = new SupersededResultProvider(
      staleReask,
      (prompt) => (prompt.includes('was not delivered') && prompt.includes('Cobalt') ? currentReply : staleReask),
      () => 1,
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000, 'pi_rpc');
    try {
      await waitFor(() => provider.queries === 1, 1000);
      insertMessage('m-0844', ticoAnswer, { platformId: 'chan-1', channelType: 'whatsapp' });
      await waitFor(() => provider.pushes === 1, 1500);
      expect(provider.pushedPrompts[0]).toContain('was not delivered');
      provider.releaseResults();
      await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);
      await sleep(100);
      const rows = getUndeliveredMessages().filter((row) => row.kind === 'chat');
      expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['Booked Saturday 10:30 on your Cobalt card.']);
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  it('delivers the Pi reply a steered chat message was folded into, once', async () => {
    insertMessage('m-0841', ticoRequest, { platformId: 'chan-1', channelType: 'whatsapp' });
    const provider = new SupersededResultProvider(
      currentReply,
      () => '<internal>silent turn</internal>',
      () => 0,
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000, 'pi_rpc');
    try {
      await waitFor(() => provider.queries === 1, 1000);
      insertMessage('m-0844', ticoAnswer, { platformId: 'chan-1', channelType: 'whatsapp' });
      await waitFor(() => provider.pushes === 1, 1500);
      expect(provider.pushedPrompts[0]).not.toContain('was not delivered');
      provider.releaseResults();
      await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);
      await sleep(100);
      const rows = getUndeliveredMessages().filter((row) => row.kind === 'chat');
      expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['Booked Saturday 10:30 on your Cobalt card.']);
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  it('tells a superseding Telegram follow-up to re-emit the withheld multi-block answer, not refer to it as delivered', async () => {
    // Teddy Telegram 2026-09-08: #996 supplied a sheet; #998 requested Google
    // while the analysis was running. Both result blocks were suppressed, but
    // Codex retained them in its transcript and replied "the analysis above".
    getInboundDb().exec("UPDATE destinations SET channel_type='telegram', platform_id='telegram:123'");
    insertMessage(
      'm-sheet',
      { sender: 'Teddy', text: 'Analyse this rental spreadsheet' },
      {
        platformId: 'telegram:123',
        channelType: 'telegram',
      },
    );
    const blocks =
      '<message to="discord-test">Property analysis</message>\n' +
      '<message to="discord-test">Portfolio analysis</message>';
    const provider = new SupersededResultProvider(blocks, (prompt) =>
      prompt.includes('was not delivered') && prompt.includes('self-contained')
        ? blocks
        : '<message to="discord-test">The analysis above comes from Google.</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000, 'codex');
    try {
      await waitFor(() => provider.queries === 1, 1000);
      insertMessage(
        'm-google',
        { sender: 'Teddy', text: 'Use my Google Drive integration' },
        {
          platformId: 'telegram:123',
          channelType: 'telegram',
        },
      );
      await waitFor(() => provider.pushes === 1, 1500);
      const prompt = provider.pushedPrompts[0];
      expect(prompt).toContain('was not delivered');
      expect(prompt).toContain('Use my Google Drive integration');
      expect(prompt).toContain('self-contained');
      expect(prompt).toContain('Do not repeat completed tool actions');
      provider.releaseResults();
      await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);
      const rows = getUndeliveredMessages().filter((row) => row.kind === 'chat');
      expect(rows.map((row) => JSON.parse(row.content).text)).toEqual(['Property analysis', 'Portfolio analysis']);
      expect(rows.every((row) => row.channel_type === 'telegram' && row.in_reply_to === 'm-google')).toBe(true);
      // Outbox persistence is not a platform receipt; never call this delivered.
      expect(getInboundDb().query('SELECT * FROM delivered').all()).toEqual([]);
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  it('does not claim a completed Codex answer was withheld when the next chat arrives afterward', async () => {
    insertMessage(
      'm-first',
      { sender: 'Teddy', text: 'First request' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return `<message to="discord-test">Answer ${prompts.length}</message>`;
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000, 'codex');
    try {
      await waitFor(() => getUndeliveredMessages().length === 1, 1000);
      insertMessage(
        'm-next',
        { sender: 'Teddy', text: 'Next request' },
        { platformId: 'chan-1', channelType: 'discord' },
      );
      await waitFor(() => getUndeliveredMessages().length === 2, 1500);
      expect(prompts).toHaveLength(2);
      expect(prompts[1]).toContain('Next request');
      expect(prompts[1]).not.toContain('was not delivered');
    } finally {
      controller.abort();
      await loopPromise.catch(() => {});
    }
  });

  it('keeps a wrapping retry open when accumulate-only chat arrives before the retry result', async () => {
    // Live repro: AI Friends 2026-07-18 recovery. The first result contained
    // a message block with an invalid reply reference, so dispatch dropped it
    // and pushed the one allowed wrapping retry. Ambient trigger=0 chat then
    // hit the accumulate gate; resultIndex was already >0 from the dropped
    // first result, so query.end() killed the retry before it could deliver.
    insertMessage(
      'm-wrap-trigger',
      { sender: 'Teddy', text: '@Optimus answer this' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new DelayedFollowUpProvider(
      'unwrapped first answer',
      '<message to="discord-test">wrapped retry answer</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => provider.pushes === 1, 1500);
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('m-wrap-ambient', 'chat', datetime('now'), 'pending', 0, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'Bob', text: 'ambient chatter' }));

    await sleep(800);
    expect(provider.ends).toBe(0);
    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);

    provider.releaseFollowUp();
    await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);
    const delivered = getUndeliveredMessages().find((row) => row.kind === 'chat');
    expect(JSON.parse(delivered!.content).text).toBe('wrapped retry answer');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('should process multiple messages in a batch', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'Hello' });
    insertMessage('m2', { sender: 'Bob', text: 'World' });

    const provider = new MockProvider({}, () => '<message to="discord-test">Got both messages</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Got both messages');

    await loopPromise.catch(() => {});
  });

  it('should resolve thread_id per-destination, not from global routing', async () => {
    // Seed a second destination
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    // Insert messages from each destination with distinct thread IDs
    insertMessage(
      'm-discord',
      { sender: 'Alice', text: 'from discord' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread-1' },
    );
    insertMessage(
      'm-slack',
      { sender: 'Bob', text: 'from slack' },
      { platformId: 'chan-2', channelType: 'slack', threadId: 'slack-thread-99' },
    );

    // Agent replies to both destinations
    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">reply-d</message><message to="slack-test">reply-s</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    const discordOut = out.find((m) => m.platform_id === 'chan-1');
    const slackOut = out.find((m) => m.platform_id === 'chan-2');

    expect(discordOut).toBeDefined();
    expect(discordOut!.thread_id).toBe('discord-thread-1');
    expect(discordOut!.in_reply_to).toBe('m-discord');

    expect(slackOut).toBeDefined();
    expect(slackOut!.thread_id).toBe('slack-thread-99');
    expect(slackOut!.in_reply_to).toBe('m-slack');

    await loopPromise.catch(() => {});
  });

  it('bare text is suppressed and retried, never delivered as degraded chat', async () => {
    // Bare text outside <message>/<internal> is ambiguous scratchpad. The
    // runner should nudge a retry, but must not leak it to the channel.
    insertMessage('m1', { sender: 'Alice', text: 'hello' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider({}, () => 'I am thinking about this...');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);
    for (const row of out) {
      expect(row.kind).toBe('system');
      expect(JSON.parse(row.content)).toEqual({
        action: 'silent_turn_complete',
      });
      expect(row.platform_id).toBeNull();
    }

    await loopPromise.catch(() => {});
  });

  it('directly addressed turn gets a scoped fallback when the wrapping retry is exhausted', async () => {
    // Live repro: the-vibes 2026-07-14. Mladen's follow-up was pushed into
    // the warm turn; the model returned scratchpad twice (original + wrapping
    // retry), and the runner completed the input with no visible response.
    insertMessage(
      'm-addressed',
      { sender: 'Mladen', text: '@optimus add it to the Tico calendar', isMention: true },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new MockProvider(
      {},
      () => '<internal>Awaiting a confirmation that does not exist.</internal>\ntrace',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2500);

    await waitFor(
      () =>
        getUndeliveredMessages().some(
          (row) =>
            JSON.parse(row.content).text ===
            "I couldn't complete that request or produce a reliable reply. Please try again.",
        ),
      2000,
    );
    controller.abort();

    const chat = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(chat).toHaveLength(1);
    expect(chat[0].platform_id).toBe('chan-1');
    expect(chat[0].in_reply_to).toBe('m-addressed');
    expect(JSON.parse(chat[0].content).text).toBe(
      "I couldn't complete that request or produce a reliable reply. Please try again.",
    );

    await loopPromise.catch(() => {});
  });

  it('escalation system wake answered internal-only completes silently without the failure fallback', async () => {
    // Nicole Telegram DM, 2026-10-22: the request was already answered, so the
    // resume wake was correctly answered with only a private note.
    insertMessage(
      'sys-escresume-autoesc-test',
      {
        sender: 'system',
        senderId: 'system',
        senderName: 'system',
        text: '[Auto-escalation follow-up] retry the earlier request',
        isMention: true,
        source: 'auto_escalation_resume',
      },
      { platformId: 'chan-1', channelType: 'telegram' },
    );

    const provider = new MockProvider(
      {},
      () => '<internal>Already answered earlier; no new request or user-facing update needed.</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(
      () =>
        getUndeliveredMessages().some(
          (row) => row.kind === 'system' && JSON.parse(row.content).action === 'silent_turn_complete',
        ),
      1500,
    );
    controller.abort();

    expect(getUndeliveredMessages().filter((row) => row.kind === 'chat')).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  it.each([
    ['empty-string', ''],
    ['null', null],
  ] as const)('directly addressed %s result gets a scoped fallback', async (caseName, resultText) => {
    const messageId = `m-${caseName}-addressed`;
    insertMessage(
      messageId,
      { sender: 'Alice', text: '@optimus answer me', isMention: true },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new MockProvider({}, () => resultText);
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().some((row) => row.kind === 'chat'), 1500);
    controller.abort();

    const chat = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(chat).toHaveLength(1);
    expect(chat[0].platform_id).toBe('chan-1');
    expect(chat[0].in_reply_to).toBe(messageId);
    expect(JSON.parse(chat[0].content).text).toBe(
      "I couldn't complete that request or produce a reliable reply. Please try again.",
    );

    await loopPromise.catch(() => {});
  });

  it('does not retry or send a false fallback after a tool-delivered addressed reply', async () => {
    insertMessage(
      'm-tool-addressed',
      { sender: 'Alice', text: '@optimus send it', isMention: true },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    let calls = 0;
    const provider = new MockProvider({}, () => {
      calls++;
      if (calls === 1) {
        getOutboundDb()
          .prepare(
            `INSERT INTO messages_out
               (id, seq, in_reply_to, timestamp, kind, platform_id, channel_type, thread_id, content)
             VALUES (?, 3, ?, ?, 'chat', 'chan-1', 'discord', NULL, ?)`,
          )
          .run(
            'tool-delivery',
            'm-tool-addressed',
            new Date().toISOString(),
            JSON.stringify({ text: 'Delivered through send_message.' }),
          );
      }
      // Explicitly private bookkeeping needs no retry; bare prose after a
      // tool send now gets upstream's informed recovery instead.
      return '<internal>Done. trace</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => calls === 1, 1000);
    await sleep(150);
    controller.abort();

    const chat = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(calls).toBe(1);
    expect(chat).toHaveLength(1);
    expect(chat[0].id).toBe('tool-delivery');
    expect(JSON.parse(chat[0].content).text).toBe('Delivered through send_message.');

    await loopPromise.catch(() => {});
  });

  it('unknown destination is dropped, valid destination is sent', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    let turns = 0;
    const provider = new MockProvider({}, () => {
      turns++;
      return '<message to="nonexistent">dropped</message><message to="discord-test">delivered</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait for the nudged retry to be answered too.
    await waitFor(() => turns >= 2, 2000);
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await loopPromise.catch(() => {});

    // Only the valid destination gets output. The dropped block is nudged and
    // this mock answers the retry identically: the repeat is not sent again.
    const out = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('delivered');
    expect(out[0].platform_id).toBe('chan-1');
  });

  it('multiple <message> blocks each produce an outbound message', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-test', 'Slack Test', 'channel', 'slack', 'chan-2', NULL)`,
      )
      .run();

    insertMessage('m1', { sender: 'Alice', text: 'broadcast' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () => '<message to="discord-test">for discord</message><message to="slack-test">for slack</message>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(2);
    const discord = out.find((m) => m.platform_id === 'chan-1');
    const slack = out.find((m) => m.platform_id === 'chan-2');
    expect(discord).toBeDefined();
    expect(JSON.parse(discord!.content).text).toBe('for discord');
    expect(slack).toBeDefined();
    expect(JSON.parse(slack!.content).text).toBe('for slack');

    await loopPromise.catch(() => {});
  });

  it('sends null thread_id when no prior inbound from destination', async () => {
    // Seed a second destination that has NO inbound messages
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('slack-new', 'Slack New', 'channel', 'slack', 'chan-new', NULL)`,
      )
      .run();

    // Only insert a message from discord — slack-new has never sent anything
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'tell slack' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'discord-thread' },
    );

    const provider = new MockProvider({}, () => '<message to="slack-new">hello slack</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].platform_id).toBe('chan-new');
    expect(out[0].thread_id).toBeNull();

    await loopPromise.catch(() => {});
  });

  it('resolves most recent thread_id when destination has multiple inbound messages', async () => {
    // Two messages from same destination, different threads
    insertMessage(
      'm-old',
      { sender: 'Alice', text: 'old' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-old' },
    );
    insertMessage(
      'm-new',
      { sender: 'Alice', text: 'new' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-new' },
    );

    const provider = new MockProvider({}, () => '<message to="discord-test">reply</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(out[0].thread_id).toBe('thread-new');
    expect(out[0].in_reply_to).toBe('m-new');

    await loopPromise.catch(() => {});
  });

  it('should process messages arriving after loop starts', async () => {
    const provider = new MockProvider({}, () => '<message to="discord-test">Processed</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // Insert message after loop has started
    await sleep(200);
    insertMessage('m-late', { sender: 'Charlie', text: 'Late arrival' });

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBeGreaterThanOrEqual(1);

    await loopPromise.catch(() => {});
  });

  it('internal tags between message blocks are stripped from scratchpad', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'hi' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new MockProvider(
      {},
      () =>
        '<internal>thinking about this...</internal><message to="discord-test">answer</message><internal>done thinking</internal>',
    );
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('answer');

    await loopPromise.catch(() => {});
  });

  it('mixed task + chat batch: task isolated first, chat handled separately, both correctly routed', async () => {
    // A scheduled task and a chat row land in the same channel session
    // with the same routing. Pre-2026-05-16 these folded into ONE
    // provider turn (asserted here as "exactly 1 outbound"). That fold
    // is the AI-Friends leak bug — a silent maintenance task must never
    // share a turn with chat. Correct behavior now: the task runs in
    // its own isolated turn, the chat is deferred and processed as its
    // own subsequent turn. Both still produce a correctly-routed
    // outbound; they're just no longer conflated into one reply.
    insertMessage('m-chat', { sender: 'Alice', text: 'check this' }, { platformId: 'chan-1', channelType: 'discord' });
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('t-task', 'task', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'daily check' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">done</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    // Wait for BOTH to be handled as separate turns (task isolated,
    // then the deferred chat re-processed on a later poll).
    await waitFor(() => getUndeliveredMessages().filter((row) => row.kind === 'chat').length >= 2, 2000);
    controller.abort();

    const out = getUndeliveredMessages().filter((row) => row.kind === 'chat');
    // Each turn produced its own outbound — no fold, no drop.
    expect(out.length).toBeGreaterThanOrEqual(2);
    // Every chat outbound carries the correct origin routing. Control rows
    // intentionally have no platform routing and are excluded above.
    expect(out.every((o) => o.platform_id === 'chan-1')).toBe(true);
    // The task row was consumed (not left pending after its isolated turn).
    const pendingTask = getPendingMessages().find((m) => m.id === 't-task');
    expect(pendingTask).toBeUndefined();

    await loopPromise.catch(() => {});
  });

  it('task-only wake leaves accumulated trigger=0 chat pending', async () => {
    // Repro: shit-talk 2026-05-11 04:01 — accumulated trigger=0 chat from
    // the previous evening got pulled into the prompt when the daily
    // silent-maintenance task fired, and the agent posted a chat reply
    // despite the task's explicit "do NOT send any messages" instruction.
    // The fix: drop trigger=0 chat rows from the batch when the only
    // trigger=1 row(s) are tasks. The chat rows stay pending for the
    // next real user-triggered wake.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('m-accum', 'chat', datetime('now', '-1 hour'), 'pending', 0, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'mackchiu', text: 'Not at hole in ones' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('t-silent', 'task', datetime('now'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'silent maintenance — do not send messages' }));

    let capturedPrompt = '';
    const provider = new MockProvider({}, (prompt: string) => {
      capturedPrompt = prompt;
      // Agent obeys: no <message to=...> blocks, no outbound.
      return 'noted';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1500);
    controller.abort();

    // The task row should have been processed; the accumulated chat should still be pending.
    const stillPending = getPendingMessages();
    const accumStill = stillPending.find((m) => m.id === 'm-accum');
    expect(accumStill).toBeDefined();
    expect(accumStill?.trigger).toBe(0);

    // The agent's prompt must NOT contain mackchiu's accumulated chat content.
    expect(capturedPrompt).not.toContain('Not at hole in ones');
    expect(capturedPrompt).not.toContain('mackchiu');

    await loopPromise.catch(() => {});
  });

  it('task wake isolates trigger=1 sticky-engage chat (AI-Friends 2026-05-16 leak)', async () => {
    // Repro: 2026-05-16 13:22 — the degenerate agent's silent dream task
    // (trigger=1, kind=task) was manually fired via the dashboard. It
    // co-arrived with AI-Friends mention-sticky chat that the router had
    // marked trigger=1. The OLD isolation only fired when EVERY trigger=1
    // row was a task (`taskOnlyWake`), so the trigger=1 sticky chat made
    // it false, isolation was skipped, the conversation folded into the
    // silent dream turn, and the agent reply-pilled the dream-cycle
    // summary onto "Lame…" in AI Friends. The fix isolates on ANY task
    // trigger and defers chat regardless of its trigger flag.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('m-sticky', 'chat-sdk', datetime('now', '-5 minutes'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'someone', text: 'Lame…' }));
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('t-dream', 'task', datetime('now'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'silent maintenance — do NOT send any messages to the chat' }));

    // Accumulate EVERY prompt the provider saw across all turns. The fix
    // is correct iff no single prompt contains both the silent-task
    // instruction and the sticky chat — i.e. they were never folded into
    // one provider turn. The chat may still be answered in its OWN later
    // turn (correct: deferring ≠ dropping), so asserting "still pending"
    // would be wrong; asserting "never co-folded" is the real invariant.
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt: string) => {
      prompts.push(prompt);
      return '<internal>noted</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await sleep(1500);
    controller.abort();

    // The silent dream task ran (its prompt reached the provider).
    const taskPrompt = prompts.find((p) => p.includes('silent maintenance'));
    expect(taskPrompt).toBeDefined();
    // …and the sticky "Lame…" chat was NOT folded into that task turn.
    expect(taskPrompt).not.toContain('Lame…');
    // No prompt anywhere co-folded the task with the sticky chat.
    const folded = prompts.find((p) => p.includes('silent maintenance') && p.includes('Lame…'));
    expect(folded).toBeUndefined();

    await loopPromise.catch(() => {});
  });

  it('retryable provider error with no result leaves the task row pending for host retry', async () => {
    // Repro: degenerates dream empty-fire 2026-06-05. codex's MCP-init
    // transport died (`rmcp ... session expired 404 on send initialized
    // notification`) → codex exited 0 before any turn → the driver emitted a
    // retryable `error` event with NO result. The OLD poll-loop logged it and
    // marked the task completed anyway, so the dream silently did nothing and
    // never re-ran. The fix: a retryable-with-no-result failure leaves the
    // row pending so the host re-fires it.
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, content)
         VALUES ('t-dream', 'task', datetime('now'), 'pending', 1, 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ prompt: 'silent maintenance' }));

    const provider = new MockProvider({}, undefined, {
      retryableErrorNoResult:
        'codex exited (0): ERROR rmcp::transport::worker: worker quit with fatal: ' +
        'Client error: streamable HTTP session expired with 404 Not Found',
    });
    const controller = new AbortController();
    await expect(runPollLoopWithTimeout(provider, controller.signal, 2000)).resolves.toBeUndefined();

    // The container tracks task lifecycle via processing_ack in outbound.db
    // (the inbound.db row stays host-owned 'pending'). The invariant: the
    // task must NOT be acked 'completed' — that's the empty-fire bug. The
    // runner must also exit so host-sweep can observe a stopped container,
    // clear the processing claim with backoff, and re-fire the row.
    const ack = getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 't-dream'").get() as
      | { status: string }
      | undefined;
    expect(ack?.status).not.toBe('completed');
    // And it produced no outbound (it genuinely did nothing).
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it.each([
    [false, true],
    [true, true],
    [false, false],
  ])('preserves retryability on CLI kill (result=%s retryEvent=%s)', async (resultSeen, retryEvent) => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, series_id, content)
       VALUES ('t-killed', 'task', datetime('now'), 'pending', 'dream-test', '{"prompt":"maintenance"}')`,
      )
      .run();
    class KilledProvider extends MockProvider {
      override query(input: Parameters<MockProvider['query']>[0]) {
        const query = super.query(input);
        return {
          ...query,
          events: {
            async *[Symbol.asyncIterator]() {
              if (retryEvent) yield { type: 'error' as const, message: 'API retry', retryable: true };
              if (resultSeen) yield { type: 'result' as const, text: '<internal>done</internal>' };
              throw new Error('Claude Code process exited with code 137. stderr: Killed');
            },
          },
        };
      }
    }
    const controller = new AbortController();
    const loop = runPollLoopWithTimeout(new KilledProvider(), controller.signal, 2000);
    if (resultSeen) {
      await waitFor(
        () =>
          (
            getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 't-killed'").get() as {
              status: string;
            }
          )?.status === 'completed',
        1000,
      );
      controller.abort();
    }
    if (resultSeen) await loop.catch(() => {});
    else await expect(loop).resolves.toBeUndefined();
    const ack = getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 't-killed'").get() as {
      status: string;
    };
    expect(ack.status).toBe(resultSeen ? 'completed' : 'processing');
    const fires = getOutboundDb().prepare('SELECT status, error_message FROM task_fires').all() as Array<{
      status: string;
      error_message: string | null;
    }>;
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe(resultSeen ? 'silent' : 'error');
    if (!resultSeen) expect(fires[0].error_message).toContain('Claude Code process exited with code 137');
    expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
  });

  it.each(['API Error: 502 gateway failure', null])(
    'records terminal provider error results as failed fires (%s)',
    async (text) => {
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, series_id, content)
      VALUES ('t-error-result', 'task', datetime('now'), 'pending', 'dream-test', '{"prompt":"maintenance"}')`,
        )
        .run();
      class ErrorResultProvider extends MockProvider {
        override query(input: Parameters<MockProvider['query']>[0]) {
          return {
            ...super.query(input),
            events: {
              async *[Symbol.asyncIterator]() {
                yield { type: 'result' as const, text, isError: true };
              },
            },
          };
        }
      }
      const controller = new AbortController();
      const loop = runPollLoop({
        provider: new ErrorResultProvider(),
        providerName: 'mock',
        cwd: '/tmp',
        signal: controller.signal,
        isDreamRun: true,
      });
      await waitFor(
        () => (getOutboundDb().prepare('SELECT COUNT(*) AS n FROM task_fires').get() as { n: number }).n > 0,
        2000,
      );
      controller.abort();
      await loop.catch(() => {});
      expect(getOutboundDb().prepare('SELECT status, error_message FROM task_fires').get()).toEqual({
        status: 'error',
        error_message: text ?? 'Provider returned an error result',
      });
      expect(getUndeliveredMessages().filter((m) => m.kind === 'chat')).toHaveLength(0);
    },
  );

  it('retryable provider error with no result leaves chat pending without leaking the error to outbound', async () => {
    insertMessage(
      'm-retry-chat',
      { sender: 'Alice', text: 'summarize spending' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new MockProvider({}, undefined, {
      retryableErrorNoResult:
        'codex exited (0): <message to="discord-test">This should not be delivered wrapped or prefixed.</message>',
    });
    const controller = new AbortController();
    await expect(runPollLoopWithTimeout(provider, controller.signal, 2000)).resolves.toBeUndefined();

    const ack = getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 'm-retry-chat'").get() as
      | { status: string }
      | undefined;
    expect(ack?.status).not.toBe('completed');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('SIGTERM mid-turn before any result leaves the row pending and exits the loop', async () => {
    // Repro: Degenerates AI-Friends 2026-06-08. The host idle-timeout reaper
    // SIGTERM'd the container while the codex turn was still in flight (no
    // result yet). The OLD path had no SIGTERM handler, so the process was
    // SIGKILLed mid-turn and the batched messages (incl. Teddy's @mention)
    // were consumed with zero output. The fix: SIGTERM ends the active query
    // cleanly; a turn cut short before any result leaves its rows PENDING for
    // the next container, and the loop exits on its own.
    insertMessage(
      'm-cut',
      { sender: 'Teddy', text: '@bot summarize this' },
      { platformId: 'chan-1', channelType: 'discord', threadId: 'thread-1' },
    );

    // Provider blocks (no result) until end() is called, then closes empty.
    const provider = new MockProvider({}, undefined, { blockUntilEndNoResult: true });

    // The loop runs unbounded; graceful shutdown is what makes it return.
    const loopPromise = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' });

    // Wait until the turn is in flight (row claimed 'processing'), then reap.
    await waitFor(() => {
      const ack = getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 'm-cut'").get() as
        | { status: string }
        | undefined;
      return ack?.status === 'processing';
    }, 2000);

    requestGracefulShutdown();

    // The loop must return on its own (no abort/timeout race needed).
    await Promise.race([
      loopPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('loop did not exit on shutdown')), 2000)),
    ]);

    // The cut-short turn produced nothing and must NOT be marked completed —
    // the next container re-processes it.
    const ack = getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 'm-cut'").get() as
      | { status: string }
      | undefined;
    expect(ack?.status).not.toBe('completed');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('SIGINT (host interrupt) aborts the active query, claims nothing more, leaves input unacked and exits', async () => {
    insertMessage(
      'm-stop',
      { sender: 'Alice', text: '@bot plan the trip' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const provider = new MockProvider({}, undefined, { blockUntilEndNoResult: true });
    const calls: string[] = [];
    const query = provider.query.bind(provider);
    provider.query = (input) => {
      const q = query(input);
      return {
        ...q,
        end: () => {
          calls.push('end');
          q.end();
        },
        abort: () => {
          calls.push('abort');
          q.abort();
        },
      };
    };
    const loopPromise = runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' });
    await waitFor(() => {
      const ack = getOutboundDb().prepare("SELECT status FROM processing_ack WHERE message_id = 'm-stop'").get() as
        | { status: string }
        | undefined;
      return ack?.status === 'processing';
    }, 2000);

    requestInterruptShutdown();
    // Arrives after the interrupt: must not be claimed by this runtime.
    insertMessage(
      'm-after',
      { sender: 'Bob', text: '@bot also golf' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    await Promise.race([
      loopPromise,
      new Promise<void>((_, reject) => setTimeout(() => reject(new Error('loop did not exit on interrupt')), 2000)),
    ]);

    expect(calls[0]).toBe('abort');
    const acks = getOutboundDb()
      .prepare('SELECT message_id, status FROM processing_ack ORDER BY message_id')
      .all() as Array<{
      message_id: string;
      status: string;
    }>;
    expect(acks).toEqual([{ message_id: 'm-stop', status: 'processing' }]);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

// Helper: run poll loop until aborted or timeout
async function runPollLoopWithTimeout(
  provider: MockProvider,
  signal: AbortSignal,
  timeoutMs: number,
  providerName = 'mock',
): Promise<void> {
  return Promise.race([
    runPollLoop({
      provider,
      providerName,
      cwd: '/tmp',
      signal,
    }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await sleep(50);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('poll loop — exchange hook (onExchangeComplete)', () => {
  // A provider that declares the per-exchange hook. The hook call is the
  // wiring under test — these tests go red if the poll-loop seam is severed.
  // What the provider DOES with an exchange (e.g. write markdown into
  // conversations/) ships with the provider, not the runner.
  class HookedMockProvider extends MockProvider {
    readonly exchanges: ProviderExchange[] = [];
    onExchangeComplete(exchange: ProviderExchange): void {
      this.exchanges.push(exchange);
    }
  }

  it('reports each exchange to a provider that declares the hook', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'please archive this' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new HookedMockProvider({}, () => '<message to="discord-test">archived answer</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => provider.exchanges.length > 0, 2000);
    controller.abort();

    expect(provider.exchanges.length).toBe(1);
    const exchange = provider.exchanges[0];
    expect(exchange.prompt).toContain('please archive this');
    expect(exchange.result).toContain('archived answer');
    expect(exchange.continuation).toStartWith('mock-session-');
    expect(exchange.status).toBe('completed');

    await loopPromise.catch(() => {});
  });

  it('does not report the internal wrapping-retry nudge as a user prompt', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'wrap this later' }, { platformId: 'chan-1', channelType: 'discord' });

    let calls = 0;
    const provider = new HookedMockProvider({}, () => {
      calls += 1;
      // First result is unwrapped (triggers the retry nudge), second is wrapped.
      return calls === 1 ? 'unwrapped text' : '<message to="discord-test">wrapped now</message>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    await waitFor(() => provider.exchanges.length >= 2, 3000);
    controller.abort();

    // Both exchanges attribute themselves to the real user prompt, never the nudge.
    for (const exchange of provider.exchanges) {
      expect(exchange.prompt).not.toContain('Your response was not delivered');
      expect(exchange.prompt).toContain('wrap this later');
    }
    expect(provider.exchanges.map((e) => e.status)).toEqual(['undelivered', 'completed']);

    await loopPromise.catch(() => {});
  });

  it('a throwing hook never breaks delivery', async () => {
    insertMessage(
      'm1',
      { sender: 'Alice', text: 'still deliver this' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    class ThrowingHookProvider extends MockProvider {
      onExchangeComplete(): void {
        throw new Error('hook exploded');
      }
    }
    const provider = new ThrowingHookProvider({}, () => '<message to="discord-test">delivered anyway</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out.length).toBe(1);
    expect(out[0].content).toContain('delivered anyway');

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — provider error recovery', () => {
  it('writes a safe error notice to outbound and continues loop on provider throw', async () => {
    insertMessage('m1', { sender: 'Alice', text: 'trigger error' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new ThrowingProvider('permission denied');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(GENERIC_FAILURE_NOTICE);
    expect(out[0].content).not.toContain('permission denied');

    // Input message should be marked completed despite the error
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });

  // B(ii) prototype (Nicole / Sanuki Udon, 2026-10-14): the failed request is
  // carried once into the NEXT user-initiated turn on the same chat, and
  // nothing is sent or retried until that turn arrives.
  it('carries a failed chat request into the next turn on the same route', async () => {
    insertMessage(
      'm1',
      { sender: 'Nicole', text: 'What are top dishes' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const failing = new ThrowingProvider('native_terminal');
    const c1 = new AbortController();
    const loop1 = runPollLoopWithTimeout(failing as unknown as MockProvider, c1.signal, 2000);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    c1.abort();
    await loop1.catch(() => {});
    expect(getUndeliveredMessages()).toHaveLength(1);

    insertMessage(
      'm2',
      { sender: 'Nicole', text: 'What is this tree' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return `<message to="discord-test">Answer ${prompts.length}</message>`;
    });
    const c2 = new AbortController();
    const loop2 = runPollLoopWithTimeout(provider, c2.signal, 3000);
    try {
      await waitFor(() => prompts.length >= 1, 2000);
      expect(prompts[0]).toContain('<failed_request>');
      expect(prompts[0]).toContain('What are top dishes');
      expect(prompts[0]).toContain('What is this tree');
      // No automatic send: only the original failure notice plus answers to real turns.
      expect(getUndeliveredMessages().filter((r) => JSON.parse(r.content).failureNotice)).toHaveLength(1);
    } finally {
      c2.abort();
      await loop2.catch(() => {});
    }
  });

  it('a failure-notice wake on the same route neither sees nor consumes the reminder', async () => {
    insertMessage(
      'm1',
      { sender: 'Nicole', text: 'What are top dishes' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const failing = new ThrowingProvider('native_terminal');
    const c1 = new AbortController();
    const loop1 = runPollLoopWithTimeout(failing as unknown as MockProvider, c1.signal, 2000);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    c1.abort();
    await loop1.catch(() => {});

    insertMessage(
      'n1',
      { text: 'Other agent failed', failureNotice: true },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="discord-test">ok</message>';
    });
    const c2 = new AbortController();
    const loop2 = runPollLoopWithTimeout(provider, c2.signal, 3000);
    try {
      await waitFor(() => prompts.length >= 1, 2000);
      expect(prompts[0]).not.toContain('<failed_request>');
      expect(getAgentMailbox().operations.getState('failed_turn_notice')?.value).toContain('What are top dishes');
    } finally {
      c2.abort();
      await loop2.catch(() => {});
    }
  });

  it('does not carry a failed request into another chat sharing the session', async () => {
    insertMessage(
      'm1',
      { sender: 'Nicole', text: 'What are top dishes' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    const failing = new ThrowingProvider('native_terminal');
    const c1 = new AbortController();
    const loop1 = runPollLoopWithTimeout(failing as unknown as MockProvider, c1.signal, 2000);
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    c1.abort();
    await loop1.catch(() => {});

    insertMessage('m2', { sender: 'Bob', text: 'hello' }, { platformId: 'chan-2', channelType: 'discord' });
    const prompts: string[] = [];
    const provider = new MockProvider({}, (prompt) => {
      prompts.push(prompt);
      return '<message to="discord-test">hi</message>';
    });
    const c2 = new AbortController();
    const loop2 = runPollLoopWithTimeout(provider, c2.signal, 3000);
    try {
      await waitFor(() => prompts.length >= 1, 2000);
      expect(prompts[0]).not.toContain('What are top dishes');
      expect(prompts[0]).not.toContain('<failed_request>');
    } finally {
      c2.abort();
      await loop2.catch(() => {});
    }
  });
});

describe('poll loop — task_fires recording', () => {
  // Regression: scheduled-task fires were silently never written to
  // task_fires on two paths, so the dashboard showed "No fires recorded
  // yet" for the dream/maintenance task that fired daily.
  //
  // Path A (the dream/maintenance common case): a task that comes due
  // while a chat turn is active is DEFERRED by the activeSender task-wake
  // guard (it must not fold into the user's stream), then re-enters the
  // outer loop as a TASK-ONLY initial batch. Pre-fix the initial-batch
  // capture used keep.find() (single) so a batch with >1 due task only
  // recorded the first; and a silent task-only turn recorded nothing
  // unless it was the find()-matched row.
  //
  // Path B: a task that comes due while ANOTHER task turn is running (no
  // activeSender) is pushed via the in-query follow-up path. Pre-fix that
  // path had no gated-write and registered no fire context at all.

  function readTaskFires(seriesId: string): Array<{
    series_id: string;
    task_id: string;
    status: string;
    dispatched: string;
    error_message: string | null;
  }> {
    return getOutboundDb()
      .prepare(
        `SELECT series_id, task_id, status, dispatched, error_message
           FROM task_fires WHERE series_id = ? ORDER BY fired_at`,
      )
      .all(seriesId) as Array<{
      series_id: string;
      task_id: string;
      status: string;
      dispatched: string;
      error_message: string | null;
    }>;
  }

  function insertTask(id: string, seriesId: string, content: { prompt: string; script?: string }): void {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, trigger, series_id, platform_id, channel_type, content)
         VALUES (?, 'task', datetime('now'), 'pending', 1, ?, 'chan-1', 'discord', ?)`,
      )
      .run(id, seriesId, JSON.stringify(content));
  }

  it('writes a "silent" fire for a task-only turn that dispatches nothing', async () => {
    // The real dream/maintenance shape: task-only batch (no chat trigger
    // → no activeSender), agent emits only <internal> (strips to empty →
    // no safety-net, sent===0 → silent). Pre-fix this produced no row.
    insertTask('t-dream-1', 'dream-series-A', {
      prompt: 'Follow the agent protocol for end-of-day maintenance.',
    });

    const provider = new EndingProvider(() => '<internal>nothing to report</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3000);

    await waitFor(() => readTaskFires('dream-series-A').length > 0, 2500);
    controller.abort();

    const fires = readTaskFires('dream-series-A');
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('silent');
    expect(fires[0].task_id).toBe('t-dream-1');
    expect(JSON.parse(fires[0].dispatched)).toEqual([]);

    await loopPromise.catch(() => {});
  });

  it('records the silent fire at the result event even when the stream stays open (warm-container, 2026-05-16 23folg)', async () => {
    // Repro: telegram_dm_teddy 23folg. A warm agent-shared container
    // holds the query open for the follow-up window and does not idle-
    // kill for many minutes (browser pre-warm + 10 MCP servers keep it
    // resident). Pre-fix the fire was written ONLY in processQuery's
    // finally (stream close), so a silent dream task that finished its
    // turn had its fire stuck unwritten indefinitely — dashboard showed
    // "never ran" for a task that completed (0 fires after a 7-min live
    // watch). MockProvider emits init→result then BLOCKS waiting for
    // push()/end() — it never closes the stream on its own, exactly the
    // held-open shape. The fire must land at the `result` event, before
    // the stream is ever closed.
    insertTask('t-dream-warm', 'dream-series-warm', {
      prompt: 'Follow the agent protocol for end-of-day maintenance.',
    });

    const provider = new MockProvider({}, () => '<internal>maintenance complete</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // The fire must appear WITHOUT ever aborting/closing the stream.
    await waitFor(() => readTaskFires('dream-series-warm').length > 0, 2500);

    const fires = readTaskFires('dream-series-warm');
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('silent');
    expect(fires[0].task_id).toBe('t-dream-warm');
    expect(JSON.parse(fires[0].dispatched)).toEqual([]);

    // Only now tear down — proves the write happened at the result
    // event, not at stream close.
    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('ends the stream after a task-only turn so the outer loop unwinds (Bug 6: container idle-kill)', async () => {
    // Bug 6: a task-only turn held the query stream open after result
    // (no human follow-up sender to wait for), so the keepalive kept
    // the heartbeat fresh and the host stop-idle never fired — the
    // container lingered ~30 min instead of idle-killing in ~2 min.
    // MockProvider BLOCKS forever after emitting result unless end() is
    // called. Pre-fix the loop would hang on the first task's open
    // stream until the test aborts; post-fix query.end() unwinds it so
    // the outer loop resumes and picks up a SECOND task inserted after
    // the first completed. Observing the second task's fire proves the
    // first turn's stream closed on its own (no abort).
    insertTask('t-task-A', 'series-A', { prompt: 'first task turn' });

    const provider = new MockProvider({}, () => '<internal>done</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 4000);

    // First task records its fire (eager flush at result).
    await waitFor(() => readTaskFires('series-A').length > 0, 2500);
    // Now insert a second task. It can only be processed if the first
    // turn's stream ENDED and the outer loop re-queried — with the old
    // behavior the stream stays open on MockProvider and the outer loop
    // never gets here.
    insertTask('t-task-B', 'series-B', { prompt: 'second task turn' });
    await waitFor(() => readTaskFires('series-B').length > 0, 2500);

    expect(readTaskFires('series-A')).toHaveLength(1);
    expect(readTaskFires('series-B')).toHaveLength(1);
    expect(readTaskFires('series-B')[0].task_id).toBe('t-task-B');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('keeps a task turn open when trigger chat arrives before its first result', async () => {
    // Live repro: AI Friends 2026-07-18. OneCLI was offline while a recap
    // task and several @mentions queued. After OneCLI recovered, the recap
    // started first and the follow-up poll correctly deferred the chat — but
    // immediately called query.end() before Codex emitted any result. Codex
    // exited 0, the recap stayed pending, and every host retry repeated the
    // same empty turn while the mentions remained blocked behind it.
    insertTask('t-recap-blocked', 'recap-series-blocked', {
      prompt: 'daily recap task',
    });

    const provider = new DelayedResultProvider('<internal>recap complete</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => provider.queries === 1, 1000);
    insertMessage(
      'm-midtask-mention',
      { sender: 'Teddy', text: '@Optimus are you there?' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    // Let the 500ms follow-up poll observe and defer the trigger chat. It
    // must leave the active task query open until that task has a result.
    await sleep(800);
    expect(provider.ends).toBe(0);
    expect(readTaskFires('recap-series-blocked')).toHaveLength(0);

    provider.releaseResult();
    await waitFor(() => readTaskFires('recap-series-blocked').length === 1, 1500);

    expect(readTaskFires('recap-series-blocked')[0].status).toBe('silent');

    controller.abort();
    await loopPromise.catch(() => {});
  });

  it('defers chat that arrives mid-task-turn instead of folding it (Bug D follow-up half)', async () => {
    // Bug D follow-up half: a task-only turn is active; chat arrives via
    // the follow-up poll during the task's generation window. Pre-fix it
    // was pushed into the task's stream — the AI-Friends dream-summary
    // leak via the follow-up path. EndingProvider holds the stream ~400ms
    // (its one in-query fold window); we inject a chat row inside that
    // window via the responseFactory. The chat must be DEFERRED (stay
    // pending, never appear in any prompt the provider saw).
    insertTask('t-dream-iso', 'dream-series-iso', {
      prompt: 'silent maintenance — do NOT send any messages',
    });

    const prompts: string[] = [];
    let injected = false;
    const provider = new EndingProvider((p: string) => {
      prompts.push(p);
      if (!injected) {
        injected = true;
        // Chat lands while the task turn's stream is still open.
        insertMessage(
          'm-midturn',
          { sender: 'Alice', text: 'hey are you there' },
          { platformId: 'chan-1', channelType: 'discord' },
        );
      }
      return '<internal>maintenance done</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => readTaskFires('dream-series-iso').length > 0, 3000);
    controller.abort();

    // The task ran and recorded its silent fire.
    expect(readTaskFires('dream-series-iso')).toHaveLength(1);
    expect(readTaskFires('dream-series-iso')[0].status).toBe('silent');
    // The invariant: the mid-turn chat was never FOLDED into the task
    // turn. The task prompt contains the maintenance instruction but
    // NOT the chat; the chat is correctly handled in its own separate
    // chat turn afterward (deferring ≠ dropping), so it legitimately
    // appears in a *different* prompt — assert no single prompt mixes
    // the two, and the task prompt specifically is chat-free.
    const taskPrompt = prompts.find((p) => p.includes('silent maintenance'));
    expect(taskPrompt).toBeDefined();
    expect(taskPrompt).not.toContain('hey are you there');
    const folded = prompts.find((p) => p.includes('silent maintenance') && p.includes('hey are you there'));
    expect(folded).toBeUndefined();

    await loopPromise.catch(() => {});
  });

  it('records a distinct fire per task when several come due in one batch', async () => {
    // Multiple recurring tasks due in the same wake (RSS + dream). Pre-fix
    // keep.find() captured only the first → the second never recorded.
    insertTask('t-rss-1', 'rss-series', { prompt: 'rss check' });
    insertTask('t-dream-2', 'dream-series-C', { prompt: 'end-of-day maintenance' });

    const provider = new EndingProvider(() => '<internal>done</internal>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => readTaskFires('rss-series').length > 0 && readTaskFires('dream-series-C').length > 0, 3000);
    controller.abort();

    expect(readTaskFires('rss-series')).toHaveLength(1);
    expect(readTaskFires('dream-series-C')).toHaveLength(1);
    // Each keyed by its own task id — never collapsed into one row.
    expect(readTaskFires('rss-series')[0].task_id).toBe('t-rss-1');
    expect(readTaskFires('dream-series-C')[0].task_id).toBe('t-dream-2');

    await loopPromise.catch(() => {});
  });

  it('writes a "gated" fire for a follow-up task whose pre-task script gates it', async () => {
    // Path B: a task arrives while another (task) turn is running → goes
    // through the in-query follow-up handler. A wakeAgent=false script
    // must still record a 'gated' fire (pre-fix the follow-up path had no
    // gated-write — only the initial-batch path did).
    insertTask('t-trigger', 'trigger-series', { prompt: 'long running task' });

    let pushedFollowup = false;
    const provider = new EndingProvider(() => {
      if (!pushedFollowup) {
        pushedFollowup = true;
        // Insert the gated follow-up while this turn's stream is open
        // (the EndingProvider holds the stream ~400ms for the in-query
        // poll to fold it in before ending).
        insertTask('t-gated-1', 'dream-series-B', {
          prompt: 'maintenance',
          script: 'echo \'{"wakeAgent": false}\'',
        });
      }
      return '<internal>working</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(() => readTaskFires('dream-series-B').length > 0, 3000);
    controller.abort();

    const fires = readTaskFires('dream-series-B');
    expect(fires).toHaveLength(1);
    expect(fires[0].status).toBe('gated');
    expect(fires[0].task_id).toBe('t-gated-1');

    await loopPromise.catch(() => {});
  });

  it('a task-only follow-up that posts a message does NOT inherit a reply pill', async () => {
    // The regret after the NUL-sentinel fix (999c201): a task-only turn
    // (recurring RSS / daily recap) goes multi-batch — it pushes a
    // task-only follow-up mid-stream (the recap waits on an async
    // search_conversations, then continues and posts). The follow-up
    // re-publish block only wrote setCurrentBatchReplyTarget when
    // pickInReplyToMessage(keep) returned a truthy id. For an all-task
    // `keep` the picker correctly returns null, so the block was SKIPPED
    // and the authoritative "no reply pill" null was never republished.
    // Combined with the per-iteration finally clearCurrentBatchReplyTarget,
    // the session_state key was ABSENT when the follow-up's send_message
    // ran → resolveInReplyTo fell to the racy legacy heuristic → the
    // recap/status post reply-pilled onto a stale ~22h-old chat message
    // (observed live in AI Friends 2026-05-18/19). The fix publishes the
    // tri-state unconditionally (target?.id ?? null). Both the initial
    // task post AND the task follow-up post must go out with NO pill.
    insertMessage(
      'm-stale-human',
      { sender: 'Alice', text: 'a human message from way earlier' },
      { platformId: 'chan-1', channelType: 'discord' },
    );
    // Let the stale human message be consumed/answered first so it is no
    // longer the freshest pending row; the task turns below are what we
    // assert on.
    await sleep(50);
    insertTask('t-recap-1', 'recap-series', { prompt: 'recap turn — post the daily recap' });

    let followedUp = false;
    const provider = new EndingProvider((p: string) => {
      if (p.includes('recap turn') && !followedUp) {
        followedUp = true;
        // A task-only follow-up lands mid-stream (the async-continuation
        // shape: search_conversations returns, the recap continues).
        insertTask('t-recap-2', 'recap-series', {
          prompt: 'recap follow-up — continue and post',
        });
        return '<message to="discord-test">## Recap — initial</message>';
      }
      if (p.includes('recap follow-up')) {
        return '<message to="discord-test">## Recap — continued</message>';
      }
      return '<internal>noop</internal>';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 3500);

    await waitFor(
      () => getUndeliveredMessages().filter((m) => JSON.parse(m.content).text?.includes('Recap')).length >= 2,
      3000,
    );
    controller.abort();

    const recapPosts = getUndeliveredMessages().filter((m) => JSON.parse(m.content).text?.includes('Recap'));
    expect(recapPosts.length).toBeGreaterThanOrEqual(2);
    // The invariant: NEITHER the initial task post nor the task follow-up
    // post may carry a reply pill. A task fire answers no chat message.
    // Pre-fix the follow-up ("Recap — continued") pilled onto the stale
    // human row; the assertion below fails on that.
    for (const post of recapPosts) {
      expect(post.in_reply_to == null || post.in_reply_to === '').toBe(true);
    }

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — stale session recovery', () => {
  it('clears continuation when provider reports session invalid', async () => {
    // Pre-seed a continuation so the local variable in runPollLoop is set.
    // Without this, the `if (continuation && isSessionInvalid)` check skips.
    setContinuation('mock', 'pre-existing-session');

    insertMessage('m1', { sender: 'Alice', text: 'stale session' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new InvalidSessionProvider();
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // A safe notice reaches the user; the provider diagnostic stays private.
    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe(GENERIC_FAILURE_NOTICE);
    expect(out[0].content).not.toContain('session not found');

    // Continuation was cleared (isSessionInvalid returned true)
    expect(getContinuation('mock')).toBeUndefined();

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that drives the day-aware rotation evaluator via its
 * `maybeRotateContinuation` hook so poll-loop integration tests can exercise
 * the same rotation flow ClaudeProvider does (just without a real on-disk
 * transcript). Reuses the real `evaluateRotation` so test coverage tracks
 * the production decision function. Emits an init event with a new
 * continuation so the stamp path also runs.
 */
class StatsConfigurableProvider {
  readonly supportsNativeSlashCommands = false;
  private stats: { compactCount: number; sizeBytes: number; turnCount: number };
  private nextContinuation: string;

  constructor(
    stats: { compactCount?: number; sizeBytes?: number; turnCount?: number } = {},
    nextContinuation = 'fresh-session-id',
  ) {
    this.stats = {
      compactCount: stats.compactCount ?? 0,
      sizeBytes: stats.sizeBytes ?? 0,
      turnCount: stats.turnCount ?? 0,
    };
    this.nextContinuation = nextContinuation;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  maybeRotateContinuation(continuation: string): string | null {
    if (!continuation) return null;
    const startedAt = getContinuationStartedAt('mock');
    const decision = evaluateRotation(new Date(), TIMEZONE, startedAt, this.stats);
    return decision.rotate ? decision.reason : null;
  }

  query(_input: { prompt: string; cwd: string; continuation?: string }) {
    const continuation = this.nextContinuation;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation };
        yield { type: 'result' as const, text: '<message to="discord-test">ok</message>' };
      })(),
    };
  }
}

describe('poll loop — lazy session rotation', () => {
  it('rotates a prior-day session with compacts before next query', async () => {
    setContinuation('mock', 'pre-rotation-id');
    // Stamp the session as belonging to "yesterday" so the day-boundary
    // check fails, then load the disk-evidence axis.
    setContinuationStartedAt('mock', '2020-01-01');

    insertMessage('m1', { sender: 'Alice', text: 'wake up' }, { platformId: 'chan-1', channelType: 'discord' });

    const provider = new StatsConfigurableProvider({ compactCount: 2 }, 'fresh-after-rotation');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // The stored continuation should be the FRESH one — proving the old
    // continuation was wiped before query, then the new one stamped after.
    expect(getContinuation('mock')).toBe('fresh-after-rotation');
    // startedAt should reflect today's rotation day, not the pre-seeded
    // 2020-01-01 stamp.
    expect(getContinuationStartedAt('mock')).toBe(computeRotationDate(new Date(), TIMEZONE));

    await loopPromise.catch(() => {});
  });

  it('preserves a same-day session even when compacted (mid-chat continuity)', async () => {
    setContinuation('mock', 'mid-day-id');
    setContinuationStartedAt('mock', computeRotationDate(new Date(), TIMEZONE));

    insertMessage('m1', { sender: 'Alice', text: 'still chatting' }, { platformId: 'chan-1', channelType: 'discord' });

    // Compact count is high, but day-boundary check fires first and preserves.
    const provider = new StatsConfigurableProvider({ compactCount: 99 }, 'should-not-be-stamped');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    // The provider emitted a new continuation in `init`, but since the
    // lazy hook did NOT rotate, runPollLoop should detect the new id and
    // store it — without re-stamping startedAt (resume path, not new
    // thread). Verifying we did not rotate: the stored continuation will
    // be the provider's emitted id since the SDK reported it back, but
    // the startedAt stamp must still equal what we pre-seeded.
    expect(getContinuationStartedAt('mock')).toBe(computeRotationDate(new Date(), TIMEZONE));

    await loopPromise.catch(() => {});
  });
});

describe('poll loop — /clear command', () => {
  it('clears session, writes confirmation, skips query', async () => {
    // Seed a continuation so we can verify it gets cleared
    setContinuation('mock', 'existing-session-id');
    expect(getContinuation('mock')).toBe('existing-session-id');

    // Insert a /clear command
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-clear', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/clear' }));

    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 2000);

    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Session cleared.');

    // Continuation was cleared
    expect(getContinuation('mock')).toBeUndefined();

    // Command message was completed
    const pending = getPendingMessages();
    expect(pending).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

/**
 * Provider that throws on every query, simulating API failures.
 */
/**
 * Provider whose stream ENDS after delivering one result per prompt —
 * models a real provider/SDK whose agent turn completes and the event
 * stream closes (which is what triggers processQuery's finally, where the
 * task_fires row is written). The shared MockProvider deliberately blocks
 * the stream open for follow-up pushes, so it can never exercise the
 * natural-stream-end fire-write; this one can. Each `query.push` (a
 * follow-up the poll-loop folds in) produces one more result then the
 * stream ends again on the next outer-loop query.
 */
class EndingProvider {
  readonly supportsNativeSlashCommands = false;
  private responseFactory: (prompt: string) => string;

  constructor(responseFactory: (prompt: string) => string) {
    this.responseFactory = responseFactory;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: { prompt: string }) {
    const factory = this.responseFactory;
    const pending: string[] = [];
    let resolveWait: (() => void) | null = null;
    let ended = false;
    return {
      push(message: string) {
        pending.push(message);
        resolveWait?.();
      },
      end() {
        ended = true;
        resolveWait?.();
      },
      abort() {
        ended = true;
        resolveWait?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: `mock-session-${Date.now()}` };
        yield { type: 'result' as const, text: factory(input.prompt) };
        // Give the poll-loop one short window to fold in a follow-up
        // (its in-query poll runs on an interval). If one arrives, emit
        // its result; otherwise end the stream so processQuery returns
        // and the finally writes the fire — the real "turn finished"
        // shape, not an infinite open stream.
        for (;;) {
          if (pending.length > 0) {
            yield { type: 'result' as const, text: factory(pending.shift()!) };
            continue;
          }
          if (ended) return;
          await new Promise<void>((r) => {
            resolveWait = r;
            setTimeout(() => {
              resolveWait = null;
              r();
            }, 400);
          });
          if (pending.length === 0) return; // settled with no follow-up → end
        }
      })(),
    };
  }
}

class ThrowingProvider {
  private errorMessage: string;

  constructor(errorMessage: string) {
    this.errorMessage = errorMessage;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  query(_input: { prompt: string; cwd: string }) {
    const errorMessage = this.errorMessage;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        throw new Error(errorMessage);
      })(),
    };
  }
}

/**
 * Provider that throws with an error that triggers isSessionInvalid.
 * First emits an init event (setting continuation), then throws.
 */
class InvalidSessionProvider {
  isSessionInvalid(): boolean {
    return true;
  }

  query(_input: { prompt: string; cwd: string }) {
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'doomed-session' };
        throw new Error('session not found');
      })(),
    };
  }
}

describe('poll loop — slash command during active query', () => {
  it('aborts the active query when /clear arrives as a follow-up', async () => {
    insertMessage(
      'm-active',
      { sender: 'Alice', text: 'long running request' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    const provider = new BlockingProvider();
    const controller = new AbortController();
    // Generous budgets: on resource-starved CI runners the poll loop can take
    // well over 2s to issue its first query, which made this test the only
    // deterministic CI failure while passing everywhere else (macOS + Linux
    // dev boxes run it in ~0.6s; success aborts the loop early, so the large
    // ceilings cost nothing on the happy path).
    const loopPromise = runPollLoopWithTimeout(provider as unknown as MockProvider, controller.signal, 20000);

    await waitFor(() => provider.queries === 1, 2000);
    insertMessage(
      'm-clear-active',
      { sender: 'Alice', text: '/clear' },
      { platformId: 'chan-1', channelType: 'discord' },
    );

    await waitFor(() => provider.aborts === 1, 15000);
    await waitFor(
      () => getUndeliveredMessages().some((msg) => JSON.parse(msg.content).text === 'Session cleared.'),
      15000,
    );
    controller.abort();

    expect(provider.ends).toBe(0);
    expect(getContinuation('mock')).toBeUndefined();
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  }, 30000);
});

/**
 * Provider whose query never completes until ended/aborted — for testing how
 * the loop interrupts an active stream.
 */
class DelayedFollowUpProvider {
  readonly supportsNativeSlashCommands = false;
  pushes = 0;
  ends = 0;
  private released = false;
  private wake: (() => void) | null = null;

  constructor(
    private readonly initialResponse: string,
    private readonly followUpResponse: string,
  ) {}

  isSessionInvalid(): boolean {
    return false;
  }

  releaseFollowUp(): void {
    this.released = true;
    this.wake?.();
  }

  query() {
    const owner = this;
    let ended = false;
    let aborted = false;

    return {
      push() {
        owner.pushes += 1;
        owner.wake?.();
      },
      end() {
        owner.ends += 1;
        ended = true;
        owner.wake?.();
      },
      abort() {
        aborted = true;
        owner.wake?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'delayed-follow-up-session' };
        yield { type: 'result' as const, text: owner.initialResponse };
        while ((!owner.released || owner.pushes === 0) && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
        if (ended || aborted) return;
        yield { type: 'result' as const, text: owner.followUpResponse };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
      })(),
    };
  }
}

class SupersededResultProvider {
  readonly supportsNativeSlashCommands = false;
  queries = 0;
  pushes = 0;
  pushedPrompts: string[] = [];

  constructor(
    private readonly firstResponse = '<message to="discord-test">details missing</message>',
    private readonly followUpResponse = (_prompt: string) =>
      '<message to="discord-test">labels created from the order details</message>',
    private readonly waitsFor?: (prompt: string) => number,
  ) {}
  private released = false;
  private wake: (() => void) | null = null;

  isSessionInvalid(): boolean {
    return false;
  }

  releaseResults(): void {
    this.released = true;
    this.wake?.();
  }

  query() {
    const owner = this;
    owner.queries += 1;
    let ended = false;
    let aborted = false;
    return {
      ...(owner.waitsFor ? { pushWaitsFor: owner.waitsFor } : {}),
      push(prompt: string) {
        owner.pushedPrompts.push(prompt);
        owner.pushes += 1;
        owner.wake?.();
      },
      end() {
        ended = true;
        owner.wake?.();
      },
      abort() {
        aborted = true;
        owner.wake?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'superseded-result-session' };
        while (!owner.released && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
        if (ended || aborted) return;
        yield { type: 'result' as const, text: owner.firstResponse };
        yield {
          type: 'result' as const,
          text: owner.followUpResponse(owner.pushedPrompts[0] ?? ''),
        };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
      })(),
    };
  }
}

class MergedFollowUpProvider {
  readonly supportsNativeSlashCommands = false;
  queries = 0;
  pushes = 0;
  pushedPrompts: string[] = [];
  private released = false;
  private wake: (() => void) | null = null;

  isSessionInvalid(): boolean {
    return false;
  }

  releaseResult(): void {
    this.released = true;
    this.wake?.();
  }

  query() {
    const owner = this;
    owner.queries += 1;
    let ended = false;
    let aborted = false;
    return {
      push(prompt: string) {
        owner.pushedPrompts.push(prompt);
        owner.pushes += 1;
      },
      end() {
        ended = true;
        owner.wake?.();
      },
      abort() {
        aborted = true;
        owner.wake?.();
      },
      events: (async function* () {
        yield { type: 'init' as const, continuation: 'merged-follow-up-session' };
        while (!owner.released && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
        if (ended || aborted) return;
        yield { type: 'result' as const, text: '<message to="discord-test">3-day meal plan</message>' };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
      })(),
    };
  }
}

class DelayedResultProvider {
  readonly supportsNativeSlashCommands = false;
  queries = 0;
  ends = 0;
  private released = false;
  private wake: (() => void) | null = null;
  private readonly response: string;

  constructor(response: string) {
    this.response = response;
  }

  isSessionInvalid(): boolean {
    return false;
  }

  releaseResult(): void {
    this.released = true;
    this.wake?.();
  }

  query() {
    const owner = this;
    owner.queries += 1;
    let ended = false;
    let aborted = false;

    return {
      push() {},
      end: () => {
        owner.ends += 1;
        ended = true;
        owner.wake?.();
      },
      abort: () => {
        aborted = true;
        owner.wake?.();
      },
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'delayed-result-session' };
        while (!owner.released && !ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
        if (ended || aborted) return;
        yield { type: 'result' as const, text: owner.response };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            owner.wake = resolve;
          });
          owner.wake = null;
        }
      })(),
    };
  }
}

class BlockingProvider {
  queries = 0;
  aborts = 0;
  ends = 0;

  isSessionInvalid(): boolean {
    return false;
  }

  query() {
    const owner = this;
    this.queries += 1;
    let wake: (() => void) | null = null;
    let ended = false;
    let aborted = false;

    return {
      push() {},
      end: () => {
        owner.ends += 1;
        ended = true;
        wake?.();
      },
      abort: () => {
        owner.aborts += 1;
        aborted = true;
        wake?.();
      },
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'blocking-session' };
        while (!ended && !aborted) {
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
          wake = null;
        }
      })(),
    };
  }
}
