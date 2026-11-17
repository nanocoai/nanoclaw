/**
 * The wake-context seam through the REAL routeInbound path and real session
 * mailboxes: what core guarantees every registered provider.
 */
import fs from 'fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ChannelAdapter, ChannelDefaults } from './channels/adapter.js';
import { initChannelAdapters, registerChannelAdapter, teardownChannelAdapters } from './channels/channel-registry.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createMessagingGroupAgent,
  getAgentGroup,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  initTestDb,
  runMigrations,
} from './db/index.js';
import { findSessionForAgent } from './db/sessions.js';
import { inboundDbPath } from './mailbox/sqlite/paths.js';
import { settleEchoFans } from './modules/cross-session-context/index.js';
import { routeInbound } from './router.js';
import {
  gatherWakeContext,
  registerWakeContext,
  type ContextBlock,
  type ContextLine,
  type WakeContextInput,
} from './wake-context.js';

const TEST_DIR = '/tmp/nanoclaw-test-wake-context';

vi.mock('./container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(true),
  isContainerRunning: vi.fn().mockReturnValue(false),
  getActiveContainerCount: vi.fn().mockReturnValue(0),
  killContainer: vi.fn(),
}));
// Lets a test make the backfill throw: an exit between taking the write turn and the write.
const backfill = vi.hoisted(() => ({ fail: false }));
vi.mock('./modules/cross-session-context/index.js', async () => {
  const actual = await vi.importActual<typeof import('./modules/cross-session-context/index.js')>(
    './modules/cross-session-context/index.js',
  );
  return {
    ...actual,
    backfillSession: (async (...args: Parameters<typeof actual.backfillSession>) => {
      if (backfill.fail) throw new Error('left before the write');
      return actual.backfillSession(...args);
    }) as typeof actual.backfillSession,
  };
});
vi.mock('./config.js', async () => ({
  ...(await vi.importActual<object>('./config.js')),
  DATA_DIR: '/tmp/nanoclaw-test-wake-context',
}));

type Provider = (input: WakeContextInput) => Promise<ContextBlock[]>;
const providers: { first: Provider; second: Provider } = { first: async () => [], second: async () => [] };
const calls = { first: 0, second: 0 };
registerWakeContext('first', (input) => {
  calls.first++;
  return providers.first(input);
});
registerWakeContext('second', (input) => {
  calls.second++;
  return providers.second(input);
});

const T0 = Date.now() - 60 * 60 * 1000;
const at = (minutes: number) => new Date(T0 + minutes * 60_000).toISOString();
const THREAD = 'testchat:C1:100';

function block(key: string, tag: string, text: string): ContextBlock {
  return { key, tag, about: `what ${tag} holds`, lines: [{ id: `${key}-1`, sender: 'Dana', time: at(1), text }] };
}

const defaults: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'platform',
};

function adapter(): ChannelAdapter {
  return {
    name: 'testchat',
    channelType: 'testchat',
    supportsThreads: true,
    defaults,
    setup: async () => {},
    teardown: async () => {},
    isConnected: () => true,
    deliver: async () => undefined,
  };
}

async function send(id: string, minutes: number, text = `message ${id}`): Promise<void> {
  await routeInbound({
    channelType: 'testchat',
    platformId: 'testchat:C1',
    threadId: THREAD,
    message: {
      id,
      kind: 'chat-sdk',
      content: JSON.stringify({ id, sender: 'Alex', senderId: 'U1', text }),
      timestamp: at(minutes),
      isMention: true,
      isGroup: true,
    },
  });
}

async function input(triggerId: string): Promise<WakeContextInput> {
  return {
    agentGroup: (await getAgentGroup('ag-1'))!,
    session: (await findSessionForAgent('ag-1', 'mg-1', THREAD))!,
    mg: (await getMessagingGroup('mg-1'))!,
    wiring: (await getMessagingGroupAgentByPair('mg-1', 'ag-1'))!,
    created: false,
    trigger: { id: triggerId, timestamp: at(30) },
  };
}

async function stored(): Promise<Array<{ id: string; block?: ContextBlock }>> {
  const session = (await findSessionForAgent('ag-1', 'mg-1', THREAD))!;
  const db = new Database(inboundDbPath('ag-1', session.id), { readonly: true });
  try {
    const found = db.prepare('SELECT id, content FROM messages_in ORDER BY seq').all() as Array<{
      id: string;
      content: string;
    }>;
    return found.map((r) => ({ id: r.id, block: JSON.parse(r.content).block as ContextBlock | undefined }));
  } finally {
    db.close();
  }
}

/** The session's rows in order: a block by its tag, a message by its id. */
async function rows(): Promise<string[]> {
  return (await stored()).map((r) => r.block?.tag ?? r.id);
}

beforeEach(async () => {
  providers.first = async () => [];
  providers.second = async () => [];
  calls.first = 0;
  calls.second = 0;
  backfill.fail = false;
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'ag-1', name: 'Pip', folder: 'pip', agent_provider: null, created_at: at(0) });
  await createMessagingGroup({
    id: 'mg-1',
    channel_type: 'testchat',
    platform_id: 'testchat:C1',
    instance: 'testchat',
    name: 'Team room',
    is_group: 1,
    unknown_sender_policy: 'public',
    created_at: at(0),
  });
  await createMessagingGroupAgent({
    id: 'mga-1',
    messaging_group_id: 'mg-1',
    agent_group_id: 'ag-1',
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'drop',
    session_mode: 'per-thread',
    priority: 0,
    threads: 1,
    created_at: at(0),
  });
  registerChannelAdapter('testchat', { factory: () => adapter(), defaults });
  await initChannelAdapters(() => ({
    onInbound: () => {},
    onInboundEvent: () => {},
    onMetadata: () => {},
    onAction: () => {},
  }));
});

afterEach(async () => {
  await settleEchoFans();
  await teardownChannelAdapters();
  await closeDb();
  fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

describe('wake context', () => {
  it('writes nothing more than the message when providers have nothing', async () => {
    await send('m1', 5);

    expect(calls).toEqual({ first: 1, second: 1 });
    expect(await rows()).toEqual(['m1:ag-1']);
  });

  it('writes each block as one row before the message, in the order providers registered', async () => {
    providers.first = async () => [block('a', 'alpha', 'first block')];
    providers.second = async () => [block('b', 'beta', 'second block')];

    await send('m1', 5);

    expect(await rows()).toEqual(['alpha', 'beta', 'm1:ag-1']);
  });

  it('lets a slow provider cost neither the message nor another block; its block follows, and it is not run again meanwhile', async () => {
    await send('m1', 5);
    let finish: (blocks: ContextBlock[]) => void = () => {};
    providers.first = () => new Promise((resolve) => (finish = resolve));
    providers.second = async () => [block('b', 'beta', 'on time')];

    await gatherWakeContext(await input('m2'), 50);
    expect(await rows()).toEqual(['m1:ag-1', 'beta']);

    await gatherWakeContext(await input('m3'), 50);
    expect(calls.first).toBe(2); // the wake of m1, then m2; skipped for m3 while still running

    finish([block('a', 'alpha', 'late')]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await rows()).toEqual(['m1:ag-1', 'beta', 'beta', 'alpha']);
  });

  it('writes a later message after an earlier one still waiting for its context', async () => {
    providers.first = async (wake) => {
      if (wake.trigger.id !== 'm1') return [];
      await new Promise((resolve) => setTimeout(resolve, 300));
      return [block('a', 'alpha', 'for the first message')];
    };

    const first = send('m1', 5);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await send('m2', 6);
    await first;

    expect(await rows()).toEqual(['alpha', 'm1:ag-1', 'm2:ag-1']);
  });

  it("lets the session's next message through when an earlier one leaves before its write", async () => {
    backfill.fail = true;
    await send('m1', 5).catch(() => {});
    backfill.fail = false;

    await send('m2', 6);

    expect(await rows()).toEqual(['m2:ag-1']);
  });

  it("stores only the block's contract: a line's raw or any other extra field never reaches the row, and a malformed block or line costs only itself", async () => {
    providers.first = async () => [
      { key: 'broken', tag: 'broken' } as ContextBlock,
      {
        key: 'a',
        tag: 'alpha',
        about: 'what alpha holds',
        debug: 'not stored',
        lines: [
          { id: 'L1', sender: 'Dana', time: at(1), text: 'kept', raw: { files: ['private'] }, senderId: 'U2' },
          null,
        ] as unknown as ContextLine[],
        state: { left: ['L0'] },
      } as ContextBlock,
    ];
    providers.second = async () => [block('b', 'beta', 'also kept')];

    await send('m1', 5);

    expect((await stored()).flatMap((r) => (r.block ? [r.block] : []))).toEqual([
      {
        key: 'a',
        tag: 'alpha',
        about: 'what alpha holds',
        lines: [{ id: 'L1', sender: 'Dana', time: at(1), text: 'kept' }],
        state: { left: ['L0'] },
      },
      {
        key: 'b',
        tag: 'beta',
        about: 'what beta holds',
        lines: [{ id: 'b-1', sender: 'Dana', time: at(1), text: 'also kept' }],
      },
    ]);
  });

  it('runs no provider for a slash command, so the runner still takes it as one', async () => {
    providers.first = async () => [block('a', 'alpha', 'never ahead of a command')];

    await send('m1', 5, '/mycmd hello');

    expect(calls.first).toBe(0);
    expect(await rows()).toEqual(['m1:ag-1']);
  });

  it("keeps two providers' blocks apart even when they use the same key", async () => {
    providers.first = async () => [block('recent', 'alpha', 'from the first')];
    providers.second = async () => [block('recent', 'beta', 'from the second')];

    await send('m1', 5);

    expect(await rows()).toEqual(['alpha', 'beta', 'm1:ag-1']);
  });

  it('keeps one provider failing, at once or later, from costing the other its block', async () => {
    providers.first = (() => {
      throw new Error('broken at once');
    }) as unknown as Provider;
    providers.second = async () => [block('b', 'beta', 'still here')];
    await send('m1', 5);

    providers.first = async () => {
      throw new Error('broken later');
    };
    await gatherWakeContext(await input('m2'));

    expect(await rows()).toEqual(['beta', 'm1:ag-1', 'beta']);
  });

  it('writes a block once per message, and drops a block whose tag could carry markup', async () => {
    await send('m1', 5);
    providers.first = async () => [block('a', 'alpha', 'once')];
    providers.second = async () => [block('x', 'x"><injected', 'never shown'), block('y:z', 'gamma', 'bad key')];

    await gatherWakeContext(await input('m2'));
    await gatherWakeContext(await input('m2'));

    expect(await rows()).toEqual(['m1:ag-1', 'alpha']);
  });
});
