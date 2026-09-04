import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

import { AgentNotFoundError } from '@cursor/sdk';

import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { getContinuation, setContinuation } from '../db/session-state.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';
import { processQuery, runPollLoop } from '../poll-loop.js';
import { CursorProvider, cursorAgentApi } from './cursor.js';

const TEST_ROOT = path.join(import.meta.dir, '..', '..', '.tmp-cursor-poll-loop');
const ROUTING = {
  platformId: 'chan-1',
  channelType: 'discord',
  threadId: null,
  inReplyTo: 'm1',
};

let previousHome: string | undefined;
let previousAgentDir: string | undefined;

beforeEach(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  previousHome = process.env.HOME;
  previousAgentDir = process.env.NANOCLAW_AGENT_DIR;
  process.env.HOME = fs.mkdtempSync(path.join(TEST_ROOT, 'home-'));
  process.env.NANOCLAW_AGENT_DIR = fs.mkdtempSync(path.join(TEST_ROOT, 'agent-'));
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('discord-test', 'Discord Test', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousAgentDir === undefined) delete process.env.NANOCLAW_AGENT_DIR;
  else process.env.NANOCLAW_AGENT_DIR = previousAgentDir;
  closeSessionDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function insertMessage(id: string, text: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO messages_in (id, kind, timestamp, status, platform_id, channel_type, content)
       VALUES (?, 'chat', datetime('now'), 'pending', 'chan-1', 'discord', ?)`,
    )
    .run(id, JSON.stringify({ sender: 'Alice', text }));
}

async function waitFor(condition: () => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now();
  while (!condition()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('CursorProvider through the real poll-loop', () => {
  it('delivers assistant messages emitted before and after a tool call exactly once', async () => {
    const original = { ...cursorAgentApi };
    cursorAgentApi.create = async () =>
      ({
        agentId: 'agent-stream',
        send: async () => ({
          supports: (op: string) => op === 'stream' || op === 'wait',
          stream: async function* () {
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: '<message to="discord-test">FIRST</message>' }] },
            };
            yield { type: 'tool_call', name: 'shell', status: 'running' };
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: '<message to="discord-test">SECOND</message>' }] },
            };
          },
          wait: async () => ({
            id: 'run-stream',
            status: 'finished' as const,
            result: '<message to="discord-test">SECOND</message>',
          }),
          cancel: async () => {},
        }),
        close: () => {},
      }) as never;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'send two updates', cwd: process.env.NANOCLAW_AGENT_DIR! });
      await processQuery(
        query,
        ROUTING,
        ['m1'],
        'cursor',
        undefined,
        'send two updates',
        undefined,
        provider.emitsMidTurnText,
      );

      expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toEqual(['FIRST', 'SECOND']);
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('accepts the wrapping nudge and delivers the retried envelope', async () => {
    const original = { ...cursorAgentApi };
    const sent: string[] = [];
    cursorAgentApi.create = async () =>
      ({
        agentId: 'agent-wrap',
        send: async (prompt: string) => {
          sent.push(prompt);
          return {
            supports: (op: string) => op === 'wait',
            wait: async () => ({
              id: `run-${sent.length}`,
              status: 'finished' as const,
              result: sent.length === 1 ? 'bare text with no envelope' : '<message to="discord-test">WRAP_OK</message>',
            }),
            cancel: async () => {},
          };
        },
        close: () => {},
      }) as never;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'say hi', cwd: process.env.NANOCLAW_AGENT_DIR! });
      await processQuery(query, ROUTING, ['m1'], 'cursor', undefined, 'say hi', undefined);

      expect(sent).toHaveLength(2);
      expect(sent[1]).toContain('was not delivered');
      const out = getUndeliveredMessages();
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!.content).text).toBe('WRAP_OK');
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('delivers a terminal Cursor error without wrapping-nudging it', async () => {
    const original = { ...cursorAgentApi };
    const sent: string[] = [];
    cursorAgentApi.create = async () =>
      ({
        agentId: 'agent-error',
        send: async (prompt: string) => {
          sent.push(prompt);
          return {
            supports: (op: string) => op === 'wait',
            wait: async () => ({
              id: 'run-error',
              status: 'error' as const,
              error: { message: 'model failed mid-turn' },
            }),
            cancel: async () => {},
          };
        },
        close: () => {},
      }) as never;
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const query = provider.query({ prompt: 'fail', cwd: process.env.NANOCLAW_AGENT_DIR! });
      await processQuery(query, ROUTING, ['m1'], 'cursor', undefined, 'fail', undefined);

      expect(sent).toHaveLength(1);
      const out = getUndeliveredMessages();
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!.content).text).toBe('model failed mid-turn');
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });

  it('clears a stored Cursor continuation when resume throws AgentNotFoundError', async () => {
    const original = { ...cursorAgentApi };
    setContinuation('cursor', 'missing-agent');
    insertMessage('m1', 'continue please');
    cursorAgentApi.resume = async () => {
      throw new AgentNotFoundError('missing');
    };
    try {
      const provider = new CursorProvider();
      provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
      const controller = new AbortController();
      const loopPromise = Promise.race([
        runPollLoop({
          provider,
          providerName: 'cursor',
          cwd: process.env.NANOCLAW_AGENT_DIR!,
          signal: controller.signal,
        }),
        waitFor(() => getUndeliveredMessages().length > 0, 2000),
      ]);
      await loopPromise;
      controller.abort();

      expect(getContinuation('cursor')).toBeUndefined();
      const out = getUndeliveredMessages();
      expect(out).toHaveLength(1);
      expect(JSON.parse(out[0]!.content).text).toContain('Error:');
    } finally {
      cursorAgentApi.create = original.create;
      cursorAgentApi.resume = original.resume;
    }
  });
});
