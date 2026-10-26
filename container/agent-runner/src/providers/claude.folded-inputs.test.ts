import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The Claude CLI folds a message pushed mid-turn into the running turn
// (between tool rounds) and answers both with one result, listing every
// input it consumed in `user_message_uuids`. The provider stamps each input
// with a uuid and reports a multi-input result as `answeredInputs`, so the
// poll loop can retire the folded turns instead of answering one behind.

type UserInput = { uuid: string; message: { content: string } };
type Script = (inputs: AsyncIterator<UserInput>) => AsyncGenerator<unknown>;
let script: Script;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<UserInput> }) => script(prompt[Symbol.asyncIterator]()),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-folded-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** Run a query with one push; `result` builds each result from the two inputs' uuids. */
async function results(result: (a: string, b: string) => Array<Record<string, unknown>>) {
  script = async function* (inputs) {
    const a = (await inputs.next()).value as UserInput;
    const b = (await inputs.next()).value as UserInput;
    expect([a.message.content, b.message.content]).toEqual(['first', 'second']);
    yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
    for (const r of result(a.uuid, b.uuid)) yield { type: 'result', subtype: 'success', result: 'ok', ...r };
  };
  const provider = createProvider('claude');
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const query = provider.query({ prompt: 'first', cwd: tmp });
  query.push('second');
  const out: Array<{ type: string; answeredInputs?: number }> = [];
  for await (const e of query.events) if (e.type === 'result') out.push(e);
  return out.map((e) => e.answeredInputs);
}

describe('folded inputs', () => {
  it('stamps every input with its own uuid', async () => {
    await results((a, b) => {
      expect(a).toMatch(/^[0-9a-f-]{36}$/);
      expect(b).not.toBe(a);
      return [];
    });
  });

  it('reports a result that answered a folded push', async () => {
    expect(await results((a, b) => [{ user_message_uuids: [a, b], user_message_uuid: a }])).toEqual([2]);
  });

  it('reports nothing extra when each input gets its own result', async () => {
    expect(
      await results((a, b) => [{ user_message_uuids: [a], user_message_uuid: a }, { user_message_uuid: b }]),
    ).toEqual([undefined, undefined]);
  });

  it('treats a result without uuids (older CLI) as answering one input', async () => {
    expect(await results(() => [{}, {}])).toEqual([undefined, undefined]);
  });

  it('counts folded inputs past the 64-entry uuid list from the queued count', async () => {
    // Live shape (CLI 2.1.300): 71 inputs folded into one turn listed only
    // the first 64 uuids, with queued_turn_count 0.
    script = async function* (inputs) {
      const uuids: string[] = [];
      for (let i = 0; i < 70; i++) uuids.push(((await inputs.next()).value as UserInput).uuid);
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        user_message_uuids: uuids.slice(0, 64),
        queued_turn_count: 1,
      };
      yield { type: 'result', subtype: 'success', result: 'ok', user_message_uuids: [uuids[69]], queued_turn_count: 0 };
    };
    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({ prompt: 'first', cwd: tmp });
    // Input 70 is never taken by the SDK, so it cannot have been folded.
    for (let i = 1; i <= 70; i++) query.push(`input ${i}`);
    const answered: Array<number | undefined> = [];
    for await (const e of query.events) if (e.type === 'result') answered.push(e.answeredInputs);
    expect(answered).toEqual([69, undefined]);
  });

  it('retires the input a uuid-less result answered, so a later capped count stays exact', async () => {
    script = async function* (inputs) {
      const uuids: string[] = [];
      for (let i = 0; i < 71; i++) uuids.push(((await inputs.next()).value as UserInput).uuid);
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, errors: ['zeroed'] };
      yield {
        type: 'result',
        subtype: 'success',
        result: 'ok',
        user_message_uuids: uuids.slice(1, 65),
        queued_turn_count: 1,
      };
      yield { type: 'result', subtype: 'success', result: 'ok', user_message_uuids: [uuids[70]], queued_turn_count: 0 };
    };
    const provider = createProvider('claude');
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const query = provider.query({ prompt: 'first', cwd: tmp });
    for (let i = 1; i <= 70; i++) query.push(`input ${i}`);
    const answered: Array<number | undefined> = [];
    for await (const e of query.events) if (e.type === 'result') answered.push(e.answeredInputs);
    expect(answered).toEqual([undefined, 69, undefined]);
  });

  it('never counts an input twice or one it did not send', async () => {
    expect(
      await results((a, b) => [{ user_message_uuids: [a, 'cron-trigger'] }, { user_message_uuids: [a, b] }]),
    ).toEqual([undefined, undefined]);
  });
});
