import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ProviderEvent, ProviderOptions, QueryInput } from './types.js';

// The two per-attempt hooks a provider wrapper relies on: a per-query model
// override, and a `retryable` mark on failed results that ran no tool and
// emitted no text, so a retry cannot repeat anything the user already saw.

let lastOptions: Record<string, unknown> | undefined;
let sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    const messages = sdkMessages;
    return (async function* () {
      for (const message of messages) yield message;
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  lastOptions = undefined;
  sdkMessages = [{ type: 'system', subtype: 'init', session_id: 'sess-attempt' }];
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-attempt-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(options: ProviderOptions, input: Partial<QueryInput> = {}): Promise<ProviderEvent[]> {
  const provider = createProvider('claude', options);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const events: ProviderEvent[] = [];
  for await (const event of provider.query({ prompt: 'hi', cwd: tmp, ...input }).events) events.push(event);
  return events;
}

function result(events: ProviderEvent[]): Extract<ProviderEvent, { type: 'result' }> | undefined {
  return events.find((event): event is Extract<ProviderEvent, { type: 'result' }> => event.type === 'result');
}

const FAILED = { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['upstream 529'] };

describe('per-query model override', () => {
  it('uses the configured model when the query sets none', async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'ok' });
    await drive({ model: 'configured-model' });
    expect(lastOptions?.model).toBe('configured-model');
  });

  it('sends the query model instead of the configured one', async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'ok' });
    await drive({ model: 'configured-model' }, { model: 'backup-model' });
    expect(lastOptions?.model).toBe('backup-model');
  });
});

describe('retryable failed results', () => {
  it('marks a failure with no tool call and no text as retryable', async () => {
    sdkMessages.push(FAILED);
    expect(result(await drive({}))).toMatchObject({ isError: true, retryable: true, error: 'upstream 529' });
  });

  it('marks a failure after a tool call as not retryable', async () => {
    sdkMessages.push(
      { type: 'assistant', message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      FAILED,
    );
    expect(result(await drive({}))).toMatchObject({ isError: true, retryable: false });
  });

  it('marks a failure after assistant text as not retryable', async () => {
    sdkMessages.push({ type: 'assistant', message: { content: [{ type: 'text', text: 'working on it' }] } }, FAILED);
    expect(result(await drive({}))).toMatchObject({ isError: true, retryable: false });
  });

  it('leaves successful results unmarked', async () => {
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'ok' });
    expect(result(await drive({}))).toEqual({ type: 'result', text: 'ok', isError: false, error: undefined });
  });
});
