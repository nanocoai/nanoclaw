import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// The Claude SDK result names the inputs a turn consumed with
// user_message_uuid(s). The provider must surface those as `answered` so the
// poll-loop can drop follow-ups the SDK folded into an earlier turn.
const sdkMessages: unknown[] = [];
let lastPrompt: { push: (text: string, uuid?: string) => void } | undefined;
mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (opts: { prompt: { push: (text: string, uuid?: string) => void } }) => {
    lastPrompt = opts.prompt;
    return (async function* () {
      for (const message of sdkMessages) yield message;
    })();
  },
}));

const pushed: { text: string; uuid?: string }[] = [];

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let previousHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-answered-'));
  previousHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  pushed.length = 0;
});

afterEach(() => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

it('maps user_message_uuid(s) on a result to answered, and forwards the push id', async () => {
  sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
  sdkMessages.push({
    type: 'result',
    subtype: 'success',
    result: 'ok',
    user_message_uuid: 'u-C',
    user_message_uuids: ['u-B', 'u-C'],
  });

  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'first', cwd: tmp });
  lastPrompt!.push('second', 'u-B');
  pushed.push({ text: 'second', uuid: 'u-B' });
  lastPrompt!.push('third', 'u-C');
  pushed.push({ text: 'third', uuid: 'u-C' });

  const results: unknown[] = [];
  for await (const e of q.events) if (e.type === 'result') results.push(e);
  q.end();

  expect(pushed).toEqual([
    { text: 'second', uuid: 'u-B' },
    { text: 'third', uuid: 'u-C' },
  ]);
  expect(results).toEqual([expect.objectContaining({ type: 'result', text: 'ok', answered: ['u-B', 'u-C'] })]);
});

it('falls back to user_message_uuid for older SDKs that omit the plural field', async () => {
  sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-2' });
  sdkMessages.push({ type: 'result', subtype: 'success', result: 'ok', user_message_uuid: 'u-only' });

  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'first', cwd: tmp });

  const results: unknown[] = [];
  for await (const e of q.events) if (e.type === 'result') results.push(e);
  q.end();

  expect(results).toEqual([expect.objectContaining({ type: 'result', answered: ['u-only'] })]);
});
