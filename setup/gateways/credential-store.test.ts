import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { getCredentialStore } from './credential-store.js';

const roots: string[] = [];
afterEach(() => {
  delete process.env.NANOCLAW_GATEWAY_PROVIDER;
  roots.splice(0).forEach((r) => fs.rmSync(r, { recursive: true, force: true }));
});
it('loads an arbitrary selected gateway without a provider-specific switch', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-store-'));
  roots.push(root);
  const skill = path.join(root, '.claude/skills/add-example');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(skill, 'SKILL.md'), 'fixture');
  fs.writeFileSync(
    path.join(skill, 'gateway.json'),
    JSON.stringify({ kind: 'example', label: 'Example', description: 'Test gateway', default: true }),
  );
  fs.writeFileSync(
    path.join(skill, 'scripts/credential-store.ts'),
    'export function createCredentialStore(){return {has: async p=>p==="codex", save: async ()=>{}}}',
  );
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'example';
  expect(await (await getCredentialStore(root)).has('codex')).toBe(true);
  process.env.NANOCLAW_GATEWAY_PROVIDER = 'missing';
  await expect(getCredentialStore(root)).rejects.toThrow('Unknown gateway');
});
