import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { assertCredentialIsolation } from './credential-isolation.js';
import { controlPaths } from './control.js';
import { getInstallSlug } from '../../../../src/install-slug.js';
const roots: string[] = [];
afterEach(() => roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true })));
function fixture(secrets: any[], inherited = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-isolation-'));
  roots.push(root);
  const registration = controlPaths(root).registration;
  fs.mkdirSync(path.dirname(registration), { recursive: true });
  fs.writeFileSync(registration, JSON.stringify({ principalId: 'install' }));
  const request = vi.fn(async (resource: string): Promise<any> => {
    if (resource.endsWith('/roles')) return inherited ? [{ id: 'team' }] : [];
    if (resource.includes('/grants?'))
      return resource.startsWith(inherited ? 'roles/team/' : 'principals/install/')
        ? secrets.map((_, i) => ({ static_secret_id: `s${i}` }))
        : [];
    if (resource.startsWith('static_secrets/'))
      return { id: resource.split('/')[1], namespace: 'other', ...secrets[Number(resource.slice(-1))] };
    throw new Error('Unexpected resource ' + resource);
  });
  const check = (overrides = {}) =>
    assertCredentialIsolation(
      root,
      {
        host: 'api.openai.com',
        headers: ['Authorization'],
        proxyValue: 'nc-opencode-token-v1',
        ownedForeignIds: [],
        ...overrides,
      },
      request,
    );
  return { root, request, check };
}
const rule = [{ host: 'api.openai.com', http_methods: ['*'] }];
it.each([false, true])('rejects a host injector including inherited grants=%s', async (inherited) => {
  const f = fixture([{ rules: rule, inject_config: { header: 'Authorization' } }], inherited);
  await expect(f.check()).rejects.toThrow('conflicts on api.openai.com');
  expect(f.request.mock.calls.every(([resource]) => !resource.includes('effective_config'))).toBe(true);
});
it('checks inactive broker-backed secrets without reading token values', async () => {
  const f = fixture([
    {
      rules: [{ host: '*.openai.com' }],
      source: { source_type: 'token_broker', config: { credential_id: 'inactive' } },
      inject_config: { header: 'authorization' },
    },
  ]);
  await expect(f.check()).rejects.toThrow('conflicts');
});
it.each([
  { proxy_value: 'legacy', match_headers: ['Authorization'], require: true },
  { proxy_value: 'opencode-token', match_headers: ['Authorization'], require: false },
])('rejects required or overlapping replacement markers', async (replace_config) => {
  await expect(fixture([{ rules: rule, replace_config }]).check()).rejects.toThrow('conflicts');
});
it('allows separate Codex and OpenCode account selection on the same HTTPS host', async () => {
  const f = fixture([
    {
      rules: rule,
      replace_config: { proxy_value: 'nc-codex-token-v1', match_headers: ['Authorization'], require: false },
    },
  ]);
  await expect(f.check()).resolves.toBeUndefined();
});
it('allows unrelated hosts and headers while excluding only owned namespace IDs', async () => {
  const f = fixture([{ foreign_id: 'own', rules: rule, inject_config: { header: 'Authorization' } }]);
  await expect(f.check({ ownedForeignIds: ['own'] })).rejects.toThrow('conflicts');
  await expect(f.check({ host: 'models.example.test' })).resolves.toBeUndefined();
  await expect(f.check({ headers: ['x-api-key'] })).resolves.toBeUndefined();
  f.request.mockImplementation(async (resource) =>
    resource.endsWith('/roles')
      ? []
      : resource.includes('/grants?')
        ? [{ static_secret_id: 'own' }]
        : {
            namespace: getInstallSlug(f.root),
            foreign_id: 'own',
            rules: rule,
            inject_config: { header: 'Authorization' },
          },
  );
  await expect(f.check({ ownedForeignIds: ['own'] })).resolves.toBeUndefined();
});
it('reads every grant page and fails closed on unavailable metadata', async () => {
  const f = fixture([]);
  f.request.mockImplementation(async (resource) => {
    if (resource.endsWith('/roles')) return [];
    if (resource.includes('page=1')) return Array.from({ length: 200 }, () => ({ static_secret_id: 'safe' }));
    if (resource.includes('page=2')) return [{ static_secret_id: 'unreadable' }];
    if (resource.endsWith('/safe')) return { rules: [{ host: 'other.example.test' }] };
    throw new Error('Control unavailable');
  });
  await expect(f.check()).rejects.toThrow('Control unavailable');
});

it.each(['api.[o]penai.com', 'api.\\openai.com', '*.*.com'])(
  'rejects ambiguous native host glob %s conservatively',
  async (host) => {
    await expect(fixture([{ rules: [{ host }], inject_config: { header: 'Authorization' } }]).check()).rejects.toThrow(
      'conflicts',
    );
  },
);
it.each([
  { replace_config: { proxy_value: 'unrelated', match_headers: ['X-Api-Key'], require: true } },
  { inject_config: { header: 'X-Api-Key', require: true } },
])('rejects required transforms even on another header', async (config) => {
  await expect(fixture([{ rules: rule, ...config }]).check()).rejects.toThrow('conflicts');
});

it('rejects another marker with a noncanonical shared account header', async () => {
  const f = fixture([
    {
      rules: [{ host: 'chatgpt.com' }],
      replace_config: { proxy_value: 'nc-codex-token-v1', match_headers: ['ChatGPT-Account-Id'], require: false },
    },
  ]);
  await expect(f.check({ host: 'chatgpt.com', headers: ['ChatGPT-Account-Id'] })).rejects.toThrow('conflicts');
});
