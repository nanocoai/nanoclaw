import { afterEach, describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  PI_CHATGPT_PROVIDER_ID,
  PI_CREDENTIAL_PLACEHOLDER,
  buildPlaceholderAccessToken,
  initializePiGatewayAuth,
  parseGatewayProviders,
  resolveDefaultProvider,
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
    const second = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8');
    initializePiGatewayAuth(agentDir, { providers: ['openai'] });

    expect(fs.readFileSync(path.join(agentDir, 'auth.json'), 'utf-8')).toBe(first);
    expect(fs.statSync(path.join(agentDir, 'auth.json')).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8')).toBe(second);
    expect(fs.readdirSync(agentDir).sort()).toEqual(['auth.json', 'settings.json']);
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

describe('default provider settings', () => {
  it('points pi at the single declared provider so it does not fall back to Anthropic', () => {
    const agentDir = path.join(root(), 'agent');
    initializePiGatewayAuth(agentDir, { providers: ['deepseek'] });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8'))).toEqual({
      defaultProvider: 'deepseek',
    });
  });

  it('honours an explicit provider/model override and never overwrites operator settings', () => {
    const agentDir = path.join(root(), 'agent');
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(
      path.join(agentDir, 'settings.json'),
      JSON.stringify({ defaultProvider: 'openrouter', theme: 'dark' }),
    );
    initializePiGatewayAuth(agentDir, { providers: ['deepseek'], defaultModel: 'deepseek-v4-pro' });
    expect(JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8'))).toEqual({
      defaultProvider: 'openrouter',
      theme: 'dark',
      defaultModel: 'deepseek-v4-pro',
    });
  });

  it('leaves the default provider unset when several providers are ambiguous', () => {
    const agentDir = path.join(root(), 'agent');
    initializePiGatewayAuth(agentDir, { providers: ['deepseek', 'openrouter'] });
    expect(fs.existsSync(path.join(agentDir, 'settings.json'))).toBe(false);
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
