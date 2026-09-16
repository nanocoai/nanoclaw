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
await import('../provider-contracts/ollama.js');
const { createProvider } = await import('./factory.js');

let home: string;
let previousHome: string | undefined;
let previousRuntimeModel: string | undefined;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ollama-tools-'));
  previousHome = process.env.HOME;
  process.env.HOME = home;
  // The contract's inference resolve reads the container environment; the host
  // passes the launch alias there, next to the copy the provider gets.
  previousRuntimeModel = process.env.NANOCLAW_OLLAMA_RUNTIME_MODEL;
  delete process.env.NANOCLAW_OLLAMA_RUNTIME_MODEL;
  initTestSessionDb();
  capturedOptions = undefined;
});

afterEach(() => {
  closeSessionDb();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  if (previousRuntimeModel === undefined) delete process.env.NANOCLAW_OLLAMA_RUNTIME_MODEL;
  else process.env.NANOCLAW_OLLAMA_RUNTIME_MODEL = previousRuntimeModel;
  fs.rmSync(home, { recursive: true, force: true });
});

it('routes the runtime alias and keeps web tools usable without the cloud preflight', () => {
  process.env.NANOCLAW_OLLAMA_RUNTIME_MODEL = 'nanoclaw/abc:latest';
  const provider = createProvider('ollama', {
    model: 'qwen3:8b',
    env: { NANOCLAW_OLLAMA_RUNTIME_MODEL: 'nanoclaw/abc:latest' },
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'browse locally', cwd: home });

  expect(capturedOptions?.model).toBe('nanoclaw/abc:latest');
  expect(capturedOptions?.effort).toBeUndefined();
  expect(capturedOptions?.thinking).toEqual({ type: 'disabled' });
  expect(capturedOptions?.env).toMatchObject({ ANTHROPIC_CUSTOM_HEADERS: 'X-Ollama-Think: false' });
  expect(capturedOptions?.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  expect(capturedOptions?.tools).not.toContain('WebFetch');
  expect(capturedOptions?.tools).not.toContain('WebSearch');
  expect(capturedOptions?.allowedTools).not.toContain('WebFetch');
  expect(capturedOptions?.allowedTools).not.toContain('WebSearch');
  expect(capturedOptions?.settings).toEqual({ skipWebFetchPreflight: true });
  expect(JSON.stringify(capturedOptions?.systemPrompt)).not.toContain('mcp__nanoclaw__ollama_web_fetch');
  expect(capturedOptions?.systemPrompt).toMatchObject({
    append: expect.stringContaining('approval-pending'),
  });
});

it('disables Anthropic server tools when direct Ollama browsing is enabled', () => {
  const provider = createProvider('ollama', {
    model: 'qwen3:8b',
    env: { NANOCLAW_OLLAMA_WEB_BROWSING: 'enabled' },
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'browse locally', cwd: home });

  expect(capturedOptions?.disallowedTools).toEqual(expect.arrayContaining(['WebFetch', 'WebSearch']));
  expect(capturedOptions?.tools).not.toContain('WebFetch');
  expect(capturedOptions?.tools).not.toContain('WebSearch');
  expect(capturedOptions?.systemPrompt).toMatchObject({
    append: expect.stringContaining('mcp__nanoclaw__ollama_web_fetch'),
  });
});

it('preserves an explicit effort setting', () => {
  const provider = createProvider('ollama', { effort: 'high' });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'think deeply', cwd: home });

  expect(capturedOptions?.effort).toBe('high');
  expect(capturedOptions).not.toHaveProperty('thinking');
  expect(capturedOptions?.env).not.toHaveProperty('ANTHROPIC_CUSTOM_HEADERS');
});

it('preserves existing Claude Code custom headers before the Ollama thinking override', () => {
  const provider = createProvider('ollama', {
    env: { ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: value' },
  });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  provider.query({ prompt: 'answer directly', cwd: home });

  expect(capturedOptions?.env).toMatchObject({
    ANTHROPIC_CUSTOM_HEADERS: 'X-Existing: value\nX-Ollama-Think: false',
  });
});

it('pins skipWebFetchPreflight in the installed SDK type surface', () => {
  // The SDK's Settings type has a top-level index signature, which defeats
  // excess-property checking, so this string-level pin is the only thing that
  // fails loudly when an SDK bump drops the key.
  const sdkEntry = require.resolve('@anthropic-ai/claude-agent-sdk');
  const types = fs.readFileSync(path.join(path.dirname(sdkEntry), 'sdk.d.ts'), 'utf8');
  expect(types).toMatch(/skipWebFetchPreflight\?:\s*boolean/);
});
