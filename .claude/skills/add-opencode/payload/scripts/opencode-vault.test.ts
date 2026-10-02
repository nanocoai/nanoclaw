import { afterEach, expect, it, vi } from 'vitest';
import { apiKeyInjection, CHATGPT_SECRET, createOpenCodeVault } from './opencode-vault.js';
import { OPENCODE_CREDENTIAL_PLACEHOLDER as HOST_PLACEHOLDER } from '../src/providers/opencode-auth-stub.js';
import { OPENCODE_CREDENTIAL_PLACEHOLDER as RUNTIME_PLACEHOLDER } from '../container/agent-runner/src/providers/opencode-auth.js';
const mock = vi.hoisted(() => ({ store: vi.fn() }));
vi.mock('../setup/gateways/credential-store.js', () => ({ getCredentialStore: mock.store }));
afterEach(() => {
  vi.unstubAllEnvs();
  mock.store.mockReset();
});
it('presents one placeholder in setup and in the container', () => {
  expect(HOST_PLACEHOLDER).toBe(RUNTIME_PLACEHOLDER);
});
it('routes lookup, save and retention through the selected gateway without OneCLI configuration', async () => {
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', 'iron-proxy');
  vi.stubEnv('ONECLI_URL', undefined);
  const connection = {
    find: vi.fn(async () => ({ reusable: false })),
    save: vi.fn(async () => {}),
    keep: vi.fn(async () => {}),
  };
  const store = { has: vi.fn(), save: vi.fn(), connection: vi.fn(() => connection) };
  mock.store.mockResolvedValue(store);
  const target = {
    name: 'OpenCode google',
    kind: 'api-key' as const,
    host: 'generativelanguage.googleapis.com',
    injection: apiKeyInjection('google'),
  };
  const vault = createOpenCodeVault(target, '/fixture');
  expect(mock.store).not.toHaveBeenCalled();
  expect(await vault.find()).toEqual({ reusable: false });
  await vault.save('fixture-key');
  await vault.keep();
  expect(mock.store).toHaveBeenCalledExactlyOnceWith('/fixture');
  expect(store.connection).toHaveBeenCalledExactlyOnceWith({ ...target, proxyValue: HOST_PLACEHOLDER });
  expect(connection.save).toHaveBeenCalledWith('fixture-key');
  expect(connection.keep).toHaveBeenCalledWith();
});
it('does not fall back when the selected gateway rejects the connection', async () => {
  mock.store.mockRejectedValue(new Error('gateway unavailable'));
  const vault = createOpenCodeVault(CHATGPT_SECRET);
  await expect(vault.find()).rejects.toThrow('gateway unavailable');
  expect(mock.store).toHaveBeenCalledTimes(1);
});
it('fails explicitly when the selected gateway offers only provider-named credentials', async () => {
  mock.store.mockResolvedValue({ has: vi.fn(), save: vi.fn() });
  await expect(createOpenCodeVault(CHATGPT_SECRET).find()).rejects.toThrow('does not support provider credential');
});
it('describes ChatGPT as the named profile with only provider-owned facts', () => {
  expect(CHATGPT_SECRET).toEqual({
    name: 'OpenCode ChatGPT',
    kind: 'oauth',
    host: 'chatgpt.com',
    oauth: { profile: 'chatgpt', clientId: expect.any(String), tokenEndpoint: 'https://auth.openai.com/oauth/token' },
  });
});
it.each([
  ['openai', 'Authorization', 'Bearer {value}'],
  ['openrouter', 'Authorization', 'Bearer {value}'],
  ['deepseek', 'Authorization', 'Bearer {value}'],
  ['google', 'x-goog-api-key', '{value}'],
  ['anthropic', 'x-api-key', '{value}'],
])('declares %s authentication in the provider', (provider, headerName, valueFormat) => {
  expect(apiKeyInjection(provider)).toEqual({ headerName, valueFormat });
});
it('rejects unknown authentication schemes', () => {
  expect(() => apiKeyInjection('unknown')).toThrow('does not yet support');
});
