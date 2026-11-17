import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

// A resumed agent must see its current name and destinations: the append is never recorded.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-sp' };
      yield { type: 'result', subtype: 'success', result: 'ok' };
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-sysprompt-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(instructions: string, continuation?: string): Promise<void> {
  const provider = createProvider('claude', {});
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp, continuation, systemContext: { instructions } });
  for await (const _ of q.events) {
    /* drain */
  }
}

describe('system prompt append', () => {
  it('is never recorded, so a resume renders the current append', async () => {
    const append = '# You are Ada\n\n## Sending messages\n\n- ops-log';
    await drive(append, 'sess-earlier');
    expect(lastOptions?.systemPrompt).toEqual({
      type: 'preset',
      preset: 'claude_code',
      append,
      snapshot: false,
    });
  });
});
