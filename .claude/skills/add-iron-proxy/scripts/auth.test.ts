import { describe, expect, it } from 'vitest';

import { customEndpoint, run } from './auth.js';

describe('Iron Proxy custom endpoint', () => {
  it('stops before credential handling for an unsupported agent provider', async () => {
    await expect(run('unsupported-provider')).rejects.toThrow('No authentication flow installed for unsupported-provider');
  });

  it('maps a local HTTP endpoint to Docker’s host alias', () => {
    expect(
      customEndpoint({
        NANOCLAW_ANTHROPIC_BASE_URL: 'http://127.0.0.1:19001',
        NANOCLAW_ANTHROPIC_AUTH_TOKEN: 'fixture-token',
      }),
    ).toEqual({
      secret: 'fixture-token',
      authEnv: 'ANTHROPIC_AUTH_TOKEN',
      modelHost: 'host.docker.internal',
      baseUrl: 'http://host.docker.internal:19001',
    });
  });

  it('rejects cleartext remote endpoints', () => {
    expect(() =>
      customEndpoint({
        NANOCLAW_ANTHROPIC_BASE_URL: 'http://model.example.com',
        NANOCLAW_ANTHROPIC_AUTH_TOKEN: 'fixture-token',
      }),
    ).toThrow('must use HTTPS unless it is local');
  });
});
