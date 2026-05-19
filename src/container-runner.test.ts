import { afterEach, describe, expect, it } from 'vitest';

import { setCredentialResolverHook, resetCredentialResolverHook } from './credentials/index.js';
import { buildContributionForSpawn, resolveProviderName } from './container-runner.js';

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('container-runner credential integration', () => {
  afterEach(() => resetCredentialResolverHook());

  it('resolveProviderName precedence is preserved', () => {
    expect(resolveProviderName(undefined, undefined)).toBe('claude');
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
    expect(resolveProviderName(undefined, 'opencode')).toBe('opencode');
  });

  it('with no hook and claude provider, contribution comes from claude.ts default', async () => {
    const result = await buildContributionForSpawn({
      provider: 'claude',
      sessionDir: '/tmp/sess',
      agentGroupId: 'g1',
      hostEnv: {} as NodeJS.ProcessEnv,
    });
    expect(result.refusal).toBeNull();
    expect(result.contribution.env).toEqual({});
  });

  it('with hook returning forbidden, refusal is surfaced', async () => {
    setCredentialResolverHook(async () => ({
      kind: 'forbidden',
      provider: 'claude',
      reason: 'classroom policy',
    }));
    const result = await buildContributionForSpawn({
      provider: 'claude',
      sessionDir: '/tmp/sess',
      agentGroupId: 'g1',
      hostEnv: {} as NodeJS.ProcessEnv,
    });
    expect(result.refusal?.kind).toBe('forbidden');
  });

  it('with hook returning gateway_secret for codex+openai, env carries placeholder + gateway URL', async () => {
    setCredentialResolverHook(async (input) => {
      if (input.runtimeProvider === 'codex' && input.modelProvider === 'openai') {
        return {
          kind: 'gateway_secret',
          providerId: 'openai',
          baseUrl: 'https://gw.example/openai/v1',
          placeholderToken: 'placeholder',
          refreshPolicy: 'gateway',
        };
      }
      return { kind: 'fallback' };
    });
    const result = await buildContributionForSpawn({
      provider: 'codex',
      modelProvider: 'openai',
      authMode: 'api_key',
      sessionDir: '/tmp/sess',
      agentGroupId: 'g1',
      hostEnv: {} as NodeJS.ProcessEnv,
    });
    expect(result.refusal).toBeNull();
    expect(result.contribution.env).toEqual({
      OPENAI_BASE_URL: 'https://gw.example/openai/v1',
      OPENAI_API_KEY: 'placeholder',
    });
  });
});
