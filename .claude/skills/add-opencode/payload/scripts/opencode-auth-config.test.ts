import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  writes: [] as Array<[string, string | null]>,
  requests: [] as RequestInit[],
  vaultUrls: [] as string[],
  textPrompts: [] as string[],
  catalogs: 0,
  customProvider: 'openai',
  baseUrl: 'https://models.example/v1',
  oldHost: '',
  moveHost: true,
  hostConfirmations: 0,
  failVault: false,
  cancelPassword: false,
  existing: false,
  backend: 'openrouter',
  key: 'fixture-key',
  writesAtVault: -1,
  passwords: 0,
  keyless: false,
  modelRequests: [] as Array<{ request: RequestInit; passwords: number; saved: number }>,
  failModels: false,
  cancelModel: false,
}));
vi.mock('../setup/lib/bright-select.js', () => ({
  brightSelect: async ({ message }: { message: string }) =>
    message.includes('backend')
      ? fixture.backend
      : fixture.cancelModel
        ? Symbol('cancel')
        : `${fixture.backend === 'local' ? 'openai' : fixture.backend === 'custom' ? fixture.customProvider : 'openrouter'}/fixture`,
}));
vi.mock('@clack/prompts', () => ({
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: () => {
    throw new Error('cancelled');
  },
  text: async ({ message }: { message: string }) => {
    fixture.textPrompts.push(message);
    if (message.includes('provider id')) return fixture.customProvider;
    if (message.includes('base URL')) return fixture.baseUrl;
    return `${fixture.backend === 'local' ? 'openai' : fixture.backend === 'custom' ? fixture.customProvider : 'openrouter'}/fixture`;
  },
  confirm: async ({ message }: { message: string }) => {
    if (message.includes('Move')) {
      fixture.hostConfirmations++;
      return fixture.moveHost;
    }
    return fixture.keyless;
  },
  password: async () => {
    fixture.passwords++;
    return fixture.cancelPassword ? Symbol('cancel') : fixture.key;
  },
  log: { success: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));
vi.mock('../setup/logs.js', () => ({ userInput: vi.fn(), step: vi.fn() }));
vi.mock('../setup/set-env.js', () => ({
  upsertEnvVar: (key: string, value: string) => fixture.writes.push([key, value]),
  removeEnvVar: (key: string) => fixture.writes.push([key, null]),
}));
vi.mock('../src/config.js', async (original) => ({
  ...(await original<object>()),
  ONECLI_URL: 'https://configured-vault.example',
}));
vi.mock('child_process', async (original) => ({
  ...(await original<typeof import('child_process')>()),
  execFileSync: () => {
    fixture.catalogs++;
    throw new Error('catalog unavailable');
  },
}));
import { runOpenCodeAuthStep } from './opencode-auth.js';

beforeEach(() => {
  Object.assign(fixture, {
    writes: [],
    requests: [],
    vaultUrls: [],
    textPrompts: [],
    catalogs: 0,
    customProvider: 'openai',
    baseUrl: 'https://models.example/v1',
    oldHost: '',
    moveHost: true,
    hostConfirmations: 0,
    failVault: false,
    cancelPassword: false,
    existing: false,
    backend: 'openrouter',
    key: 'fixture-key',
    writesAtVault: -1,
    passwords: 0,
    keyless: false,
    modelRequests: [],
    failModels: false,
    cancelModel: false,
  });
  for (const key of [
    'OPENCODE_PROVIDER',
    'OPENCODE_MODEL',
    'OPENCODE_SMALL_MODEL',
    'OPENCODE_BASE_URL',
    'OPENCODE_AUTH_MODE',
  ]) {
    vi.stubEnv(key, undefined);
  }
  vi.stubEnv('ONECLI_URL', 'https://configured-vault.example');
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, request: RequestInit) => {
      if (String(_url).endsWith('/models')) {
        fixture.modelRequests.push({
          request,
          passwords: fixture.passwords,
          saved: fixture.requests.filter((r) => ['POST', 'PATCH'].includes(r.method ?? '')).length,
        });
        if (fixture.failModels) return new Response('Unauthorized', { status: 401 });
        return new Response(JSON.stringify({ data: [{ id: 'fixture' }] }));
      }
      fixture.requests.push(request);
      fixture.vaultUrls.push(String(_url));
      fixture.writesAtVault = fixture.writes.length;
      if (fixture.failVault) throw new Error('private-transport-detail');
      return new Response(
        JSON.stringify(
          request.method === 'GET'
            ? fixture.existing
              ? [
                  {
                    id: 'granted-id',
                    name: `OpenCode ${fixture.backend === 'local' ? 'openai' : fixture.backend === 'custom' ? fixture.customProvider : 'openrouter'}`,
                    type: 'generic',
                    hostPattern:
                      fixture.oldHost ||
                      (fixture.backend === 'local'
                        ? 'models.example'
                        : fixture.backend === 'custom'
                          ? 'api.openai.com'
                          : 'openrouter.ai'),
                    scope: 'project',
                    valueSource: 'inline',
                    pathPattern: null,
                    injectionConfig: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
                  },
                ]
              : []
            : { id: 'created-id', success: true, preview: 'private-preview' },
        ),
      );
    }),
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('OpenCode auth configuration commit', () => {
  it('vaults before writing only provider-owned defaults and never invokes the global CLI', async () => {
    await runOpenCodeAuthStep();
    expect(fixture.writesAtVault).toBe(0);
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
    expect(JSON.parse(fixture.requests.at(-1)!.body as string).value).toBe('fixture-key');
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', 'native']);
    expect(fixture.writes.every(([key]) => key.startsWith('OPENCODE_'))).toBe(true);
  });
  it('preserves defaults and does not request a key when metadata is unavailable', async () => {
    fixture.failVault = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('Could not confirm');
    expect(fixture.writes).toEqual([]);
    expect(fixture.passwords).toBe(0);
  });
  it('preserves defaults and the vault when the password prompt is cancelled', async () => {
    fixture.cancelPassword = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('cancelled');
    expect(fixture.writes).toEqual([]);
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET']);
  });
  it('keeps a blank key and replaces its value while preserving the granted ID', async () => {
    fixture.existing = true;
    fixture.key = '';
    await runOpenCodeAuthStep();
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET']);
    fixture.key = 'replacement-fixture';
    fixture.requests = [];
    await runOpenCodeAuthStep();
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(fixture.vaultUrls.at(-1)).toBe('https://configured-vault.example/v1/secrets/granted-id');
  });
  it.each(['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'OPENCODE_BASE_URL', 'OPENCODE_AUTH_MODE'])(
    'refuses an exported %s conflict before requesting or saving credentials',
    async (name) => {
      vi.stubEnv(name, 'conflicting-value');
      await expect(runOpenCodeAuthStep()).rejects.toThrow(`exported ${name}`);
      expect(fixture.requests).toEqual([]);
      expect(fixture.writes).toEqual([]);
      expect(fixture.passwords).toBe(0);
    },
  );
  it.each(
    ['local', 'custom'].flatMap((backend) =>
      ['OPENCODE_PROVIDER', 'OPENCODE_MODEL', 'OPENCODE_SMALL_MODEL', 'OPENCODE_BASE_URL', 'OPENCODE_AUTH_MODE'].map(
        (name) => [backend, name],
      ),
    ),
  )(
    'refuses a %s endpoint exported %s conflict before keys, vault reads, or catalog requests',
    async (backend, name) => {
      fixture.backend = backend;
      vi.stubEnv(name, name.includes('MODEL') ? 'openai/another-model' : 'conflicting-value');
      await expect(runOpenCodeAuthStep()).rejects.toThrow(`exported ${name}`);
      expect(fixture.passwords).toBe(0);
      expect(fixture.requests).toEqual([]);
      expect(fixture.modelRequests).toEqual([]);
      expect(fixture.catalogs).toBe(0);
      expect(fixture.writes).toEqual([]);
    },
  );
  it.each(['local', 'custom'])(
    'keeps matching exported %s settings without a keyed catalog request',
    async (backend) => {
      fixture.backend = backend;
      vi.stubEnv('OPENCODE_PROVIDER', 'openai');
      vi.stubEnv('OPENCODE_BASE_URL', fixture.baseUrl);
      vi.stubEnv('OPENCODE_MODEL', 'openai/fixture');
      vi.stubEnv('OPENCODE_SMALL_MODEL', 'openai/fixture');
      vi.stubEnv('OPENCODE_AUTH_MODE', '');
      await runOpenCodeAuthStep();
      expect(fixture.modelRequests).toEqual([]);
      expect(fixture.requests.map((request) => request.method)).toEqual(['GET', 'GET', 'POST']);
      expect(fixture.writes).toContainEqual(['OPENCODE_MODEL', 'openai/fixture']);
    },
  );
});

describe('custom endpoint model discovery', () => {
  it('prompts first and sends the new bearer only to the configured catalog before vaulting', async () => {
    fixture.backend = 'local';
    await runOpenCodeAuthStep();
    expect(fixture.modelRequests).toHaveLength(1);
    const catalog = fixture.modelRequests[0];
    expect(catalog.passwords).toBe(1);
    expect(catalog.saved).toBe(0);
    expect(catalog.request.headers).toEqual({ Authorization: 'Bearer fixture-key' });
    expect(catalog.request.redirect).toBe('error');
    expect(fixture.writes).toContainEqual(['OPENCODE_MODEL', 'openai/fixture']);
    expect(JSON.stringify(fixture.writes)).not.toContain('fixture-key');
  });
  it('supports keyless discovery without a vault lookup or Authorization header', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    await runOpenCodeAuthStep();
    expect(fixture.requests).toEqual([]);
    expect(fixture.passwords).toBe(0);
    expect(fixture.modelRequests[0].request.headers).toBeUndefined();
  });
  it('keeps a vaulted key without extracting it or sending an unauthenticated catalog request', async () => {
    fixture.backend = 'local';
    fixture.existing = true;
    fixture.key = '';
    await runOpenCodeAuthStep();
    expect(fixture.modelRequests).toEqual([]);
    expect(fixture.requests.map((r) => r.method)).toEqual(['GET', 'GET']);
    expect(fixture.writes).toContainEqual(['OPENCODE_MODEL', 'openai/fixture']);
  });
  it('falls back to manual model entry when the guarded catalog fails', async () => {
    fixture.backend = 'local';
    fixture.failModels = true;
    await runOpenCodeAuthStep();
    expect(fixture.modelRequests).toHaveLength(1);
    expect(fixture.writes).toContainEqual(['OPENCODE_MODEL', 'openai/fixture']);
  });
  it('does not save the key or defaults when model selection is cancelled', async () => {
    fixture.backend = 'local';
    fixture.cancelModel = true;
    await expect(runOpenCodeAuthStep()).rejects.toThrow('cancelled');
    expect(fixture.requests.map((r) => r.method)).toEqual(['GET']);
    expect(fixture.writes).toEqual([]);
  });
});

describe('backend authentication changes', () => {
  it('rejects unsupported native auth before the base URL, catalog, model, or key prompts', async () => {
    fixture.backend = 'custom';
    fixture.customProvider = 'amazon-bedrock';
    await expect(runOpenCodeAuthStep()).rejects.toThrow('API-key setup does not yet support');
    expect(fixture.textPrompts).toEqual(['OpenCode provider id']);
    expect(fixture.catalogs).toBe(0);
    expect(fixture.passwords).toBe(0);
    expect(fixture.requests).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });

  it.each(['fixture-key', ''])('confirms a local host change and preserves its granted ID (key: %s)', async (key) => {
    fixture.backend = 'local';
    fixture.existing = true;
    fixture.oldHost = 'previous.example';
    fixture.key = key;
    await runOpenCodeAuthStep();
    expect(fixture.hostConfirmations).toBe(1);
    expect(fixture.vaultUrls.at(-1)).toMatch(/\/granted-id$/);
    const patch = JSON.parse(fixture.requests.at(-1)!.body as string);
    expect(patch.hostPattern).toBe('models.example');
    if (key) expect(patch.value).toBe(key);
    else expect(patch).not.toHaveProperty('value');
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', fixture.baseUrl]);
  });

  it('can move a local OpenAI credential back to the native OpenAI endpoint', async () => {
    fixture.backend = 'custom';
    fixture.baseUrl = '';
    fixture.existing = true;
    fixture.oldHost = 'previous.example';
    await runOpenCodeAuthStep();
    expect(fixture.hostConfirmations).toBe(1);
    expect(JSON.parse(fixture.requests.at(-1)!.body as string).hostPattern).toBe('api.openai.com');
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', 'native']);
  });

  it.each(['decline', 'cancel-model'])('leaves the old host and defaults unchanged on %s', async (outcome) => {
    fixture.backend = 'local';
    fixture.existing = true;
    fixture.oldHost = 'previous.example';
    fixture.moveHost = outcome !== 'decline';
    fixture.cancelModel = outcome === 'cancel-model';
    await expect(runOpenCodeAuthStep()).rejects.toThrow(outcome === 'decline' ? 'host change cancelled' : 'cancelled');
    expect(fixture.requests.map((request) => request.method)).toEqual(['GET']);
    expect(fixture.writes).toEqual([]);
  });
});
