import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import { processQuery } from '../poll-loop.js';
import type { ProviderExchange } from './types.js';

const sdkMessages: unknown[] = [];
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const message of sdkMessages) yield message;
    })(),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { claudeRuntimeContract } = await import('../provider-contracts/claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

const BILLING_ERROR = '403 billing_error: Spending limit reached. Update your billing settings to continue.';
let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-error-delivery-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  initTestSessionDb();
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES ('main', 'main', 'channel', 'discord', 'chan-1', NULL)`,
    )
    .run();
});

afterEach(() => {
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

it.each([false, true])('delivers the Claude SDK billing error once, with prior reply=%s', async (partialReply) => {
  sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'billing-session' });
  if (partialReply) {
    sdkMessages.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: '<message to="main">Finished the first step.</message>' }] },
    });
  }
  sdkMessages.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [BILLING_ERROR] });
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'continue', cwd: tmp });
  const pushes: string[] = [];
  query.push = (message) => pushes.push(message);
  const exchanges: ProviderExchange[] = [];

  await processQuery(
    query,
    { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' },
    ['m1'],
    'claude',
    (exchange) => exchanges.push(exchange),
    'continue',
    undefined,
    claudeRuntimeContract,
  );

  expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toEqual([
    ...(partialReply ? ['Finished the first step.'] : []),
    BILLING_ERROR,
  ]);
  expect(exchanges).toEqual([
    { prompt: 'continue', result: BILLING_ERROR, continuation: 'billing-session', status: 'error' },
  ]);
  expect(pushes).toHaveLength(0);
});

it('keeps a Claude task billing failure in its task log and out of chat', async () => {
  sdkMessages.push({ type: 'result', subtype: 'error_during_execution', is_error: true, errors: [BILLING_ERROR] });
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'scheduled work', cwd: tmp });
  const pushes: string[] = [];
  query.push = (message) => pushes.push(message);

  await processQuery(
    query,
    { platformId: null, channelType: null, threadId: 'system:tasks:billing', inReplyTo: 't1', taskRun: true },
    ['t1'],
    'claude',
    undefined,
    'scheduled work',
    undefined,
    claudeRuntimeContract,
  );

  const rows = getUndeliveredMessages();
  expect(rows.filter((row) => row.kind === 'chat')).toHaveLength(0);
  expect(rows.filter((row) => row.kind === 'task_log').map((row) => JSON.parse(row.content).text)).toEqual([
    BILLING_ERROR,
  ]);
  expect(pushes).toHaveLength(0);
});
