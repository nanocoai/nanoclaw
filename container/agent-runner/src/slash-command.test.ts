import { describe, it, expect, beforeEach, afterEach } from 'bun:test';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import type { MessageInRow } from './db/messages-in.js';
import { categorizeMessage, isClearCommand } from './formatter.js';
import { MockProvider } from './providers/mock.js';
import { runPollLoop } from './poll-loop.js';
import { isUploadTraceCommand } from './upload-trace.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const chat = (text: string) =>
  ({ kind: 'chat', channel_type: 'telegram', content: JSON.stringify({ text }) }) as MessageInRow;

// Mirror of the corpus in src/command-gate.test.ts: the host gate denies a
// non-admin exactly the rows the runner executes here.
const RUNNER_COMMAND_CORPUS: Array<[string, '/clear' | '/upload-trace' | null]> = [
  ['/clear', '/clear'],
  ['/CLEAR', '/clear'],
  ['  /clear now ', '/clear'],
  ['/clear@somebot', '/clear'],
  ['/CLEAR@Bot', '/clear'],
  ['/clear@somebot please', '/clear'],
  ['/clear\tnow', '/clear'],
  ['/clear\nnow', '/clear'],
  ['/clearx', null],
  ['/clear.', null],
  ['/clear-', null],
  ['/clear_all', null],
  ['/clear@', null],
  ['/clear@bot.', null],
  ['/clear@bot/x', null],
  ['/upload-trace', '/upload-trace'],
  ['/upload-trace@somebot', '/upload-trace'],
  ['/UPLOAD-TRACE now', '/upload-trace'],
  ['/upload-tracex', null],
  ['/upload-trace.', null],
  ['/upload', null],
  ['clear', null],
  ['hello /clear', null],
];

describe('runner command names match the host gate', () => {
  it.each(RUNNER_COMMAND_CORPUS)('%j', (text, executes) => {
    expect(isClearCommand(chat(text))).toBe(executes === '/clear');
    expect(isUploadTraceCommand(chat(text))).toBe(executes === '/upload-trace');
  });

  it.each([
    ['/compact@somebot', 'admin', '/compact', '/compact'],
    ['/compact@SomeBot keep the plan', 'admin', '/compact', '/compact keep the plan'],
    ['/Reset@bot', 'admin', '/reset', '/Reset'],
    ['/myskill@bot run', 'passthrough', '/myskill', '/myskill run'],
    ['/a/b@2026/c.md explain', 'passthrough', '/a/b@2026/c.md', '/a/b@2026/c.md explain'],
  ])('categorizes %j by its canonical name and dispatches it without the suffix', (text, category, command, sent) => {
    const info = categorizeMessage(chat(text), 'claude');
    expect([info.category, info.command, info.text]).toEqual([category, command, sent]);
  });
});

describe('poll loop — suffixed /clear', () => {
  it('clears on /clear@botname', async () => {
    insertChat('m-clear', '/clear@somebot');
    const provider = new MockProvider({}, () => '<message to="discord-test">should not run</message>');
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    await waitFor(() => getUndeliveredMessages().length > 0, 5000);
    controller.abort();

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts).toEqual(['Session cleared.']);
    await loopPromise.catch(() => {});
  });

  it('does not clear on a longer name that starts with /clear', async () => {
    insertChat('m-clearx', '/clearx');
    let queried = false;
    const provider = new MockProvider({}, () => {
      queried = true;
      return '';
    });
    const controller = new AbortController();
    const loopPromise = runPollLoopWithTimeout(provider, controller.signal, 5000);

    await waitFor(() => queried, 5000);
    controller.abort();

    const texts = getUndeliveredMessages().map((m) => JSON.parse(m.content).text);
    expect(texts).not.toContain('Session cleared.');
    await loopPromise.catch(() => {});
  });
});

function insertChat(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'telegram', ?)`,
    )
    .run(id, JSON.stringify({ text }));
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
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
