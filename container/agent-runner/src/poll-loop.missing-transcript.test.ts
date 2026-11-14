import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { initTestSessionDb, closeSessionDb, getInboundDb } from './mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from './db/messages-out.js';
import { getContinuation, setContinuation } from './db/session-state.js';

// Claude Code deletes transcripts after ~30 days (cleanupPeriodDays), but the
// session keeps the old continuation. The fake SDK below replays what the real
// one does on `resume` of a missing transcript (captured live, SDK 0.3.321):
// one error result, then the iterator throws.

const STALE_ID = '11111111-2222-4333-8444-555555555555';
const FRESH_ID = '66666666-7777-4888-9999-000000000000';
const resumes: Array<string | undefined> = [];
let tmp: string;

function transcriptExists(id: string): boolean {
  const root = path.join(tmp, '.claude', 'projects');
  return fs.readdirSync(root).some((dir) => fs.existsSync(path.join(root, dir, `${id}.jsonl`)));
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: { resume?: string } }) =>
    (async function* () {
      resumes.push(options.resume);
      if (options.resume && !transcriptExists(options.resume)) {
        const error = `No conversation found with session ID: ${options.resume}`;
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: [error] };
        throw new Error(`Claude Code returned an error result: ${error}`);
      }
      const reply = '<message to="discord-test">fresh reply</message>';
      yield { type: 'system', subtype: 'init', session_id: FRESH_ID };
      yield { type: 'assistant', message: { content: [{ type: 'text', text: reply }] } };
      yield { type: 'result', subtype: 'success', is_error: false, result: reply };
    })(),
}));

await import('./providers/index.js');
await import('./provider-contracts/index.js');
const { createProvider } = await import('./providers/factory.js');
const { getProviderRuntimeContract } = await import('./providers/provider-registry.js');
const { MEMORY_SESSION_HOOK } = await import('./memory/session-hook.js');
const { runPollLoop } = await import('./poll-loop.js');

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'missing-transcript-'));
  // The project dir exists (other sessions live there); only this session's transcript is gone.
  fs.mkdirSync(path.join(tmp, '.claude', 'projects', '-workspace-agent'), { recursive: true });
  for (const key of ['HOME', 'CLAUDE_CONFIG_DIR', 'NANOCLAW_CONVERSATIONS_DIR']) savedEnv[key] = process.env[key];
  process.env.HOME = tmp;
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.NANOCLAW_CONVERSATIONS_DIR = path.join(tmp, 'conversations');
  resumes.length = 0;
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('poll loop — continuation whose transcript was deleted', () => {
  it('answers the first message from a fresh session instead of sending "No conversation found"', async () => {
    setContinuation('claude', STALE_ID);
    getInboundDb()
      .prepare(
        `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
         VALUES ('m1', 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
      )
      .run(JSON.stringify({ sender: 'Alice', text: 'are you there?' }));

    const provider = createProvider('claude');
    provider.registerMemorySessionHook!(MEMORY_SESSION_HOOK);
    const controller = new AbortController();
    const loop = runPollLoop({
      provider,
      providerContract: getProviderRuntimeContract('claude'),
      providerName: 'claude',
      cwd: '/workspace/agent',
      signal: controller.signal,
    }).catch(() => {});

    try {
      await waitFor(() => getUndeliveredMessages().length > 0, 3000);
      // Room for a recovery path that answers after an error.
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      controller.abort();
      await loop;
    }

    const texts = getUndeliveredMessages().map((m) => (JSON.parse(m.content) as { text: string }).text);
    expect(texts).toEqual(['fresh reply']);
    expect(resumes).toEqual([undefined]);
    expect(getContinuation('claude')).toBe(FRESH_ID);
  });
});
