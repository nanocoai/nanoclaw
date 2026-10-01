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
    claudeRuntimeContract.textDelivery === 'mid-turn-complete',
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
    claudeRuntimeContract.textDelivery === 'mid-turn-complete',
  );

  const rows = getUndeliveredMessages();
  expect(rows.filter((row) => row.kind === 'chat')).toHaveLength(0);
  expect(rows.filter((row) => row.kind === 'task_log').map((row) => JSON.parse(row.content).text)).toEqual([
    BILLING_ERROR,
  ]);
  expect(pushes).toHaveLength(0);
});

const AUTH_ERROR = 'Invalid API key · Fix external API key';

async function resultEvents(): Promise<Array<{ text: string | null; isError?: boolean; error?: string }>> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const events: Array<{ type: string; text: string | null; isError?: boolean; error?: string }> = [];
  for await (const e of provider.query({ prompt: 'ping', cwd: tmp }).events) events.push(e as (typeof events)[0]);
  return events.filter((e) => e.type === 'result');
}

it('uses the SDK result text as the error when errors[] is empty', async () => {
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result: `  ${AUTH_ERROR}\n`, errors: [] });
  expect(await resultEvents()).toEqual([{ type: 'result', text: null, isError: true, error: AUTH_ERROR }]);
});

it('caps a long SDK result used as the error', async () => {
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result: 'x'.repeat(2000) });
  const [result] = await resultEvents();
  expect(result!.error!.length).toBeLessThanOrEqual(500);
});

it('keeps errors[] as the error when the SDK provides it', async () => {
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result: AUTH_ERROR, errors: [BILLING_ERROR] });
  expect(await resultEvents()).toEqual([{ type: 'result', text: AUTH_ERROR, isError: true, error: BILLING_ERROR }]);
});

it('leaves a successful result untouched', async () => {
  sdkMessages.push({
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: '<message to="main">pong</message>',
  });
  expect(await resultEvents()).toEqual([
    { type: 'result', text: '<message to="main">pong</message>', isError: false, error: undefined },
  ]);
});

it('delivers the SDK auth error to the channel instead of the generic notice', async () => {
  sdkMessages.push({ type: 'result', subtype: 'success', is_error: true, result: AUTH_ERROR, errors: [] });
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const exchanges: ProviderExchange[] = [];

  await processQuery(
    provider.query({ prompt: 'ping', cwd: tmp }),
    { platformId: 'chan-1', channelType: 'discord', threadId: null, inReplyTo: 'm1' },
    ['m1'],
    'claude',
    (exchange) => exchanges.push(exchange),
    'ping',
    undefined,
    claudeRuntimeContract.textDelivery === 'mid-turn-complete',
  );

  expect(getUndeliveredMessages().map((row) => JSON.parse(row.content).text)).toEqual([AUTH_ERROR]);
  expect(exchanges.map((e) => [e.result, e.status])).toEqual([[AUTH_ERROR, 'error']]);
});
