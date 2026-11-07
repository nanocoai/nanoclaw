import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { findQuestionResponse } from '../db/messages-in.js';
import { askUserQuestion, LINK_ACTION_SCHEMA, MAX_CARD_QUESTION_LENGTH, sendCard } from './interactive.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

describe('ask_user_question cancellation', () => {
  const args = { title: 'Fixture', question: 'Choose', options: ['yes', 'no'] };
  it('does not publish a question for an already cancelled request', async () => {
    const controller = new AbortController();
    controller.abort();
    const result = await askUserQuestion.handler(args, { signal: controller.signal });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('cancelled');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('stops waiting promptly and never consumes a later response after cancellation', async () => {
    const controller = new AbortController();
    const waiting = askUserQuestion.handler(args, { signal: controller.signal });
    while (!getUndeliveredMessages().length) await Bun.sleep(1);
    const { questionId } = JSON.parse(getUndeliveredMessages()[0].content);
    const started = Date.now();
    controller.abort();
    const result = await waiting;
    expect(Date.now() - started).toBeLessThan(250);
    expect(result.content[0].text).toContain('cancelled');
    getInboundDb()
      .prepare('INSERT INTO messages_in (id, kind, timestamp, content) VALUES (?, ?, ?, ?)')
      .run(
        'late-question-answer',
        'chat',
        new Date().toISOString(),
        JSON.stringify({ questionId, selectedOption: 'yes' }),
      );
    expect(findQuestionResponse(questionId)?.id).toBe('late-question-answer');
  });
});

describe('ask_user_question length', () => {
  it('refuses a title plus question too long for a card without publishing it', async () => {
    const question = 'x'.repeat(MAX_CARD_QUESTION_LENGTH);
    const result = await askUserQuestion.handler({ title: 'Fixture', question, options: ['yes'] });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('too long to show in full');
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('publishes a question right at the limit', async () => {
    const controller = new AbortController();
    const question = 'x'.repeat(MAX_CARD_QUESTION_LENGTH - 'Fixture'.length);
    const waiting = askUserQuestion.handler(
      { title: 'Fixture', question, options: ['yes'] },
      { signal: controller.signal },
    );
    while (!getUndeliveredMessages().length) await Bun.sleep(1);
    controller.abort();
    await waiting;
    expect(JSON.parse(getUndeliveredMessages()[0].content).question).toBe(question);
  });
});

/** The host's delivery outcome, as delivery.ts records it in the session's inbound.db. */
function recordDelivery(messageOutId: string, status: 'delivered' | 'failed'): void {
  getInboundDb()
    .prepare('INSERT INTO delivered (message_out_id, platform_message_id, status, delivered_at) VALUES (?, NULL, ?, ?)')
    .run(messageOutId, status, new Date().toISOString());
}

async function postedQuestionId(): Promise<string> {
  while (!getUndeliveredMessages().length) await Bun.sleep(1);
  return JSON.parse(getUndeliveredMessages()[0].content).questionId;
}

describe('ask_user_question — card the host could not post', () => {
  const args = { title: 'Fixture', question: 'Choose', options: ['yes', 'no'] };

  it('returns an error once the host gives up on the card, instead of waiting out the timeout', async () => {
    const waiting = askUserQuestion.handler(args);
    const questionId = await postedQuestionId();
    const started = Date.now();
    recordDelivery(questionId, 'failed');
    const result = await waiting;
    expect(Date.now() - started).toBeLessThan(2500);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('could not be delivered');
    expect(result.content[0].text).toContain('Shorten the title, question or option labels, or ask in a plain message');
  });

  it('still returns an answer that arrived by the time the host gave up on the card', async () => {
    const waiting = askUserQuestion.handler(args);
    const questionId = await postedQuestionId();
    answerQuestion(questionId, null);
    recordDelivery(questionId, 'failed');
    const result = await waiting;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('yes');
  });

  it('keeps waiting for the answer while its card is delivered, whatever happened to other messages', async () => {
    let settled = false;
    const waiting = askUserQuestion.handler({ ...args, timeout: 10 }).finally(() => (settled = true));
    const questionId = await postedQuestionId();
    recordDelivery(questionId, 'delivered');
    recordDelivery('msg-other-card', 'failed');
    await Bun.sleep(1200);
    expect(settled).toBe(false);
    answerQuestion(questionId, null);
    const result = await waiting;
    expect(result.isError).toBeUndefined();
    expect(result.content[0].text).toBe('yes');
  });
});

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

  it('keeps a non-ASCII link by normalizing it with URL', async () => {
    const result = await sendCard.handler({
      card: {
        title: 'Test',
        actions: [
          { label: 'Wiki', url: 'https://de.wikipedia.org/wiki/München' },
          { label: 'Host', url: 'https://münchen.de/' },
        ],
      },
    });

    expect(result.content[0].text).toMatch(/^Card sent \(id: msg-[^)]+\)$/);
    const content = JSON.parse(getUndeliveredMessages()[0].content);
    expect(content.card.actions).toEqual([
      { label: 'Wiki', url: 'https://de.wikipedia.org/wiki/M%C3%BCnchen' },
      { label: 'Host', url: 'https://xn--mnchen-3ya.de/' },
    ]);
  });

  it('states the url rule in the schema description the agent reads', () => {
    const url = LINK_ACTION_SCHEMA.properties.url as { description: string };

    expect(url.description).toContain('http or https');
  });

  // llama.cpp compiles tool schemas to a grammar and rejects these escapes,
  // failing every request that carries send_card.
  it('keeps the url pattern free of escapes a grammar converter rejects', () => {
    const { pattern } = LINK_ACTION_SCHEMA.properties.url as { pattern: string };

    expect(pattern).not.toMatch(/\\[sStn]/);

    const re = new RegExp(pattern);
    for (const url of ['https://example.com', 'http://a', 'https://x.io/p?q=1#f', 'HTTP://h:8080/~u']) {
      expect(re.test(url)).toBe(true);
    }
    for (const url of [
      'https://',
      'https:///p',
      'https://?q',
      'https://#f',
      'https://ex ample.com',
      'https://example.com\t',
      'https://example.com\n',
      'ftp://example.com',
      'https://a.com/"x',
      'https://a.com/\\x',
      'https://"a.com',
    ]) {
      expect(re.test(url)).toBe(false);
    }
  });

  it('offers text and display parts as children, never a button or nested action blocks', () => {
    const cardSchema = sendCard.tool.inputSchema.properties.card as {
      properties: { children: { description: string; items: { anyOf: Array<Record<string, unknown>> } } };
    };
    const advertised = JSON.stringify(cardSchema.properties.children.items.anyOf);

    expect(cardSchema.properties.children.description).toContain('Nested action blocks are unsupported');
    expect(advertised).toContain('"enum":["Text","Fields","Table","Chart","Divider"]');
    expect(advertised).not.toMatch(/Button|Actions|Image|"const"|"null"/);
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

describe('send_card — card parts', () => {
  beforeEach(() => seedBoundThread('slack', 'C-fixture', null));
  const field = (label: string, value: string | number) => ({ type: 'Field', props: { label, value } });
  const table = (rows: string[][], headers = ['Scale', 'Before', 'After']) => ({
    type: 'Table',
    props: { headers, rows },
  });
  const chart = (title: string, spec: Record<string, unknown>) => ({ type: 'Chart', props: { title, chart: spec } });
  const bar = (title = 'Latency') =>
    chart(title, { type: 'bar', categories: ['1x', '2x'], series: [{ name: 'Before', values: [40, 80] }] });
  const pie = (value: number) => chart('Split', { type: 'pie', segments: [{ label: 'Render', value }] });
  const sent = () => JSON.parse(getUndeliveredMessages()[0].content);

  it('sends a card of every part as the agent wrote it, next to its text children', async () => {
    const children = [
      'Before/after the cache change.',
      { type: 'Fields', children: [field('p50', '42 ms'), field('Errors', 0.2)] },
      table([['1x', '40', '38']]),
      bar(),
      pie(55),
      { type: 'Divider' },
      { type: 'Text', props: { content: 'Measured on staging.', style: 'muted' } },
      { type: 'text', text: 'A text child that also names a type stays text.' },
    ];
    const result = await sendCard.handler({ card: { title: 'Perf', children } });

    expect(result.isError).toBeUndefined();
    expect(sent().card.children).toEqual(children);
  });

  it.each([
    ['a callback button', { type: 'Button', props: { id: 'ncq:q-1:0', label: 'Approve' } }, 'unknown part "Button"'],
    ['an image', { type: 'Image', props: { url: 'https://example.com/a.png', alt: 'x' } }, 'unknown part "Image"'],
    ['a nested card', { type: 'Card', props: { title: 'Approve?' } }, 'unknown part "Card"'],
    ['a field outside Fields', field('p50', '42 ms'), 'unknown part "Field"'],
    ['an empty Fields', { type: 'Fields', children: [] }, 'Fields needs at least one Field'],
    [
      'a button inside Fields',
      { type: 'Fields', children: [{ type: 'Button', props: { id: 'ncq:q-1:0', label: 'x' } }] },
      'Fields holds only Field parts',
    ],
    ['a field named after an object method', { type: 'Fields', children: [{ type: 'constructor' }] }, 'Fields holds only Field parts'],
    ['a short table row', table([['1x', '40']]), 'row 0 has 2 cells, expected 3'],
    ['a table of 31 rows', table(Array.from({ length: 31 }, () => ['1x', '40', '38'])), 'at most 30 rows'],
    ['an align list longer than the headers', { type: 'Table', props: { headers: ['a'], rows: [['1']], align: ['left', 'right'] } }, 'one per column'],
    ['a pie with a repeated slice label', chart('Split', { type: 'pie', segments: [{ label: 'a', value: 1 }, { label: 'a', value: 2 }] }), 'must not repeat'],
    ['a table of 7 columns', table([['a', 'b', 'c', 'd', 'e', 'f', 'g']], ['1', '2', '3', '4', '5', '6', '7']), 'at most 6 columns'],
    [
      'a series missing a value',
      chart('Latency', { type: 'line', categories: ['1x', '2x'], series: [{ name: 'Before', values: [40] }] }),
      'has 1 values, expected 2',
    ],
    ['a pie slice of zero', pie(0), 'segments[0].value'],
    ['a table too long for Slack to draw', table([['x'.repeat(10_000), 'a', 'b']]), 'at most 10000'],
    ['a table given as object rows', { type: 'Table', props: { headers: ['Evidence'], rows: [{ Evidence: 'x' }] } }, 'row 0 must be a list of cells'],
    [
      'a table cell given as a template',
      { type: 'Table', props: { headers: ['Evidence'], rows: [[{ $template: 'x' }]] } },
      'a cell must be text or a number',
    ],
    ['a text part over 2,500 characters', { type: 'Text', props: { content: 'x'.repeat(2_501) } }, 'at most 2500 characters'],
    ['a text part with an unknown style', { type: 'Text', props: { content: 'x', style: 'huge' } }, 'plain, bold or muted'],
    ['a field over 1,500 characters', { type: 'Fields', children: [field('p95', 'x'.repeat(1_500))] }, 'at most 1500 characters'],
    [
      'a chart value of Infinity, as JSON reads 1e400',
      chart('Latency', { type: 'bar', categories: ['1x'], series: [{ name: 'Before', values: [Infinity] }] }),
      'values must be numbers',
    ],
    ['a field with no value', { type: 'Fields', children: [{ type: 'Field', props: { label: 'p95' } }] }, 'props.label and props.value'],
    [
      'a table whose caption makes it too long',
      { type: 'Table', props: { headers: ['a'], rows: [['b']], caption: 'x'.repeat(10_000) } },
      'at most 10000',
    ],
    ['a chart title over 50 characters', bar('x'.repeat(51)), 'props.title'],
    [
      'a chart label over 20 characters',
      chart('Latency', { type: 'bar', categories: ['x'.repeat(21)], series: [{ name: 'Before', values: [1] }] }),
      'at most 20 characters',
    ],
    [
      'an axis label over 50 characters',
      chart('Latency', { type: 'bar', categories: ['1x'], series: [{ name: 'Before', values: [1] }], xLabel: 'x'.repeat(51) }),
      'axis labels',
    ],
    [
      'a chart of 21 categories',
      chart('Latency', { type: 'line', categories: Array.from({ length: 21 }, (_, i) => `${i}`), series: [{ name: 'B', values: Array.from({ length: 21 }, () => 1) }] }),
      '1 to 20 categories',
    ],
    [
      'a chart of 13 series',
      chart('Latency', { type: 'bar', categories: ['1x'], series: Array.from({ length: 13 }, (_, i) => ({ name: `s${i}`, values: [1] })) }),
      '1 to 12 series',
    ],
    [
      'a chart with a repeated category',
      chart('Latency', { type: 'bar', categories: ['1x', '1x'], series: [{ name: 'B', values: [1, 2] }] }),
      'must not repeat',
    ],
    ['a chart of an unknown type', chart('Latency', { type: 'radar' }), 'pie, bar, line or area'],
  ])('refuses %s and says which child to fix', async (_, part, reason) => {
    const result = await sendCard.handler({ card: { title: 'Perf', children: ['intro', part] } });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Card not sent');
    expect(result.content[0].text).toContain('children[1]');
    expect(result.content[0].text).toContain(reason);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it.each([
    ['11 parts', Array.from({ length: 11 }, () => ({ type: 'Divider' })), 'at most 10 parts per card'],
    [
      '11 fields across two Fields parts',
      [
        { type: 'Fields', children: Array.from({ length: 6 }, (_, i) => field(`f${i}`, '1')) },
        { type: 'Fields', children: Array.from({ length: 5 }, (_, i) => field(`g${i}`, '1')) },
      ],
      'at most 10 fields per card',
    ],
    [
      'over 12,000 characters of text across parts',
      Array.from({ length: 5 }, () => ({ type: 'Text', props: { content: 'x'.repeat(2_500) } })),
      'at most 12000 per card',
    ],
  ])('refuses a card of %s', async (_, children, reason) => {
    const result = await sendCard.handler({ card: { title: 'Perf', children } });

    expect(result.content[0].text).toContain(reason);
    expect(getUndeliveredMessages()).toHaveLength(0);
  });

  it('refuses a second table and a third chart', async () => {
    const tables = await sendCard.handler({
      card: { children: [table([['1x', '40', '38']]), table([['2x', '80', '61']])] },
    });
    const charts = await sendCard.handler({ card: { children: [bar('a'), bar('b'), bar('c')] } });

    expect(tables.content[0].text).toContain('at most 1 Table');
    expect(charts.content[0].text).toContain('at most 2 Chart');
    expect(getUndeliveredMessages()).toHaveLength(0);
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
