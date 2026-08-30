import { afterEach, beforeEach, expect, it, mock } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

let capturedOptions: Record<string, unknown> | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ options }: { options: Record<string, unknown> }) => {
    capturedOptions = options;
    return (async function* () {})();
  },
}));

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
await import('./ollama.js');
const { getProviderFactory } = await import('./provider-registry.js');

let home: string;
let previousHome: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ollama-tools-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  initTestSessionDb();
  capturedOptions = undefined;
});

afterEach(() => {
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

it('routes the runtime alias and keeps web tools usable without the cloud preflight', () => {
  const provider = getProviderFactory('ollama')({
    model: 'qwen3:8b',
    env: { NANOCLAW_OLLAMA_RUNTIME_MODEL: 'nanoclaw/abc:latest' },
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'browse locally', cwd: home });

  expect(capturedOptions?.model).toBe('nanoclaw/abc:latest');
  expect(capturedOptions?.effort).toBe('low');
  expect(capturedOptions?.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  expect(capturedOptions?.settings).toEqual({ skipWebFetchPreflight: true });
});

it('uses Ollama search and redirects fetch through the signed local daemon when browsing is enabled', () => {
  const provider = getProviderFactory('ollama')({
    model: 'qwen3:8b',
    env: {
      NANOCLAW_OLLAMA_RUNTIME_MODEL: 'nanoclaw/abc:latest',
      NANOCLAW_OLLAMA_WEB_BROWSING: 'enabled',
    },
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'browse locally', cwd: home });

  expect(capturedOptions?.disallowedTools).not.toContain('WebFetch');
  expect(capturedOptions?.disallowedTools).not.toContain('WebSearch');
  expect(capturedOptions?.toolAliases).toEqual({ WebFetch: 'mcp__nanoclaw__ollama_web_fetch' });
});

it('preserves an explicit effort setting', () => {
  const provider = getProviderFactory('ollama')({ effort: 'high' });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'think deeply', cwd: home });

  expect(capturedOptions?.effort).toBe('high');
});

it('pins skipWebFetchPreflight in the installed SDK type surface', () => {
  // The SDK's Settings type has a top-level index signature, which defeats excess-property checking, so this
  // string-level pin is the only thing that fails loudly when an SDK bump drops the key.
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const types = fs.readFileSync(path.join(path.dirname(sdkEntry), 'sdk.d.ts'), 'utf8');
  expect(types).toMatch(/skipWebFetchPreflight\?:\s*boolean/);
  expect(types).toMatch(/toolAliases\?:\s*Record<string, string>/);
});
