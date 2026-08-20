/**
 * The memory-staleness notice, driven through the real poll loop.
 *
 * staleness.test.ts covers the fingerprint and the notice text; this file
 * covers the wiring decisions the loop owns: which turns get a notice, and
 * when the baseline is written.
 */
import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { clearContinuation, setContinuation } from './db/session-state.js';
import { runPollLoop } from './poll-loop.js';
import type { AgentQuery, QueryInput } from './providers/types.js';

let baseDir: string;

beforeEach(() => {
  initTestSessionDb();
  baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-staleness-loop-'));
});

afterEach(() => {
  closeSessionDb();
  fs.rmSync(baseDir, { recursive: true, force: true });
});

function writeMemory(relPath: string, content: string): void {
  const full = path.join(baseDir, 'memory', relPath);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, content)
       VALUES (?, 'chat', datetime('now'), 'pending', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

/**
 * Closes its stream after each turn's result, so every batch goes through a
 * fresh `query()` — the seam the notice hangs off. MockProvider deliberately
 * holds one stream open across turns (follow-ups arrive via push), which is
 * the case this notice does NOT cover.
 */
class OneTurnProvider {
  readonly supportsNativeSlashCommands = false;
  readonly prompts: string[] = [];

  constructor(private readonly duringTurn?: () => void) {}

  registerMemorySessionHook(): void {}

  isSessionInvalid(): boolean {
    return false;
  }

  query(input: QueryInput): AgentQuery {
    this.prompts.push(input.prompt);
    const duringTurn = this.duringTurn;
    return {
      push() {},
      end() {},
      abort() {},
      events: (async function* () {
        yield { type: 'activity' as const };
        yield { type: 'init' as const, continuation: 'session-1' };
        duringTurn?.();
        yield { type: 'result' as const, text: 'ok' };
      })(),
    };
  }
}

async function runTurns(provider: OneTurnProvider, turns: number): Promise<void> {
  const controller = new AbortController();
  const loop = runPollLoop({
    provider: provider as unknown as Parameters<typeof runPollLoop>[0]['provider'],
    providerName: 'mock',
    cwd: baseDir,
    signal: controller.signal,
  });
  const deadline = Date.now() + 5000;
  while (provider.prompts.length < turns) {
    if (Date.now() > deadline) throw new Error(`only ${provider.prompts.length}/${turns} turns ran`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  controller.abort();
  await loop.catch(() => {});
}

describe('poll loop — memory staleness notice', () => {
  it('names memory files that changed while a resumed conversation was away', async () => {
    writeMemory('index.md', '# Index\n');
    // A resumed conversation: a continuation is on file from a prior container.
    setContinuation('mock', 'session-1');

    const provider = new OneTurnProvider();
    insertMessage('m1', 'what do you know?');
    await runTurns(provider, 1);

    // No baseline existed, so turn 1 only establishes one — no notice yet.
    expect(provider.prompts[0]).not.toContain('<memory_changed>');

    // Someone else edits the tree between turns.
    writeMemory('index.md', '# Index\n- deploys on Fridays are banned\n');
    insertMessage('m2', 'when can we deploy?');
    await runTurns(provider, 2);

    expect(provider.prompts[1]).toContain('<memory_changed>');
    expect(provider.prompts[1]).toContain('modified: memory/index.md');
    // The notice leads; the batch itself still follows intact.
    expect(provider.prompts[1].indexOf('<memory_changed>')).toBe(0);
    expect(provider.prompts[1]).toContain('when can we deploy?');
  });

  it('stays silent when there is no continuation to resume', async () => {
    writeMemory('index.md', '# Index\n');
    const provider = new OneTurnProvider();

    insertMessage('m1', 'first ever message');
    await runTurns(provider, 1);

    // Turn 1 sets a continuation and a baseline. Change the tree, then run a
    // turn whose continuation is cleared: the provider is about to load the
    // whole tree fresh, so a notice would be redundant.
    writeMemory('index.md', '# Index\n- changed\n');
    clearContinuation('mock');

    insertMessage('m2', 'second message');
    await runTurns(provider, 2);

    expect(provider.prompts[1]).not.toContain('<memory_changed>');
  });

  it('stays silent on the next turn when nothing changed', async () => {
    writeMemory('index.md', '# Index\n');
    setContinuation('mock', 'session-1');
    const provider = new OneTurnProvider();

    insertMessage('m1', 'one');
    await runTurns(provider, 1);
    insertMessage('m2', 'two');
    await runTurns(provider, 2);

    expect(provider.prompts[1]).not.toContain('<memory_changed>');
  });

  it('does not report the agent own edits back to it', async () => {
    writeMemory('index.md', '# Index\n');
    setContinuation('mock', 'session-1');

    // The agent writes to memory during its turn — as it does when asked to
    // remember something. That must not come back as a notice next turn.
    const provider = new OneTurnProvider(() => writeMemory('index.md', '# Index\n- learned something\n'));

    insertMessage('m1', 'remember: deploys on Fridays are banned');
    await runTurns(provider, 1);
    insertMessage('m2', 'thanks');
    await runTurns(provider, 2);

    expect(provider.prompts[1]).not.toContain('<memory_changed>');
  });
});
