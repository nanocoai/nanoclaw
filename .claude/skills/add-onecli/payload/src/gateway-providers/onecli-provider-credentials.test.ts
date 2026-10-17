import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createdSecretId,
  isSavedProviderCredential,
  providerCredentialFile,
  readProviderCredentials,
  recordProviderCredentials,
  updateProviderCredentials,
} from './onecli-provider-credentials.js';

let data: string;
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-record-'));
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

describe('OneCLI provider credential record', () => {
  it('starts empty, adds ids per provider without duplicates, and replaces on request', () => {
    expect(readProviderCredentials(data)).toEqual({ providers: {}, matched: [] });
    recordProviderCredentials(data, 'claude', ['a']);
    recordProviderCredentials(data, 'claude', ['a', 'b']);
    recordProviderCredentials(data, 'codex', ['c']);
    expect(readProviderCredentials(data).providers).toEqual({ claude: ['a', 'b'], codex: ['c'] });
    recordProviderCredentials(data, 'claude', ['d'], { replace: true });
    expect(readProviderCredentials(data)).toEqual({ providers: { claude: ['d'], codex: ['c'] }, matched: [] });
  });

  it('keeps the file private, its directory usable for staged OneCLI files (0700), and leaves no lock behind', () => {
    recordProviderCredentials(data, 'claude', ['a']);
    expect(fs.statSync(providerCredentialFile(data)).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(providerCredentialFile(data))).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(providerCredentialFile(data)))).toEqual(['provider-credentials.json']);
  });

  it.each([
    '[]',
    '{"providers":{"claude":"a"},"matched":[]}',
    '{"providers":{"claude":[1]},"matched":[]}',
    '{"providers":{}}',
    'not json',
  ])('rejects a malformed record: %s', (raw) => {
    fs.mkdirSync(path.dirname(providerCredentialFile(data)), { recursive: true });
    fs.writeFileSync(providerCredentialFile(data), raw);
    expect(() => readProviderCredentials(data)).toThrow();
    expect(() => recordProviderCredentials(data, 'claude', ['a'])).toThrow();
  });

  it('waits for another writer’s lock and never takes one over, naming it instead', () => {
    recordProviderCredentials(data, 'claude', ['a']);
    const lock = `${providerCredentialFile(data)}.lock`;
    fs.writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    expect(() => updateProviderCredentials(data, () => {}, { lockTimeoutMs: 100 })).toThrow(/\.lock is held/);
    expect(fs.existsSync(lock)).toBe(true);
    fs.rmSync(lock);
    recordProviderCredentials(data, 'codex', ['c']);
    expect(readProviderCredentials(data).providers).toEqual({ claude: ['a'], codex: ['c'] });
  });

  it('never drops an id when separate processes record at the same time', async () => {
    const script = `
      import { recordProviderCredentials } from ${JSON.stringify(path.resolve(__dirname, 'onecli-provider-credentials.ts'))};
      for (let i = 0; i < 20; i++) recordProviderCredentials(process.argv[1], 'p', [process.argv[2] + '-' + i]);
    `;
    const run = (tag: string) =>
      new Promise<number>((resolve) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, data, tag], {
          stdio: 'ignore',
        });
        child.on('exit', (code) => resolve(code ?? 1));
      });
    expect(await Promise.all([run('a'), run('b'), run('c')])).toEqual([0, 0, 0]);
    expect(readProviderCredentials(data).providers.p).toHaveLength(60);
  });

  it('matches only the names NanoClaw provider setup writes', () => {
    const is = isSavedProviderCredential;
    expect(is('claude', { name: 'Anthropic' })).toBe(true);
    expect(is('claude', { name: 'My key', type: 'anthropic' } as never)).toBe(false);
    expect(is('claude', { name: 'OpenCode anthropic' })).toBe(false);
    expect(is('codex', { name: 'Codex' })).toBe(true);
    expect(is('codex', { name: 'openai' })).toBe(true);
    expect(is('codex', { name: 'OpenCode ChatGPT', type: 'openai' } as never)).toBe(false);
    expect(is('opencode', { name: 'OpenCode ChatGPT' })).toBe(true);
    expect(is('opencode', { name: 'OpenCode openrouter' })).toBe(true);
    expect(is('opencode', { name: 'Vercel API Token' })).toBe(false);
    expect(is('ollama', { name: 'Anthropic' })).toBe(false);
    expect(is('claude', {})).toBe(false);
  });

  it('reads the id from `onecli secrets create` output, with or without a hint', () => {
    expect(createdSecretId('{"id":"sec-1","name":"Codex"}')).toBe('sec-1');
    expect(createdSecretId('{\n  "hint": "next: attach",\n  "id": "sec-2"\n}')).toBe('sec-2');
    expect(createdSecretId('{"data":{"id":"sec-3"}}')).toBe('sec-3');
    expect(createdSecretId('Done.')).toBeNull();
    expect(createdSecretId('{"id":""}')).toBeNull();
  });
});
