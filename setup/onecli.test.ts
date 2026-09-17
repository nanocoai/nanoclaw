/**
 * The step DETECTS gateway /v1 compatibility and warns (pointing at
 * docs/onecli-upgrades.md) — it does not migrate the gateway; that's the
 * agent's job via /update-nanoclaw. The verify helper must distinguish
 * incompatible (pre-/v1 server: warn) from unreachable (transient: nothing to
 * say) so the warning only fires on a real pre-/v1 server.
 */
import { describe, expect, it } from 'vitest';

import { resolveOnecliBindHostEnv, verifyGatewayV1 } from './onecli.js';

function fakeFetch(behavior: 'ok' | '404' | 'down'): typeof fetch {
  return (async () => {
    if (behavior === 'down') throw new Error('ECONNREFUSED');
    return { ok: behavior === 'ok' } as Response;
  }) as unknown as typeof fetch;
}

describe('verifyGatewayV1', () => {
  it('ok when /v1/health answers', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('ok'))).toBe('ok');
  });
  it('incompatible when the server answers HTTP without /v1', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('404'))).toBe('incompatible');
  });
  it('unreachable on connection failure', async () => {
    expect(await verifyGatewayV1('http://x', fakeFetch('down'))).toBe('unreachable');
  });
});

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
