/**
 * The step DETECTS gateway /v1 compatibility and warns (pointing at
 * docs/onecli-upgrades.md) — it does not migrate the gateway; that's the
 * agent's job via /update-nanoclaw. The verify helper must distinguish
 * incompatible (pre-/v1 server: warn) from unreachable (transient: nothing to
 * say) so the warning only fires on a real pre-/v1 server.
 */
import { describe, expect, it } from 'vitest';

import { verifyGatewayV1 } from './onecli.js';

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
