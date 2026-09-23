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
import { createCredentialStore, waitForBrokerToken } from './credential-store.js';
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
  mocks.request.mockImplementation(async (_r: string, resource: string, method?: string) => ({
    id: resource.startsWith('broker_') ? 'bcr_test' : 'ssr_test',
    ...(resource.startsWith('broker_') && method === undefined ? { status: 'live' } : {}),
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

function oauthLogin(root: string): string {
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
  return file;
}
it('waits for the broker to mint its first access token before the proxy is refreshed', async () => {
  const root = fixture();
  let polls = 0;
  mocks.request.mockImplementation(async (_r: string, resource: string, method?: string) => {
    if (resource === 'broker_credentials/bcr_test' && method === undefined)
      return { id: 'bcr_test', status: ++polls < 3 ? 'bootstrapping' : 'live', dead: false };
    return { id: resource.startsWith('broker_') ? 'bcr_test' : 'ssr_test' };
  });
  vi.useFakeTimers();
  try {
    const saved = createCredentialStore(root).save('codex', { kind: 'oauth', file: oauthLogin(root) });
    await vi.advanceTimersByTimeAsync(10_000);
    await saved;
  } finally {
    vi.useRealTimers();
  }
  expect(polls).toBe(3);
  const order = mocks.request.mock.calls.map((call) => `${call[2] ?? 'GET'} ${call[1]}`);
  expect(order.indexOf('GET broker_credentials/bcr_test')).toBeGreaterThan(
    order.indexOf('PUT broker_credentials/codex'),
  );
  expect(order.lastIndexOf('GET broker_credentials/bcr_test')).toBeLessThan(
    order.indexOf('PUT static_secrets/codex-chatgpt'),
  );
  expect(mocks.run).toHaveBeenCalledTimes(1);
  expect(fs.existsSync(path.join(root, 'codex.json'))).toBe(true);
});
it('does not report success while the broker is still bootstrapping', async () => {
  const root = fixture();
  mocks.request.mockImplementation(async (_r: string, resource: string, method?: string) =>
    resource === 'broker_credentials/bcr_test' && method === undefined
      ? { id: 'bcr_test', status: 'bootstrapping', dead: false }
      : { id: resource.startsWith('broker_') ? 'bcr_test' : 'ssr_test' },
  );
  await expect(waitForBrokerToken(root, 'bcr_test', { timeoutMs: 30, intervalMs: 10 })).rejects.toThrow(
    'has not minted a Codex access token',
  );
  mocks.request.mockResolvedValue({ id: 'bcr_test', status: 'dead', dead: true, dead_reason: 'fixture-sensitive' });
  const dead = waitForBrokerToken(root, 'bcr_test', { timeoutMs: 30, intervalMs: 10 });
  await expect(dead).rejects.toThrow('could not refresh the Codex session');
  await expect(dead).rejects.not.toThrow('fixture-sensitive');
  expect(mocks.run).not.toHaveBeenCalled();
});
