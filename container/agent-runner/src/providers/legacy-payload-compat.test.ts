import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'bun:test';

import { createProvider } from './factory.js';
import { listProviderNames } from './provider-registry.js';
import './index.js';

const hasCodex = fs.existsSync(new URL('./codex.ts', import.meta.url));
const hasOpenCode = fs.existsSync(new URL('./opencode.ts', import.meta.url));
let temp: string | undefined;

afterEach(() => {
  if (temp) fs.rmSync(temp, { recursive: true, force: true });
  temp = undefined;
  delete process.env.NANOCLAW_CONVERSATIONS_DIR;
});

(hasCodex ? describe : describe.skip)('Codex payload compatibility through new runtime core', () => {
  it('registers, constructs, and archives one exchange exactly once', () => {
    expect(listProviderNames()).toContain('codex');
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-codex-compat-'));
    process.env.NANOCLAW_CONVERSATIONS_DIR = temp;
    const provider = createProvider('codex');

    provider.onExchangeComplete?.({
      prompt: 'hello',
      result: 'world',
      continuation: 'thread-1',
      status: 'completed',
    });

    const files = fs.readdirSync(temp);
    expect(files).toHaveLength(1);
    const content = fs.readFileSync(path.join(temp, files[0]), 'utf8');
    expect(content.match(/# Codex Conversation/g)).toHaveLength(1);
    expect(content.match(/Status: completed/g)).toHaveLength(1);
  });
});

(hasOpenCode ? describe : describe.skip)('OpenCode payload compatibility through new runtime core', () => {
  it('registers, constructs, and enters the real query path', () => {
    expect(listProviderNames()).toContain('opencode');
    const provider = createProvider('opencode');
    provider.registerMemorySessionHook({
      command: 'true',
      legacyCommands: [],
      sources: ['startup', 'clear', 'compact'],
    });

    const query = provider.query({ prompt: 'hello', cwd: '/workspace/agent' });
    query.abort();

    expect(query.events[Symbol.asyncIterator]).toBeFunction();
    expect(provider.isSessionInvalid(new Error('session not found'))).toBe(true);
  });
});
