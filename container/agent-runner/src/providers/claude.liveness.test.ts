import { describe, it, expect, beforeEach, afterEach, mock, spyOn } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// Proves streaming deltas keep the heartbeat alive through a long content block,
// throttled to one `activity` per second (see includePartialMessages in claude.ts).

const sdkMessages: unknown[] = [];
let lastOptions: Record<string, unknown> | undefined;

// A controlled clock. `at(ms)` in the scripted stream moves it before the
// next message is yielded, so the throttle sees real elapsed time without
// the test sleeping.
const T0 = 1_760_000_000_000;
let fakeNow = T0;
const CLOCK = Symbol('clock');
const at = (ms: number) => ({ [CLOCK]: T0 + ms });

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      for (const m of sdkMessages) {
        if (m && typeof m === 'object' && CLOCK in m) {
          fakeNow = (m as Record<symbol, number>)[CLOCK];
          continue;
        }
        yield m;
      }
    })();
  },
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;
let nowSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  fakeNow = T0;
  nowSpy = spyOn(Date, 'now').mockImplementation(() => fakeNow);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-liveness-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  sdkMessages.length = 0;
  lastOptions = undefined;
});

afterEach(() => {
  nowSpy.mockRestore();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Drives one query; each event carries the clock offset it arrived at. */
async function drive(): Promise<{ type: string; t: number }[]> {
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  const events: { type: string; t: number }[] = [];
  for await (const e of q.events) events.push({ ...(e as { type: string }), t: fakeNow - T0 });
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

  it('throttles a burst of deltas to one activity frame', async () => {
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    for (let i = 0; i < 200; i++) sdkMessages.push(delta(i));
    sdkMessages.push({ type: 'result', subtype: 'success', result: 'done' });
    const events = await drive();
    // init + result always count; 200 deltas on a frozen clock are one touch.
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(3);
  });

  it('keeps emitting activity once per elapsed second through a long block', async () => {
    // A 5 s block: ten deltas every 100 ms. The throttle must let one
    // through per second (the regression was a silent window), and only one.
    sdkMessages.push({ type: 'system', subtype: 'init', session_id: 'sess-1' });
    for (let i = 0; i < 50; i++) sdkMessages.push(at(i * 100), delta(i));
    sdkMessages.push(at(5000), { type: 'result', subtype: 'success', result: 'done' });
    const events = await drive();
    const fromDeltas = events.filter((e) => e.type === 'activity' && e.t > 0 && e.t < 5000).map((e) => e.t);
    // t=0 is shared with init, so count it from the total instead.
    expect(fromDeltas).toEqual([1000, 2000, 3000, 4000]);
    expect(events.filter((e) => e.type === 'activity')).toHaveLength(1 + 5 + 1);
  });

  it('holds the throttle until a full second has passed', async () => {
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      at(100),
      delta(1), // first delta: emits
      at(1099),
      delta(2), // 999 ms later: suppressed
      at(1100),
      delta(3), // 1000 ms later: emits
      at(2099),
      delta(4), // suppressed
      at(3500),
      delta(5), // emits
      { type: 'result', subtype: 'success', result: 'done' },
    );
    const events = await drive();
    const times = events.filter((e) => e.type === 'activity').map((e) => e.t);
    // init at 0, deltas at 100/1100/3500, result at 3500.
    expect(times).toEqual([0, 100, 1100, 3500, 3500]);
  });
});
