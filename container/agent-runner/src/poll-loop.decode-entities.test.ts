import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { decodeMessageEntities, processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const ROUTING = {
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

function makeQuery(events: AsyncGenerator<ProviderEvent>): { query: AgentQuery; pushes: string[] } {
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

describe('decodeMessageEntities', () => {
  it('decodes the entities escapeXml produces', () => {
    expect(decodeMessageEntities('a?x=1&amp;y=2')).toBe('a?x=1&y=2');
    expect(decodeMessageEntities('&lt;tag&gt;')).toBe('<tag>');
    expect(decodeMessageEntities('&quot;quoted&quot;')).toBe('"quoted"');
    expect(decodeMessageEntities('it&#39;s')).toBe("it's");
    expect(decodeMessageEntities('it&apos;s')).toBe("it's");
  });

  it('undoes exactly one escaping pass (&amp; decodes last)', () => {
    expect(decodeMessageEntities('&amp;lt;')).toBe('&lt;');
    expect(decodeMessageEntities('&amp;amp;')).toBe('&amp;');
  });

  it('leaves a plain ampersand and other entities alone', () => {
    expect(decodeMessageEntities('fish & chips')).toBe('fish & chips');
    expect(decodeMessageEntities('a&nbsp;b &copy; c')).toBe('a&nbsp;b &copy; c');
  });

  it('returns text without an ampersand unchanged', () => {
    expect(decodeMessageEntities('a perfectly normal reply')).toBe('a perfectly normal reply');
  });
});

// The formatter escapes inbound message text with escapeXml, so a model
// that echoes user text copies the escaped form into its <message> blocks.
// Both delivery doors must decode before the text reaches the chat.
describe('message entities decoded before delivery (wiring)', () => {
  it('decodes a <message> block body on the final-result path', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      yield {
        type: 'result',
        text: '<message to="discord-main">Your link: https://example.com/a?x=1&amp;agent_name=Andy</message>',
      };
    }
    const { query } = makeQuery(events());

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Your link: https://example.com/a?x=1&agent_name=Andy');
  });

  it('decodes a <message> block body on the mid-turn path', async () => {
    seedDest();
    async function* events(): AsyncGenerator<ProviderEvent> {
      yield { type: 'init', continuation: 'sess-1' };
      yield {
        type: 'text',
        text: 'Echoing you:\n<message to="discord-main">You wrote &lt;hello&gt; &amp; goodbye</message>',
      };
      yield { type: 'result', text: 'wrapped answer already sent above' };
    }
    const { query } = makeQuery(events());

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined, true);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('You wrote <hello> & goodbye');
  });
});
