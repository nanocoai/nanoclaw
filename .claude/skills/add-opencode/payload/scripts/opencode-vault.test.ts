import { afterEach, expect, it, vi } from 'vitest';
import { apiKeyInjection, CHATGPT_SECRET, createOpenCodeVault } from './opencode-vault.js';
const mock = vi.hoisted(() => ({ resolve: vi.fn() }));
vi.mock('../setup/gateways/credential-store.js', () => ({ getCredentialConnection: mock.resolve }));
afterEach(() => {
  vi.unstubAllEnvs();
  mock.resolve.mockReset();
});
it('routes lookup, save and retention through the selected gateway without OneCLI configuration', async () => {
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', 'iron-proxy');
  vi.stubEnv('ONECLI_URL', undefined);
  const connection = {
    canKeep: false,
    find: vi.fn(async () => 'id'),
    save: vi.fn(async () => 'id'),
    keep: vi.fn(async () => {}),
  };
  mock.resolve.mockResolvedValue(connection);
  const target = {
    name: 'OpenCode google',
    kind: 'api-key' as const,
    host: 'generativelanguage.googleapis.com',
    injection: apiKeyInjection('google'),
  };
  const vault = createOpenCodeVault(target, '/fixture');
  expect(mock.resolve).not.toHaveBeenCalled();
  expect(await vault.find()).toBe('id');
  expect(vault.canKeep).toBe(false);
  await vault.save('fixture-key', 'id');
  await vault.keep('id');
  expect(mock.resolve).toHaveBeenCalledExactlyOnceWith({ ...target, proxyValue: 'nc-opencode-token-v1' }, '/fixture');
  expect(connection.save).toHaveBeenCalledWith('fixture-key', 'id');
  expect(connection.keep).toHaveBeenCalledWith('id');
});
it('does not fall back when the selected gateway rejects the connection', async () => {
  mock.resolve.mockRejectedValue(new Error('gateway unavailable'));
  const vault = createOpenCodeVault(CHATGPT_SECRET);
  await expect(vault.find()).rejects.toThrow('gateway unavailable');
  expect(mock.resolve).toHaveBeenCalledTimes(1);
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
