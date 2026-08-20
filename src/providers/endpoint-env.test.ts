import { describe, expect, it } from 'vitest';

import { endpointEnvFor, endpointOverrideSupported, mergeNoProxy } from './endpoint-env.js';

describe('endpointOverrideSupported', () => {
  it('covers the built-in provider, including the implicit default', () => {
    expect(endpointOverrideSupported('claude')).toBe(true);
    expect(endpointOverrideSupported('CLAUDE')).toBe(true);
    expect(endpointOverrideSupported(null)).toBe(true);
    expect(endpointOverrideSupported('')).toBe(true);
  });

  it('excludes providers that own their endpoint config', () => {
    // The ncl write path refuses --base-url for these rather than storing a
    // value nothing reads.
    expect(endpointOverrideSupported('opencode')).toBe(false);
    expect(endpointOverrideSupported('codex')).toBe(false);
  });
});

describe('endpointEnvFor', () => {
  it('maps a local endpoint onto base URL, placeholder bearer and proxy bypass', () => {
    expect(endpointEnvFor('claude', 'http://host.docker.internal:11434')).toEqual({
      ANTHROPIC_BASE_URL: 'http://host.docker.internal:11434',
      ANTHROPIC_AUTH_TOKEN: 'placeholder',
      NO_PROXY: 'host.docker.internal',
      no_proxy: 'host.docker.internal',
    });
  });

  it('keeps the gateway proxy in front of a remote endpoint', () => {
    // A remote HTTPS endpoint is exactly the case where the gateway must stay
    // in the path: that is how its real credential gets attached without ever
    // entering the container.
    const env = endpointEnvFor('claude', 'https://anthropic.example.com');
    expect(env.NO_PROXY).toBeUndefined();
    expect(env.no_proxy).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://anthropic.example.com');
  });

  it('extends an existing NO_PROXY instead of replacing it', () => {
    const env = endpointEnvFor('claude', 'http://127.0.0.1:11434', {
      NO_PROXY: 'localhost,10.0.0.0/8',
      no_proxy: 'localhost',
    });
    expect(env.NO_PROXY).toBe('localhost,10.0.0.0/8,127.0.0.1');
    expect(env.no_proxy).toBe('localhost,127.0.0.1');
  });

  it('contributes nothing for a provider that owns its endpoint config', () => {
    expect(endpointEnvFor('opencode', 'http://host.docker.internal:11434')).toEqual({});
  });
});

describe('mergeNoProxy', () => {
  it('is idempotent and case-insensitive on the host', () => {
    expect(mergeNoProxy('host.docker.internal', 'host.docker.internal')).toBe('host.docker.internal');
    expect(mergeNoProxy('HOST.DOCKER.INTERNAL', 'host.docker.internal')).toBe('HOST.DOCKER.INTERNAL');
  });

  it('starts a list from nothing', () => {
    expect(mergeNoProxy(undefined, 'localhost')).toBe('localhost');
    expect(mergeNoProxy('', 'localhost')).toBe('localhost');
  });
});
