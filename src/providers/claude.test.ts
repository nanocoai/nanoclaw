import { afterEach, describe, expect, it, vi } from 'vitest';
import * as envModule from '../env.js';
import { setCredentialResolverHook, resetCredentialResolverHook } from '../credentials/index.js';

describe('claude provider container config', () => {
  afterEach(() => {
    resetCredentialResolverHook();
    vi.restoreAllMocks();
  });

  it('with no hook and no ANTHROPIC_BASE_URL in .env, contribution is empty', async () => {
    vi.spyOn(envModule, 'readEnvFile').mockReturnValue({});
    const { getClaudeContribution } = await import('../providers/claude.js');
    const contribution = await getClaudeContribution({
      sessionDir: '/tmp/session',
      agentGroupId: 'g1',
      hostEnv: {} as NodeJS.ProcessEnv,
    });
    expect(contribution.env).toEqual({});
    expect(contribution.mounts).toEqual([]);
  });

  it('with no hook and ANTHROPIC_BASE_URL set, env carries baseUrl + placeholder token', async () => {
    vi.spyOn(envModule, 'readEnvFile').mockReturnValue({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    });
    const { getClaudeContribution } = await import('../providers/claude.js');
    const contribution = await getClaudeContribution({
      sessionDir: '/tmp/session',
      agentGroupId: 'g1',
      hostEnv: {} as NodeJS.ProcessEnv,
    });
    expect(contribution.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
  });

  it('a registered hook can override Claude behaviour', async () => {
    vi.spyOn(envModule, 'readEnvFile').mockReturnValue({});
    setCredentialResolverHook(async () => ({
      kind: 'gateway_secret',
      providerId: 'anthropic',
      baseUrl: 'https://custom.example',
      placeholderToken: 'placeholder',
      refreshPolicy: 'gateway',
    }));
    const { getClaudeContribution } = await import('../providers/claude.js');
    const contribution = await getClaudeContribution({
      sessionDir: '/tmp/session',
      agentGroupId: 'g1',
      hostEnv: {} as NodeJS.ProcessEnv,
    });
    expect(contribution.env).toEqual({
      ANTHROPIC_BASE_URL: 'https://custom.example',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
    });
  });

  it('hook returning forbidden surfaces as a thrown error', async () => {
    vi.spyOn(envModule, 'readEnvFile').mockReturnValue({});
    setCredentialResolverHook(async () => ({
      kind: 'forbidden',
      provider: 'anthropic',
      reason: 'policy',
    }));
    const { getClaudeContribution } = await import('../providers/claude.js');
    await expect(
      getClaudeContribution({
        sessionDir: '/tmp/session',
        agentGroupId: 'g1',
        hostEnv: {} as NodeJS.ProcessEnv,
      }),
    ).rejects.toThrow(/forbidden/i);
  });
});
