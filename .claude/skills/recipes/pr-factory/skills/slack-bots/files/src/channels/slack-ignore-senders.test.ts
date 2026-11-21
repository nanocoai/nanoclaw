/**
 * pr-factory slack-bots guard — the sibling echo guard and the slack.ts
 * delta this skill patches into the stock /add-slack adapter:
 *
 *   1. `import { slackBotUserIds, registerSlackBotUserId, withSiblingEchoGuard } from './slack-bot-ids.js';`
 *   2. `void registerSlackBotUserId(env.SLACK_BOT_TOKEN, 'worker');` in the factory
 *   3. `return withSiblingEchoGuard(bridge, slackBotUserIds);` replacing `return bridge;`
 *
 * Behavior, not structural — driven through the REAL entry
 * (initChannelAdapters runs the real slack.ts / slack-supervisor.ts /
 * slack-tester.ts factories; messages flow through the REAL Chat SDK dispatch
 * against the real SqliteStateAdapter on the real migrated central DB).
 * Hermetic at the external edge only: `@chat-adapter/slack` is stubbed (its
 * initialize() makes a live auth.test call through @slack/web-api — the
 * unmocked-dependency guard lives in multibot-registration.test.ts instead),
 * readEnvFile injects test credentials (key-filtered, so a drifted env-var
 * name in a factory still goes red), and global fetch serves the
 * slack-bot-ids auth.test lookup.
 *
 * What goes red:
 *   - slack.ts line 2 deleted → the worker's bot user id never lands in the
 *     shared Set;
 *   - slack.ts line 3 deleted → the bridge's inbound path loses the guard and
 *     the sibling-bot message is forwarded instead of dropped;
 *   - slack.ts line 1 deleted → build/typecheck leg, and this file's import
 *     of './slack.js' fails to evaluate;
 *   - the wrapper stops covering the onDirectMessage dispatch path (the DM
 *     case below — newly covered by withSiblingEchoGuard; the old
 *     three-site bridge hack missed it);
 *   - an adapter loses its `instance` wiring (exact-key resolution cases) —
 *     supervisor/tester traffic would silently hijack or shadow the worker.
 *
 * The sibling id is added to the EXPORTED Set after the bridge is created:
 * that pins the cross-adapter contract — the supervisor/tester factories push
 * their bot user ids into the same module-level Set object, and the guard
 * must consult it live (Set identity, not a snapshot).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { Message, parseMarkdown, type Adapter, type Chat } from 'chat';

const fixture = vi.hoisted(() => ({
  env: {} as Record<string, string>,
  chats: new Map<string, unknown>(), // routingPath → captured Chat instance
  adapters: [] as unknown[],
}));

// External platform edge — the real adapter's initialize() calls Slack's
// auth.test over the network. The package's presence is guarded unmocked in
// multibot-registration.test.ts.
vi.mock('@chat-adapter/slack', () => ({
  createSlackAdapter: (config: { botToken?: string; signingSecret?: string }) => {
    const adapter = {
      name: 'slack',
      botToken: config.botToken,
      initialize: async () => {},
      channelIdFromThreadId: (threadId: string) => `slack:${threadId}`,
      isDM: (threadId: string) => threadId.startsWith('D'),
      fetchThread: async () => ({ channelName: null }),
    };
    fixture.adapters.push(adapter);
    return adapter as unknown as Adapter;
  },
}));

// Credential injection. Key-filtered like the real readEnvFile: the factory
// only receives values for the keys it actually asks for.
vi.mock('../env.js', () => ({
  readEnvFile: (keys: string[]) =>
    Object.fromEntries(keys.filter((k) => fixture.env[k] !== undefined).map((k) => [k, fixture.env[k]])),
}));

// Capture the real Chat instances instead of binding the shared webhook
// server. Tip signature: registerWebhookAdapter(chat, adapterName, routingPath)
// — the bridge passes routingPath = instance ?? adapter.name.
vi.mock('../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn((chat: unknown, _adapterName: string, routingPath: string) => {
    fixture.chats.set(routingPath, chat);
  }),
}));

import { closeDb, initTestDb, runMigrations } from '../db/index.js';
import { getChannelAdapterExact, initChannelAdapters, teardownChannelAdapters } from './channel-registry.js';
import { slackBotUserIds } from './slack-bot-ids.js';
import './slack.js'; // real worker module — registers the real (patched) factory
import './slack-supervisor.js'; // real supervisor module
import './slack-tester.js'; // real tester module

const WORKER_ENV = { SLACK_BOT_TOKEN: 'xoxb-test-worker', SLACK_SIGNING_SECRET: 'test-signing-secret' };
const ALL_ENV = {
  ...WORKER_ENV,
  SLACK_SUPERVISOR_BOT_TOKEN: 'xoxb-test-supervisor',
  SLACK_SUPERVISOR_SIGNING_SECRET: 'test-super-secret',
  SLACK_TESTER_BOT_TOKEN: 'xoxb-test-tester',
  SLACK_TESTER_SIGNING_SECRET: 'test-tester-secret',
};
const BOT_USER_BY_TOKEN: Record<string, string> = {
  'xoxb-test-worker': 'U-WORKER-BOT',
  'xoxb-test-supervisor': 'U-SUPER-BOT',
  'xoxb-test-tester': 'U-TESTER-BOT',
};

function makeMessage(authorId: string, text: string, threadId: string): Message {
  return new Message({
    id: `m-${authorId}-${Math.random().toString(36).slice(2, 8)}`,
    threadId,
    text,
    formatted: parseMarkdown(text),
    raw: {},
    author: { userId: authorId, userName: authorId, fullName: authorId, isBot: false, isMe: false },
    metadata: { dateSent: new Date(), edited: false },
    attachments: [],
  });
}

const onInbound = vi.fn();

async function initAdapters() {
  await initChannelAdapters(() => ({
    onInbound,
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
}

function workerChat(): Chat {
  const chat = fixture.chats.get('slack') as Chat;
  expect(chat).toBeTruthy();
  return chat;
}

function workerSdkAdapter(): Adapter {
  // With WORKER_ENV only one factory produces an adapter.
  return fixture.adapters[0] as Adapter;
}

beforeEach(() => {
  fixture.env = {};
  fixture.chats.clear();
  fixture.adapters.length = 0;
  onInbound.mockReset();
  slackBotUserIds.clear();
  const db = initTestDb();
  runMigrations(db);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
      if (String(url).includes('slack.com/api/auth.test')) {
        const token = (init?.headers?.Authorization ?? '').replace('Bearer ', '');
        return { json: async () => ({ ok: true, user_id: BOT_USER_BY_TOKEN[token] ?? 'U-UNKNOWN' }) };
      }
      throw new Error(`unexpected fetch in test: ${String(url)}`);
    }),
  );
});

afterEach(async () => {
  await teardownChannelAdapters();
  closeDb();
  vi.unstubAllGlobals();
});

describe('slack worker bot — slack-bot-ids delta', () => {
  it('factory is inert without SLACK_BOT_TOKEN (reads the token from .env)', async () => {
    fixture.env = {};
    await initAdapters();
    expect(getChannelAdapterExact('slack')).toBeUndefined();
  });

  it('factory registers the worker bot user id in the shared Set via auth.test', async () => {
    fixture.env = { ...WORKER_ENV };
    await initAdapters();
    expect(getChannelAdapterExact('slack')).toBeDefined();
    // `void registerSlackBotUserId(env.SLACK_BOT_TOKEN, 'worker')` is
    // fire-and-forget — wait for the stubbed auth.test round-trip to land.
    await vi.waitFor(() => expect(slackBotUserIds.has('U-WORKER-BOT')).toBe(true));
  });

  it('guard drops sibling-bot messages via the shared Set and forwards humans', async () => {
    fixture.env = { ...WORKER_ENV };
    await initAdapters();
    const bridge = getChannelAdapterExact('slack');
    expect(bridge).toBeDefined();
    const chat = workerChat();

    // Subscribe the thread through the bridge (real state adapter) so both
    // messages take the onSubscribedMessage dispatch path.
    await bridge!.subscribe!('slack:T-1', 'T-1');

    // Added AFTER bridge creation — a sibling adapter (supervisor/tester)
    // registering its bot user id later must still be honored: the guard
    // holds the shared Set by identity and reads it per message.
    slackBotUserIds.add('U-SIBLING');

    chat.processMessage(workerSdkAdapter(), 'T-1', makeMessage('U-SIBLING', 'sibling bot noise', 'T-1'));
    chat.processMessage(workerSdkAdapter(), 'T-1', makeMessage('U-HUMAN', 'real user message', 'T-1'));

    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(1));
    // Give the dropped message's async dispatch time to (not) land.
    await new Promise((r) => setTimeout(r, 100));

    expect(onInbound).toHaveBeenCalledTimes(1);
    const [channelId, threadId, inbound] = onInbound.mock.calls[0];
    expect(channelId).toBe('slack:T-1');
    expect(threadId).toBe('T-1');
    expect(JSON.parse(JSON.stringify(inbound.content)).senderId).toBe('U-HUMAN');
  });

  it('guard covers the DM dispatch path too', async () => {
    fixture.env = { ...WORKER_ENV };
    await initAdapters();
    const chat = workerChat();

    slackBotUserIds.add('U-SIBLING');

    // 'D'-prefixed thread → adapter.isDM() true → Chat SDK dispatches via
    // onDirectMessage. The fork's old three-site bridge hack missed this
    // path; the setup-level wrapper must cover it.
    chat.processMessage(workerSdkAdapter(), 'D-1', makeMessage('U-SIBLING', 'sibling DM noise', 'D-1'));
    chat.processMessage(workerSdkAdapter(), 'D-1', makeMessage('U-HUMAN', 'human DM', 'D-1'));

    await vi.waitFor(() => expect(onInbound).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 100));

    expect(onInbound).toHaveBeenCalledTimes(1);
    const [channelId, , inbound] = onInbound.mock.calls[0];
    expect(channelId).toBe('slack:D-1');
    expect(JSON.parse(JSON.stringify(inbound.content)).senderId).toBe('U-HUMAN');
    expect(inbound.isMention).toBe(true); // DMs are addressed to the bot by definition
  });
});

describe('slack supervisor/tester — instance keying', () => {
  it('all three adapters resolve by EXACT instance key with channelType slack', async () => {
    fixture.env = { ...ALL_ENV };
    await initAdapters();

    const worker = getChannelAdapterExact('slack');
    const supervisor = getChannelAdapterExact('slack-supervisor');
    const tester = getChannelAdapterExact('slack-tester');

    expect(worker).toBeDefined();
    expect(worker!.channelType).toBe('slack');
    expect(worker!.instance).toBeUndefined(); // default instance — keyed by channelType

    expect(supervisor).toBeDefined();
    expect(supervisor!.channelType).toBe('slack');
    expect(supervisor!.instance).toBe('slack-supervisor');

    expect(tester).toBeDefined();
    expect(tester!.channelType).toBe('slack');
    expect(tester!.instance).toBe('slack-tester');

    // No cross-instance identity mixups: three distinct live adapters.
    expect(new Set([worker, supervisor, tester]).size).toBe(3);

    // Each factory registered its own bot user id in the shared Set.
    await vi.waitFor(() => {
      expect(slackBotUserIds.has('U-WORKER-BOT')).toBe(true);
      expect(slackBotUserIds.has('U-SUPER-BOT')).toBe(true);
      expect(slackBotUserIds.has('U-TESTER-BOT')).toBe(true);
    });

    // The tester keeps its resolveChannelName extra; the supervisor ships
    // without one (deliberate asymmetry, ported from the validated fork).
    expect(typeof tester!.resolveChannelName).toBe('function');
    expect(supervisor!.resolveChannelName).toBeUndefined();
  });

  it('a named instance never hijacks the worker key (and vice versa)', async () => {
    fixture.env = { ...WORKER_ENV }; // supervisor/tester unconfigured
    await initAdapters();
    expect(getChannelAdapterExact('slack')).toBeDefined();
    expect(getChannelAdapterExact('slack-supervisor')).toBeUndefined();
    expect(getChannelAdapterExact('slack-tester')).toBeUndefined();
  });
});
