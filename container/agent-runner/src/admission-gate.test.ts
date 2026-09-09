import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import { evaluateAdmission, registerAdmissionGate, resetAdmissionGatesForTesting } from './admission-gate.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getPendingMessages } from './db/messages-in.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';

beforeEach(() => {
  initTestSessionDb();
  resetAdmissionGatesForTesting();
});

afterEach(() => {
  closeSessionDb();
  resetAdmissionGatesForTesting();
});

describe('admission gate', () => {
  it('runs every registered gate and holds when any holds', () => {
    expect(evaluateAdmission()).toBe(false);

    let secondCalls = 0;
    registerAdmissionGate(() => true);
    registerAdmissionGate(() => {
      secondCalls += 1;
      return false;
    });

    // Both gates ran even though the first already decided the outcome.
    expect(evaluateAdmission()).toBe(true);
    expect(secondCalls).toBe(1);
  });

  it('treats a throwing gate as not holding, and reports it once per distinct message', () => {
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      let laterCalls = 0;
      registerAdmissionGate(() => {
        throw new Error('gate exploded');
      });
      registerAdmissionGate(() => {
        laterCalls += 1;
        return false;
      });

      // The throwing gate never holds admission, and the gate registered
      // after it still runs.
      expect(evaluateAdmission()).toBe(false);
      expect(laterCalls).toBe(1);
      expect(errors.mock.calls.length).toBe(1);

      // Repeating the same failure does not add another log line.
      expect(evaluateAdmission()).toBe(false);
      expect(laterCalls).toBe(2);
      expect(errors.mock.calls.length).toBe(1);

      // A different gate throwing a different message gets its own report.
      registerAdmissionGate(() => {
        throw new Error('gate exploded differently');
      });
      expect(evaluateAdmission()).toBe(false);
      expect(errors.mock.calls.length).toBe(2);
    } finally {
      errors.mockRestore();
    }
  });
});

function insertMessage(id: string, content: object) {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, trigger, platform_id, channel_type, thread_id, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 1, 'chan-1', 'discord', 'thread-1', ?)`,
    )
    .run(id, JSON.stringify(content));
}

async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp', signal }),
    new Promise<void>((_, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')));
    }),
    new Promise<void>((_, reject) => setTimeout(() => reject(new Error('timeout')), timeoutMs)),
  ]);
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe('admission gate — poll loop wiring', () => {
  it('a held gate stops dispatch, and a released gate resumes it', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
      )
      .run();
    insertMessage('m1', { sender: 'Alice', text: 'ping' });

    let held = true;
    registerAdmissionGate(() => held);

    const provider = new MockProvider({}, () => '<message to="discord-test">pong</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 3000);

    // While held, the message is never picked off the queue.
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(getPendingMessages().some((m) => m.id === 'm1')).toBe(true);
    expect(getUndeliveredMessages()).toHaveLength(0);

    // Releasing the gate lets the same still-pending message dispatch.
    held = false;
    await waitFor(() => getUndeliveredMessages().length > 0, 2000);
    controller.abort();

    expect(getPendingMessages().some((m) => m.id === 'm1')).toBe(false);

    await loopPromise.catch(() => {});
  });
});
