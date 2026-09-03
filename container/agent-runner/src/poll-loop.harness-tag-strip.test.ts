import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { stripHarnessTagArtifacts } from './harness-tag-strip.js';
import { processQuery } from './poll-loop.js';
import type { AgentQuery, ProviderEvent } from './providers/types.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

/**
 * Build a one-shot stub query that yields init + a single result event, then
 * ends. `pushes` records any follow-ups the loop tried to inject (e.g. the
 * re-wrap nudge), so a test can assert the loop did NOT re-hammer.
 */
function makeResultQuery(result: ProviderEvent): { query: AgentQuery; pushes: string[] } {
  const pushes: string[] = [];
  async function* events(): AsyncGenerator<ProviderEvent> {
    yield { type: 'init', continuation: 'sess-1' };
    yield result;
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

const ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
  taskRun: false,
};

describe('stripHarnessTagArtifacts', () => {
  it('strips a single trailing orphan closing tag', () => {
    expect(stripHarnessTagArtifacts('Deploy is done.\n</parameter>')).toBe('Deploy is done.');
  });

  it('strips a single trailing orphan opening tag', () => {
    expect(stripHarnessTagArtifacts('Deploy is done.\n<parameter>')).toBe('Deploy is done.');
  });

  it('strips opening tags with attributes', () => {
    expect(stripHarnessTagArtifacts('Deploy is done.\n<invoke name="Bash">')).toBe('Deploy is done.');
  });

  it('strips a mixed trailing run with whitespace and newlines between tags', () => {
    expect(stripHarnessTagArtifacts('All set.\n<invoke name="Bash">\n </parameter>\n<dispatch>\n')).toBe('All set.');
  });

  it('is case-insensitive', () => {
    expect(stripHarnessTagArtifacts('ok <PARAMETER NAME="VALUE">')).toBe('ok');
  });

  it('preserves tags that appear mid-text', () => {
    const text = 'the <parameter> and </parameter> tags delimit a parameter element';
    expect(stripHarnessTagArtifacts(text)).toBe(text);
  });

  it('preserves mid-text tags while stripping the trailing run', () => {
    expect(stripHarnessTagArtifacts('use <invoke> to open it\n</parameter>')).toBe('use <invoke> to open it');
  });

  it('collapses text consisting only of tags to empty', () => {
    expect(stripHarnessTagArtifacts('<invoke name="Bash"></parameter>')).toBe('');
  });

  it('leaves unrelated trailing opening and closing tags alone', () => {
    expect(stripHarnessTagArtifacts('done <message></message>')).toBe('done <message></message>');
  });

  it('leaves text without any tags unchanged', () => {
    expect(stripHarnessTagArtifacts('a perfectly normal reply')).toBe('a perfectly normal reply');
  });
});

// Wiring guards: the sanitizer must be applied at BOTH delivery seams inside
// the real processQuery path — the <message> block extraction in
// dispatchResultText (exercised here without emitsMidTurnText, where the
// result is the delivery door; the mid-turn seam has its own sanitization
// test in poll-loop.midturn.test.ts), and the bare error-result delivery.
// Removing either call site (not just the helper) goes red here.
describe('harness tag artifacts stripped from deliveries (wiring)', () => {
  it('sanitizes a <message> block body before it reaches messages_out', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('discord-main', 'discord-main', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();

    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: '<message to="discord-main">Deploy is done.\n<invoke name="Bash"></parameter></message>',
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Deploy is done.');
    expect(pushes).toHaveLength(0);
  });

  it('sanitizes bare error-result text before it reaches messages_out', async () => {
    const { query, pushes } = makeResultQuery({
      type: 'result',
      text: 'Spending limit reached.\n<dispatch>',
      isError: true,
    });

    await processQuery(query, ROUTING, ['m1'], 'claude', undefined, 'prompt', undefined);

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0].content).text).toBe('Spending limit reached.');
    // No re-wrap nudge — an error result must not re-hammer the gateway.
    expect(pushes).toHaveLength(0);
  });
});
