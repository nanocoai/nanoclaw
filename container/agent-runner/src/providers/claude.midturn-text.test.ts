import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// ClaudeProvider must surface every non-empty assistant text block as a
// 'text' provider event, in stream order, before the turn's result. The SDK's
// final `result` event only carries the LAST assistant text — a complete
// <message to> block composed between tool calls is invisible to the
// poll-loop unless the provider emits it as a text event. Deleting the
// assistant-message branch in claude.ts goes red here.

const sdkMessages: unknown[] = [];

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: () =>
    (async function* () {
      for (const m of sdkMessages) yield m;
    })(),
}));

const { ClaudeProvider } = await import('./claude.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-midturn-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('assistant text block surfacing', () => {
  it('declares the emitsMidTurnText capability the poll-loop keys one-door delivery on', () => {
    expect(new ClaudeProvider({}).emitsMidTurnText).toBe(true);
  });

  it('yields one text event per assistant message with text, before the result', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '<message to="user">mid-turn reply</message>' },
            { type: 'tool_use', name: 'Bash', input: {} },
            { type: 'text', text: '' },
          ],
        },
      },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'second segment' }] } },
      { type: 'result', subtype: 'success', result: 'final text' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    const texts = events.filter((e) => e.type === 'text');
    expect(texts.map((e) => e.text)).toEqual(['<message to="user">mid-turn reply</message>', 'second segment']);
    // Every text event precedes the result event.
    const resultIdx = events.findIndex((e) => e.type === 'result');
    const lastTextIdx = events.map((e) => e.type).lastIndexOf('text');
    expect(resultIdx).toBeGreaterThan(-1);
    expect(lastTextIdx).toBeLessThan(resultIdx);
    expect(events[resultIdx]!.text).toBe('final text');
  });

  it('yields no text events for assistant messages without text blocks', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-2' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'result', subtype: 'success', result: 'done' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string }[] = [];
    for await (const e of q.events) events.push(e as { type: string });

    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
  });

  it('joins text blocks of ONE assistant message: a <message> block split across them stays parseable', async () => {
    // A block spanning two text blocks of the same assistant message would be
    // a fragment in each per-block event — unparseable at the poll-loop's
    // mid-turn door — while the SDK result reports the message's text whole.
    // One joined event per message pins door granularity to result granularity.
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-3' },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '<message to="user">The answer' },
            { type: 'text', text: ' is 4.</message>' },
          ],
        },
      },
      { type: 'result', subtype: 'success', result: '<message to="user">The answer is 4.</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    const texts = events.filter((e) => e.type === 'text');
    expect(texts.map((e) => e.text)).toEqual(['<message to="user">The answer is 4.</message>']);
  });

  it('passes fragments split across ASSISTANT MESSAGES through verbatim — no cross-message buffering or healing', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-4' },
      { type: 'assistant', message: { content: [{ type: 'text', text: '<message to="user">opened here' }] } },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'closed here</message>' }] } },
      { type: 'result', subtype: 'success', result: 'closed here</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    const texts = events.filter((e) => e.type === 'text');
    expect(texts.map((e) => e.text)).toEqual(['<message to="user">opened here', 'closed here</message>']);
  });
});

// The provider does NOT derive the result event's text from the streamed
// assistant messages — it takes the SDK's own `result` / `errors[]` fields
// verbatim (see the result branch in claude.ts). Containment of result text
// in streamed text is therefore an SDK premise the provider cannot enforce.
// These pin the two divergence shapes the poll-loop's midTurnSent===0
// fallback exists for.
describe('result text is an independent SDK field (divergence surface)', () => {
  it('surfaces a result whose text never appeared in any assistant message', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-5' },
      { type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: {} }] } },
      { type: 'result', subtype: 'success', result: '<message to="user">only in the result field</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    expect(events.filter((e) => e.type === 'text')).toHaveLength(0);
    const result = events.find((e) => e.type === 'result');
    expect(result?.text).toBe('<message to="user">only in the result field</message>');
  });

  it('error-subtype results carry errors[] text that never streamed', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-6' },
      { type: 'assistant', message: { content: [{ type: 'text', text: 'partial progress' }] } },
      { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['billing hard-stop'] },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null; isError?: boolean }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null; isError?: boolean });

    const result = events.find((e) => e.type === 'result');
    expect(result?.text).toBe('billing hard-stop');
    expect(result?.isError).toBe(true);
    // 'billing hard-stop' never appeared in a text event — only 'partial progress' did.
    expect(events.filter((e) => e.type === 'text').map((e) => e.text)).toEqual(['partial progress']);
  });
});
