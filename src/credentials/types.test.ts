import { describe, expect, it } from 'vitest';
import type { CredentialDecision, CredentialResolverInput, CredentialResolverHook } from './types.js';

describe('CredentialDecision', () => {
  it('narrows on kind discriminator', () => {
    const decisions: CredentialDecision[] = [
      {
        kind: 'gateway_secret',
        providerId: 'anthropic',
        baseUrl: 'https://api.anthropic.com',
        placeholderToken: 'placeholder',
        injection: { header: 'authorization', scheme: 'Bearer' },
        refreshPolicy: 'gateway',
      },
      {
        kind: 'native_auth_bundle',
        providerId: 'codex',
        bundleRef: 'host:~/.codex/auth.json',
        mountPath: '/home/node/.codex/auth.json',
        refreshPolicy: 'runtime',
      },
      { kind: 'connect_required', provider: 'codex', message: 'Sign in' },
      { kind: 'forbidden', provider: 'codex', reason: 'policy' },
      { kind: 'fallback' },
    ];

    for (const d of decisions) {
      switch (d.kind) {
        case 'gateway_secret':
          expect(d.providerId).toBeTypeOf('string');
          break;
        case 'native_auth_bundle':
          expect(d.bundleRef).toBeTypeOf('string');
          break;
        case 'connect_required':
          expect(d.message).toBeTypeOf('string');
          break;
        case 'forbidden':
          expect(d.provider).toBeTypeOf('string');
          break;
        case 'fallback':
          break;
      }
    }
  });

  it('CredentialResolverHook accepts a typed input', () => {
    const hook: CredentialResolverHook = async (input: CredentialResolverInput) => {
      expect(input.agentGroupId).toBeTypeOf('string');
      expect(input.runtimeProvider).toBeTypeOf('string');
      return { kind: 'fallback' };
    };
    return hook({ agentGroupId: 'g1', runtimeProvider: 'claude' });
  });
});
