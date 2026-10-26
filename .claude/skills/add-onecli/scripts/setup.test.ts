import { describe, expect, it } from 'vitest';

import { resolveOnecliBindHostEnv } from './setup.js';

describe('resolveOnecliBindHostEnv', () => {
  it('adds ONECLI_BIND_HOST when the api-host is the docker bridge address (#2903)', () => {
    const result = resolveOnecliBindHostEnv('', 'http://10.0.0.1:10254');
    expect(result).toBe('ONECLI_BIND_HOST=10.0.0.1\n');
  });

  it('replaces a stale ONECLI_BIND_HOST value in place', () => {
    const result = resolveOnecliBindHostEnv('ONECLI_BIND_HOST=192.168.1.5\nOTHER=1\n', 'http://10.0.0.1:10254');
    expect(result).toBe('ONECLI_BIND_HOST=10.0.0.1\nOTHER=1\n');
  });

  it('is a no-op when the value already matches', () => {
    const result = resolveOnecliBindHostEnv('ONECLI_BIND_HOST=10.0.0.1\n', 'http://10.0.0.1:10254');
    expect(result).toBeNull();
  });

  it('does not rewrite for a loopback api-host', () => {
    expect(resolveOnecliBindHostEnv('', 'http://127.0.0.1:10254')).toBeNull();
    expect(resolveOnecliBindHostEnv('', 'http://localhost:10254')).toBeNull();
  });

  it('is a no-op on an unparseable api-host', () => {
    expect(resolveOnecliBindHostEnv('', 'not-a-url')).toBeNull();
  });

  it('appends without a leading newline to an empty file', () => {
    const result = resolveOnecliBindHostEnv('', 'http://10.0.0.1:10254');
    expect(result?.startsWith('\n')).toBe(false);
  });

  it('appends after existing content, preserving it', () => {
    const result = resolveOnecliBindHostEnv('FOO=bar\n', 'http://10.0.0.1:10254');
    expect(result).toBe('FOO=bar\nONECLI_BIND_HOST=10.0.0.1\n');
  });
});
