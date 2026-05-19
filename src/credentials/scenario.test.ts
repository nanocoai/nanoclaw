import { afterEach, describe, expect, it } from 'vitest';
import { setCredentialResolverHook, resetCredentialResolverHook } from './index.js';
import { buildContributionForSpawn } from '../container-runner.js';

describe('end-to-end: Codex API-key mode via gateway resolver', () => {
  afterEach(() => resetCredentialResolverHook());

  it('returns a gateway credential decision and does not expose the real key', async () => {
    setCredentialResolverHook(async (input) => {
      if (
        input.agentGroupId === 'student-a' &&
        input.runtimeProvider === 'codex' &&
        input.modelProvider === 'openai' &&
        input.authMode === 'api_key'
      ) {
        return {
          kind: 'gateway_secret',
          providerId: 'openai',
          baseUrl: 'https://gateway.example/openai/v1',
          placeholderToken: 'placeholder',
          injection: { header: 'authorization', scheme: 'Bearer' },
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
      agentGroupId: 'student-a',
      hostEnv: { OPENAI_API_KEY: 'sk-real-secret-do-not-leak' } as NodeJS.ProcessEnv,
    });

    expect(result.refusal).toBeNull();
    expect(result.contribution.env.OPENAI_BASE_URL).toBe('https://gateway.example/openai/v1');
    expect(result.contribution.env.OPENAI_API_KEY).toBe('placeholder');

    // The real key must never reach the container env.
    const allEnvValues = Object.values(result.contribution.env ?? {});
    expect(allEnvValues).not.toContain('sk-real-secret-do-not-leak');
  });
});
