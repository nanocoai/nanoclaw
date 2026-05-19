import { afterEach, describe, expect, it } from 'vitest';
import { resolveCredential, setCredentialResolverHook, resetCredentialResolverHook } from './resolver.js';

describe('credential resolver', () => {
  afterEach(() => resetCredentialResolverHook());

  it('default hook returns fallback', async () => {
    const decision = await resolveCredential({
      agentGroupId: 'g1',
      runtimeProvider: 'claude',
    });
    expect(decision).toEqual({ kind: 'fallback' });
  });

  it('default hook maps Codex OpenAI API-key mode to OneCLI gateway placeholder auth', async () => {
    const decision = await resolveCredential({
      agentGroupId: 'g1',
      runtimeProvider: 'codex',
      modelProvider: 'openai',
      authMode: 'api_key',
    });

    expect(decision).toEqual({
      kind: 'gateway_secret',
      providerId: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      placeholderToken: 'placeholder',
      injection: { header: 'authorization', scheme: 'Bearer' },
      refreshPolicy: 'gateway',
    });
  });

  it('custom hook can return gateway_secret', async () => {
    setCredentialResolverHook(async (input) => ({
      kind: 'gateway_secret',
      providerId: input.modelProvider ?? 'unknown',
      baseUrl: 'https://example.test',
      placeholderToken: 'placeholder',
      refreshPolicy: 'gateway',
    }));

    const decision = await resolveCredential({
      agentGroupId: 'g1',
      runtimeProvider: 'codex',
      modelProvider: 'openai',
      authMode: 'api_key',
    });

    expect(decision).toEqual({
      kind: 'gateway_secret',
      providerId: 'openai',
      baseUrl: 'https://example.test',
      placeholderToken: 'placeholder',
      refreshPolicy: 'gateway',
    });
  });

  it('custom hook can return native_auth_bundle', async () => {
    setCredentialResolverHook(async () => ({
      kind: 'native_auth_bundle',
      providerId: 'codex',
      bundleRef: 'host:~/.codex/auth.json',
      mountPath: '/home/node/.codex/auth.json',
      refreshPolicy: 'runtime',
    }));

    const decision = await resolveCredential({
      agentGroupId: 'g1',
      runtimeProvider: 'codex',
      authMode: 'subscription',
    });
    expect(decision).toEqual({
      kind: 'native_auth_bundle',
      providerId: 'codex',
      bundleRef: 'host:~/.codex/auth.json',
      mountPath: '/home/node/.codex/auth.json',
      refreshPolicy: 'runtime',
    });
  });

  it('resetCredentialResolverHook restores fallback', async () => {
    setCredentialResolverHook(async () => ({
      kind: 'forbidden',
      provider: 'codex',
    }));
    resetCredentialResolverHook();
    const decision = await resolveCredential({
      agentGroupId: 'g1',
      runtimeProvider: 'codex',
    });
    expect(decision).toEqual({ kind: 'fallback' });
  });
});
