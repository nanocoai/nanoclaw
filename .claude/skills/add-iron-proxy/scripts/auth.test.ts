import { describe, expect, it } from 'vitest';

import { customEndpoint, run, suppliedCredential } from './auth.js';

describe('Iron Proxy prompt-free credential', () => {
  it('stores an API key under ANTHROPIC_API_KEY', () => {
    expect(suppliedCredential({ NANOCLAW_ANTHROPIC_API_KEY: ' sk-ant-api03-fixture ' })).toEqual({
      secret: 'sk-ant-api03-fixture',
      authEnv: 'ANTHROPIC_API_KEY',
    });
  });

  it('recognises an OAuth token handed over as the API key and stores it as a bearer token', () => {
    expect(suppliedCredential({ ANTHROPIC_API_KEY: 'sk-ant-oat01-fixture' })).toEqual({
      secret: 'sk-ant-oat01-fixture',
      authEnv: 'CLAUDE_CODE_OAUTH_TOKEN',
    });
  });

  it('accepts an OAuth token through its own variable, preferring it over an API key', () => {
    expect(
      suppliedCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture', ANTHROPIC_API_KEY: 'sk-ant-api03-x' }),
    ).toEqual({ secret: 'sk-ant-oat01-fixture', authEnv: 'CLAUDE_CODE_OAUTH_TOKEN' });
  });

  it('returns nothing when no credential variable is set', () => {
    expect(suppliedCredential({})).toBeUndefined();
  });
});

describe('Iron Proxy custom endpoint', () => {
  it('stops before credential handling for an unsupported agent provider', async () => {
    await expect(run('unsupported-provider')).rejects.toThrow(
      'No authentication flow installed for unsupported-provider',
    );
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
