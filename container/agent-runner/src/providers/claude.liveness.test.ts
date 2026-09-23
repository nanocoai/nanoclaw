import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Liveness while the model is generating. The SDK emits one `assistant`
// message per COMPLETED content block, so a long single block (a 2 500-word
// answer, a long thinking block) produces no message at all until it ends.
// The poll-loop touches the heartbeat only on provider events, so the host
// sweep saw a silent container and killed it at the ceiling mid-generation
// (reproduced on exe.dev 2026-09-23 with the ceiling lowered to 30 s: three
// kills in a row on the same message, no result ever delivered). Streaming
// deltas are the liveness signal the SDK offers for that window: opt in with
// `includePartialMessages` and surface each `stream_event` as activity,
// throttled so a burst of deltas is one touch per second, not one per token.

const sdkMessages: unknown[] = [];
let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    lastOptions = args.options;
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-liveness-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  lastOptions = undefined;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(): Promise<{ type: string }[]> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const events: { type: string }[] = [];
  for await (const e of q.events) events.push(e as { type: string });
  return events;
}

function delta(i: number): unknown {
  return {
    type: 'stream_event',
    event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: `w${i} ` } },
    parent_tool_use_id: null,
    uuid: `u-${i}`,
    session_id: 'sess-1',
  };
}

describe('liveness during generation', () => {
  it('asks the SDK for partial messages so a long block is not a silent window', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    await drive();
    expect(lastOptions?.includePartialMessages).toBe(true);
  });

  it('surfaces stream deltas as activity only — never as text or a result', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      delta(1),
      delta(2),
      { type: 'assistant', message: { content: [{ type: 'text', text: 'w1 w2 ' }] } },
      { type: 'result', subtype: 'success', result: 'w1 w2 ' },
    );
    const events = await drive();
    const types = events.map((e) => e.type);
    expect(types.filter((t) => t === 'text')).toHaveLength(1);
    expect(types.filter((t) => t === 'result')).toHaveLength(1);
    // init, one assistant message, one result: at least three activity
    // frames; the deltas add liveness but no content.
    expect(types.filter((t) => t === 'activity').length).toBeGreaterThanOrEqual(3);
  });

  it('throttles a burst of deltas to one activity frame per second', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    for (let i = 0; i < 200; i++) sdkMessages.push(delta(i));
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'done' });
    const events = await drive();
    const activity = events.filter((e) => e.type === 'activity').length;
    // init + result always count; the 200 deltas arrive within a few
    // milliseconds, so the throttle lets at most a couple of them through.
    expect(activity).toBeGreaterThanOrEqual(3);
    expect(activity).toBeLessThanOrEqual(5);
  });
});
