import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { createServer, type ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { initTestSessionDb, closeSessionDb } from '../mailbox/sqlite/connection.js';
import { registerAgentMailbox, resetAgentMailboxForTesting } from '../mailbox/index.js';
import { SqliteAgentMailbox } from '../mailbox/sqlite/index.js';
import type { OpenCodeMessage } from './opencode-turn.js';
import { createOpencodeClient } from '@opencode-ai/sdk';
import {
  destroySharedRuntime,
  OpenCodeProvider,
  setSharedRuntimeDepsForTesting,
  type SseSubscribeOptions,
} from './opencode.js';

let directory: string;
let previousXdg: string | undefined;
let previousMailbox: ReturnType<typeof resetAgentMailboxForTesting>;
beforeEach(() => {
  directory = mkdtempSync(path.join(tmpdir(), 'opencode-sse-'));
  previousXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = directory;
  previousMailbox = resetAgentMailboxForTesting();
  initTestSessionDb();
  registerAgentMailbox(() => new SqliteAgentMailbox());
});
afterEach(() => {
  destroySharedRuntime();
  setSharedRuntimeDepsForTesting();
  if (previousXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previousXdg;
  resetAgentMailboxForTesting();
  closeSessionDb();
  if (previousMailbox) registerAgentMailbox(previousMailbox);
  rmSync(directory, { recursive: true, force: true });
});

// Exercise the pinned generated SDK, whose reader.cancel() abort rejection is
// invisible to the provider's fake event streams. No global rejection handler.
describe('real SDK event-stream teardown', () => {
  for (const phase of ['yield', 'read', 'backoff'] as const) {
    it(`releases during ${phase} without unhandled rejection or retry`, async () => {
      let response: ServerResponse | undefined;
      let requests = 0;
      let signalPrompt!: () => void;
      const prompted = new Promise<void>((resolve) => {
        signalPrompt = resolve;
      });
      let signalSleep!: () => void;
      const sleeping = new Promise<void>((resolve) => {
        signalSleep = resolve;
      });
      const send = (value: unknown) => response!.write(`data: ${JSON.stringify(value)}\n\n`);
      const server = createServer((_req, res) => {
        requests++;
        response = res;
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        send({ type: 'server.connected', properties: {} });
        if (phase === 'yield') {
          send({ type: 'session.idle', properties: { sessionID: 'ses_fixture' } });
        } else if (phase === 'backoff') {
          setTimeout(() => res.destroy(), 5);
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const address = server.address() as { port: number };
      const url = `http://127.0.0.1:${address.port}`;
      const sdk = createOpencodeClient({ baseUrl: url });
      const proc = Object.assign(new EventEmitter(), {
        pid: undefined,
        exitCode: null,
        signalCode: null,
        kill: () => {
          server.closeAllConnections();
          return true;
        },
      }) as unknown as ChildProcess;
      const history: OpenCodeMessage[] = [];
      let finishPrompt: ((result: { error: unknown }) => void) | undefined;
      setSharedRuntimeDepsForTesting({
        spawnServer: async () => ({ url, proc }),
        createClient: () => ({
          session: {
            create: async () => ({ data: { id: 'ses_fixture' } }),
            messages: async () => ({ data: history }),
            abort: async () => {
              finishPrompt?.({ error: { name: 'MessageAbortedError' } });
              return {};
            },
            prompt: async (params) => {
              history.push({
                info: { id: params.body.messageID, role: 'user', time: { created: Date.now() } },
                parts: [],
              });
              signalPrompt();
              if (phase !== 'yield')
                return await new Promise((resolve) => {
                  finishPrompt = resolve;
                });
              const answer: OpenCodeMessage = {
                info: {
                  id: 'msg_answer',
                  role: 'assistant',
                  parentID: params.body.messageID,
                  time: { created: Date.now() },
                },
                parts: [{ id: 'prt_answer', type: 'text', text: 'done' }],
              };
              history.push(answer);
              return { data: answer };
            },
          },
          event: {
            subscribe: (options?: SseSubscribeOptions) =>
              sdk.event.subscribe({
                ...options,
                sseSleepFn: async () => {
                  signalSleep();
                  await options!.sseSleepFn!(30_000);
                },
              }),
          },
        }),
        createQuestionClient: () => ({
          question: { reply: async () => ({ data: true }), list: async () => ({ data: [] }) },
        }),
      });
      try {
        const provider = new OpenCodeProvider();
        provider.registerMemorySessionHook({ command: 'true', legacyCommands: [], sources: [] });
        const query = provider.query({ prompt: 'test', cwd: '/tmp' });
        query.end();
        const collected = (async () => {
          for await (const _event of query.events) {
          }
        })();
        // Attach a rejection handler before provoking the expected termination.
        const settled = collected.then(
          () => 'finished',
          () => 'stream-ended',
        );
        await prompted;
        if (phase === 'yield') await collected;
        else if (phase === 'backoff') await sleeping;
        else while (!response) await Bun.sleep(1);
        destroySharedRuntime();
        let timeout: ReturnType<typeof setTimeout>;
        try {
          await Promise.race([
            settled,
            new Promise((_, reject) => {
              timeout = setTimeout(() => reject(new Error('teardown did not wake stream')), 1000);
            }),
          ]);
        } finally {
          clearTimeout(timeout!);
        }
        await Bun.sleep(10);
        expect(requests).toBe(1);
      } finally {
        destroySharedRuntime();
        server.closeAllConnections();
        server.close();
      }
    });
  }
});
