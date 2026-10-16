import { expect, test } from 'bun:test';

import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { registerDueTaskRowHooks, DUE_TASK_ROW_SEAM } from './provider-contracts/due-task-rows.js';
import { runPollLoop } from './poll-loop.js';

test('provider-owned due task rows skip the runner log only when begin() returns non-null', async () => {
  expect(DUE_TASK_ROW_SEAM).toBe(1);
  const seen: string[] = [];
  registerDueTaskRowHooks('seam-probe', {
    begin() {
      return { owned: true };
    },
    noteFollowUpRows() {},
    onErrorEvent() {},
    onResultEvent() {},
    decideResult(_turn: unknown, text: string | null) {
      seen.push(text ?? '');
    },
    decideError() {},
    markHandled() {},
    isHandled: () => true,
    finish() {},
  });

  async function once(id: string, contractTurn: Record<string, string> | undefined) {
    initTestSessionDb();
    try {
      getInboundDb()
        .prepare(
          `INSERT INTO messages_in (id, kind, timestamp, status, process_after, trigger, platform_id, channel_type, thread_id, content)
           VALUES (?, 'task', datetime('now'), 'pending', datetime('now'), 1, 'C1', 'slack', NULL, ?)`,
        )
        .run(id, JSON.stringify({ prompt: 'ping' }));
      let prompts = 0;
      const controller = new AbortController();
      const loop = runPollLoop({
        provider: {
          registerMemorySessionHook() {},
          isSessionInvalid: () => false,
          query() {
            prompts += 1;
            return {
              push() {},
              end() {},
              abort() {},
              events: {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'result', text: 'owned visible text', isError: false };
                },
              },
            };
          },
        },
        providerContract: {
          textDelivery: 'result',
          commands: { formatting: 'xml' },
          turn: contractTurn,
        },
        providerName: 'seam-probe',
        cwd: process.cwd(),
        signal: controller.signal,
      });
      const start = Date.now();
      while (prompts < 1 && Date.now() - start < 4000) await new Promise((r) => setTimeout(r, 40));
      await new Promise((r) => setTimeout(r, 200));
      controller.abort();
      await Promise.race([loop.catch(() => {}), new Promise((r) => setTimeout(r, 1000))]);
      return getOutboundDb().prepare('SELECT kind, content FROM messages_out').all() as Array<{
        kind: string;
        content: string;
      }>;
    } finally {
      closeSessionDb();
    }
  }

  const owned = await once('owned', { dueTaskRows: 'provider' });
  expect(owned.some((row) => row.kind === 'task_log')).toBe(false);
  expect(seen.some((text) => text.includes('owned visible text'))).toBe(true);

  const historical = await once('historical', undefined);
  expect(historical.some((row) => row.kind === 'task_log')).toBe(true);
}, 15000);
