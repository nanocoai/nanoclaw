import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createdSecretId,
  isSavedProviderCredential,
  providerCredentialFile,
  readProviderCredentials,
  RecordLockedError,
  recordProviderCredentials,
  savedProviderCredentials,
  updateProviderCredentials,
} from './onecli-provider-credentials.js';

let data: string;
beforeEach(() => {
  data = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-record-'));
});
afterEach(() => fs.rmSync(data, { recursive: true, force: true }));

describe('OneCLI provider credential record', () => {
  it('starts empty, adds ids per provider without duplicates, and replaces on request', async () => {
    expect(readProviderCredentials(data)).toEqual({ providers: {}, matched: [] });
    await recordProviderCredentials(data, 'claude', ['a']);
    await recordProviderCredentials(data, 'claude', ['a', 'b']);
    await recordProviderCredentials(data, 'codex', ['c']);
    expect(readProviderCredentials(data).providers).toEqual({ claude: ['a', 'b'], codex: ['c'] });
    await recordProviderCredentials(data, 'claude', ['d'], { replace: true });
    expect(readProviderCredentials(data)).toEqual({ providers: { claude: ['d'], codex: ['c'] }, matched: [] });
  });

  it('keeps the file private, its directory usable for staged OneCLI files (0700), and leaves no lock behind', async () => {
    await recordProviderCredentials(data, 'claude', ['a']);
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
  ])('rejects a malformed record: %s', async (raw) => {
    fs.mkdirSync(path.dirname(providerCredentialFile(data)), { recursive: true });
    fs.writeFileSync(providerCredentialFile(data), raw);
    expect(() => readProviderCredentials(data)).toThrow();
    await expect(recordProviderCredentials(data, 'claude', ['a'])).rejects.toThrow();
  });

  const lockFile = () => `${providerCredentialFile(data)}.lock`;
  const holdLock = (content: string, ageMs = 0) => {
    fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
    fs.writeFileSync(lockFile(), content);
    if (ageMs) fs.utimesSync(lockFile(), new Date(Date.now() - ageMs), new Date(Date.now() - ageMs));
  };

  it('waits for a held lock without blocking the event loop, then fails naming the lock', async () => {
    holdLock(`${os.hostname()} ${process.ppid}`);
    let ticked = false;
    setTimeout(() => (ticked = true), 20);
    const err = await updateProviderCredentials(data, () => {}, { lockTimeoutMs: 200 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RecordLockedError);
    expect(String(err)).toContain(lockFile());
    expect(ticked).toBe(true);
  });

  it.each([
    ['a live writer', `${os.hostname()} ${process.ppid}`, 0],
    ['an old lock of a writer that is gone', `${os.hostname()} 999999`, 600_000],
    ['an empty lock', '', 600_000],
  ])('never takes over a lock (%s): a takeover could race a live writer', async (_name, content, age) => {
    holdLock(content, age);
    await expect(updateProviderCredentials(data, () => {}, { lockTimeoutMs: 100 })).rejects.toBeInstanceOf(
      RecordLockedError,
    );
    expect(fs.readFileSync(lockFile(), 'utf8')).toBe(content);
  });

  it('removes its own lock when writing its name fails (disk full), leaving nothing behind', async () => {
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' });
    });
    try {
      await expect(recordProviderCredentials(data, 'claude', ['a'])).rejects.toThrow('no space left');
    } finally {
      spy.mockRestore();
    }
    expect(fs.existsSync(lockFile())).toBe(false);
    await recordProviderCredentials(data, 'claude', ['a']);
    expect(readProviderCredentials(data).providers).toEqual({ claude: ['a'] });
  });

  it('names its writer in the lock, for whoever finds one left behind', async () => {
    let seen = '';
    await updateProviderCredentials(data, () => {
      seen = fs.readFileSync(lockFile(), 'utf8');
    });
    expect(seen).toBe(`${os.hostname()} ${process.pid}`);
  });

  it('never drops an id when separate processes record at the same time', async () => {
    const script = `
      import { recordProviderCredentials } from ${JSON.stringify(path.resolve(__dirname, 'onecli-provider-credentials.ts'))};
      for (let i = 0; i < 20; i++) await recordProviderCredentials(process.argv[1], 'p', [process.argv[2] + '-' + i]);
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
    expect(is('cursor', { name: 'Cursor' })).toBe(true);
    expect(is('cursor', { name: 'Cursor models' })).toBe(true);
    expect(is('cursor', { name: 'Cursor notes' })).toBe(false);
    expect(is('claude', { name: 'Cursor' })).toBe(false);
    expect(is('ollama', { name: 'Anthropic' })).toBe(false);
    expect(is('llmman', { name: 'Anthropic' })).toBe(false);
    expect(is('claude', {})).toBe(false);
  });

  it('refuses saved names that differ only in case, as the Codex matcher ignores case', () => {
    const codex = savedProviderCredentials('codex', [
      { id: 'c1', name: 'Codex' },
      { id: 'c2', name: 'codex' },
      { id: 'o1', name: 'OpenAI' },
    ]);
    expect(codex.ids).toEqual([]);
    expect(codex.duplicates).toEqual(['Codex c1', 'codex c2']);
    const openai = savedProviderCredentials('codex', [
      { id: 'o1', name: 'OpenAI' },
      { id: 'o2', name: 'openai' },
    ]);
    expect(openai).toEqual({ ids: [], duplicates: ['OpenAI o1', 'openai o2'] });
    expect(
      savedProviderCredentials('codex', [
        { id: 'c1', name: 'Codex' },
        { id: 'o1', name: 'OpenAI' },
      ]),
    ).toEqual({
      ids: ['c1', 'o1'],
      duplicates: [],
    });
  });

  it('reads the id from `onecli secrets create` output, with or without a hint', () => {
    expect(createdSecretId('{"id":"sec-1","name":"Codex"}')).toBe('sec-1');
    expect(createdSecretId('{\n  "hint": "next: attach",\n  "id": "sec-2"\n}')).toBe('sec-2');
    expect(createdSecretId('{"data":{"id":"sec-3"}}')).toBe('sec-3');
    expect(createdSecretId('Done.')).toBeNull();
    expect(createdSecretId('{"id":""}')).toBeNull();
  });
});
