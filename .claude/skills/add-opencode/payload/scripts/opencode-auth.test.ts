import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  checkOpenCodeInstall,
  buildOneCliManagedStub,
  buildOneCliOAuthSecret,
  buildOpenCodeLoginArgs,
  discoverLocalModelIds,
  normalizeOptionalInput,
  findChatGptSecret,
  createChatGptVault,
  runOpenCodeAuthCli,
  runOpenCodeChatGptAuth,
} from './opencode-auth.js';

const proc = vi.hoisted(() => ({ execFileSync: vi.fn(), spawn: vi.fn() }));
vi.mock('child_process', async (importActual) => {
  const actual = await importActual<typeof import('child_process')>();
  return {
    ...actual,
    execFileSync: (...args: unknown[]) => proc.execFileSync(...args),
    spawn: (...args: unknown[]) => proc.spawn(...args),
  };
});

describe('OpenCode setup payload', () => {
  it('accepts a blank optional API key for a keyless local endpoint', () => {
    expect(normalizeOptionalInput(undefined)).toBe('');
    expect(normalizeOptionalInput('  local-key  ')).toBe('local-key');
  });

  it('discovers, trims, sorts, and deduplicates OpenAI-compatible model ids', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'qwen-b' }, { id: ' qwen-a ' }, { id: 'qwen-b' }, {}] })),
    );

    await expect(discoverLocalModelIds('http://host.docker.internal:8891/v1/', fetchImpl)).resolves.toEqual([
      'qwen-a',
      'qwen-b',
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      new URL('http://127.0.0.1:8891/v1/models'),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('rejects malformed model discovery responses so the wizard can fall back to manual input', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ models: [] })));
    await expect(discoverLocalModelIds('http://127.0.0.1:8891/v1', fetchImpl)).rejects.toThrow('no data array');
  });

  it('vaults ChatGPT tokens in the Codex shape OneCLI classifies as oauth', () => {
    expect(
      buildOneCliOAuthSecret(
        {
          openai: {
            type: 'oauth',
            access: 'live-access-token',
            refresh: 'live-refresh-token',
            expires: 1,
            accountId: 'account-123',
          },
        },
        new Date('2026-08-29T12:00:00.000Z'),
      ),
    ).toEqual({
      tokens: {
        access_token: 'live-access-token',
        refresh_token: 'live-refresh-token',
        account_id: 'account-123',
      },
      OPENAI_API_KEY: null,
      last_refresh: '2026-08-29T12:00:00.000Z',
    });
  });

  it('refuses to vault a credential with no account id, which the gateway cannot route', () => {
    const base = { type: 'oauth', access: 'a', refresh: 'r' };
    expect(() => buildOneCliOAuthSecret({ openai: base })).toThrow('no account id');
    expect(() => buildOneCliOAuthSecret({ openai: { ...base, accountId: '  ' } })).toThrow('no account id');
  });

  it('refuses to vault a credential with no refresh token, which the gateway cannot renew', () => {
    expect(() => buildOneCliOAuthSecret({ openai: { type: 'oauth', access: 'a', accountId: 'account-123' } })).toThrow(
      'did not create an OpenAI OAuth credential',
    );
  });

  it('rejects API-key auth records instead of misrepresenting them as subscription OAuth', () => {
    expect(() => buildOneCliOAuthSecret({ openai: { type: 'api', key: 'sk-live' } })).toThrow(
      'did not create an OpenAI OAuth credential',
    );
  });

  it('runs the pinned container CLI with isolated XDG state for device pairing', () => {
    const args = buildOpenCodeLoginArgs('/tmp/login', 'device', false);
    expect(args).toContain('/tmp/login:/opencode-login');
    expect(args).toContain('XDG_DATA_HOME=/opencode-login/data');
    expect(args.slice(-6)).toEqual([
      'auth',
      'login',
      '--provider',
      'openai',
      '--method',
      'ChatGPT Pro/Plus (headless)',
    ]);
    expect(args).not.toContain('-t');
    expect(args).not.toContain('127.0.0.1:1455:1455');
  });

  it('matches a root-owned private login directory without blocking root installations', () => {
    const args = buildOpenCodeLoginArgs('/tmp/root-login', 'device', false, { uid: 0, gid: 0 });
    expect(args.slice(args.indexOf('--user'), args.indexOf('--user') + 2)).toEqual(['--user', '0:0']);
  });

  it('publishes only the native callback port for browser sign-in', () => {
    const args = buildOpenCodeLoginArgs('/tmp/login', 'browser', true);
    expect(args).toContain('127.0.0.1:1455:1455');
    expect(args).toContain('-t');
    expect(args.at(-1)).toBe('ChatGPT Pro/Plus (browser)');
  });

  it('keeps the verified runtime pin and trusted postinstall together', () => {
    const root = process.cwd();
    const tools = JSON.parse(fs.readFileSync(path.join(root, 'container/cli-tools.json'), 'utf8')) as Array<{
      name: string;
      version: string;
      onlyBuilt?: boolean;
    }>;
    const runner = JSON.parse(fs.readFileSync(path.join(root, 'container/agent-runner/package.json'), 'utf8')) as {
      dependencies?: Record<string, string>;
    };
    const cli = tools.find((entry) => entry.name === 'opencode-ai');
    expect(cli).toEqual({ name: 'opencode-ai', version: '1.18.25', onlyBuilt: true });
    expect(runner.dependencies?.['@opencode-ai/sdk']).toBe('1.18.25');
  });
});

const secretMetadata = {
  id: 'secret-existing',
  name: 'OpenCode ChatGPT',
  type: 'openai',
  hostPattern: 'chatgpt.com',
  valueSource: 'inline',
  scope: 'project',
  metadata: { authMode: 'oauth' },
  pathPattern: null,
};
const fakeVault = (id: string | null = 'secret-existing') => ({
  find: vi.fn(async () => id),
  save: vi.fn(async () => {}),
});

describe('ChatGPT vault recovery', () => {
  it('finds a unique credential and rejects ambiguous or malformed metadata', () => {
    expect(findChatGptSecret([secretMetadata])).toBe('secret-existing');
    expect(findChatGptSecret([{ name: 'Anthropic' }])).toBeNull();
    for (const value of [
      null,
      {},
      [null],
      [secretMetadata, secretMetadata],
      [{ ...secretMetadata, id: '' }],
      [{ ...secretMetadata, type: 'generic' }],
      [{ ...secretMetadata, valueSource: 'onepassword' }],
      [{ ...secretMetadata, metadata: { authMode: 'api-key' } }],
      [{ ...secretMetadata, pathPattern: '/restricted' }],
    ]) {
      expect(() => findChatGptSecret(value)).toThrow();
    }
  });

  it('updates only the existing secret value through the configured gateway', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === 'GET' ? [secretMetadata] : { success: true })),
    );
    const vault = createChatGptVault('https://gateway.example', 'management-fixture', fetchImpl as typeof fetch);
    expect(await vault.find()).toBe('secret-existing');
    await vault.save({ tokens: { refresh_token: 'refresh-fixture' } }, 'secret-existing');
    const [url, options] = fetchImpl.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(url).toBe('https://gateway.example/v1/secrets/secret-existing');
    expect(options).toMatchObject({
      method: 'PATCH',
      redirect: 'error',
      headers: { Authorization: 'Bearer management-fixture' },
    });
    expect(JSON.parse(options?.body as string)).toEqual({
      value: JSON.stringify({ tokens: { refresh_token: 'refresh-fixture' } }),
    });
    expect(proc.execFileSync).not.toHaveBeenCalled();
  });

  it('creates a credential only when no existing ID was found', async () => {
    const fetchImpl = vi.fn(
      async (_url: string, init?: RequestInit) =>
        new Response(JSON.stringify(init?.method === 'GET' ? [] : { id: 'created-fixture' })),
    );
    await createChatGptVault('http://localhost:10255', '', fetchImpl as typeof fetch).save({ tokens: {} }, null);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://localhost:10255/v1/secrets',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          name: 'OpenCode ChatGPT',
          type: 'openai',
          valueSource: 'inline',
          hostPattern: 'chatgpt.com',
          value: '{"tokens":{}}',
        }),
      }),
    );
  });

  it('sanitizes response, transport, and JSON errors', async () => {
    for (const fetchImpl of [
      vi.fn(async () => new Response('sensitive-response', { status: 403 })),
      vi.fn(async () => {
        throw new Error('sensitive-transport');
      }),
      vi.fn(async () => new Response('sensitive-json')),
    ]) {
      await expect(createChatGptVault('https://gateway.example', '', fetchImpl).find()).rejects.toThrow(
        'Check gateway connectivity',
      );
      await expect(createChatGptVault('https://gateway.example', '', fetchImpl).find()).rejects.not.toThrow(
        'sensitive',
      );
    }
  });

  it('rejects unknown command options before changing state', async () => {
    await expect(runOpenCodeAuthCli(['--reauth', '--method', 'invalid'])).rejects.toThrow('Usage:');
  });
});

describe('ChatGPT credential lifecycle', () => {
  const roots: string[] = [];
  const makeRoot = (): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-stub-test-'));
    roots.push(root);
    return root;
  };
  const stubIn = (root: string): string => path.join(root, 'data', 'opencode', 'openai-auth-stub.json');

  afterEach(() => {
    while (roots.length) fs.rmSync(roots.pop() as string, { recursive: true, force: true });
    proc.execFileSync.mockReset();
    proc.spawn.mockReset();
  });

  it('keeps a vaulted login through the real entry point without starting sign-in or changing state', async () => {
    const root = makeRoot();
    const env = 'OPENCODE_MODEL=openai/existing\n';
    fs.writeFileSync(path.join(root, '.env'), env);
    const vault = fakeVault();
    await runOpenCodeChatGptAuth('device', { root, vault });
    expect(proc.spawn).not.toHaveBeenCalled();
    expect(vault.find).toHaveBeenCalledTimes(1);
    expect(vault.save).not.toHaveBeenCalled();
    expect(fs.readdirSync(root)).toEqual(['.env']);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(env);
  });

  it('reauthenticates into the existing ID and does not rewrite defaults', async () => {
    const root = makeRoot();
    const env = 'OPENCODE_MODEL=openai/example\nOPENCODE_SMALL_MODEL=openai/small\n';
    fs.writeFileSync(path.join(root, '.env'), env);
    const vault = fakeVault();
    const signIn = vi.fn(async () => {});
    await runOpenCodeChatGptAuth('device', { root, vault, signIn, reauth: true });
    expect(signIn).toHaveBeenCalledWith('device', root, 'secret-existing', vault);
    expect(fs.readFileSync(path.join(root, '.env'), 'utf8')).toBe(env);
  });

  it('does not sign in or overwrite the stub when the vault lookup fails', async () => {
    const root = makeRoot();
    fs.mkdirSync(path.dirname(stubIn(root)), { recursive: true });
    fs.writeFileSync(stubIn(root), 'legacy-file-untouched');
    const before = fs.readFileSync(stubIn(root), 'utf8');
    const vault = fakeVault();
    vault.find.mockRejectedValue(new Error('vault unavailable'));
    const signIn = vi.fn(async () => {});
    await expect(runOpenCodeChatGptAuth('device', { root, vault, signIn, reauth: true })).rejects.toThrow(
      'vault unavailable',
    );
    expect(signIn).not.toHaveBeenCalled();
    expect(fs.readFileSync(stubIn(root), 'utf8')).toBe(before);
  });

  it.each(['success', 'save-failure', 'changed-id', 'empty-access', 'blank-refresh', 'pending-save'])(
    'removes temporary native credentials and preserves state (%s)',
    async (outcome) => {
      const root = makeRoot();
      let loginDir = '';
      const vault = fakeVault();
      let finishSave: (() => void) | undefined;
      let observeSave: (() => void) | undefined;
      const saving = new Promise<void>((resolve) => {
        observeSave = resolve;
      });
      if (outcome === 'pending-save') {
        vault.save.mockImplementation(
          () =>
            new Promise<void>((resolve) => {
              finishSave = resolve;
              observeSave!();
            }),
        );
      }
      if (outcome === 'save-failure') vault.save.mockRejectedValue(new Error('save failed'));
      if (outcome === 'changed-id')
        vault.find.mockResolvedValueOnce('secret-existing').mockResolvedValue('secret-other');
      proc.spawn.mockImplementation((_command: string, args: string[]) => {
        loginDir = args[args.indexOf('-v') + 1].split(':')[0];
        const authDir = path.join(loginDir, 'data', 'opencode');
        fs.mkdirSync(authDir, { recursive: true });
        fs.writeFileSync(
          path.join(authDir, 'auth.json'),
          JSON.stringify({
            openai: {
              type: 'oauth',
              access: outcome === 'empty-access' ? '' : 'access-fixture',
              refresh: outcome === 'blank-refresh' ? '  ' : 'refresh-fixture',
              accountId: 'account-fixture',
            },
          }),
        );
        const child = {
          on: (event: string, handler: (code: number) => void) => {
            if (event === 'close') queueMicrotask(() => handler(0));
            return child;
          },
        };
        return child;
      });
      const result = runOpenCodeChatGptAuth('device', { root, vault, reauth: true });
      if (outcome === 'pending-save') {
        await saving;
        try {
          expect(fs.existsSync(loginDir)).toBe(false);
        } finally {
          finishSave!();
          await result;
        }
      } else if (outcome === 'save-failure') await expect(result).rejects.toThrow('save failed');
      else if (outcome === 'changed-id') await expect(result).rejects.toThrow('changed during sign-in');
      else if (outcome === 'empty-access' || outcome === 'blank-refresh')
        await expect(result).rejects.toThrow('did not create an OpenAI OAuth credential');
      else await result;
      expect(loginDir).not.toBe('');
      expect(fs.existsSync(loginDir)).toBe(false);
      if (['changed-id', 'empty-access', 'blank-refresh'].includes(outcome)) expect(vault.save).not.toHaveBeenCalled();
      else
        expect(vault.save).toHaveBeenCalledWith(
          expect.objectContaining({
            tokens: { access_token: 'access-fixture', refresh_token: 'refresh-fixture', account_id: 'account-fixture' },
          }),
          'secret-existing',
        );
      expect(proc.execFileSync).not.toHaveBeenCalled();
    },
  );

  it('still runs sign-in when no vault secret exists', async () => {
    const root = makeRoot();
    const signIn = vi.fn(async () => {});

    await runOpenCodeChatGptAuth('browser', { root, vault: fakeVault(null), signIn });

    expect(signIn).toHaveBeenCalledWith('browser', root, null, expect.any(Object));
  });

  it('omits accountId, leaving OneCLI the sole source of chatgpt-account-id', () => {
    // The pinned OpenCode CLI sets `ChatGPT-Account-Id` only when
    // `openai.accountId` is present; OneCLI injects it from the vaulted
    // `tokens.account_id`, so a sign-in-free stub needs no account id and
    // never has to read a secret value to invent one.
    expect(buildOneCliManagedStub().openai).not.toHaveProperty('accountId');
  });
});

describe('OpenCode installation preflight', () => {
  it('checks pinned dependencies, registration, and managed config files before authentication', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pin-check-'));
    const cwd = vi.spyOn(process, 'cwd').mockReturnValue(root);
    try {
      for (const file of [
        'src/providers/opencode.ts',
        'src/provider-contracts/opencode.ts',
        'container/agent-runner/src/provider-contracts/opencode.ts',
        'container/agent-runner/src/providers/opencode.ts',
        'container/agent-runner/src/providers/opencode-config.ts',
        'container/agent-runner/src/providers/opencode-managed-config/opencode/opencode.json',
        'container/agent-runner/src/providers/opencode-managed-config/opencode/.gitignore',
        'container/agent-runner/src/providers/opencode-auth.ts',
        'container/agent-runner/src/providers/opencode-turn.ts',
        'container/agent-runner/src/providers/opencode-memory.ts',
        'container/agent-runner/src/providers/opencode-memory-plugin.ts',
        'container/agent-runner/src/providers/mcp-to-opencode.ts',
        'scripts/opencode-vault.ts',
      ]) {
        fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
        fs.writeFileSync(path.join(root, file), '');
      }
      fs.writeFileSync(
        path.join(root, 'container/cli-tools.json'),
        JSON.stringify([{ name: 'opencode-ai', version: '1.18.25', onlyBuilt: true }]),
      );
      const manifest = path.join(root, 'container/agent-runner/package.json');
      fs.writeFileSync(manifest, JSON.stringify({ dependencies: { '@opencode-ai/sdk': '1.4.17' } }));
      await expect(checkOpenCodeInstall()).rejects.toThrow('SDK must be pinned');
      fs.writeFileSync(manifest, JSON.stringify({ dependencies: { '@opencode-ai/sdk': '1.18.25' } }));
      for (const barrel of [
        'src/providers/index.ts',
        'src/provider-contracts/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'container/agent-runner/src/provider-contracts/index.ts',
      ]) {
        fs.writeFileSync(path.join(root, barrel), "import './opencode.js';\n");
      }
      proc.execFileSync.mockReturnValue(JSON.stringify({ host: ['opencode'], hostProviders: ['opencode'] }));
      await expect(checkOpenCodeInstall()).resolves.toBeUndefined();
      for (const name of ['opencode.json', '.gitignore']) {
        const asset = `container/agent-runner/src/providers/opencode-managed-config/opencode/${name}`;
        fs.unlinkSync(path.join(root, asset));
        await expect(checkOpenCodeInstall()).rejects.toThrow(`OpenCode payload is missing ${asset}`);
        fs.writeFileSync(path.join(root, asset), '');
      }
      fs.writeFileSync(path.join(root, 'src/providers/index.ts'), '');
      await expect(checkOpenCodeInstall()).rejects.toThrow('registration is missing');
    } finally {
      cwd.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
