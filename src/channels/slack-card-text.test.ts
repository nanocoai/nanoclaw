/**
 * Slack approval cards end to end through the real Slack bridge factory: the
 * adapter is stubbed to capture the card, then the real @chat-adapter/slack
 * Block Kit converter renders it, so the test sees the mrkdwn Slack receives.
 *
 * Like slack-instances-registration.test.ts, the factory reads `.env` from
 * process.cwd(), so the test chdirs into a temp dir with a placeholder token.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cardToBlockKit, cardToFallbackText } from '@chat-adapter/slack';
import type { AdapterPostableMessage } from 'chat';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { escapeCardTitles, escapeSlackMrkdwn, escapeSlackTitle, slackInstanceBridgeFactory } from './slack.js';

const posted: AdapterPostableMessage[] = [];
const notifications: Array<{ text?: string; blocks?: unknown }> = [];

vi.mock('@chat-adapter/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chat-adapter/slack')>();
  return {
    ...actual,
    createSlackAdapter: (...args: Parameters<typeof actual.createSlackAdapter>) => {
      const adapter = actual.createSlackAdapter(...args);
      const transport = adapter as unknown as { _client: typeof adapter.webClient };
      transport._client.chat.postMessage = vi.fn(async (payload) => {
        notifications.push(payload);
        return { ok: true, ts: 'm1' };
      });
      const post = adapter.postMessage.bind(adapter);
      adapter.postMessage = async (threadId, message) => {
        posted.push(message);
        return post(threadId, message);
      };
      return adapter;
    },
  };
});

vi.mock('../webhook-server.js', () => ({ registerWebhookAdapter: vi.fn() }));

const originalCwd = process.cwd();

beforeAll(() => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-card-text-'));
  writeFileSync(join(dir, '.env'), 'SLACK_BOT_TOKEN_CARDS=xoxb-placeholder\nSLACK_SIGNING_SECRET_CARDS=test-secret\n');
  process.chdir(dir);
});

afterAll(() => {
  process.chdir(originalCwd);
});

describe('escapeSlackMrkdwn', () => {
  it('entity-escapes &, < and >, ampersand first', () => {
    expect(escapeSlackMrkdwn('a & <b> &lt;')).toBe('a &amp; &lt;b&gt; &amp;lt;');
  });

  it('keeps bare special mentions inert without changing other @ words', () => {
    expect(escapeSlackMrkdwn('@here @Channel @everyone @hereby a@b')).toBe(
      '@\u2060here @\u2060Channel @\u2060everyone @hereby a@b',
    );
  });

  it('leaves Markdown formatting alone', () => {
    expect(escapeSlackMrkdwn('*bold* `code` [x](y)')).toBe('*bold* `code` [x](y)');
  });
});

describe('escapeSlackTitle', () => {
  it('escapes the notification title without look-alike characters', () => {
    const title = 'Create agent: "<!channel>" @here a@b & x';
    expect(escapeSlackTitle(title)).toBe('Create agent: "&lt;!channel&gt;" @here a@b &amp; x');
  });
});

describe('Slack approval card text', () => {
  /** Text of every section block in the last posted card, as Slack receives it. */
  function postedSections(): string[] {
    const blocks = cardToBlockKit((posted.at(-1) as { card: Parameters<typeof cardToBlockKit>[0] }).card);
    return blocks
      .filter((b) => b.type === 'section')
      .map((b) => (b as unknown as { text: { text: string } }).text.text);
  }

  beforeEach(() => {
    posted.length = 0;
    notifications.length = 0;
  });

  it('renders link and mention syntax in the question as plain text', async () => {
    const bridge = slackInstanceBridgeFactory('cards');
    expect(bridge).not.toBeNull();

    await bridge!.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-1',
        title: 'CLI: groups-list',
        question: '<https://example.com|click> wants to talk & <!here> @here',
        options: [{ label: 'Approve', style: 'primary' }],
      },
    });

    expect(posted).toHaveLength(1);
    const blocks = cardToBlockKit((posted[0] as { card: Parameters<typeof cardToBlockKit>[0] }).card);
    const section = blocks.find((b) => b.type === 'section') as unknown as { text: { type: string; text: string } };
    expect(section.text).toEqual({
      type: 'mrkdwn',
      text: '&lt;https://example.com|click&gt; wants to talk &amp; &lt;!here&gt; @\u2060here',
    });
  });

  it('keeps link and mention syntax in the title inert in the notification text', async () => {
    const bridge = slackInstanceBridgeFactory('cards');
    const title = 'Create agent: "<!channel>" @here <https://example.com|click>';
    await bridge!.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: { type: 'ask_question', questionId: 'appr-2', title, question: 'Approve?', options: ['Approve'] },
    });

    const card = (posted.at(-1) as { card: Parameters<typeof cardToBlockKit>[0] }).card;
    // Slack's top-level `text`, the mrkdwn fallback for notifications.
    const postMessage = vi.fn();
    const update = vi.fn();
    const payload = { text: cardToFallbackText(card), blocks: cardToBlockKit(card) };
    // Test both Web API methods after the real Block Kit/fallback conversion.
    const client = { webClient: { chat: { postMessage, update } } };
    escapeCardTitles(client as never);
    client.webClient.chat.postMessage(payload);
    client.webClient.chat.update(payload);
    expect(postMessage.mock.calls[0]).toEqual(update.mock.calls[0]);
    const notification = notifications.at(-1)!.text!;
    expect(postMessage.mock.calls[0][0].text).toBe(notification);
    expect(notification).not.toContain('<!channel>');
    expect(notification).not.toContain('<https://');
    // A bare @here stays as typed; without `<!here>` (and no link_names) it is no mention.
    expect(notification).toContain('@here');
    expect(notification).not.toContain('<!');
    // The plain-text header preserves the exact title.
    const header = cardToBlockKit(card).find((b) => b.type === 'header') as unknown as { text: { text: string } };
    expect(header.text.text).toBe(title);
  });

  it('escapes every block when a long host card is split into several sections', async () => {
    const bridge = slackInstanceBridgeFactory('cards')!;
    const action = '<https://example.com/verify|Approve safely> & more\n'.repeat(120);

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'appr-2',
        title: 'Approve external request',
        question: `*Action:* ${action}`,
        options: ['Approve'],
      },
    });

    const sections = postedSections();
    expect(sections.length).toBeGreaterThan(1);
    for (const text of sections) expect(text).not.toMatch(/[<>]/);
  });

  it('keeps the markup of a question the agent asked itself', async () => {
    const bridge = slackInstanceBridgeFactory('cards')!;

    await bridge.deliver('slack:D1', null, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId: 'q-agent',
        title: 'Pick one',
        question: 'See <https://example.com|the docs>?',
        options: ['Yes'],
        fromAgent: true,
      },
    });

    expect(postedSections()).toEqual(['See <https://example.com|the docs>?']);
  });
});
