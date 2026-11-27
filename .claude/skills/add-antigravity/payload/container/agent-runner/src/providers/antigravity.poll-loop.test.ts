/**
 * The Antigravity provider through the real poll-loop (`processQuery`), with
 * a scripted fake agy child speaking the stream-json protocol. Covers what
 * the provider's unit tests cannot: result-door delivery, follow-ups the
 * poll-loop pushes mid-turn, the wrap-nudge retry, and recovery when agy exits
 * after a failed turn with a follow-up already queued.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ChildProcess } from 'child_process';
import fs from 'fs';
import { EventEmitter } from 'events';
import { PassThrough } from 'stream';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, getOutboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { processQuery } from '../poll-loop.js';
import { antigravityRuntimeOwnership } from './antigravity-config.js';
import { AntigravityProvider, type AntigravityRuntimeDeps } from './antigravity.js';

// The contract core's poll-loop delivers a failed result's `error` field as
// the channel notice; a pre-contract poll-loop delivers only its `text`.
const coreDeliversErrorNotices = fs.existsSync(new URL('../provider-contracts/realize.ts', import.meta.url));

const ROUTING = { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' };
const CONVERSATION = '74791993-7f4a-4c02-ba48-5f12500720f3';
const HOOK = { command: 'true', legacyCommands: [], sources: ['startup'] };

type Script = (prompt: string, child: FakeAgy) => void;

/** A ChildProcess stand-in that hands each user line to a script and exits once stdin closes. */
class FakeAgy extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly prompts: string[] = [];
  private exited = false;
  private initSent = false;

  constructor(
    readonly args: string[],
    script: Script,
  ) {
    super();
    let partial = '';
    this.stdin.on('data', (chunk: Buffer) => {
      partial += chunk.toString();
      const lines = partial.split('\n');
      partial = lines.pop()!;
      for (const line of lines) {
        const prompt = (JSON.parse(line) as { message: { content: string } }).message.content;
        this.prompts.push(prompt);
        setTimeout(() => script(prompt, this), 0);
      }
    });
    // Like agy: closing stdin lets the in-flight turn finish, then it exits 0.
    this.stdin.on('finish', () => setTimeout(() => this.exit(0), 20));
  }

  line(event: unknown): void {
    if (this.exited) return;
    if (!this.initSent) {
      this.initSent = true;
      this.stdout.write(JSON.stringify({ event: 'init', conversation_id: CONVERSATION, init: {} }) + '\n');
    }
    this.stdout.write(JSON.stringify(event) + '\n');
  }

  answer(response: string): void {
    this.line({ event: 'result', result: { conversation_id: CONVERSATION, status: 'SUCCESS', response } });
  }

  fail(error: string): void {
    this.stderr.write(`error: ${error}\n`);
    this.line({ event: 'result', result: { conversation_id: CONVERSATION, status: 'ERROR', response: '', error } });
  }

  kill(): boolean {
    this.exit(0);
    return true;
  }

  exit(code: number): void {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    setTimeout(() => this.emit('close', code, null), 5);
  }
}

function fakeRuntime(scripts: Script[]): { runtime: AntigravityRuntimeDeps; spawned: FakeAgy[] } {
  const spawned: FakeAgy[] = [];
  return {
    spawned,
    runtime: {
      spawnAgy: (args) => {
        const script = scripts[spawned.length] ?? scripts[scripts.length - 1];
        const child = new FakeAgy(args, script);
        spawned.push(child);
        return child as unknown as ChildProcess;
      },
      writeRuntimeFiles: () => {},
      prepareRules: async () => {},
      killGraceMs: 50,
    },
  };
}

function startQuery(runtime: AntigravityRuntimeDeps, prompt: string) {
  const provider = new AntigravityProvider({}, runtime);
  provider.registerMemorySessionHook(HOOK);
  const query = provider.query({ prompt, cwd: '/workspace/agent' });
  const done = processQuery(query, ROUTING, ['m1'], 'antigravity', undefined, prompt, undefined);
  return { query, done };
}

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

/** The poll-loop acknowledges a follow-up once it has pushed it into the live query. */
function pushed(id: string): boolean {
  const row = getOutboundDb().prepare('SELECT status FROM processing_ack WHERE message_id = ?').get(id) as
    { status: string } | undefined;
  return row?.status === 'completed';
}

function delivered(): string[] {
  return getUndeliveredMessages().map((row) => JSON.parse(row.content).text as string);
}

async function waitFor(condition: () => boolean, timeoutMs = 4000): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let previousOwnership: boolean;

beforeEach(() => {
  previousOwnership = antigravityRuntimeOwnership.contractOwnsRuntimeFiles;
  antigravityRuntimeOwnership.contractOwnsRuntimeFiles = false;
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  antigravityRuntimeOwnership.contractOwnsRuntimeFiles = previousOwnership;
  closeSessionDb();
});

describe('AntigravityProvider through the real poll-loop', () => {
  it('delivers the result-door reply exactly once', async () => {
    const { runtime } = fakeRuntime([(_prompt, child) => child.answer('<message to="discord-test">HELLO</message>')]);
    const { query, done } = startQuery(runtime, 'say hello');
    await waitFor(() => delivered().length > 0);
    await new Promise((resolve) => setTimeout(resolve, 100));
    query.end();
    await done;
    expect(delivered()).toEqual(['HELLO']);
  });

  it('answers a follow-up the poll-loop queued during a turn, in order', async () => {
    let releaseFirst!: () => void;
    const { runtime, spawned } = fakeRuntime([
      (prompt, child) => {
        if (child.prompts.length === 1) {
          releaseFirst = () => child.answer('<message to="discord-test">ONE</message>');
        } else {
          expect(prompt).toContain('second question');
          child.answer('<message to="discord-test">TWO</message>');
        }
      },
    ]);
    const { query, done } = startQuery(runtime, 'first question');
    await waitFor(() => spawned[0]?.prompts.length === 1);
    insertMessage('m2', 'second question');
    await waitFor(() => pushed('m2'));
    // Pushed into the query, but held until agy answers the first turn.
    expect(spawned[0].prompts).toHaveLength(1);
    releaseFirst();
    await waitFor(() => delivered().length === 2);
    query.end();
    await done;
    expect(delivered()).toEqual(['ONE', 'TWO']);
    expect(spawned).toHaveLength(1);
  });

  it('accepts the wrapping nudge and delivers the retried envelope', async () => {
    const { runtime, spawned } = fakeRuntime([
      (prompt, child) => {
        if (child.prompts.length === 1) child.answer('bare text with no envelope');
        else {
          expect(prompt).toContain('was not delivered');
          child.answer('<message to="discord-test">WRAP_OK</message>');
        }
      },
    ]);
    const { query, done } = startQuery(runtime, 'say hi');
    await waitFor(() => delivered().length > 0);
    query.end();
    await done;
    expect(spawned[0].prompts).toHaveLength(2);
    expect(delivered()).toEqual(['WRAP_OK']);
  });

  it('recovers a follow-up queued behind a failed turn after agy exits with code 3', async () => {
    let failFirst!: () => void;
    const { runtime, spawned } = fakeRuntime([
      (_prompt, child) => {
        if (child.prompts.length === 1) failFirst = () => child.fail('Error 400, Message: API key not valid.');
        // agy reads the queued line, then exits 3 after the HTTP 400.
        else child.exit(3);
      },
      (prompt, child) => {
        expect(prompt).toContain('second question');
        child.answer('<message to="discord-test">TWO</message>');
      },
    ]);
    const { query, done } = startQuery(runtime, 'first question');
    await waitFor(() => spawned[0]?.prompts.length === 1);
    insertMessage('m2', 'second question');
    await waitFor(() => pushed('m2'));
    failFirst();
    await waitFor(() => delivered().includes('TWO'));
    query.end();
    await done;

    if (coreDeliversErrorNotices) {
      const [notice, reply] = delivered();
      expect(notice).toContain('could not authenticate with the Gemini API');
      expect(reply).toBe('TWO');
    } else {
      // A pre-contract poll-loop delivers only a failed result's `text`.
      expect(delivered()).toEqual(['TWO']);
    }
    expect(spawned).toHaveLength(2);
    expect(spawned[1].args.slice(-2)).toEqual(['--conversation', CONVERSATION]);
  });
});
