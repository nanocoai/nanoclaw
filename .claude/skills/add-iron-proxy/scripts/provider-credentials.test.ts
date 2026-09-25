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
    // Iron's PUT/PATCH takes an opaque id (updates, 404 when gone) or a
    // foreign id (upserts). The fixture keys records by foreign id.
    const byOid = action.startsWith('id-') ? [...records.entries()].find(([, r]) => r.id === action) : undefined;
    if (method !== 'GET' && action.startsWith('id-') && !byOid) throw new IronControlRequestError('fixture', 404);
    const key = method === 'GET' ? kind + '/' + id : (byOid?.[0] ?? kind + '/' + action);
    if (method === 'GET') {
      const record = records.get(key);
      if (!record || record.namespace !== namespace) throw new IronControlRequestError('fixture', 404);
      const response = structuredClone(record);
      if (kind === 'broker_credentials') {
        response.status = record.dead ? 'dead' : 'live';
        response.last_refresh = 'refreshed-' + Date.now();
        response.expires_at ??= new Date(Date.now() + 3_600_000).toISOString();
      }
      return response;
    }
    const foreignId = byOid ? byOid[1].foreign_id : action;
    const record = { ...data, id: records.get(key)?.id ?? 'id-' + records.size, foreign_id: foreignId };
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
    profile: 'chatgpt',
    clientId: 'public-opencode-client',
    tokenEndpoint: 'https://auth.example.test/oauth/token',
  },
};
const tokens = (refreshToken = 'refresh-fixture') =>
  ({ profile: 'chatgpt', accessToken: 'unused-access', refreshToken, accountId: 'account-fixture' }) as const;
/** The native id assigned to the connection's static secret, read from the fixture rather than the seam. */
const idOf = (f: ReturnType<typeof fixture>, name: string) =>
  [...f.records.values()].find((r) => r.name === name && r.rules)?.id as string;
it.each([
  ['Authorization', 'Bearer {value}'],
  ['x-goog-api-key', '{value}'],
  ['x-api-key', '{value}'],
])('stores and rotates %s without changing the granted ID or exposing keys in metadata', async (header, format) => {
  const f = fixture();
  const target = api(undefined, header, format);
  const c = f.connect(target);
  expect(await c.find()).toBeNull();
  await c.save('first-fixture');
  const id = idOf(f, target.name);
  expect(f.values.get(id)).toBe('first-fixture');
  expect(f.grants.has(id)).toBe(true);
  const next = f.connect(target);
  expect(await next.find()).toEqual({ reusable: true });
  await next.save('rotated-fixture');
  expect(idOf(f, target.name)).toBe(id);
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
  await c.save('fixture');
  const id = idOf(f, api().name);
  const fresh = f.connect(api());
  await fresh.find();
  f.request.mockClear();
  await fresh.keep();
  expect(f.request.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(true);
  expect(f.values.get(id)).toBe('fixture');
});
it('requires explicit host consent and a replacement value while preserving ID and grants', async () => {
  const f = fixture();
  const old = f.connect(api());
  await old.find();
  await old.save('fixture');
  const id = idOf(f, api().name);
  const next = f.connect(api('new.example.test'));
  await expect(next.find()).rejects.toThrow('host change cancelled');
  const confirmHostChange = vi.fn(async () => true);
  // Iron replaces the source alongside the rules, so a moved key is not reusable.
  expect(await next.find({ confirmHostChange })).toEqual({ reusable: false });
  expect(confirmHostChange).toHaveBeenCalledWith('models.example.test', 'new.example.test');
  await expect(next.keep()).rejects.toThrow('Re-enter');
  expect(f.values.get(id)).toBe('fixture');
  await next.save('replacement');
  expect(idOf(f, api().name)).toBe(id);
  expect([...f.records.values()][0].rules[0].host).toBe('new.example.test');
});
it('refuses changed metadata before credential replacement', async () => {
  const f = fixture();
  const c = f.connect(api());
  await c.find();
  await c.save('fixture');
  const id = idOf(f, api().name);
  const next = f.connect(api());
  await next.find();
  [...f.records.values()][0].rules[0].http_methods = ['GET'];
  await expect(next.save('replacement')).rejects.toThrow('unexpected metadata');
  expect(f.values.get(id)).toBe('fixture');
});
it('delegates OAuth refresh to Iron and preserves broker, secret, account and grant IDs on reauth', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  await c.save(tokens());
  expect(f.records.size).toBe(3);
  expect(f.grants.size).toBe(2);
  const before = [...f.records.values()].map((r) => r.id);
  const next = f.connect(oauth);
  expect(await next.find()).toEqual({ reusable: true });
  await next.save(tokens('rotated-refresh'));
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
  await c.save(tokens());
  [...f.records.values()].find((r) => r.client_id).dead = true;
  const next = f.connect(oauth);
  expect(await next.find()).toEqual({ reusable: false });
  await expect(next.keep()).rejects.toThrow('sign in again');
});
it('updates an existing credential by its opaque id so a replacement created in the race window is never overwritten', async () => {
  const f = fixture();
  const c = f.connect(api());
  await c.find();
  await c.save('fixture');
  const id = idOf(f, api().name);
  const next = f.connect(api());
  await next.find();
  const request = f.request.getMockImplementation()!;
  let swapped = false;
  f.request.mockImplementation(async (resource, method = 'GET', data) => {
    // Between the last unchanged() read and the PUT, an operator deletes the
    // record and recreates it under the same foreign id with other grants.
    if (!swapped && method === 'PUT' && resource.startsWith('static_secrets/')) {
      swapped = true;
      const [key, old] = [...f.records.entries()].find(([, r]) => r.id === id)!;
      f.records.set(key, { ...old, id: 'id-replacement' });
      f.values.set('id-replacement', 'replacement-secret');
      f.values.delete(id);
    }
    return request(resource, method, data);
  });
  await expect(next.save('rotated')).rejects.toMatchObject({ status: 404 });
  expect(f.values.get('id-replacement')).toBe('replacement-secret');
  expect([...f.values.values()]).not.toContain('rotated');
  expect(f.grants.has('id-replacement')).toBe(false);
});
it('does not report a half-rotated OAuth login as reusable', async () => {
  const f = fixture();
  const first = f.connect(oauth);
  await first.find();
  await first.save({ ...tokens('refresh-A'), accountId: 'account-A' });
  const relogin = f.connect(oauth);
  await relogin.find();
  const request = f.request.getMockImplementation()!;
  let failed = false;
  f.request.mockImplementation(async (resource, method = 'GET', data) => {
    // Account B's refresh token lands in the broker, then the account-header write fails.
    if (!failed && method === 'PUT' && resource.startsWith('static_secrets/') && data?.name?.endsWith(' account')) {
      failed = true;
      throw new Error('account write interrupted');
    }
    return request(resource, method, data);
  });
  await expect(relogin.save({ ...tokens('refresh-B'), accountId: 'account-B' })).rejects.toThrow('interrupted');
  expect([...f.values.values()]).toContain('refresh-B');
  expect([...f.values.values()]).toContain('account-A');
  const retry = f.connect(oauth);
  expect(await retry.find()).toEqual({ reusable: false });
  await expect(retry.keep()).rejects.toThrow('sign in again');
  await retry.save({ ...tokens('refresh-B'), accountId: 'account-B' });
  expect([...f.values.values()]).toContain('account-B');
  expect(await f.connect(oauth).find()).toEqual({ reusable: true });
});
it('treats a live broker whose token has expired as needing a new sign-in', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  await c.save(tokens());
  const broker = [...f.records.values()].find((r) => r.client_id);
  broker.expires_at = new Date(Date.now() - 1_000).toISOString();
  const next = f.connect(oauth);
  expect(await next.find()).toEqual({ reusable: false });
  await expect(next.keep()).rejects.toThrow('sign in again');
  expect(f.grants.size).toBe(2);
});
it('does not turn API unavailability into an absent credential', async () => {
  const f = fixture();
  f.request.mockRejectedValue(new IronControlRequestError('fixture 503', 503));
  await expect(f.connect(api()).find()).rejects.toThrow('503');
});

it.each([
  'http://models.example.test/v1',
  'https://models.example.test:8000/v1',
  'https://192.168.1.20/v1',
  'https://host.docker.internal/v1',
  'https://llm.local/v1',
  'https://home.arpa/v1',
  'https://llm.home.arpa/v1',
])('rejects unsupported model endpoint %s before changing configuration', (url) => {
  const f = fixture();
  expect(() => ironModelEndpoint(url, f.root)).toThrow('HTTPS model endpoint on port 443');
  expect(f.allowHost).not.toHaveBeenCalled();
});
it('names what Iron needs when it refuses a model endpoint', () => {
  const f = fixture();
  expect(() => ironModelEndpoint('http://host.docker.internal:8000/v1', f.root)).toThrow(
    /port 443 whose host is a DNS name with a publicly trusted certificate/,
  );
});
it.each(['https://models.example.test/v1', 'https://models.example.test:443/v1'])(
  'accepts the HTTPS endpoint %s',
  (url) => {
    const f = fixture();
    expect(() => ironModelEndpoint(url, f.root)).not.toThrow();
  },
);
it('rechecks OAuth account rules before keeping or replacing a credential', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  await c.save(tokens());
  const next = f.connect(oauth);
  await next.find();
  [...f.records.values()].find((r) => r.foreign_id.endsWith('-account')).rules[0].paths = ['/only'];
  await expect(next.keep()).rejects.toThrow('unexpected metadata');
  await expect(next.save(tokens('new'))).rejects.toThrow('unexpected metadata');
  expect([...f.values.values()]).not.toContain('new');
});
it('allows normal broker refresh activity during sign-in without accepting an edited binding', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  await c.save(tokens());
  const next = f.connect(oauth);
  await next.find();
  const broker = [...f.records.values()].find((r) => r.client_id);
  broker.updated_at = 'later';
  broker.next_refresh_attempt_at = 'later';
  expect(await next.find()).toEqual({ reusable: true });
  broker.client_id = 'different-client';
  await expect(next.save(tokens('new'))).rejects.toThrow('unexpected metadata');
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
  await expect(c.save(tokens())).rejects.toThrow('interrupted save');
  const partialIds = [...f.records.values()].map((r) => r.id);
  const retry = f.connect(oauth);
  expect(await retry.find()).toBeNull();
  await retry.save(tokens());
  expect([...f.records.values()].map((r) => r.id)).toEqual(expect.arrayContaining(partialIds));
  expect(f.records.size).toBe(3);
  expect(f.grants.size).toBe(2);
});

it('requires a lookup before any write and refuses keep() with nothing stored', async () => {
  const f = fixture();
  await expect(f.connect(api()).save('fixture')).rejects.toThrow('Look up');
  await expect(f.connect(api()).keep()).rejects.toThrow('Look up');
  const c = f.connect(api());
  expect(await c.find()).toBeNull();
  await expect(c.keep()).rejects.toThrow('No stored Iron credential');
  expect(f.request.mock.calls.every(([, method]) => method === undefined || method === 'GET')).toBe(true);
});
it('accepts only the ChatGPT profile and only values matching the connection kind', async () => {
  const f = fixture();
  expect(() => f.connect({ ...oauth, oauth: { ...oauth.oauth, profile: 'other' as never } })).toThrow(
    'only the ChatGPT subscription OAuth profile',
  );
  const login = f.connect(oauth);
  await login.find();
  await expect(login.save('not-a-login')).rejects.toThrow('does not match its connection type');
  await expect(login.save({ ...tokens(), profile: 'other' as never })).rejects.toThrow(
    'does not match its connection type',
  );
  const key = f.connect(api());
  await key.find();
  await expect(key.save(tokens())).rejects.toThrow('does not match its connection type');
  expect(f.records.size).toBe(0);
});
it('routes the ChatGPT account id on the profile header without the caller naming it', async () => {
  const f = fixture();
  const c = f.connect(oauth);
  await c.find();
  await c.save(tokens());
  const account = [...f.records.values()].find((r) => r.foreign_id.endsWith('-account'));
  expect(account.replace_config.match_headers).toEqual(['Chatgpt-Account-Id']);
  expect(f.values.get(account.id)).toBe('account-fixture');
});
