import { describe, expect, it } from 'vitest';

import { LOCAL_PROXY_BYPASS, withLocalProxyBypass } from './local-proxy-bypass.js';

describe('withLocalProxyBypass', () => {
  it('adds NO_PROXY for local hops when a gateway injected a proxy', () => {
    const env = withLocalProxyBypass({
      HTTPS_PROXY: 'http://host.docker.internal:10255',
      HTTP_PROXY: 'http://host.docker.internal:10255',
    });
    expect(env.NO_PROXY).toBe(LOCAL_PROXY_BYPASS);
    expect(env.no_proxy).toBe(LOCAL_PROXY_BYPASS);
    expect(LOCAL_PROXY_BYPASS.split(',')).toContain('host.docker.internal');
  });

  it('leaves env alone when there is no proxy, and never overrides a contributed NO_PROXY', () => {
    expect(withLocalProxyBypass({ SSL_CERT_FILE: '/tmp/ca.pem' })).toEqual({ SSL_CERT_FILE: '/tmp/ca.pem' });
    const env = withLocalProxyBypass({ HTTP_PROXY: 'http://gw:1', NO_PROXY: 'example.internal' });
    expect(env.NO_PROXY).toBe('example.internal');
    expect(env.no_proxy).toBeUndefined();
  });
});
