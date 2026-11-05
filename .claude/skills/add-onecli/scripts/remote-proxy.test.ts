import { describe, expect, it, vi } from 'vitest';

import { advertisedProxy, remoteProxyHint } from './remote-proxy.js';

const GATEWAY = 'http://gw.example.com:10254';
const proxy = (url: string) => new URL(url);

describe('remote gateway proxy hint', () => {
  it.each([
    'http://x:aoc_secret@host.docker.internal:10255',
    'http://x:aoc_secret@127.0.0.1:10255',
    'http://x:aoc_secret@localhost:10255',
    'http://x:aoc_secret@[::1]:10255',
    'http://x:aoc_secret@[::ffff:127.0.0.1]:10255',
  ])('names the exact line to set when agents are sent to their own machine (%s)', (advertised) => {
    const hint = remoteProxyHint(GATEWAY, proxy(advertised))!;
    expect(hint).toContain('GATEWAY_BASE_URL=gw.example.com:10255');
    expect(hint).toContain('Remote gateway');
    // The proxy URL carries the agent token.
    expect(hint).not.toContain('aoc_secret');
  });

  it('keeps the port the gateway hands out, and names the published port it cannot see', () => {
    const hint = remoteProxyHint(GATEWAY, proxy('http://x:t@host.docker.internal:20255'))!;
    expect(hint).toContain('GATEWAY_BASE_URL=gw.example.com:20255');
    // OneCLI advertises its default port even when ONECLI_GATEWAY_PORT publishes another.
    expect(hint).toContain('ONECLI_GATEWAY_PORT in place of 20255');
  });

  it.each(['http://x:t@gw.example.com:10255', 'http://x:t@10.0.0.5:10255'])('says nothing for %s', (advertised) => {
    expect(remoteProxyHint(GATEWAY, proxy(advertised))).toBeNull();
  });

  it('says nothing when the proxy could not be read', () => {
    expect(remoteProxyHint(GATEWAY, null)).toBeNull();
  });
});

describe('advertised proxy', () => {
  const answer = (status: number, body: unknown) =>
    vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

  it("reads the default agent's proxy, with the API key", async () => {
    const fetchImpl = answer(200, { env: { HTTPS_PROXY: 'http://x:t@host.docker.internal:10255' } });
    const got = await advertisedProxy(`${GATEWAY}/`, 'oc_key', fetchImpl as unknown as typeof fetch);
    expect(got?.host).toBe('host.docker.internal:10255');
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${GATEWAY}/v1/container-config?agent=default`);
    expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer oc_key');
  });

  it.each([
    ['a refused request', answer(401, {})],
    ['no proxy in the answer', answer(200, { env: {} })],
    ['a proxy that is not a URL', answer(200, { env: { HTTPS_PROXY: 'not a url' } })],
    [
      'an unreachable gateway',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    ],
  ])('gives null for %s', async (_case, fetchImpl) => {
    expect(await advertisedProxy(GATEWAY, undefined, fetchImpl as unknown as typeof fetch)).toBeNull();
  });
});
