import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  apiKeyInjection,
  CHATGPT_SECRET,
  createOpenCodeVault,
  findOpenCodeSecret,
  type OpenCodeSecret,
} from './opencode-vault.js';

const google: OpenCodeSecret = {
  name: 'OpenCode google',
  type: 'generic',
  hostPattern: 'generativelanguage.googleapis.com',
  injectionConfig: apiKeyInjection('google'),
};
const metadata = (spec: OpenCodeSecret = google) => ({
  id: 'existing-key',
  name: spec.name,
  type: spec.type,
  hostPattern: spec.hostPattern,
  scope: 'project',
  valueSource: 'inline',
  pathPattern: null,
  injectionConfig: spec.injectionConfig ?? null,
  metadata: spec.authMode ? { authMode: spec.authMode } : {},
});

afterEach(() => vi.unstubAllEnvs());

describe('OpenCode vault management', () => {
  it('reads the gateway saved after the setup process imported configuration', async () => {
    const cwd = process.cwd();
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-fresh-vault-'));
    vi.stubEnv('ONECLI_URL', undefined);
    vi.stubEnv('ONECLI_API_KEY', undefined);
    try {
      process.chdir(directory);
      await import('../src/config.js');
      fs.writeFileSync('.env', 'ONECLI_URL=https://new-vault.example\nONECLI_API_KEY=new-management-fixture\n');
      const transport = vi.fn(async () => new Response('[]'));
      await createOpenCodeVault(google, undefined, undefined, transport).find();
      expect(transport).toHaveBeenCalledWith(
        'https://new-vault.example/v1/secrets',
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: 'Bearer new-management-fixture' }),
        }),
      );
    } finally {
      process.chdir(cwd);
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('repairs a legacy header while keeping the existing secret value and grants', async () => {
    const transport = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(
          JSON.stringify(
            init.method === 'GET' ? [{ ...metadata(), injectionConfig: apiKeyInjection('openai') }] : { success: true },
          ),
        ),
    );
    await createOpenCodeVault(google, 'http://vault.example', '', transport as typeof fetch).keep('existing-key');
    expect(transport.mock.calls.map(([, request]) => request.method)).toEqual(['GET', 'PATCH']);
    expect(JSON.parse(transport.mock.calls[1][1].body as string)).toEqual({ injectionConfig: google.injectionConfig });
  });

  it('uses the configured gateway, key and project despite conflicting CLI settings', async () => {
    vi.stubEnv('ONECLI_API_HOST', 'https://wrong-cli-vault.example');
    vi.stubEnv('ONECLI_PROJECT_ID', 'project-fixture');
    const requests: Array<[string, RequestInit]> = [];
    const transport = vi.fn(async (url: string, init: RequestInit) => {
      requests.push([url, init]);
      return new Response(JSON.stringify(init.method === 'GET' ? [metadata()] : { success: true }));
    });
    const vault = createOpenCodeVault(
      google,
      'https://configured.example/prefix/',
      'management-fixture',
      transport as typeof fetch,
    );
    const id = await vault.find();
    expect(await vault.save('replacement-fixture', id)).toBe('existing-key');
    expect(requests.map(([, request]) => request.method)).toEqual(['GET', 'GET', 'PATCH']);
    expect(requests.at(-1)).toEqual([
      'https://configured.example/prefix/v1/secrets/existing-key',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer management-fixture',
          'X-Project-Id': 'project-fixture',
        }),
        redirect: 'error',
        body: JSON.stringify({ value: 'replacement-fixture', injectionConfig: google.injectionConfig }),
      }),
    ]);
    expect(JSON.stringify(requests)).not.toContain('wrong-cli-vault');
  });

  it('creates a correctly mapped Google key and returns no response preview', async () => {
    const requests: RequestInit[] = [];
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      requests.push(init);
      return new Response(JSON.stringify(init.method === 'GET' ? [] : { id: 'new-id', preview: 'must-not-leak' }));
    });
    const vault = createOpenCodeVault(google, 'http://vault.example', '', transport as typeof fetch);
    expect(await vault.save('google-fixture', null)).toBe('new-id');
    expect(JSON.parse(requests[1].body as string)).toEqual({
      name: google.name,
      type: 'generic',
      valueSource: 'inline',
      hostPattern: google.hostPattern,
      value: 'google-fixture',
      injectionConfig: { headerName: 'x-goog-api-key', valueFormat: '{value}' },
    });
  });

  it('repairs the recognized old Google bearer mapping without replacing the granted ID', async () => {
    const old = { ...metadata(), injectionConfig: apiKeyInjection('openai') };
    const transport = vi.fn(
      async (_url: string, init: RequestInit) =>
        new Response(JSON.stringify(init.method === 'GET' ? [old] : { success: true })),
    );
    const vault = createOpenCodeVault(google, 'http://vault.example', '', transport as typeof fetch);
    await vault.save('replacement-fixture', await vault.find());
    const write = transport.mock.calls.find(([, init]) => init.method === 'PATCH')!;
    expect(write[0]).toMatch(/\/existing-key$/);
    expect(JSON.parse(write[1].body as string).injectionConfig).toEqual(google.injectionConfig);
    expect(transport.mock.calls.some(([, init]) => init.method === 'POST')).toBe(false);
  });

  it.each([
    { scope: 'organization' },
    { valueSource: 'onepassword' },
    { type: 'openai' },
    { hostPattern: '*.googleapis.com' },
    { pathPattern: '/restricted' },
    { injectionConfig: { headerName: 'X-Unrelated', valueFormat: '{value}' } },
  ])('rejects incompatible metadata before writing: %j', async (change) => {
    const transport = vi.fn(async () => new Response(JSON.stringify([{ ...metadata(), ...change }])));
    const vault = createOpenCodeVault(google, 'http://vault.example', '', transport);
    await expect(vault.save('replacement-fixture', 'existing-key')).rejects.toThrow('unexpected metadata');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('refuses duplicates and a changed identity instead of creating another secret', async () => {
    expect(() => findOpenCodeSecret([metadata(), metadata()], google)).toThrow('Multiple');
    const transport = vi.fn(async () => new Response(JSON.stringify([{ ...metadata(), id: 'changed' }])));
    await expect(
      createOpenCodeVault(google, 'http://vault.example', '', transport).save('key-fixture', 'existing-key'),
    ).rejects.toThrow('changed during setup');
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('does not recreate an entry after a failed update or reveal upstream error contents', async () => {
    const transport = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'GET'
        ? new Response(JSON.stringify([metadata()]))
        : new Response('private-key-preview', { status: 403 }),
    );
    const vault = createOpenCodeVault(google, 'http://vault.example', '', transport as typeof fetch);
    await expect(vault.save('replacement-fixture', 'existing-key')).rejects.toThrow('Check gateway connectivity');
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(['GET', 'PATCH']);
  });

  it('preserves ChatGPT OAuth metadata and rejects inherited names', () => {
    expect(findOpenCodeSecret([metadata(CHATGPT_SECRET)], CHATGPT_SECRET)).toBe('existing-key');
    expect(() =>
      findOpenCodeSecret([{ ...metadata(CHATGPT_SECRET), scope: 'organization' }], CHATGPT_SECRET),
    ).toThrow();
  });

  it('maps supported API-key backends and refuses to guess an unknown native scheme', () => {
    expect(apiKeyInjection('anthropic')).toEqual({ headerName: 'x-api-key', valueFormat: '{value}' });
    for (const provider of ['openai', 'openrouter', 'deepseek']) {
      expect(apiKeyInjection(provider)).toEqual({ headerName: 'Authorization', valueFormat: 'Bearer {value}' });
    }
    expect(() => apiKeyInjection('amazon-bedrock')).toThrow('does not yet support');
  });
});

describe('OpenCode credential host migration', () => {
  const target: OpenCodeSecret = {
    name: 'OpenCode openai',
    type: 'generic',
    hostPattern: 'new.example',
    injectionConfig: apiKeyInjection('openai'),
  };

  it.each(['keep', 'replace'])('requires confirmation and updates the same granted ID on %s', async (mode) => {
    let current = { ...metadata(target), hostPattern: 'old.example' };
    const transport = vi.fn(async (_url: string, init: RequestInit) => {
      if (init.method === 'PATCH') current = { ...current, ...JSON.parse(init.body as string) };
      return new Response(JSON.stringify(init.method === 'GET' ? [current] : { success: true }));
    });
    const confirmHostChange = vi.fn(async () => true);
    const vault = createOpenCodeVault(target, 'https://vault.example', '', transport as typeof fetch);
    const id = await vault.find({ confirmHostChange });
    expect(confirmHostChange).toHaveBeenCalledWith('old.example', 'new.example');
    expect(transport.mock.calls.map(([, init]) => init.method)).toEqual(['GET']);
    if (mode === 'keep') await vault.keep(id!);
    else expect(await vault.save('replacement-fixture', id)).toBe('existing-key');
    const write = transport.mock.calls.at(-1)!;
    expect(write[0]).toBe('https://vault.example/v1/secrets/existing-key');
    expect(JSON.parse(write[1].body as string)).toEqual(
      mode === 'keep'
        ? { hostPattern: 'new.example' }
        : { value: 'replacement-fixture', hostPattern: 'new.example', injectionConfig: target.injectionConfig },
    );
    expect(await vault.find()).toBe(id);
  });

  it.each([
    { scope: 'organization' },
    { valueSource: 'onepassword' },
    { type: 'openai' },
    { pathPattern: '/restricted' },
    { injectionConfig: { headerName: 'X-Unrelated', valueFormat: '{value}' } },
    { hostPattern: '*.example' },
    { hostPattern: 'old.example/path' },
    { hostPattern: 'old.example:8443' },
  ])('rejects unsafe source metadata before offering a move: %j', async (change) => {
    const transport = vi.fn(
      async () => new Response(JSON.stringify([{ ...metadata(target), hostPattern: 'old.example', ...change }])),
    );
    const confirmHostChange = vi.fn(async () => true);
    await expect(
      createOpenCodeVault(target, 'https://vault.example', '', transport).find({ confirmHostChange }),
    ).rejects.toThrow('unexpected metadata');
    expect(confirmHostChange).not.toHaveBeenCalled();
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it.each(['identity', 'host', 'scope'])('refuses a concurrent %s change after confirmation', async (change) => {
    const current: Record<string, unknown> = { ...metadata(target), hostPattern: 'old.example' };
    const transport = vi.fn(async () => new Response(JSON.stringify([current])));
    const vault = createOpenCodeVault(target, 'https://vault.example', '', transport);
    const id = await vault.find({ confirmHostChange: async () => true });
    if (change === 'identity') current.id = 'another-id';
    else if (change === 'host') current.hostPattern = 'another.example';
    else current.scope = 'organization';
    await expect(vault.save('replacement-fixture', id)).rejects.toThrow(
      change === 'identity' ? 'changed during setup' : 'unexpected metadata',
    );
    expect(transport).toHaveBeenCalledTimes(2);
  });

  it('keeps ChatGPT host validation strict even when confirmation is supplied', async () => {
    const transport = vi.fn(
      async () => new Response(JSON.stringify([{ ...metadata(CHATGPT_SECRET), hostPattern: 'other.example' }])),
    );
    const confirmHostChange = vi.fn(async () => true);
    await expect(
      createOpenCodeVault(CHATGPT_SECRET, 'https://vault.example', '', transport).find({ confirmHostChange }),
    ).rejects.toThrow('unexpected metadata');
    expect(confirmHostChange).not.toHaveBeenCalled();
  });
});
