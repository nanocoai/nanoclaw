import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { askUserQuestion, LINK_ACTION_SCHEMA, sendCard } from './interactive.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('send_card', () => {
  it('tells the agent when callback actions will be dropped', async () => {
    const result = await sendCard.handler({
      card: {
        title: 'Test',
        actions: [
          { label: 'Approve', value: 'approve' },
          { label: 'Reject', value: 'reject' },
          { label: 'Docs', url: 'https://example.com' },
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    expect(result.content[0].text).toContain('2 invalid action(s) were dropped');
    expect(result.content[0].text).toContain('ask_user_question');
    // Only renderable actions reach the payload, so the count and the row agree.
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.type).toBe('card');
    expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
  });

  it('drops a null action instead of writing something the bridge cannot read', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [null, { label: 'Docs', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com' }]);
  });

  // The bridge maps any unrecognized style to the default button styling, so a
  // bad style must never cost the agent the whole button. `null` is the case
  // that matters: it is how a model most often fills an optional field.
  it.each([['chartreuse'], [null], [5], [true]])(
    'keeps an action whose style is %p, for the bridge to fall back on',
    async (style) => {
      const result = await sendCard.handler({
        card: { title: 'Test', actions: [{ label: 'Docs', url: 'https://example.com', style }] },
      });

      expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
      const content = JSON.parse(getUndeliveredMessages()[0].content);
      expect(content.card.actions).toEqual([{ label: 'Docs', url: 'https://example.com', style }]);
    },
  );

  it('drops an action whose label is empty, the rule the schema owns', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ label: '', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([]);
  });

  it('leaves an empty or non-array actions value exactly as the bridge would', async () => {
    await sendCard.handler({ card: { title: 'Empty', actions: [] } });
    await sendCard.handler({ card: { title: 'Bogus', actions: 'nope' } });

    const [empty, bogus] = getUndeliveredMessages().map((m) => JSON.parse(m.content));
    expect(empty.card.actions).toEqual([]);
    expect(bogus.card.actions).toBe('nope');
  });

  it('advertises the same action schema it enforces', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { actions: { items: unknown } };
    };

    expect(cardSchema.properties.actions.items).toBe(LINK_ACTION_SCHEMA);
  });

  it('tells the agent when a URL action has no label', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    expect(result.content[0].text).toContain('web link (http or https)');
  });

  // A model asked for an approval card cannot make a callback button, so it
  // fakes one with a placeholder href. Dropping it points the agent at
  // ask_user_question instead of posting two dead links. Non-web schemes go the
  // same way: the agent does not pick the channel, and mailto:/tel: are not
  // link buttons on Discord or Telegram.
  it.each([
    ['#'],
    ['/docs'],
    ['example.com'],
    ['   '],
    ['localhost:3000'],
    ['mailto:someone@example.com'],
    ['tel:+34600000000'],
    ['javascript:alert(1)'],
    // A scheme with no host satisfies the drop message read literally, so it is
    // the cheapest wrong retry; whitespace would break out of '[label](url)'.
    ['https://'],
    ['https:///nohost'],
    ['https://example.com '],
    ['https://example.com\njavascript:alert(1)'],
  ])('drops a link action whose url is %p', async (url) => {
    const result = await sendCard.handler({
      card: { title: 'Test Approval Card', actions: [{ label: 'Approve', url }] },
    });

    expect(result.content[0].text).toContain('1 invalid action(s) were dropped');
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([]);
  });

  // The scheme is case-insensitive per RFC 3986 §3.1, and an agent quoting a
  // url out of a document may well quote it uppercase.
  it.each([['https://example.com'], ['http://localhost:3000/x'], ['HTTPS://EXAMPLE.COM']])(
    'keeps a link action whose url is %p',
    async (url) => {
      const result = await sendCard.handler({ card: { title: 'Test', actions: [{ label: 'Open', url }] } });

      expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
      const content = JSON.parse(getUndeliveredMessages()[0].content);
      expect(content.card.actions).toEqual([{ label: 'Open', url }]);
    },
  );

  it('states the url rule in the schema description the agent reads', () => {
    const url = LINK_ACTION_SCHEMA.properties.url as { description: string };

    expect(url.description).toContain('http or https');
  });

  it('constrains children to text instead of promising nested action blocks', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { children: { description: string; items: { anyOf: Array<Record<string, unknown>> } } };
    };

    expect(cardSchema.properties.children.description).toContain('Nested action blocks are unsupported');
    expect(cardSchema.properties.children.items.anyOf).toHaveLength(2);
  });

  it('stays quiet when every action has a url', async () => {
    const result = await sendCard.handler({
      card: { title: 'Test', actions: [{ label: 'Docs', url: 'https://example.com' }] },
    });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
  });

  it('stays quiet for display-only cards', async () => {
    const result = await sendCard.handler({ card: { title: 'Test', description: 'No actions' } });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
  });
});

// ── Thread of the chat being answered ──
// Same rule as send_message / send_file (core.test.ts): the thread of the
// message being answered, else the chat's latest inbound thread. The bound
// thread in session_routing is null for every session that isn't per-thread.

function seedBoundThread(channelType: string, platformId: string, threadId: string | null): void {
  const db = getInboundDb();
  db.exec(`CREATE TABLE IF NOT EXISTS session_routing (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    channel_type TEXT, platform_id TEXT, thread_id TEXT
  )`);
  db.prepare('INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, ?, ?, ?)').run(
    channelType,
    platformId,
    threadId,
  );
}

let hostSeq = 0;
function seedInbound(id: string, channelType: string, platformId: string, threadId: string | null): void {
  hostSeq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'chat', ?, 'completed', ?, ?, ?, ?)`,
    )
    .run(id, hostSeq, new Date().toISOString(), platformId, channelType, threadId, JSON.stringify({ text: 'hi' }));
}

function publishReplyRoute(route: {
  inReplyTo: string;
  channelType: string;
  platformId: string;
  threadId: string | null;
}) {
  getOutboundDb()
    .prepare('INSERT OR REPLACE INTO session_state (key, value, updated_at) VALUES (?, ?, ?)')
    .run('current_reply_route', JSON.stringify(route), new Date().toISOString());
}

/**
 * The user's click, as the host writes it into messages_in
 * (src/modules/interactive/index.ts): the card's own chat and thread.
 */
function answerQuestion(questionId: string, threadId: string | null): void {
  hostSeq += 2;
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, seq, kind, timestamp, status, platform_id, channel_type, thread_id, content)
       VALUES (?, ?, 'system', ?, 'pending', 'C123', 'slack', ?, ?)`,
    )
    .run(
      `resp-${questionId}`,
      hostSeq,
      new Date().toISOString(),
      threadId,
      JSON.stringify({ questionId, selectedOption: 'yes' }),
    );
}

/** Both cards' thread_id, question first. */
async function sendBoth(): Promise<Array<string | null>> {
  const pending = askUserQuestion.handler({ title: 'T', question: 'Q?', options: ['yes', 'no'], timeout: 10 });
  while (getUndeliveredMessages().length < 1) await new Promise((r) => setTimeout(r, 10));
  const question = getUndeliveredMessages()[0];
  answerQuestion(JSON.parse(question.content).questionId, question.thread_id);
  expect((await pending).content[0].text).toBe('yes');
  await sendCard.handler({ card: { title: 'Info' } });
  return getUndeliveredMessages().map((m) => m.thread_id);
}

describe('ask_user_question / send_card — thread of the chat being answered', () => {
  it('lands in the thread of the message being answered, even when the session has no bound thread', async () => {
    seedBoundThread('slack', 'C123', null);
    seedInbound('in-1', 'slack', 'C123', 'T-42');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123', threadId: 'T-42' });

    expect(await sendBoth()).toEqual(['T-42', 'T-42']);
  });

  it('stays with the answered message when a newer message from another thread arrived mid-turn', async () => {
    seedBoundThread('slack', 'C123', null);
    seedInbound('in-1', 'slack', 'C123', 'T-1');
    seedInbound('in-2', 'slack', 'C123', 'T-42');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123', threadId: 'T-1' });

    expect(await sendBoth()).toEqual(['T-1', 'T-1']);
  });

  it("falls back to the chat's latest inbound thread out of a batch, not the bound thread", async () => {
    seedBoundThread('slack', 'C123', 'T-bound');
    seedInbound('in-1', 'slack', 'C123', 'T-1');
    seedInbound('in-2', 'slack', 'C123', 'T-42');

    expect(await sendBoth()).toEqual(['T-42', 'T-42']);
  });

  it('keeps a per-thread session in its own thread', async () => {
    seedBoundThread('slack', 'C123', 'T-5');
    seedInbound('in-1', 'slack', 'C123', 'T-5');
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123', threadId: 'T-5' });

    expect(await sendBoth()).toEqual(['T-5', 'T-5']);
  });

  it('keeps a per-thread session in its thread when the answered row carries no thread', async () => {
    // e.g. a host-generated trigger row with a null thread in a per-thread session.
    seedBoundThread('slack', 'C123', 'T-5');
    seedInbound('in-1', 'slack', 'C123', null);
    publishReplyRoute({ inReplyTo: 'in-1', channelType: 'slack', platformId: 'C123', threadId: null });

    expect(await sendBoth()).toEqual(['T-5', 'T-5']);
  });

  it('keeps the bound thread when nothing has arrived from the chat', async () => {
    seedBoundThread('slack', 'C123', 'T-bound');

    expect(await sendBoth()).toEqual(['T-bound', 'T-bound']);
  });
});
