import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getCredentialStore } from './credential-store.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env.NANOCLAW_GATEWAY_PROVIDER;
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function gateway(store: string, kind = 'example'): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-store-'));
  roots.push(root);
  const skill = path.join(root, '.claude/skills', `add-${kind}`);
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(skill, 'gateway.json'),
    JSON.stringify({ kind, label: kind, description: 'fixture', default: true }),
  );
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# fixture\n');
  fs.writeFileSync(path.join(skill, 'scripts/credential-store.ts'), store);
  process.env.NANOCLAW_GATEWAY_PROVIDER = kind;
  return root;
}

it('loads an arbitrary selected gateway without a provider-specific switch', async () => {
  const root = gateway(
    'export function createCredentialStore(){return {has: async p=>p==="codex", save: async ()=>{}}}',
  );
  const store = await getCredentialStore(root);
  expect(await store.has('codex')).toBe(true);
  expect(store.connection).toBeUndefined();
  expect(store.modelEndpoint).toBeUndefined();
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'missing';
  await expect(getCredentialStore(root)).rejects.toThrow('Unknown gateway');
});

it('offers caller-described connections through the same store as provider-named credentials', async () => {
  const root = gateway(`
    const calls = [];
    export function createCredentialStore() {
      return {
        has: async () => false,
        save: async () => {},
        modelEndpoint: (url) => ({ configure: async () => { calls.push(['endpoint', url]); } }),
        connection: (target) => ({
          find: async () => ({ reusable: target.kind === 'api-key' }),
          save: async (value) => { calls.push(['save', target.name, value]); },
          keep: async () => { calls.push(['keep', target.name]); },
        }),
        calls,
      };
    }`);
  const store = (await getCredentialStore(root)) as Awaited<ReturnType<typeof getCredentialStore>> & {
    calls: unknown[];
  };
  const key = store.connection!({
    name: 'provider-key',
    kind: 'api-key',
    host: 'models.example.test',
    proxyValue: 'nc-fixture-token',
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  });
  expect(await key.find()).toEqual({ reusable: true });
  await key.save('fixture');
  await key.keep();
  const login = store.connection!({
    name: 'provider-login',
    kind: 'oauth',
    host: 'chatgpt.com',
    proxyValue: 'nc-fixture-token',
    oauth: { profile: 'chatgpt', clientId: 'public', tokenEndpoint: 'https://auth.example.test/token' },
  });
  expect(await login.find()).toEqual({ reusable: false });
  await store.modelEndpoint!('https://models.example.test/v1').configure();
  expect(store.calls).toEqual([
    ['save', 'provider-key', 'fixture'],
    ['keep', 'provider-key'],
    ['endpoint', 'https://models.example.test/v1'],
  ]);
});

it.each([
  ['a connection that is not a function', 'connection: 1'],
  ['an endpoint hook that is not a function', 'modelEndpoint: "later"'],
])('rejects a gateway declaring %s', async (_label, extra) => {
  const root = gateway(
    `export function createCredentialStore(){return {has: async()=>false, save: async()=>{}, ${extra}}}`,
  );
  await expect(getCredentialStore(root)).rejects.toThrow('invalid credential store');
});

it('rejects a half-implemented connection before the provider can call it', async () => {
  const root = gateway(
    'export function createCredentialStore(){return {has: async()=>false, save: async()=>{}, connection: () => ({ find: async () => null })}}',
  );
  const store = await getCredentialStore(root);
  expect(() =>
    store.connection!({
      name: 'x',
      kind: 'api-key',
      host: 'models.example.test',
      proxyValue: 'nc-fixture-token',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    }),
  ).toThrow('invalid provider credential connection');
});
