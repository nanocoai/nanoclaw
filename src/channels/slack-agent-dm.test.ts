/**
 * Slack agent-DM decoration through the registry passthroughs the onboarding
 * module calls: the real SDK adapter builds the assistant API payload, and the
 * Slack client is stubbed. The factory reads `.env` from process.cwd(), so the
 * test chdirs into a temp dir first (as slack-long-replies.test.ts does).
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { SlackAdapter } from '@chat-adapter/slack';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const slackCalls: Array<{ method: string; args: Record<string, unknown> }> = [];
let slackFailure: Error | null = null;

vi.mock('@chat-adapter/slack', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@chat-adapter/slack')>();
  return {
    ...actual,
    createSlackAdapter: (...args: Parameters<typeof actual.createSlackAdapter>) => {
      const adapter = actual.createSlackAdapter(...args);
      const { threads } = (adapter as unknown as { _client: SlackAdapter['webClient'] })._client.assistant;
      const record = (method: string) => async (payload: Record<string, unknown>) => {
        slackCalls.push({ method, args: payload });
        if (slackFailure) throw slackFailure;
        return { ok: true };
      };
      threads.setSuggestedPrompts = record('assistant.threads.setSuggestedPrompts') as never;
      threads.setTitle = record('assistant.threads.setTitle') as never;
      return adapter;
    },
  };
});

// A bare bridge, so the registry can start each instance without a Slack connection.
vi.mock('./chat-sdk-bridge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./chat-sdk-bridge.js')>();
  return {
    ...actual,
    createChatSdkBridge: (config: { instance?: string }) => ({
      name: 'slack',
      channelType: 'slack',
      instance: config.instance,
      supportsThreads: true,
      setup: async () => {},
      teardown: async () => {},
      isConnected: () => true,
      deliver: async () => undefined,
    }),
  };
});

const PROMPTS = [
  { title: 'Give me the tour', message: 'Give me a quick tour of what you can do.' },
  { title: 'Help me with something', message: 'I have something specific I want help with.' },
];

const originalCwd = process.cwd();
let registry: typeof import('./channel-registry.js');

beforeAll(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'slack-agent-dm-'));
  writeFileSync(
    join(dir, '.env'),
    [
      'SLACK_BOT_TOKEN=xoxb-default',
      'SLACK_SIGNING_SECRET=default-secret',
      'SLACK_INSTANCES=alpha',
      'SLACK_BOT_TOKEN_ALPHA=xoxb-alpha',
      'SLACK_SIGNING_SECRET_ALPHA=alpha-secret',
    ].join('\n') + '\n',
  );
  process.chdir(dir);
  await import('./slack.js');
  registry = await import('./channel-registry.js');
  await registry.initChannelAdapters(() => ({}) as never);
});

afterAll(async () => {
  await registry.teardownChannelAdapters();
  process.chdir(originalCwd);
});

beforeEach(() => {
  slackCalls.length = 0;
  slackFailure = null;
});

describe('Slack suggested prompts', () => {
  it('pins prompts at the top of the DM: channel id, no thread_ts, the title', async () => {
    await registry.setSuggestedPrompts('slack', 'slack:D0DEFAULT', PROMPTS, 'Get started');

    expect(slackCalls).toEqual([
      {
        method: 'assistant.threads.setSuggestedPrompts',
        args: { channel_id: 'D0DEFAULT', prompts: PROMPTS, title: 'Get started', token: 'xoxb-default' },
      },
    ]);
  });

  it('clears with an empty list and no title', async () => {
    await registry.setSuggestedPrompts('slack', 'slack:D0DEFAULT', []);

    expect(slackCalls).toEqual([
      {
        method: 'assistant.threads.setSuggestedPrompts',
        args: { channel_id: 'D0DEFAULT', prompts: [], token: 'xoxb-default' },
      },
    ]);
  });
});

describe('Slack thread titles', () => {
  it('splits the thread id into channel id and thread_ts', async () => {
    await registry.setThreadTitle('slack', 'slack:D0DEFAULT', 'slack:D0DEFAULT:1700000000.000100', 'Plan the offsite');

    expect(slackCalls).toEqual([
      {
        method: 'assistant.threads.setTitle',
        args: {
          channel_id: 'D0DEFAULT',
          thread_ts: '1700000000.000100',
          title: 'Plan the offsite',
          token: 'xoxb-default',
        },
      },
    ]);
  });
});

describe('named instances', () => {
  it('slack-<name> calls Slack with its own bot token', async () => {
    await registry.setSuggestedPrompts('slack-alpha', 'slack:D0ALPHA', PROMPTS, 'Get started');
    await registry.setThreadTitle('slack-alpha', 'slack:D0ALPHA', 'slack:D0ALPHA:1700000000.000200', 'Alpha thread');

    expect(slackCalls.map((c) => [c.method, c.args.channel_id, c.args.token])).toEqual([
      ['assistant.threads.setSuggestedPrompts', 'D0ALPHA', 'xoxb-alpha'],
      ['assistant.threads.setTitle', 'D0ALPHA', 'xoxb-alpha'],
    ]);
  });
});

describe('errors reject, so the onboarding module can log and retry', () => {
  it('passes a Slack API error through both methods', async () => {
    slackFailure = Object.assign(new Error('An API error occurred: channel_not_found'), {
      data: { ok: false, error: 'channel_not_found' },
    });

    await expect(
      registry.setThreadTitle('slack', 'slack:D0DEFAULT', 'slack:D0DEFAULT:1700000000.000100', 'Title'),
    ).rejects.toBe(slackFailure);
    await expect(registry.setSuggestedPrompts('slack', 'slack:D0DEFAULT', PROMPTS, 'Get started')).rejects.toBe(
      slackFailure,
    );
  });

  it.each([
    ['a non-Slack platform id', () => registry.setSuggestedPrompts('slack', 'discord:123', PROMPTS)],
    ['a thread id with an empty ts', () => registry.setThreadTitle('slack', 'slack:D0', 'slack:D0:', 'Title')],
    ['a thread id with no ts', () => registry.setThreadTitle('slack', 'slack:D0', 'slack:D0', 'Title')],
  ])('rejects %s without calling Slack', async (_label, call) => {
    await expect(call()).rejects.toThrow();
    expect(slackCalls).toEqual([]);
  });
});
