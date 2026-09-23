import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { OpenCodeProvider, type OpenCodeMemorySessionHook, type OpenCodeRuntimeHandle, type QuestionClient } from './opencode.js';
import type { ProviderEvent } from './types.js';

/**
 * Regression coverage for #2985: the answer streams as `message.part.delta`
 * and is consolidated into a `message.part.updated` snapshot. If the snapshot
 * doesn't land before `session.idle` breaks the read loop — a timing race, or
 * it simply isn't emitted — the provider must still surface the answer from
 * the accumulated deltas instead of silently yielding `null`.
 */

const MEMORY_HOOK: OpenCodeMemorySessionHook = {
  command: 'true',
  legacyCommands: [],
  sources: ['startup', 'clear', 'compact'],
};

function createFakeRuntime(script: Array<Array<{ type: string; properties: Record<string, unknown> }>>): {
  runtime: { getRuntime: () => Promise<OpenCodeRuntimeHandle> };
  promptIds: string[];
} {
  const promptIds: string[] = [];
  let nextCreate = 0;
  const queue: Array<{ type: string; properties: Record<string, unknown> }> = [];
  const waiters: Array<() => void> = [];

  const pushEvents = (events: Array<{ type: string; properties: Record<string, unknown> }>) => {
    queue.push(...events);
    while (waiters.length > 0 && queue.length > 0) waiters.shift()!();
  };

  async function* stream(): AsyncGenerator<{ type: string; properties: Record<string, unknown> }, void, void> {
    while (true) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      yield queue.shift()!;
    }
  }

  const questionClient: QuestionClient = {
    question: {
      async reply() {
        return { data: true };
      },
      async list() {
        return { data: [] };
      },
    },
  };

  const handle: OpenCodeRuntimeHandle = {
    questionClient,
    stream: stream(),
    client: {
      session: {
        async create() {
          nextCreate += 1;
          return { data: { id: `ses_fresh_${nextCreate}` } };
        },
        async promptAsync(params) {
          promptIds.push(params.path.id);
          const events = script[promptIds.length - 1];
          if (!events) throw new Error(`no scripted events for prompt #${promptIds.length}`);
          pushEvents(events);
          return {};
        },
      },
    },
  };

  return { promptIds, runtime: { getRuntime: async () => handle } };
}

async function collect(events: AsyncIterable<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const event of events) out.push(event);
  return out;
}

describe('OpenCodeProvider message.part.delta fallback', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-delta-fallback-'));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('surfaces the answer from accumulated deltas when the snapshot never lands', async () => {
    const fake = createFakeRuntime([
      [
        { type: 'message.updated', properties: { info: { id: 'msg_asst', role: 'assistant' } } },
        {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst', partID: 'prt_1', field: 'text', delta: 'Hel' },
        },
        {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst', partID: 'prt_1', field: 'text', delta: 'lo!' },
        },
        // No message.part.updated snapshot for msg_asst — the race from #2985.
        { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      ],
    ]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hi', cwd: dir, continuation: 'ses_1' });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'Hello!' }]);
  });

  it('prefers the consolidated snapshot over raw deltas when both are present', async () => {
    const fake = createFakeRuntime([
      [
        { type: 'message.updated', properties: { info: { id: 'msg_asst', role: 'assistant' } } },
        {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_1', messageID: 'msg_asst', partID: 'prt_1', field: 'text', delta: 'partial' },
        },
        {
          type: 'message.part.updated',
          properties: { part: { type: 'text', messageID: 'msg_asst', text: 'the full snapshot' } },
        },
        { type: 'session.idle', properties: { sessionID: 'ses_1' } },
      ],
    ]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hi', cwd: dir, continuation: 'ses_1' });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'the full snapshot' }]);
  });

  it('ignores deltas from a foreign session on the shared stream', async () => {
    const fake = createFakeRuntime([
      [
        { type: 'message.updated', properties: { info: { id: 'msg_asst', role: 'assistant' } } },
        {
          type: 'message.part.delta',
          properties: { sessionID: 'ses_other', messageID: 'msg_asst', partID: 'prt_1', field: 'text', delta: 'nope' },
        },
        { type: 'session.idle', properties: { sessionID: 'ses_fresh_1' } },
      ],
    ]);
    const provider = new OpenCodeProvider({}, fake.runtime);
    provider.registerMemorySessionHook(MEMORY_HOOK);
    const query = provider.query({ prompt: 'hi', cwd: dir });
    const done = collect(query.events);
    query.end();
    const events = await done;

    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: null }]);
  });
});
