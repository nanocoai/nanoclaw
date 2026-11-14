/**
 * Slack long replies. The Slack adapter sends a markdown reply as
 * `markdown_text`, which Slack caps at 12,000 characters, and it neither cuts
 * nor splits it. So the Slack bridge must split long replies itself, and each
 * part must still fit after the adapter's own conversion (bare @mentions gain
 * `<…>` brackets).
 *
 * The factory reads `.env` from process.cwd(), so the test chdirs into a temp
 * dir with a crafted .env before importing slack.ts (as the instances test does).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createSlackAdapter } from '@chat-adapter/slack';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { splitForLimit } from './chat-sdk-bridge.js';

const SLACK_MARKDOWN_LIMIT = 12_000;

vi.mock('./chat-sdk-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-sdk-bridge.js')>();
  return { ...actual, createChatSdkBridge: vi.fn((config: unknown) => ({ config })) };
});

const originalCwd = process.cwd();
let slack: typeof import('./slack.js');
let createChatSdkBridge: ReturnType<typeof vi.fn>;

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-long-replies-'));
  writeFileSync(
    join(dir, '.env'),
    [
      'SLACK_BOT_TOKEN=xoxb-test-token',
      'SLACK_SIGNING_SECRET=test-secret',
      'SLACK_BOT_TOKEN_ALPHA=xoxb-alpha-token',
      'SLACK_SIGNING_SECRET_ALPHA=alpha-secret',
    ].join('\n') + '\n',
  );
  process.chdir(dir);
  slack = await import('./slack.js');
  createChatSdkBridge = vi.mocked((await import('./chat-sdk-bridge.js')).createChatSdkBridge) as never;
});

afterAll(() => {
  process.chdir(originalCwd);
});

/** markdown_text exactly as the real Slack adapter would send it. */
function slackMarkdownText(markdown: string): string {
  const adapter = createSlackAdapter({ botToken: 'xoxb-test-token', signingSecret: 'test-secret', mode: 'webhook' });
  const converter = (
    adapter as unknown as {
      formatConverter: { toSlackPayload(message: { markdown: string }): { markdown_text?: string } };
    }
  ).formatConverter;
  const payload = converter.toSlackPayload({ markdown });
  expect(payload.markdown_text).toBeTypeOf('string');
  return payload.markdown_text as string;
}

function lastBridgeConfig(): { maxTextLength?: number } {
  const calls = createChatSdkBridge.mock.calls;
  return calls[calls.length - 1][0] as { maxTextLength?: number };
}

describe('Slack bridge splits long replies', () => {
  it('passes the Slack text limit to the bridge, for the default app and named instances', () => {
    expect(slack.createSlackBridge()).not.toBeNull();
    expect(lastBridgeConfig().maxTextLength).toBe(slack.SLACK_MAX_TEXT_LENGTH);

    expect(slack.slackInstanceBridgeFactory('alpha')).not.toBeNull();
    expect(lastBridgeConfig().maxTextLength).toBe(slack.SLACK_MAX_TEXT_LENGTH);
  });

  it('a reply over the cap reaches Slack whole without the split', () => {
    const reply = 'word '.repeat(2_600); // 13,000 characters
    expect(slackMarkdownText(reply).length).toBeGreaterThan(SLACK_MARKDOWN_LIMIT);
  });

  it('every part of a long reply fits after the adapter converts it', () => {
    const paragraph = 'Status for @alice and @bob: the build passed, see https://example.com/run/42 for details.\n';
    const reply = Array.from({ length: 400 }, (_, i) => `${i}. ${paragraph}`).join('\n'); // ~38,000 chars
    const parts = splitForLimit(reply, slack.SLACK_MAX_TEXT_LENGTH);

    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(slack.SLACK_MAX_TEXT_LENGTH);
      expect(slackMarkdownText(part).length).toBeLessThanOrEqual(SLACK_MARKDOWN_LIMIT);
    }
    // Nothing is lost: the parts hold every word of the reply.
    expect(parts.join(' ').split(/\s+/).filter(Boolean)).toEqual(reply.split(/\s+/).filter(Boolean));
  });

  it('a mention-dense part still fits: the gap covers 500 bare @mentions', () => {
    const mentions = Array.from({ length: 500 }, (_, i) => `@user${i}`).join(' ');
    const part = (mentions + ' ' + 'x'.repeat(slack.SLACK_MAX_TEXT_LENGTH)).slice(0, slack.SLACK_MAX_TEXT_LENGTH);
    const sent = slackMarkdownText(part);
    expect(sent.length).toBe(part.length + 2 * 500); // each bare @mention gains `<` and `>`
    expect(sent.length).toBeLessThanOrEqual(SLACK_MARKDOWN_LIMIT);
  });

  it('the real bridge built from the Slack config posts a long reply in parts', async () => {
    expect(slack.createSlackBridge()).not.toBeNull();
    const config = lastBridgeConfig();
    const actual = await vi.importActual<typeof import('./chat-sdk-bridge.js')>('./chat-sdk-bridge.js');
    const posted: string[] = [];
    const adapter = {
      name: 'slack',
      postMessage: async (threadId: string, message: { markdown: string }) => {
        posted.push(message.markdown);
        return { id: `part-${posted.length}`, threadId, raw: {} };
      },
    };
    const bridge = actual.createChatSdkBridge({ ...config, adapter } as never);
    const reply = Array.from({ length: 700 }, (_, i) => `Line ${i}: the deploy of service ${i} finished.`).join('\n');
    expect(reply.length).toBeGreaterThan(2 * SLACK_MARKDOWN_LIMIT);

    const id = await bridge.deliver('slack:C1', 'slack:C1:1700000000.000100', {
      kind: 'chat',
      content: { markdown: reply },
    });

    expect(id).toBe('part-1'); // the head of the reply, as for Discord and Telegram
    expect(posted.length).toBeGreaterThan(2);
    for (const part of posted) expect(slackMarkdownText(part).length).toBeLessThanOrEqual(SLACK_MARKDOWN_LIMIT);
    expect(posted.join('\n')).toBe(reply);
  });
});
