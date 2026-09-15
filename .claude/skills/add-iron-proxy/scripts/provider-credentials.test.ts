import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { createIronCredentialConnection, ironModelEndpoint } from './provider-credentials.js';
import { controlPaths, IronControlRequestError } from './control.js';
import type { GatewayCredentialTarget } from '../../../../setup/gateways/credential-store.js';
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-provider-'));
  roots.push(root);
  const registration = controlPaths(root).registration;
  fs.mkdirSync(path.dirname(registration), { recursive: true });
  fs.writeFileSync(registration, '{}');
  const records = new Map<string, any>();
  const values = new Map<string, string>();
  const grants = new Set<string>();
  const request = vi.fn(async (resource: string, method = 'GET', data?: any) => {
    const [kind, action, namespace, id] = resource.split('/');
    const key = kind + '/' + (method === 'GET' ? id : action);
    if (method === 'GET') {
      const record = records.get(key);
      if (!record || record.namespace !== namespace) throw new IronControlRequestError('fixture', 404);
      const response = structuredClone(record);
      if (kind === 'broker_credentials') {
        response.status = record.dead ? 'dead' : 'live';
        response.last_refresh = 'refreshed-' + Date.now();
      }
      return response;
    }
    const record = { ...data, id: records.get(key)?.id ?? 'id-' + records.size, foreign_id: action };
    if (kind === 'static_secrets') {
      if (data.source.secret !== undefined) values.set(record.id, data.source.secret);
      record.source = { source_type: data.source.source_type, config: data.source.config };
      record.inject_config ??= {};
    } else {
      values.set(record.id, record.refresh_token);
      delete record.refresh_token;
      record.dead = false;
    }
    records.set(key, record);
    return structuredClone(record);
  });
  const grant = vi.fn(async (id: string) => {
    grants.add(id);
  });
  const allowHost = vi.fn(async (_host: string) => {});
  const connect = (target: GatewayCredentialTarget) =>
    createIronCredentialConnection(target, root, { request, grant, allowHost, checkIsolation: async () => {} });
  return { root, connect, records, values, grants, request, allowHost };
}
const api = (
  host = 'models.example.test',
  headerName = 'Authorization',
  valueFormat = 'Bearer {value}',
): GatewayCredentialTarget => ({
  name: 'OpenCode fixture',
  proxyValue: 'nc-opencode-token-v1',
  kind: 'api-key',
  host,
  injection: { headerName, valueFormat },
});
const oauth: GatewayCredentialTarget = {
  name: 'OpenCode ChatGPT',
  proxyValue: 'nc-opencode-token-v1',
  kind: 'oauth',
  host: 'chatgpt.com',
  oauth: {
    clientId: 'public-opencode-client',
    tokenEndpoint: 'https://auth.example.test/oauth/token',
    accountHeader: 'ChatGPT-Account-Id',
  },
};
it.each([
  ['Authorization', 'Bearer {value}'],
  ['x-goog-api-key', '{value}'],
  ['x-api-key', '{value}'],
])('stores and rotates %s without changing the granted ID or exposing keys in metadata', async (header, format) => {
  const f = fixture();
  const target = api(undefined, header, format);
  const c = f.connect(target);
  expect(await c.find()).toBeNull();
  const id = await c.save('first-fixture', null);
  expect(f.values.get(id)).toBe('first-fixture');
  expect(f.grants.has(id)).toBe(true);
  const next = f.connect(target);
  expect(await next.find()).toBe(id);
  expect(await next.save('rotated-fixture', id)).toBe(id);
  expect(f.values.get(id)).toBe('rotated-fixture');
  expect(f.grants.size).toBe(1);
  expect(JSON.stringify([...f.records.values()])).not.toContain('rotated-fixture');
  expect([...f.records.values()][0].inject_config).toEqual({});
  expect([...f.records.values()][0].replace_config).toEqual({
    proxy_value: 'nc-opencode-token-v1',
    match_headers: [
      { Authorization: 'Authorization', 'x-goog-api-key': 'X-Goog-Api-Key', 'x-api-key': 'X-Api-Key' }[header],
    ],
    require: false,
  });
});
it('keeps a saved key without requesting its value or changing the source', async () => {
  const f = fixture();
  const c = f.connect(api());
  await c.find();
  const id = await c.save('fixture', null);
  const fresh = f.connect(api());
  await fresh.find();
  f.request.mockClear();
  await fresh.keep(id);
  expect(f.request.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(true);
  expect(f.values.get(id)).toBe('fixture');
});
it('requires explicit host consent and a replacement value while preserving ID and grants', async () => {
  const f = fixture();
  const old = f.connect(api());
  await old.find();
  const id = await old.save('fixture', null);
  const next = f.connect(api('new.example.test'));
  await expect(next.find()).rejects.toThrow('host change cancelled');
  const confirmHostChange = vi.fn(async () => true);
  expect(await next.find({ confirmHostChange })).toBe(id);
  expect(confirmHostChange).toHaveBeenCalledWith('models.example.test', 'new.example.test');
  expect(next.canKeep).toBe(false);
  await expect(next.keep(id)).rejects.toThrow('Re-enter');
  expect(f.values.get(id)).toBe('fixture');
  expect(await next.save('replacement', id)).toBe(id);
  expect([...f.records.values()][0].rules[0].host).toBe('new.example.test');
});
it('refuses changed metadata before credential replacement', async () => {
  const f = fixture();
  const c = f.connect(api());
  await c.find();
  const id = await c.save('fixture', null);
  const next = f.connect(api());
  await next.find();
  [...f.records.values()][0].rules[0].http_methods = ['GET'];
  await expect(next.save('replacement', id)).rejects.toThrow('unexpected metadata');
  expect(f.values.get(id)).toBe('fixture');
});
it('delegates OAuth refresh to Iron and preserves broker, secret, account and grant IDs on reauth', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  const tokens = { accessToken: 'unused-access', refreshToken: 'refresh-fixture', accountId: 'account-fixture' };
  const id = await c.save(tokens, null);
  expect(f.records.size).toBe(3);
  expect(f.grants.size).toBe(2);
  const before = [...f.records.values()].map((r) => r.id);
  const next = f.connect(oauth);
  expect(await next.find()).toBe(id);
  await next.save({ ...tokens, refreshToken: 'rotated-refresh' }, id);
  expect([...f.records.values()].map((r) => r.id)).toEqual(before);
  expect(f.grants.size).toBe(2);
  expect([...f.values.values()]).toContain('rotated-refresh');
  expect(JSON.stringify([...f.records.values()])).not.toContain('refresh-fixture');
  expect(JSON.stringify([...f.records.values()])).not.toContain('unused-access');
});
it('marks a dead broker for reauthentication instead of reporting a usable connection', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  await c.save({ accessToken: 'a', refreshToken: 'r', accountId: 'id' }, null);
  [...f.records.values()].find((r) => r.client_id).dead = true;
  const next = f.connect(oauth);
  expect(await next.find()).not.toBeNull();
  expect(next.canKeep).toBe(false);
});
it('does not turn API unavailability into an absent credential', async () => {
  const f = fixture();
  f.request.mockRejectedValue(new IronControlRequestError('fixture 503', 503));
  await expect(f.connect(api()).find()).rejects.toThrow('503');
});

it.each(['http://models.example.test/v1', 'https://models.example.test:8000/v1'])(
  'rejects unsupported model endpoint %s before changing configuration',
  (url) => {
    const f = fixture();
    expect(() => ironModelEndpoint(url, f.root)).toThrow('HTTPS model endpoint on port 443');
    expect(f.allowHost).not.toHaveBeenCalled();
  },
);
it('rechecks OAuth account rules before keeping or replacing a credential', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  const id = await c.save({ accessToken: 'a', refreshToken: 'r', accountId: 'id' }, null);
  const next = f.connect(oauth);
  await next.find();
  [...f.records.values()].find((r) => r.foreign_id.endsWith('-account')).rules[0].paths = ['/only'];
  await expect(next.keep(id)).rejects.toThrow('unexpected metadata');
  await expect(next.save({ accessToken: 'a', refreshToken: 'new', accountId: 'id' }, id)).rejects.toThrow(
    'unexpected metadata',
  );
  expect([...f.values.values()]).not.toContain('new');
});
it('allows normal broker refresh activity during sign-in without accepting an edited binding', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  const id = await c.save({ accessToken: 'a', refreshToken: 'r', accountId: 'id' }, null);
  const next = f.connect(oauth);
  await next.find();
  const broker = [...f.records.values()].find((r) => r.client_id);
  broker.updated_at = 'later';
  broker.next_refresh_attempt_at = 'later';
  expect(await next.find()).toBe(id);
  broker.client_id = 'different-client';
  await expect(next.save({ accessToken: 'a', refreshToken: 'new', accountId: 'id' }, id)).rejects.toThrow(
    'unexpected metadata',
  );
});

it('retries a partially saved OAuth connection without duplicating its owned broker or account', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  const request = f.request.getMockImplementation()!;
  let fail = true;
  f.request.mockImplementation(async (resource, method = 'GET', data) => {
    if (fail && method === 'PUT' && resource.startsWith('static_secrets/') && !resource.endsWith('-account')) {
      fail = false;
      throw new Error('interrupted save');
    }
    return request(resource, method, data);
  });
  const tokens = { accessToken: 'a', refreshToken: 'r', accountId: 'id' };
  await expect(c.save(tokens, null)).rejects.toThrow('interrupted save');
  const partialIds = [...f.records.values()].map((r) => r.id);
  const retry = f.connect(oauth);
  expect(await retry.find()).toBeNull();
  await retry.save(tokens, null);
  expect([...f.records.values()].map((r) => r.id)).toEqual(expect.arrayContaining(partialIds));
  expect(f.records.size).toBe(3);
  expect(f.grants.size).toBe(2);
});
