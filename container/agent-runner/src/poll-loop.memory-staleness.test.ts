/**
 * The wiring the poll loop owns: which turns carry a memory notice, and that
 * the marker is re-stamped afterwards. staleness.test.ts covers the detection
 * itself; this covers the seam — including that the check is scoped to the
 * session's cwd rather than a hardcoded path.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { getInboundDb } from './mailbox/sqlite/connection.js';
import { clearContinuation, setContinuation } from './db/session-state.js';
import { markMemoryLoaded } from './memory/staleness.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentQuery, QueryInput } from './providers/types.js';

let base: string;
let marker: string;

beforeEach(() => {
  initTestSessionDb();
  base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-staleness-loop-'));
  marker = path.join(base, '.memory-loaded');
  fs.mkdirSync(path.join(base, 'memory'), { recursive: true });
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(base, { recursive: true, force: true });
});

function writeMemory(rel: string, body: string): void {
  const full = path.join(base, 'memory', rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

/** Closes its stream per turn, so each batch goes through a fresh query(). */
class OneTurnProvider {
  readonly supportsNativeSlashCommands = false;
  readonly prompts: string[] = [];
  registerMemorySessionHook(): void {}
  isSessionInvalid(): boolean {
    return false;
  }
  query(input: QueryInput): AgentQuery {
    this.prompts.push(input.prompt);
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'session-1' };
        yield { type: 'result' as const, text: 'ok' };
      })(),
    };
  }
}

async function runTurn(provider: OneTurnProvider): Promise<void> {
  const want = provider.prompts.length + 1;
  const controller = new AbortController();
  const loop = runPollLoop({
    provider: provider as unknown as Parameters<typeof runPollLoop>[0]['provider'],
    providerName: 'mock',
    cwd: base,
    memoryMarker: marker,
    signal: controller.signal,
  });
  const deadline = Date.now() + 5000;
  while (provider.prompts.length < want) {
    if (Date.now() > deadline) throw new Error('turn never ran');
    await new Promise((r) => setTimeout(r, 20));
  }
  controller.abort();
  await loop.catch(() => {});
}

describe('poll loop — memory staleness notice', () => {
  it('names a file changed while a resumed conversation was away', async () => {
    writeMemory('index.md', '# Index\n');
    markMemoryLoaded(marker);
    setContinuation('mock', 'session-1');
    // Someone else edits the tree after this conversation loaded it.
    await new Promise((r) => setTimeout(r, 15));
    writeMemory('index.md', '# Index\n- deploys on Fridays are banned\n');

    const provider = new OneTurnProvider();
    insertMessage('m1', 'when can we deploy?');
    await runTurn(provider);

    expect(provider.prompts[0]).toContain('<memory_changed>');
    expect(provider.prompts[0]).toContain('memory/index.md');
    expect(provider.prompts[0].indexOf('<memory_changed>')).toBe(0);
    expect(provider.prompts[0]).toContain('when can we deploy?');
  });

  it('stays silent without a continuation, and re-stamps so it fires once', async () => {
    writeMemory('index.md', '# Index\n');
    markMemoryLoaded(marker);
    clearContinuation('mock');
    await new Promise((r) => setTimeout(r, 15));
    writeMemory('index.md', '# Index\n- changed\n');

    const provider = new OneTurnProvider();
    insertMessage('m1', 'first');
    await runTurn(provider);
    // No continuation: memory is about to load fresh, so no notice.
    expect(provider.prompts[0]).not.toContain('<memory_changed>');

    // That turn set a continuation and re-stamped the marker, so the same
    // edit is not reported again on the next turn.
    insertMessage('m2', 'second');
    await runTurn(provider);
    expect(provider.prompts[1]).not.toContain('<memory_changed>');
  });
});
