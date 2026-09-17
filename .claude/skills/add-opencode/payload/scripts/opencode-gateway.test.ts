// OpenCode reaches credentials only through the selected gateway's
// credential store. This test installs a gateway that exists nowhere else —
// a fixture skill with its own `gateway.json` — and drives the real setup
// entry points through the real `getCredentialStore()` resolution. If OpenCode
// carried a gateway-specific branch, the fixture gateway could not satisfy it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  backend: 'openrouter',
  key: 'fixture-key',
  passwords: 0,
  writes: [] as Array<[string, string | null]>,
}));
vi.mock('../setup/lib/bright-select.js', () => ({
  brightSelect: async ({ message }: { message: string }) =>
    message.includes('backend') ? fixture.backend : message.includes('ChatGPT') ? 'device' : 'openrouter/fixture',
}));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: () => {
    throw new Error('cancelled');
  },
  text: async () => 'openrouter/fixture',
  confirm: async () => false,
  password: async () => {
    fixture.passwords++;
    return fixture.key;
  },
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn(), step: vi.fn() },
}));
vi.mock('../setup/logs.js', () => ({ userInput: vi.fn(), step: vi.fn() }));
vi.mock('../setup/set-env.js', () => ({
  upsertEnvVar: (key: string, value: string) => fixture.writes.push([key, value]),
  removeEnvVar: (key: string) => fixture.writes.push([key, null]),
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: () => {
    throw new Error('catalog unavailable');
  },
}));
import { runOpenCodeChatGptAuth, runOpenCodeSetupAuth } from './opencode-auth.js';

type Call = [string, ...unknown[]];
declare global {
  // eslint-disable-next-line no-var
  var __opencodeGatewayFixture: { calls: Call[]; found: { reusable: boolean } | null; withConnection: boolean };
}

const cwd = process.cwd();
const roots: string[] = [];
function installFixtureGateway(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fixture-gateway-'));
  roots.push(root);
  const skill = path.join(root, '.claude/skills/add-fixture');
  fs.mkdirSync(path.join(skill, 'scripts'), { recursive: true });
  fs.writeFileSync(
    path.join(skill, 'gateway.json'),
    JSON.stringify({ kind: 'fixture', label: 'Fixture', description: 'test gateway', default: true }),
  );
  fs.writeFileSync(path.join(skill, 'SKILL.md'), '# fixture\n');
  fs.writeFileSync(
    path.join(skill, 'scripts/credential-store.ts'),
    `
    const state = globalThis.__opencodeGatewayFixture;
    export function createCredentialStore() {
      return {
        has: async () => false,
        save: async () => {},
        modelEndpoint: (url) => ({ configure: async () => { state.calls.push(['endpoint', url]); } }),
        ...(state.withConnection
          ? {
              connection: (target) => ({
                find: async (options) => { state.calls.push(['find', target, Boolean(options)]); return state.found; },
                save: async (value) => { state.calls.push(['save', value]); },
                keep: async () => { state.calls.push(['keep']); },
              }),
            }
          : {}),
      };
    }`,
  );
  return root;
}

beforeEach(() => {
  globalThis.__opencodeGatewayFixture = { calls: [], found: null, withConnection: true };
  Object.assign(fixture, { backend: 'openrouter', key: 'fixture-key', passwords: 0, writes: [] });
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_BASE_URL',
    'OPENCODE_AUTH_MODE',
  ])
    vi.stubEnv(key, undefined);
  vi.stubEnv('NANOCLAW_GATEWAY_PROVIDER', 'fixture');
  process.chdir(installFixtureGateway());
});
afterEach(() => {
  process.chdir(cwd);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const calls = () => globalThis.__opencodeGatewayFixture.calls;

describe('OpenCode through a gateway it has never heard of', () => {
  it('describes an API key with only provider-owned facts and saves before writing defaults', async () => {
    await runOpenCodeSetupAuth();
    expect(calls().map(([name]) => name)).toEqual(['find', 'save', 'endpoint']);
    expect(calls()[0][1]).toEqual({
      name: 'OpenCode openrouter',
      kind: 'api-key',
      host: 'openrouter.ai',
      proxyValue: 'nc-opencode-token-v1',
      injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
    });
    expect(calls()[0][2]).toBe(true);
    expect(calls()[1]).toEqual(['save', 'fixture-key']);
    expect(calls()[2]).toEqual(['endpoint', 'https://openrouter.ai']);
    expect(fixture.writes).toContainEqual(['OPENCODE_PROVIDER', 'openrouter']);
  });

  it('keeps a reusable credential on a blank answer without asking the gateway for an id', async () => {
    globalThis.__opencodeGatewayFixture.found = { reusable: true };
    fixture.key = '';
    await runOpenCodeSetupAuth();
    expect(calls().map(([name]) => name)).toEqual(['find', 'keep', 'endpoint']);
    expect(fixture.writes).toContainEqual(['OPENCODE_PROVIDER', 'openrouter']);
  });

  it('demands a value when the gateway reports the stored credential cannot be kept', async () => {
    globalThis.__opencodeGatewayFixture.found = { reusable: false };
    fixture.key = '';
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('API key is required');
    expect(calls().map(([name]) => name)).toEqual(['find']);
    expect(fixture.writes).toEqual([]);
  });

  it('hands ChatGPT sign-in to the gateway as the named profile and reuses a live login', async () => {
    const signIn = vi.fn(async (_method: string, _root: string, vault: { save: (v: unknown) => Promise<void> }) => {
      await vault.save({ profile: 'chatgpt', accessToken: 'a', refreshToken: 'r', accountId: 'acct' });
    });
    await runOpenCodeChatGptAuth('device', { signIn });
    expect(calls()[0][1]).toEqual({
      name: 'OpenCode ChatGPT',
      kind: 'oauth',
      host: 'chatgpt.com',
      proxyValue: 'nc-opencode-token-v1',
      oauth: { profile: 'chatgpt', clientId: expect.any(String), tokenEndpoint: 'https://auth.openai.com/oauth/token' },
    });
    expect(calls()[1]).toEqual([
      'save',
      { profile: 'chatgpt', accessToken: 'a', refreshToken: 'r', accountId: 'acct' },
    ]);
    globalThis.__opencodeGatewayFixture.calls = [];
    globalThis.__opencodeGatewayFixture.found = { reusable: true };
    await runOpenCodeChatGptAuth('device', { signIn });
    expect(calls().map(([name]) => name)).toEqual(['find', 'keep']);
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it('fails before any prompt or default when the selected gateway offers no connections', async () => {
    globalThis.__opencodeGatewayFixture.withConnection = false;
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('does not support provider credential connections');
    expect(fixture.passwords).toBe(0);
    expect(fixture.writes).toEqual([]);
  });
});
