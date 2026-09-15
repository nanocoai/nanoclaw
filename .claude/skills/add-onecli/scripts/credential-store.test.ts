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
it('recognizes existing OpenAI secrets and fails explicitly when the selected vault is unavailable', async () => {
  exec.mockReturnValue(JSON.stringify({ data: [{ type: 'openai' }] }));
  expect(await createCredentialStore().has('codex')).toBe(true);
  exec.mockImplementation(() => {
    throw new Error('fixture-private-error');
  });
  await expect(createCredentialStore().has('codex')).rejects.toThrow('Cannot read the selected OneCLI vault');
});
