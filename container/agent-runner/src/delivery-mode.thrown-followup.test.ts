import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import type { DeliveryMode } from './config.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages, writeMessageOut } from './db/messages-out.js';
import {
  clearCurrentReplyRoute,
  clearTurnOutboundBaseline,
  getCurrentInReplyTo,
  getContinuation,
  setContinuation,
} from './db/session-state.js';
import { getAgentMailbox } from './mailbox/index.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { runPollLoop, TOOLS_ONLY_ERROR_NOTICE } from './poll-loop.js';
import type { AgentProvider, ProviderEvent, ProviderExchange } from './providers/types.js';

const CHANNEL = { platformId: 'channel-1', channelType: 'mattermost' };
const DIAGNOSTIC = 'Native provider failed with private upstream diagnostic';

function insertInbound(id: string, threadId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in
       (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', ?, 'pending', 1, ?, ?, ?, ?)`,
    )
    .run(id, new Date().toISOString(), CHANNEL.platformId, CHANNEL.channelType, threadId, JSON.stringify({ text: id }));
}

function answer(id: string, threadId: string): Promise<number> {
  return writeMessageOut({
    id: `answer-${id}`,
    in_reply_to: id,
    kind: 'chat',
    platform_id: CHANNEL.platformId,
    channel_type: CHANNEL.channelType,
    thread_id: threadId,
    content: JSON.stringify({ text: `Answered ${id}` }),
  });
}

function visibleRows() {
  return getUndeliveredMessages().filter((row) => row.kind === 'chat');
}

beforeEach(() => {
  initTestSessionDb();
  getInboundDb().exec(
    `CREATE TABLE session_routing (
       id INTEGER PRIMARY KEY CHECK (id = 1),
       channel_type TEXT,
       platform_id TEXT,
       thread_id TEXT
     );
     INSERT INTO session_routing VALUES (1, 'mattermost', 'channel-1', NULL)`,
  );
});

afterEach(() => {
  clearCurrentReplyRoute();
  clearTurnOutboundBaseline();
  closeSessionDb();
});

/** A is answered, then a real active poll claims the follow-ups before the provider throws. */
async function failAfterFollowups(
  deliveryMode: DeliveryMode,
  followups: Array<{ id: string; threadId: string }>,
  answered = false,
  openingResult = true,
  options: { beforeThrow?: () => void; cancelBeforeThrow?: boolean } = {},
) {
  insertInbound('request-a', 'thread-a');
  setContinuation('mock', 'previous-session');
  let recovered: unknown;
  const controller = new AbortController();
  const exchanges: ProviderExchange[] = [];
  const pushes: string[] = [];
  let routeAtFailure: string | null = null;
  let acceptPush: (() => void) | undefined;
  const pushed = new Promise<void>((resolve) => {
    acceptPush = resolve;
  });
  const failure = new Error(DIAGNOSTIC);
  const provider: AgentProvider = {
    registerMemorySessionHook: () => {},
    isSessionInvalid: (error) => {
      recovered = error;
      return true;
    },
    onExchangeComplete: (exchange) => {
      exchanges.push(exchange);
      if (exchange.status === 'error') controller.abort();
    },
    query: () => {
      async function* events(): AsyncGenerator<ProviderEvent> {
        await answer('request-a', 'thread-a');
        if (openingResult) yield { type: 'result', text: '' };
        for (const followup of followups) insertInbound(followup.id, followup.threadId);
        await pushed;
        routeAtFailure = getCurrentInReplyTo();
        if (answered) {
          for (const followup of followups) await answer(followup.id, followup.threadId);
        }
        options.beforeThrow?.();
        if (options.cancelBeforeThrow) controller.abort();
        throw failure;
      }
      return {
        events: events(),
        push: (text) => {
          pushes.push(text);
          acceptPush?.();
        },
        end: () => {},
        abort: () => {},
      };
    },
  };
  const timeout = setTimeout(() => {
    controller.abort();
    acceptPush?.();
  }, 3000);
  try {
    await runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/workspace/agent',
      deliveryMode,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeout);
  }
  expect(recovered).toBe(failure);
  expect(getContinuation('mock')).toBeUndefined();
  expect(pushes).toHaveLength(1);
  for (const followup of followups) expect(pushes[0]).toContain(followup.id);
  expect(routeAtFailure).toBe(openingResult ? followups.at(-1)!.id : 'request-a');
  expect(exchanges.filter((exchange) => exchange.status === 'error')).toHaveLength(1);
  expect(exchanges.at(-1)!.result).toContain(DIAGNOSTIC);
  expect(getPendingMessages()).toEqual([]);
  expect(
    visibleRows()
      .map((row) => row.content)
      .join('\n'),
  ).not.toContain(DIAGNOSTIC);
}

describe('tools-only thrown provider failure after a follow-up', () => {
  const mode = 'tools-only';
  const notice = TOOLS_ONLY_ERROR_NOTICE;

  it('retains the provider error after a failed notice write and still notices the next address', async () => {
    let restore: (() => void) | undefined;
    try {
      await failAfterFollowups(
        mode,
        [
          { id: 'request-b', threadId: 'thread-b' },
          { id: 'request-d', threadId: 'thread-d' },
        ],
        false,
        true,
        {
          beforeThrow: () => {
            const write = spyOn(getAgentMailbox().operations, 'writeMessageOut').mockRejectedValueOnce(
              new Error('Mailbox notice write rejected'),
            );
            restore = () => write.mockRestore();
          },
        },
      );
      expect(visibleRows().map((row) => [JSON.parse(row.content).text, row.thread_id])).toEqual([
        ['Answered request-a', 'thread-a'],
        [notice, 'thread-d'],
      ]);
    } finally {
      restore?.();
    }
  });

  it('retains the provider error when delivery reconciliation cannot read the mailbox', async () => {
    let restore: (() => void) | undefined;
    try {
      await failAfterFollowups(mode, [{ id: 'request-b', threadId: 'thread-b' }], false, true, {
        beforeThrow: () => {
          const read = spyOn(getAgentMailbox().operations, 'getUndeliveredMessages').mockImplementationOnce(() => {
            throw new Error('Mailbox delivery read rejected');
          });
          restore = () => read.mockRestore();
        },
      });
      // The delivery state is unknown: do not guess which requests still need a notice.
      expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a']);
    } finally {
      restore?.();
    }
  });

  it('does not send a failure notice when the active query was explicitly cancelled', async () => {
    await failAfterFollowups(mode, [{ id: 'request-b', threadId: 'thread-b' }], false, true, {
      cancelBeforeThrow: true,
    });
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a']);
  });

  for (const threadId of ['thread-a', 'thread-b']) {
    it(`notifies the unanswered follow-up in ${threadId}, without re-notifying the answered opening request`, async () => {
      await failAfterFollowups(mode, [{ id: 'request-b', threadId }]);
      expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a', notice]);
      expect(visibleRows()[1]).toMatchObject({
        in_reply_to: 'request-b',
        platform_id: CHANNEL.platformId,
        channel_type: CHANNEL.channelType,
        thread_id: threadId,
      });
    });
  }

  it('also notices a follow-up still queued behind an opening turn whose result never arrived', async () => {
    await failAfterFollowups(mode, [{ id: 'request-b', threadId: 'thread-b' }], false, false);
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a', notice]);
    expect(visibleRows()[1]).toMatchObject({ in_reply_to: 'request-b', thread_id: 'thread-b' });
  });

  it('sends no failure notice when the follow-up already delivered before throwing', async () => {
    await failAfterFollowups(mode, [{ id: 'request-b', threadId: 'thread-b' }], true);
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual([
      'Answered request-a',
      'Answered request-b',
    ]);
  });

  it('notifies every still-waiting address once when the claimed batch has several requests', async () => {
    await failAfterFollowups(mode, [
      { id: 'request-b', threadId: 'thread-b' },
      { id: 'request-c', threadId: 'thread-b' },
      { id: 'request-d', threadId: 'thread-d' },
    ]);
    expect(visibleRows().map((row) => JSON.parse(row.content).text)).toEqual(['Answered request-a', notice, notice]);
    expect(
      visibleRows()
        .slice(1)
        .map((row) => row.thread_id),
    ).toEqual(['thread-b', 'thread-d']);
  });
});

for (const mode of ['envelope', 'tools-only'] as const) {
  it(`${mode} does not report slash-command cancellation as a provider failure`, async () => {
    insertInbound('request-a', 'thread-a');
    const controller = new AbortController();
    let release: () => void = () => {};
    const aborted = new Promise<void>((resolve) => {
      release = resolve;
    });
    const provider: AgentProvider = {
      registerMemorySessionHook: () => {},
      isSessionInvalid: () => false,
      query: () => ({
        events: (async function* (): AsyncGenerator<ProviderEvent> {
          yield { type: 'init', continuation: 'cancel-session' };
          insertInbound('clear-command', 'thread-b');
          getInboundDb()
            .prepare('UPDATE messages_in SET content = ? WHERE id = ?')
            .run(JSON.stringify({ text: '/clear' }), 'clear-command');
          await aborted;
          throw new Error(DIAGNOSTIC);
        })(),
        push: () => {},
        end: () => {},
        abort: release,
      }),
    };
    const loop = runPollLoop({
      provider,
      providerName: 'mock',
      cwd: '/workspace/agent',
      deliveryMode: mode,
      signal: controller.signal,
    });
    try {
      const deadline = Date.now() + 2500;
      while (!visibleRows().some((row) => JSON.parse(row.content).text === 'Session cleared.')) {
        if (Date.now() >= deadline) throw new Error('Timed out waiting for the clear command');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      controller.abort();
      await loop;
    }
    expect(visibleRows().map((row) => [JSON.parse(row.content).text, row.thread_id])).toEqual([
      ['Session cleared.', 'thread-b'],
    ]);
  });
}
