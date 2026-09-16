import { describe, it, expect, beforeEach, afterEach, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ProviderOptions } from './types.js';

// `fastMode` is a Settings member, not a query option, so the provider has to
// hand it to the SDK through `options.settings`. The failure this pins is the
// quiet one: passing it as a bare option typechecks nowhere and would simply
// never reach the API, leaving an install that believes it enabled the fast
// tier paying the ordinary rate — or expecting the higher one and not getting
// it. The absent case matters just as much: an install that never sets the
// variable must send exactly the options it always did.

let lastOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: (args: { options?: Record<string, unknown> }) => {
    lastOptions = args.options;
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 'sess-fm' };
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
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-fastmode-'));
  prevHome = process.env.HOME;
  process.env.HOME = tmp;
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  fs.rmSync(tmp, { recursive: true, force: true });
});

async function drive(options: ProviderOptions): Promise<void> {
  const provider = createProvider('claude', options);
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  const q = provider.query({ prompt: 'hi', cwd: tmp });
  for await (const _ of q.events) {
    /* drain */
  }
}

describe('fast mode reaches the SDK through settings', () => {
  it('sends settings.fastMode when enabled', async () => {
    await drive({ speed: 'fast' });
    expect(lastOptions?.settings).toEqual({ fastMode: true });
  });

  it('sends no settings key at all when not enabled', async () => {
    await drive({});
    expect(lastOptions && 'settings' in lastOptions).toBe(false);
  });

  it('sends no settings key for standard speed', async () => {
    await drive({ speed: 'standard' });
    expect(lastOptions && 'settings' in lastOptions).toBe(false);
  });

  it('leaves the settingSources chain untouched either way', async () => {
    await drive({ speed: 'fast' });
    expect(lastOptions?.settingSources).toEqual(['project', 'user', 'local']);
    await drive({});
    expect(lastOptions?.settingSources).toEqual(['project', 'user', 'local']);
  });
});
