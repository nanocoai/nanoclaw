// Both installed gateways run their real seam adapters here. Only the
// gateway selection and the transports beneath the adapters are stubbed, so
// OpenCode is exercised against OneCLI's and Iron's actual translation and
// failure paths rather than a hand-written stand-in.
vi.mock('../setup/gateways/credential-store.js', async () => {
  const { createProviderCredentialConnection } =
    await import('../.claude/skills/add-onecli/scripts/provider-credentials.js');
  const { createIronCredentialConnection, ironModelEndpoint } =
    await import('../.claude/skills/add-iron-proxy/scripts/provider-credentials.js');
  const { IronControlRequestError } = await import('../.claude/skills/add-iron-proxy/scripts/control.js');
  const ironRequest = async (resource: string, method = 'GET', data?: any) => {
    if (fixture.failVault) throw new IronControlRequestError('Iron unavailable', 503);
    const [kind, action, namespace, id] = resource.split('/');
    const key = kind + '/' + (method === 'GET' ? id : action);
    if (method === 'GET') {
      const record = fixture.iron.records.get(key);
      if (!record || record.namespace !== namespace) throw new IronControlRequestError('fixture', 404);
      const response = structuredClone(record);
      if (kind === 'broker_credentials') Object.assign(response, { status: 'live', last_refresh: 'refreshed' });
      return response;
    }
    // A PUT names either a foreign id (create or upsert) or an existing
    // record's opaque id (update in place), as Iron Control does.
    const existing =
      fixture.iron.records.get(key) ??
      [...fixture.iron.records.entries()].find(([k, r]) => k.startsWith(kind + '/') && r.id === action)?.[1];
    const record = {
      ...data,
      id: existing?.id ?? 'id-' + fixture.iron.records.size,
      foreign_id: existing?.foreign_id ?? action,
    };
    if (kind === 'static_secrets') {
      if (data.source.secret !== undefined) fixture.iron.values.set(record.id, data.source.secret);
      record.source = { source_type: data.source.source_type, config: data.source.config };
      record.inject_config ??= {};
    } else {
      fixture.iron.values.set(record.id, record.refresh_token);
      delete record.refresh_token;
      record.dead = false;
    }
    fixture.iron.records.set(kind + '/' + record.foreign_id, record);
    return structuredClone(record);
  };
  return {
    getCredentialStore: async () => ({
      has: async () => false,
      save: async () => {},
      ...(fixture.gateway === 'iron-proxy'
        ? {
            modelEndpoint: (url: string) => {
              ironModelEndpoint(url, fixture.iron.root);
              return {
                configure: async () => {
                  fixture.gatewayEndpoints.push(url);
                },
              };
            },
            connection: (target: any) =>
              createIronCredentialConnection(target, fixture.iron.root, {
                request: ironRequest,
                grant: async (id: string) => {
                  fixture.iron.grants.add(id);
                },
                allowHost: async (host: string) => {
                  fixture.iron.allowed.push(host);
                },
                checkIsolation: async () => {},
              }),
          }
        : { connection: (target: any) => createProviderCredentialConnection(target) }),
    }),
  };
});
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = vi.hoisted(() => ({
  gateway: 'onecli',
  gatewayEndpoints: [] as string[],
  iron: {
    root: '',
    records: new Map<string, any>(),
    values: new Map<string, string>(),
    grants: new Set<string>(),
    allowed: [] as string[],
  },
  writes: [] as Array<[string, string | null]>,
  requests: [] as RequestInit[],
  vaultUrls: [] as string[],
  textPrompts: [] as string[],
  catalogs: 0,
  customProvider: 'openai',
  baseUrl: 'https://models.example/v1',
  baseUrlAnswers: [] as string[],
  placeholders: [] as string[],
  validationErrors: [] as string[],
  warnings: [] as string[],
  modelFetchError: undefined as Error | undefined,
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
  text: async ({
    message,
    placeholder,
    validate,
  }: {
    message: string;
    placeholder?: string;
    validate?: (value: string) => string | undefined;
  }) => {
    fixture.textPrompts.push(message);
    if (message.includes('provider id')) return fixture.customProvider;
    if (message.includes('base URL')) {
      fixture.placeholders.push(placeholder ?? '');
      // Clack re-asks until validate passes; the operator answers in order, then gives up.
      for (const answer of fixture.baseUrlAnswers.length ? fixture.baseUrlAnswers : [fixture.baseUrl]) {
        const error = validate?.(answer);
        if (!error) return answer;
        fixture.validationErrors.push(error);
      }
      return Symbol('cancel');
    }
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
  log: {
    success: vi.fn(),
    info: vi.fn(),
    warn: (message: string) => {
      fixture.warnings.push(message);
    },
  },
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
import { runOpenCodeAuthStep, runOpenCodeSetupAuth } from './opencode-auth.js';

beforeEach(() => {
  Object.assign(fixture, {
    gateway: 'onecli',
    gatewayEndpoints: [],
    iron: { root: fixture.iron.root, records: new Map(), values: new Map(), grants: new Set(), allowed: [] },
    writes: [],
    requests: [],
    vaultUrls: [],
    textPrompts: [],
    catalogs: 0,
    customProvider: 'openai',
    baseUrl: 'https://models.example/v1',
    baseUrlAnswers: [],
    placeholders: [],
    validationErrors: [],
    warnings: [],
    modelFetchError: undefined,
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
        if (fixture.modelFetchError) throw fixture.modelFetchError;
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
  it('cannot silently skip authentication when called by setup', async () => {
    fixture.backend = 'skip';
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('requires a configured backend');
    expect(fixture.writes).toEqual([]);
    expect(fixture.requests).toEqual([]);
  });
});

describe('local endpoint with OneCLI selected', () => {
  it('still accepts a plaintext local endpoint and suggests one', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    fixture.baseUrl = 'http://host.docker.internal:8000/v1';
    await runOpenCodeAuthStep();
    expect(fixture.validationErrors).toEqual([]);
    expect(fixture.placeholders).toEqual(['http://host.docker.internal:8000/v1']);
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', 'http://host.docker.internal:8000/v1']);
  });
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

describe('OpenCode setup with Iron selected', () => {
  const roots: string[] = [];
  beforeEach(async () => {
    fixture.gateway = 'iron-proxy';
    vi.stubEnv('ONECLI_URL', undefined);
    vi.stubEnv('ONECLI_API_KEY', undefined);
    // The real Iron adapter refuses to touch credentials before Iron Control is registered.
    const { controlPaths } = await import('../.claude/skills/add-iron-proxy/scripts/control.js');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-iron-setup-'));
    roots.push(root);
    fs.mkdirSync(path.dirname(controlPaths(root).registration), { recursive: true });
    fs.writeFileSync(controlPaths(root).registration, '{}');
    fixture.iron.root = root;
  });
  afterEach(() => {
    for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  });
  const storedValues = () => [...fixture.iron.values.values()];
  it('connects a native backend without reading OneCLI or changing gateway selection', async () => {
    await runOpenCodeSetupAuth();
    expect(storedValues()).toEqual(['fixture-key']);
    expect(fixture.iron.grants.size).toBe(1);
    expect(fixture.iron.allowed).toContain('openrouter.ai');
    expect(fixture.vaultUrls).toEqual([]);
    expect(fixture.gatewayEndpoints).toEqual(['https://openrouter.ai']);
    expect(fixture.writes).toContainEqual(['OPENCODE_PROVIDER', 'openrouter']);
    expect(fixture.writes.every(([key]) => key.startsWith('OPENCODE_'))).toBe(true);
    const [record] = fixture.iron.records.values();
    expect(record.replace_config).toEqual({
      proxy_value: 'nc-opencode-token-v1',
      match_headers: ['Authorization'],
      require: false,
    });
    expect(JSON.stringify([...fixture.iron.records.values()])).not.toContain('fixture-key');
  });
  it('keeps an Iron key on a blank answer and rotates it under the same native id', async () => {
    await runOpenCodeSetupAuth();
    const [id] = fixture.iron.values.keys();
    fixture.key = '';
    fixture.writes = [];
    await runOpenCodeSetupAuth();
    expect(storedValues()).toEqual(['fixture-key']);
    expect(fixture.writes).toContainEqual(['OPENCODE_PROVIDER', 'openrouter']);
    fixture.key = 'rotated-fixture';
    await runOpenCodeSetupAuth();
    expect([...fixture.iron.values.entries()]).toEqual([[id, 'rotated-fixture']]);
    expect(fixture.iron.grants.size).toBe(1);
  });
  it('requires a value after an Iron host move because Iron cannot keep a moved key', async () => {
    fixture.backend = 'local';
    await runOpenCodeSetupAuth();
    fixture.baseUrl = 'https://moved.example/v1';
    fixture.key = '';
    fixture.writes = [];
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('API key is required');
    expect(fixture.hostConfirmations).toBe(1);
    expect(storedValues()).toEqual(['fixture-key']);
    expect(fixture.writes).toEqual([]);
  });
  it('configures a keyless HTTPS model route without creating a credential', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    await runOpenCodeSetupAuth();
    expect(storedValues()).toEqual([]);
    expect(fixture.passwords).toBe(0);
    expect(fixture.gatewayEndpoints).toEqual(['https://models.example/v1']);
    expect(fixture.vaultUrls).toEqual([]);
  });
  it('rejects a plaintext local endpoint at the prompt and asks again', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    fixture.baseUrlAnswers = ['http://host.docker.internal:8000/v1', 'https://models.example/v1'];
    await runOpenCodeSetupAuth();
    expect(fixture.validationErrors).toHaveLength(1);
    expect(fixture.validationErrors[0]).toMatch(/HTTPS model endpoint on port 443/);
    expect(fixture.validationErrors[0]).toMatch(/publicly trusted certificate/);
    expect(fixture.validationErrors[0]).toMatch(/Local model behind Iron Proxy/);
    expect(fixture.gatewayEndpoints).toEqual(['https://models.example/v1']);
    expect(fixture.writes).toContainEqual(['OPENCODE_BASE_URL', 'https://models.example/v1']);
  });
  it.each([
    ['plain HTTP', 'http://host.docker.internal:8000/v1'],
    ['HTTPS on another port', 'https://models.example:8443/v1'],
    ['an IP address', 'https://192.168.1.20/v1'],
    ['a private name', 'https://host.docker.internal/v1'],
  ])('never saves %s, before requesting keys or discovering models', async (_label, url) => {
    fixture.backend = 'local';
    fixture.baseUrl = url;
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('cancelled');
    expect(fixture.validationErrors).toHaveLength(1);
    expect(fixture.passwords).toBe(0);
    expect(fixture.catalogs).toBe(0);
    expect(fixture.modelRequests).toEqual([]);
    expect(fixture.writes).toEqual([]);
    expect(fixture.gatewayEndpoints).toEqual([]);
  });
  it('accepts HTTPS on port 443 with a DNS name', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    fixture.baseUrl = 'https://models.example:443/v1';
    await runOpenCodeSetupAuth();
    expect(fixture.validationErrors).toEqual([]);
    expect(fixture.gatewayEndpoints).toEqual(['https://models.example:443/v1']);
  });
  it('suggests an HTTPS URL in the local endpoint prompt', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    await runOpenCodeSetupAuth();
    expect(fixture.placeholders).toEqual(['https://models.example.com/v1']);
  });
  it('refuses an exported base URL Iron cannot use before asking for one', async () => {
    fixture.backend = 'local';
    vi.stubEnv('OPENCODE_BASE_URL', 'http://host.docker.internal:8000/v1');
    await expect(runOpenCodeSetupAuth()).rejects.toThrow(
      /exported OPENCODE_BASE_URL.*HTTPS model endpoint on port 443/s,
    );
    expect(fixture.placeholders).toEqual([]);
    expect(fixture.writes).toEqual([]);
  });
  it.each(['DEPTH_ZERO_SELF_SIGNED_CERT', 'INVALID_PURPOSE', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID'])(
    'warns at setup when the endpoint certificate fails verification (%s)',
    async (code) => {
      fixture.backend = 'local';
      fixture.keyless = true;
      fixture.modelFetchError = Object.assign(new TypeError('fetch failed'), {
        cause: Object.assign(new Error('certificate verification failed'), { code }),
      });
      await runOpenCodeSetupAuth();
      expect(fixture.warnings.join('\n')).toMatch(/publicly trusted certificate/);
    },
  );
  it('does not blame the certificate for a connection failure', async () => {
    fixture.backend = 'local';
    fixture.keyless = true;
    fixture.modelFetchError = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }),
    });
    await runOpenCodeSetupAuth();
    expect(fixture.warnings.join('\n')).toMatch(/Could not list models/);
    expect(fixture.warnings.join('\n')).not.toMatch(/certificate/);
  });
  it('does not fall back to OneCLI or save defaults after an Iron failure', async () => {
    fixture.failVault = true;
    await expect(runOpenCodeSetupAuth()).rejects.toThrow('Iron unavailable');
    expect(fixture.vaultUrls).toEqual([]);
    expect(fixture.passwords).toBe(0);
    expect(fixture.writes).toEqual([]);
    expect(fixture.gatewayEndpoints).toEqual([]);
  });
});
