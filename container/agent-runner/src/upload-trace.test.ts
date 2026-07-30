import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './db/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getPendingMessages } from './db/messages-in.js';
import type { MessageInRow } from './db/messages-in.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { isUploadTraceCommand } from './upload-trace.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

describe('isUploadTraceCommand', () => {
  const make = (text: unknown) => ({ content: JSON.stringify({ text }) }) as MessageInRow;

  it('matches /upload-trace (case-insensitive, with args)', () => {
    expect(isUploadTraceCommand(make('/upload-trace'))).toBe(true);
    expect(isUploadTraceCommand(make('/UPLOAD-TRACE'))).toBe(true);
    expect(isUploadTraceCommand(make('  /upload-trace now '))).toBe(true);
  });

  it('does not match other text or commands', () => {
    expect(isUploadTraceCommand(make('hello'))).toBe(false);
    expect(isUploadTraceCommand(make('/upload'))).toBe(false);
    expect(isUploadTraceCommand(make('/clear'))).toBe(false);
    expect(isUploadTraceCommand({ content: 'not json' } as MessageInRow)).toBe(false);
  });
});

describe('poll loop — /upload-trace command', () => {
  it('handles the command in the runner, writes a status, skips query', async () => {
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m-upload-trace', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ text: '/upload-trace' }));

    // If the provider were ever queried it would emit this — asserting its
    // absence proves the runner intercepted /upload-trace instead of the LLM.
    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    await waitFor(() => getUndeliveredMessages().length > 0, 5000);
    controller.abort();

    const out = getUndeliveredMessages();
    expect(out).toHaveLength(1);
    // A status line from uploadTrace() — never the provider's reply.
    const text = JSON.parse(out[0].content).text as string;
    expect(text.length).toBeGreaterThan(0);
    expect(text).not.toBe('should not run');

    // Command message was completed (not left pending).
    expect(getPendingMessages()).toHaveLength(0);

    await loopPromise.catch(() => {});
  });
});

async function runPollLoopWithTimeout(provider: MockProvider, signal: AbortSignal, timeoutMs: number): Promise<void> {
  return Promise.race([
    runPollLoop({ provider, providerName: 'mock', cwd: '/tmp' }),
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
