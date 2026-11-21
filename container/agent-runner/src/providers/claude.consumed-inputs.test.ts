import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import recorded from './__fixtures__/sdk-folded-turn-frame.json';

// The Claude CLI answers inputs waiting together at a turn boundary in one
// turn with one result, so the poll-loop cannot count results to know which
// input a turn answers. Each pushed input carries a client uuid; the CLI lists
// the uuids a turn has consumed on its assistant frames (user_message_uuids),
// and the provider reports them as a `consumed` event.

const sdkMessages: unknown[] = [];
let promptStream: AsyncIterable<{ uuid?: string; message: { content: string } }> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { prompt: typeof promptStream }) => {
    promptStream = args.prompt;
    return (async function* () {
      for (const m of sdkMessages) yield m;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-consumed-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  promptStream = undefined;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function startQuery() {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  return provider.query({ prompt: 'first', cwd: tmp });
}

describe('inputs a turn consumed', () => {
  it('sends each pushed input with a fresh UUID and returns it from push', async () => {
    const q = startQuery();
    const second = q.push('second');
    const third = q.push('third');
    const iter = promptStream![Symbol.asyncIterator]();
    const sent = [(await iter.next()).value, (await iter.next()).value, (await iter.next()).value];
    q.end();
    expect(sent.map((m) => m.message.content)).toEqual(['first', 'second', 'third']);
    expect(sent[1].uuid).toBe(second as string);
    expect(sent[2].uuid).toBe(third as string);
    expect(second).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(second).not.toBe(third);
  });

  it('reports user_message_uuids as a consumed event, before the turn’s text and result', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        user_message_uuid: 'input-3',
        user_message_uuids: ['input-2', 'input-3'],
        message: { content: [{ type: 'text', text: 'answer to both' }] },
      },
      // Later frames of the same turn carry no list.
      { type: 'assistant', message: { content: [{ type: 'text', text: 'more' }] } },
      { type: 'result', subtype: 'success', result: 'more' },
    );
    const events: Array<{ type: string; ids?: string[] }> = [];
    for await (const e of startQuery().events) events.push(e as { type: string; ids?: string[] });
    const kinds = events.map((e) => e.type).filter((t) => t !== 'activity');
    expect(kinds).toEqual(['init', 'consumed', 'text', 'text', 'result']);
    expect(events.find((e) => e.type === 'consumed')?.ids).toEqual(['input-2', 'input-3']);
  });

  it('reads the list from a frame recorded from the real CLI (2.1.280) answering two inputs in one turn', async () => {
    sdkMessages.push(recorded.frame, { type: 'result', subtype: 'success', result: 'ok 2' });
    const events: Array<{ type: string; ids?: string[] }> = [];
    for await (const e of startQuery().events) events.push(e as { type: string; ids?: string[] });
    expect(events.find((e) => e.type === 'consumed')?.ids).toEqual(recorded.frame.user_message_uuids);
    expect(recorded.frame.user_message_uuids).toHaveLength(2);
  });

  it('reports a list carried by the result frame, before the result', async () => {
    sdkMessages.push(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'result', subtype: 'success', result: 'a', user_message_uuids: ['input-4'] },
    );
    const events: Array<{ type: string; ids?: string[] }> = [];
    for await (const e of startQuery().events) events.push(e as { type: string; ids?: string[] });
    const kinds = events.map((e) => e.type).filter((t) => t !== 'activity');
    expect(kinds).toEqual(['text', 'consumed', 'result']);
    expect(events.find((e) => e.type === 'consumed')?.ids).toEqual(['input-4']);
  });

  it('emits nothing for frames without a list (older CLI, subagent frames)', async () => {
    sdkMessages.push(
      { type: 'assistant', message: { content: [{ type: 'text', text: 'a' }] } },
      { type: 'assistant', user_message_uuids: [], message: { content: [{ type: 'text', text: 'b' }] } },
      { type: 'result', subtype: 'success', result: 'b' },
    );
    const events: Array<{ type: string }> = [];
    for await (const e of startQuery().events) events.push(e);
    expect(events.some((e) => e.type === 'consumed')).toBe(false);
  });
});
