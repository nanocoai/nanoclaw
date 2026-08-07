import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A compact_boundary SDK event must never surface as a `result` provider
// event. The poll loop treats result text as the agent's turn output: a
// synthetic "Context compacted." result has no <message> block, so it fires
// the "response was not delivered — please re-send" nudge and the agent
// duplicates its previous message (observed live: compaction completing at
// turn end produced a doubled reply).

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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-compact-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('compact_boundary translation', () => {
  it('yields activity, not a result, for compaction; real results still pass through', async () => {
    sdkMessages.length = 0;
    sdkMessages.push(
      { type: 'system', subtype: 'init', session_id: 'sess-1' },
      { type: 'system', subtype: 'compact_boundary', compact_metadata: { pre_tokens: 132642 } },
      { type: 'result', subtype: 'success', result: '<message to="user">hello</message>' },
    );

    const provider = new ClaudeProvider({});
    provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
    const q = provider.query({ prompt: 'hi', cwd: tmp });

    const events: { type: string; text?: string | null }[] = [];
    for await (const e of q.events) events.push(e as { type: string; text?: string | null });

    const results = events.filter((e) => e.type === 'result');
    expect(results).toHaveLength(1);
    expect(results[0]!.text).toBe('<message to="user">hello</message>');
    // No result event may carry the compaction notice.
    expect(results.some((e) => (e.text ?? '').includes('Context compacted'))).toBe(false);
    // Compaction still registers as activity (heartbeat) alongside the per-message activity events.
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(3);
  });
});
