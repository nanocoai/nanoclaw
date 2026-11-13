import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb, getOutboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

// A chat turn that ends without a reply after its last tool call gets one
// nudge. The wrap-nudge never fires here: an <internal>-only or empty final
// has nothing unwrapped. Live shape: the agent sent "Checking… one moment"
// with send_message, researched, then ended on
// "<internal>I answered them…</internal>" — the user got only the ack.

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

function seedDest(): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
}

/** What MCP send_message / add_reaction write: a chat row to the channel. */
function toolWrite(content: Record<string, unknown>): void {
  getOutboundDb()
    .prepare(
      `INSERT INTO messages_out (id, seq, timestamp, kind, platform_id, channel_type, content)
       VALUES (?, (SELECT COALESCE(MAX(seq), 0) + 2 FROM messages_out), ?, 'chat', 'chan-1', 'discord', ?)`,
    )
    .run(`tool-${Math.random()}`, new Date().toISOString(), JSON.stringify(content));
}

async function run(events: AsyncGenerator<ProviderEvent>, routing = CHAT_ROUTING): Promise<string[]> {
  const pushes: string[] = [];
  const query: AgentQuery = { push: (m) => void pushes.push(m), end: () => {}, events, abort: () => {} };
  await processQuery(query, routing, ['m1'], 'claude', undefined, 'prompt', undefined, true);
  return pushes;
}

const silentEndNudges = (pushes: string[]) => pushes.filter((p) => p.includes('ended without a reply'));

function deliveredTexts(): string[] {
  return getUndeliveredMessages()
    .filter((m) => m.kind === 'chat')
    .map((m) => (JSON.parse(m.content) as { text?: string }).text ?? '');
}

describe('silent-end nudge', () => {
  it('ack → research → <internal>-only final: nudges once, quoting the ack; the retry answer delivers', async () => {
    seedDest();
    const pushes = await run(
      (async function* () {
        yield { type: 'init', continuation: 's1' };
        yield { type: 'tool_use', names: ['mcp__nanoclaw__send_message'] };
        toolWrite({ text: 'Checking. One moment.' });
        yield { type: 'tool_use', names: ['WebFetch'] };
        yield { type: 'tool_use', names: ['mcp__nanoclaw__add_reaction'] };
        toolWrite({ operation: 'reaction', messageId: 'x', emoji: 'tea' });
        yield { type: 'text', text: '<internal>I answered them: not free yet; 9:30 to 4.</internal>' };
        yield { type: 'result', text: '<internal>I answered them: not free yet; 9:30 to 4.</internal>' };
        // Retry turn
        yield { type: 'text', text: '<message to="discord-main">Not free yet; open 9:30 to 4.</message>' };
        yield { type: 'result', text: '<message to="discord-main">Not free yet; open 9:30 to 4.</message>' };
      })(),
    );

    expect(silentEndNudges(pushes)).toHaveLength(1);
    expect(silentEndNudges(pushes)[0]).toContain('Checking. One moment.');
    expect(deliveredTexts()).toContain('Not free yet; open 9:30 to 4.');
  });

  it('empty final after work with nothing sent: nudges once, and never twice', async () => {
    seedDest();
    const pushes = await run(
      (async function* () {
        yield { type: 'init', continuation: 's1' };
        yield { type: 'tool_use', names: ['WebSearch'] };
        yield { type: 'result', text: '' };
        yield { type: 'result', text: '<internal>done</internal>' };
      })(),
    );

    expect(silentEndNudges(pushes)).toHaveLength(1);
    expect(silentEndNudges(pushes)[0]).toContain('Nothing was sent');
  });

  it('send_message after the work, then <internal>-only final: no nudge', async () => {
    seedDest();
    const pushes = await run(
      (async function* () {
        yield { type: 'init', continuation: 's1' };
        yield { type: 'tool_use', names: ['WebFetch'] };
        yield { type: 'tool_use', names: ['mcp__nanoclaw__send_message'] };
        toolWrite({ text: 'The full answer.' });
        yield { type: 'result', text: '<internal>Replied via send_message.</internal>' };
      })(),
    );

    expect(pushes).toHaveLength(0);
  });

  it('a streamed <message> block after the work: no nudge', async () => {
    seedDest();
    const block = '<message to="discord-main">The answer.</message>';
    const pushes = await run(
      (async function* () {
        yield { type: 'init', continuation: 's1' };
        yield { type: 'tool_use', names: ['Bash'] };
        yield { type: 'text', text: block };
        yield { type: 'result', text: block };
      })(),
    );

    expect(pushes).toHaveLength(0);
  });

  it('a reaction alone is not a reply', async () => {
    seedDest();
    const pushes = await run(
      (async function* () {
        yield { type: 'init', continuation: 's1' };
        yield { type: 'tool_use', names: ['mcp__nanoclaw__add_reaction'] };
        toolWrite({ operation: 'reaction', messageId: 'x', emoji: 'eyes' });
        yield { type: 'result', text: '<internal>reacted</internal>' };
      })(),
    );

    expect(silentEndNudges(pushes)).toHaveLength(1);
  });

  it('task runs, agent-to-agent turns and failure-notice wakes are never nudged', async () => {
    seedDest();
    for (const routing of [
      { ...CHAT_ROUTING, taskRun: true },
      { ...CHAT_ROUTING, channelType: 'agent' },
      { ...CHAT_ROUTING, failureNoticeWake: true },
    ]) {
      const pushes = await run(
        (async function* () {
          yield { type: 'init', continuation: 's1' };
          yield { type: 'tool_use', names: ['Bash'] };
          yield { type: 'result', text: '<internal>done</internal>' };
        })(),
        routing,
      );
      expect(silentEndNudges(pushes)).toHaveLength(0);
    }
  });

  it('a failed turn is never nudged (it gets the failure notice instead)', async () => {
    seedDest();
    const pushes = await run(
      (async function* () {
        yield { type: 'init', continuation: 's1' };
        yield { type: 'tool_use', names: ['Bash'] };
        yield { type: 'result', text: null, isError: true };
      })(),
    );

    expect(silentEndNudges(pushes)).toHaveLength(0);
  });
});
