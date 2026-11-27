import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  PI_CHATGPT_PROVIDER_ID,
  PI_CREDENTIAL_PLACEHOLDER,
  type GatewayModelCatalog,
  buildPlaceholderAccessToken,
  ensurePiSettings,
  initializePiGatewayAuth,
  operatorAuthoredSettings,
  parseGatewayProviders,
  readManagedDefaults,
  readPiSettings,
  resolveDefaultProvider,
  selectGatewayModel,
  usesSubscription,
} from './pi-auth.js';

const roots: string[] = [];
function root(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-auth-'));
  roots.push(directory);
  return directory;
}
afterEach(() => {
  for (const directory of roots.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

/** Mirror pi's own decode: split the JWT and read the ChatGPT account id claim. */
function accountIdFromToken(token: string): string | undefined {
  const payload = JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64').toString('utf-8')) as {
    'https://api.openai.com/auth'?: { chatgpt_account_id?: string };
  };
  return payload['https://api.openai.com/auth']?.chatgpt_account_id;
}

describe('container-owned pi gateway auth', () => {
  it('writes a ChatGPT placeholder the pi transport can decode', () => {
    const agentDir = path.join(root(), 'agent');
    initializePiGatewayAuth(agentDir, { providers: [PI_CHATGPT_PROVIDER_ID] });

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8')) as Record<
      string,
      Record<string, unknown>
    >;
    const credential = auth[PI_CHATGPT_PROVIDER_ID];
    expect(credential).toMatchObject({
      type: 'oauth',
      refresh: PI_CREDENTIAL_PLACEHOLDER,
      accountId: PI_CREDENTIAL_PLACEHOLDER,
    });
    // pi derives the account id from the access token; a bare string would fail.
    expect(accountIdFromToken(credential.access as string)).toBe(PI_CREDENTIAL_PLACEHOLDER);
    expect((credential.expires as number) > Date.now()).toBe(true);
  });

  it('writes api-key placeholders for declared providers and nothing else', () => {
    const agentDir = path.join(root(), 'agent');
    initializePiGatewayAuth(agentDir, { providers: ['anthropic', 'openai'] });

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8')) as Record<string, unknown>;
    expect(auth.anthropic).toEqual({ type: 'api_key', key: PI_CREDENTIAL_PLACEHOLDER });
    expect(auth.openai).toEqual({ type: 'api_key', key: PI_CREDENTIAL_PLACEHOLDER });
    expect(auth.google).toBeUndefined();
    expect(auth[PI_CHATGPT_PROVIDER_ID]).toBeUndefined();
  });

  it('writes no auth file when the gateway holds nothing', () => {
    const agentDir = path.join(root(), 'agent');
    initializePiGatewayAuth(agentDir, { providers: [] });
    expect(fs.existsSync(path.join(agentDir, 'auth.json'))).toBe(false);
  });

  it('never overwrites a real login someone put there', () => {
    const agentDir = path.join(root(), 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const real = { type: 'oauth', access: 'real-access', refresh: 'real-refresh', expires: 1, accountId: 'acct' };
    fs.writeFileSync(path.join(agentDir, 'auth.json'), JSON.stringify({ [PI_CHATGPT_PROVIDER_ID]: real }));

    initializePiGatewayAuth(agentDir, { providers: [PI_CHATGPT_PROVIDER_ID, 'anthropic'] });

    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8')) as Record<string, unknown>;
    expect(auth[PI_CHATGPT_PROVIDER_ID]).toEqual(real);
    expect(auth.anthropic).toEqual({ type: 'api_key', key: PI_CREDENTIAL_PLACEHOLDER });
  });

  it('is idempotent and writes a private file without leaving a temp file behind', () => {
    const agentDir = path.join(root(), 'agent');
    initializePiGatewayAuth(agentDir, { providers: ['openai'] });
    const first = fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8');
    initializePiGatewayAuth(agentDir, { providers: ['openai'] });

    expect(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8')).toBe(first);
    expect(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(agentDir)).toEqual(['auth.json']);
  });

  it('replaces a planted file link without touching its target', () => {
    const directory = root();
    const unrelated = path.join(directory, 'unrelated');
    fs.writeFileSync(unrelated, 'preserve');
    const agentDir = path.join(directory, 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.symlinkSync(unrelated, path.join(agentDir, 'auth.json'));

    initializePiGatewayAuth(agentDir, { providers: [PI_CHATGPT_PROVIDER_ID] });

    expect(fs.lstatSync(path.join(agentDir, 'auth.json')).isFile()).toBe(true);
    expect(fs.readFileSync(unrelated, 'utf-8')).toBe('preserve');
  });
});

describe('selectGatewayModel', () => {
  const catalog: GatewayModelCatalog = {
    getModel: (provider, id) => (provider === 'deepseek' && id === 'deepseek-v4-pro' ? { provider, id } : undefined),
    getModels: (provider) => (provider === 'deepseek' ? [{ provider: 'deepseek', id: 'catalog-first' }] : []),
    getAvailableSnapshot: () => [
      { provider: 'anthropic', id: 'a-model' },
      { provider: 'deepseek', id: 'available-first' },
    ],
  };

  it('takes the first available model of the resolved provider and ignores others', () => {
    expect(selectGatewayModel(catalog, ['deepseek'])).toEqual({ provider: 'deepseek', id: 'available-first' });
  });

  it('honours an explicit model id, falling back to the provider catalog when unknown', () => {
    expect(selectGatewayModel(catalog, ['deepseek'], 'deepseek', 'deepseek-v4-pro')).toEqual({
      provider: 'deepseek',
      id: 'deepseek-v4-pro',
    });
    expect(selectGatewayModel(catalog, ['deepseek'], 'deepseek', 'renamed-in-a-newer-pi')).toEqual({
      provider: 'deepseek',
      id: 'catalog-first',
    });
  });

  it('resolves nothing for an ambiguous provider set or a provider with no models', () => {
    expect(selectGatewayModel(catalog, ['deepseek', 'openrouter'])).toBeUndefined();
    expect(selectGatewayModel(catalog, ['openrouter'])).toBeUndefined();
  });
});

describe('ensurePiSettings / readPiSettings', () => {
  it('fills a missing default provider and model', () => {
    const agentDir = path.join(root(), 'agent');
    ensurePiSettings(agentDir, { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash' });
    expect(readPiSettings(agentDir)).toEqual({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash' });
  });

  it('never overwrites operator-authored values and preserves other keys', () => {
    const agentDir = path.join(root(), 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openrouter', defaultModel: 'x', theme: 'dark' }),
    );
    ensurePiSettings(agentDir, { defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-flash' });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8'))).toEqual({
      defaultProvider: 'openrouter',
      defaultModel: 'x',
      theme: 'dark',
    });
  });

  // Without this, the first spawn's guess shadows PI_DEFAULT_MODEL forever:
  // the value it wrote looks exactly like one the operator chose.
  it('replaces the default it wrote itself when a later spawn resolves a different one', () => {
    const agentDir = path.join(root(), 'agent');
    ensurePiSettings(agentDir, { defaultProvider: 'openai-codex', defaultModel: 'gpt-5.3-codex-spark' });
    ensurePiSettings(agentDir, { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' });
    expect(readPiSettings(agentDir)).toEqual({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' });
    expect(readManagedDefaults(agentDir)).toEqual({ defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' });
  });

  it('stops claiming a key once an operator edits it', () => {
    const agentDir = path.join(root(), 'agent');
    ensurePiSettings(agentDir, { defaultProvider: 'openai-codex', defaultModel: 'gpt-5.3-codex-spark' });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'operator-choice' }),
    );
    ensurePiSettings(agentDir, { defaultProvider: 'openai-codex', defaultModel: 'gpt-6.1-sol' });
    expect(readPiSettings(agentDir)).toEqual({ defaultProvider: 'openai-codex', defaultModel: 'operator-choice' });
    // The model is theirs now; the provider it agrees with is still ours.
    expect(readManagedDefaults(agentDir)).toEqual({ defaultProvider: 'openai-codex' });
  });

  it('pins only the provider when a spawn has no model to assert', () => {
    const agentDir = path.join(root(), 'agent');
    ensurePiSettings(agentDir, { defaultProvider: 'openai-codex' });
    expect(readPiSettings(agentDir)).toEqual({ defaultProvider: 'openai-codex' });
    expect(readManagedDefaults(agentDir)).toEqual({ defaultProvider: 'openai-codex' });
  });
});

describe('operatorAuthoredSettings', () => {
  it('hides what this module wrote and surfaces what it did not', () => {
    const agentDir = path.join(root(), 'agent');
    ensurePiSettings(agentDir, { defaultProvider: 'openai-codex', defaultModel: 'gpt-5.3-codex-spark' });
    expect(operatorAuthoredSettings(agentDir)).toEqual({});

    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openai-codex', defaultModel: 'operator-choice' }),
    );
    expect(operatorAuthoredSettings(agentDir)).toEqual({ defaultModel: 'operator-choice' });
  });

  it('treats a settings file with no record of its own as entirely operator-authored', () => {
    const agentDir = path.join(root(), 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'deepseek', defaultModel: 'deepseek-v4-pro' }),
    );
    expect(operatorAuthoredSettings(agentDir)).toEqual({
      defaultProvider: 'deepseek',
      defaultModel: 'deepseek-v4-pro',
    });
  });
});

describe('usesSubscription', () => {
  const catalog = (isUsingSubscription?: (provider: string) => boolean): GatewayModelCatalog => ({
    getModel: () => undefined,
    getModels: () => [],
    getAvailableSnapshot: () => [],
    ...(isUsingSubscription ? { isUsingSubscription } : {}),
  });

  it('reports what the runtime says about the provider', () => {
    expect(usesSubscription(catalog((provider) => provider === 'openai-codex'), 'openai-codex')).toBe(true);
    expect(usesSubscription(catalog(() => false), 'openai-codex')).toBe(false);
  });

  it('treats a runtime that cannot answer as an ordinary key', () => {
    expect(usesSubscription(catalog(), 'openai-codex')).toBe(false);
    expect(
      usesSubscription(
        catalog(() => {
          throw new Error('auth unreadable');
        }),
        'openai-codex',
      ),
    ).toBe(false);
  });
});

describe('resolveDefaultProvider', () => {
  it('prefers an explicit choice, falls back to a lone provider', () => {
    expect(resolveDefaultProvider(['deepseek'], undefined)).toBe('deepseek');
    expect(resolveDefaultProvider(['deepseek'], 'openrouter')).toBe('openrouter');
    expect(resolveDefaultProvider(['deepseek', 'openrouter'], undefined)).toBeUndefined();
    expect(resolveDefaultProvider([], undefined)).toBeUndefined();
  });
});

describe('parseGatewayProviders', () => {
  it('trims, drops empties, and de-duplicates', () => {
    expect(parseGatewayProviders(' openai, anthropic ,,openai ')).toEqual(['openai', 'anthropic']);
    expect(parseGatewayProviders(undefined)).toEqual([]);
    expect(parseGatewayProviders('   ')).toEqual([]);
  });

  it('builds a decodable placeholder token', () => {
    expect(accountIdFromToken(buildPlaceholderAccessToken('edge-account'))).toBe('edge-account');
  });
});
