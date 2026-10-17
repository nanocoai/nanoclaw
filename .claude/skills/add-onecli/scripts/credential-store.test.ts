import { getProviderHostContract, registerProviderHostContract } from '../../../../src/provider-contracts/index.js';
if (!getProviderHostContract('codex'))
  registerProviderHostContract('codex', {
    ...getProviderHostContract('claude')!,
    modelDomains: ['openai.com', 'chatgpt.com'],
    modelEndpoints: {
      api: 'https://api.openai.com',
      subscription: 'https://chatgpt.com',
      token: 'https://auth.openai.com/oauth/token',
    },
  });
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
const exec = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ execFileSync: exec }));
import { createCredentialStore } from './credential-store.js';
afterEach(() => vi.resetAllMocks());
it('passes API credentials in a private temporary file, never in argv, and removes it', async () => {
  let file = '';
  exec.mockImplementation((_bin, args) => {
    file = args[args.indexOf('--file') + 1];
    expect(fs.readFileSync(file, 'utf8')).toBe('fixture-key');
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(args).not.toContain('fixture-key');
  });
  await createCredentialStore().save('codex', { kind: 'api-key', value: 'fixture-key' });
  expect(fs.existsSync(file)).toBe(false);
});
it('counts only credentials Codex groups will be granted, records them, and fails explicitly without a vault', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-has-'));
  const record = () =>
    JSON.parse(fs.readFileSync(path.join(root, 'data', 'onecli', 'provider-credentials.json'), 'utf8')).providers;
  try {
    // OpenCode's credentials are not Codex's: Codex setup must still sign in.
    exec.mockReturnValueOnce(
      JSON.stringify({
        data: [
          { id: 'sec-oc', name: 'OpenCode openai', type: 'generic' },
          { id: 'sec-chatgpt', name: 'OpenCode ChatGPT', type: 'openai' },
        ],
      }),
    );
    expect(await createCredentialStore(root).has('codex')).toBe(false);
    // A credential Codex setup saved is counted and recorded, so a retried login repairs the record.
    exec.mockReturnValueOnce(JSON.stringify({ hint: 'h', data: [{ id: 'sec-codex', name: 'Codex', type: 'openai' }] }));
    expect(await createCredentialStore(root).has('codex')).toBe(true);
    expect(record()).toEqual({ codex: ['sec-codex'] });
    expect(exec.mock.calls.every(([, args]) => args.join(' ') === 'secrets list --max 0')).toBe(true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
  exec.mockImplementation(() => {
    throw new Error('fixture-private-error');
  });
  await expect(createCredentialStore().has('codex')).rejects.toThrow('Cannot read the selected OneCLI vault');
});
it('records the created Codex secret id so Codex groups are granted it, and only after a successful save', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-record-'));
  const file = path.join(root, 'data', 'onecli', 'provider-credentials.json');
  try {
    exec.mockReturnValueOnce('{\n  "hint": "attach it",\n  "id": "sec-codex"\n}');
    await createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-key' });
    expect(JSON.parse(fs.readFileSync(file, 'utf8')).providers).toEqual({ codex: ['sec-codex'] });
    fs.rmSync(path.join(root, 'data'), { recursive: true });
    exec.mockReturnValueOnce('not json');
    await createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-key' });
    exec.mockImplementationOnce(() => {
      throw new Error('fixture-private-error');
    });
    await expect(createCredentialStore(root).save('codex', { kind: 'api-key', value: 'k' })).rejects.toThrow(
      'Cannot save Codex credentials',
    );
    expect(fs.existsSync(file)).toBe(false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
