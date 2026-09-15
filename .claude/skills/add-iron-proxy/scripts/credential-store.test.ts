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
const mocks = vi.hoisted(() => ({ request: vi.fn(), grant: vi.fn(), run: vi.fn() }));
vi.mock('./control.js', () => ({
  controlPaths: (root: string) => ({ directory: root, registration: path.join(root, 'registration.json') }),
  controlRequest: mocks.request,
  grantSecret: mocks.grant,
}));
vi.mock('./setup.js', () => ({
  statePaths: (root: string) => ({ allowedHosts: path.join(root, 'allowed.json') }),
  run: mocks.run,
}));
import { createCredentialStore } from './credential-store.js';
const roots: string[] = [];
afterEach(() => {
  roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
  vi.clearAllMocks();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-store-'));
  roots.push(root);
  fs.writeFileSync(path.join(root, 'registration.json'), '{}');
  fs.writeFileSync(path.join(root, 'allowed.json'), '[]');
  return root;
}
it('stores an API key only in Iron and records credential-free local metadata', async () => {
  const root = fixture();
  mocks.request.mockResolvedValue({ id: 'ssr_test' });
  await createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-sensitive' });
  expect(mocks.request).toHaveBeenCalledWith(
    root,
    'static_secrets/codex-api',
    'PUT',
    expect.objectContaining({
      source: { source_type: 'control_plane', secret: 'fixture-sensitive', config: {} },
      rules: [{ host: 'api.openai.com', http_methods: ['*'] }],
    }),
  );
  expect(fs.readFileSync(path.join(root, 'codex.json'), 'utf8')).not.toContain('fixture-sensitive');
  expect(mocks.grant).toHaveBeenCalledWith('static', 'ssr_test', root);
  expect(mocks.run).toHaveBeenCalledWith([], root);
});
it('delegates refresh rotation to the native Iron broker and grants only derived access/account secrets', async () => {
  const root = fixture();
  mocks.request.mockImplementation(async (_r: string, resource: string) => ({
    id: resource.startsWith('broker_') ? 'bcr_test' : 'ssr_test',
  }));
  const file = path.join(root, 'dedicated-login.json');
  const claims = Buffer.from(JSON.stringify({ aud: 'codex-public-client' })).toString('base64url');
  fs.writeFileSync(
    file,
    JSON.stringify({
      tokens: {
        id_token: `e30.${claims}.signature`,
        refresh_token: 'fixture-refresh',
        access_token: 'fixture-access',
        account_id: 'fixture-account',
      },
    }),
  );
  await createCredentialStore(root).save('codex', { kind: 'oauth', file });
  expect(mocks.request).toHaveBeenCalledWith(
    root,
    'broker_credentials/codex',
    'PUT',
    expect.objectContaining({
      client_id: 'codex-public-client',
      refresh_token: 'fixture-refresh',
      token_endpoint: 'https://auth.openai.com/oauth/token',
    }),
  );
  expect(mocks.request).toHaveBeenCalledWith(
    root,
    'static_secrets/codex-chatgpt',
    'PUT',
    expect.objectContaining({ source: { source_type: 'token_broker', config: { credential_id: 'bcr_test' } } }),
  );
  const local = fs.readFileSync(path.join(root, 'codex.json'), 'utf8');
  expect(local).not.toMatch(/fixture-(refresh|access|account)/);
});
it('does not claim a dead broker is connected', async () => {
  const root = fixture();
  fs.writeFileSync(path.join(root, 'codex.json'), JSON.stringify({ secretIds: [], brokerId: 'bcr_test' }));
  mocks.request.mockResolvedValue({ dead: true });
  expect(await createCredentialStore(root).has('codex')).toBe(false);
});

it('does not mark authentication complete when proxy refresh fails', async () => {
  const root = fixture();
  mocks.request.mockResolvedValue({ id: 'ssr_test' });
  mocks.run.mockRejectedValueOnce(new Error('fixture unavailable'));
  await expect(createCredentialStore(root).save('codex', { kind: 'api-key', value: 'fixture-key' })).rejects.toThrow(
    'fixture unavailable',
  );
  expect(fs.existsSync(path.join(root, 'codex.json'))).toBe(false);
});
