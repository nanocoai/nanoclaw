/**
 * The Claude provider hands the trace hooks to the SDK. Drives the real
 * provider against a fake SDK that fires the configured tool hooks, then
 * checks the tool call lands in the turn's trace. Goes red if the
 * `withTurnTraceHooks(...)` wrap is removed from providers/claude.ts.
 */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { HookCallbackMatcher } from '@anthropic-ai/claude-agent-sdk';

type Hooks = Record<string, HookCallbackMatcher[] | undefined>;
let lastHooks: Hooks | undefined;

async function fire(hooks: Hooks | undefined, event: string, input: Record<string, unknown>): Promise<void> {
  for (const matcher of hooks?.[event] ?? []) {
    for (const hook of matcher.hooks) {
      await hook({ hook_event_name: event, ...input } as never, input.tool_use_id as string, {
        signal: new AbortController().signal,
      });
    }
  }
}

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: { hooks?: Hooks } }) => {
    lastHooks = args.options?.hooks;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-trace' };
      const call = { tool_name: 'Glob', tool_input: { pattern: '*.md' }, tool_use_id: 'tu-9' };
      await fire(lastHooks, 'PreToolUse', call);
      await fire(lastHooks, 'PostToolUse', { ...call, tool_response: ['README.md'], duration_ms: 3 });
      yield { type: 'result', subtype: 'success', result: 'found it' };
    })();
  },
}));

await import('../../providers/index.js');
await import('../../provider-contracts/index.js');
const { createProvider } = await import('../../providers/factory.js');
const { MEMORY_SESSION_HOOK } = await import('../../memory/session-hook.js');
const { closeSessionDb, initTestSessionDb } = await import('../../mailbox/sqlite/connection.js');
const { getUndeliveredMessages } = await import('../../db/messages-out.js');
const { runBeforeTurn, runProviderEvent } = await import('../../turn-hooks.js');
const { resetTurnTraces } = await import('./recorder.js');
await import('./index.js');

let tmp: string;
let prevHome: string | undefined;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-trace-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
  const marker = path.join(tmp, 'turn-traces.enabled');
  fs.writeFileSync(marker, '');
  initTestSessionDb();
  resetTurnTraces(marker);
});

afterEach(() => {
  resetTurnTraces();
  closeSessionDb();
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('claude provider trace hooks', () => {
  it('records SDK tool calls on the turn being answered', async () => {
    const routing = { platformId: 'c', channelType: 'test', threadId: null, inReplyTo: 'm-1', taskRun: false };
    await runBeforeTurn({ messages: [], routing, followUp: false });

    const provider = createProvider('claude', {});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'find docs', cwd: tmp });
    for await (const event of q.events) runProviderEvent(event, routing);
    await new Promise((resolve) => setTimeout(resolve, 0));

    const trace = getUndeliveredMessages()
      .filter((m) => m.kind === 'system')
      .map((m) => JSON.parse(m.content))
      .find((c) => c.action === 'turn_trace');
    expect(trace.output).toBe('found it');
    expect(trace.steps).toEqual([
      expect.objectContaining({
        type: 'tool',
        name: 'Glob',
        tool_use_id: 'tu-9',
        output: '["README.md"]',
        duration_ms: 3,
      }),
    ]);
  });

  it('appends to the provider tool hooks instead of replacing them', () => {
    expect(lastHooks?.PreToolUse?.length).toBeGreaterThanOrEqual(2);
    expect(lastHooks?.PostToolUseFailure?.length).toBeGreaterThanOrEqual(2);
  });
});
