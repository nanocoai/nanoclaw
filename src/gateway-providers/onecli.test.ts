import { describe, expect, it, vi } from 'vitest';

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));
vi.mock('../config.js', () => ({ ONECLI_URL: 'http://localhost:1', ONECLI_API_KEY: 'unused' }));

import { LOCAL_PROXY_BYPASS, contributionFromArgs, withLocalProxyBypass } from './onecli.js';

describe('contributionFromArgs', () => {
  it('types the closed grammar the SDK emits: -e pairs and ro mounts', () => {
    const contribution = contributionFromArgs(
      [
        '-e',
        'HTTPS_PROXY=http://host.docker.internal:15001',
        '-e',
        'SSL_CERT_FILE=/tmp/onecli-combined-ca.pem',
        '-v',
        '/tmp/onecli/ca.pem:/usr/local/share/ca.pem:ro',
        '-v',
        '/tmp/onecli/stub.json:/workspace/.config/creds.json:ro',
      ],
      'g1',
    );

    expect(contribution.env).toEqual({
      HTTPS_PROXY: 'http://host.docker.internal:15001',
      SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem',
    });
    expect(contribution.mounts).toEqual([
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli/ca.pem',
        containerPath: '/usr/local/share/ca.pem',
        mode: 'ro',
        groupScope: 'g1',
      },
      {
        class: 'allowlisted-extra',
        hostPath: '/tmp/onecli/stub.json',
        containerPath: '/workspace/.config/creds.json',
        mode: 'ro',
        groupScope: 'g1',
      },
    ]);
  });

  it('refuses argv outside the grammar — nothing rides raw around the spec again', () => {
    // Grammar drift in the SDK must break the spawn loudly, not smuggle flags.
    expect(() => contributionFromArgs(['--network', 'something'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', '/odd'], 'g1')).toThrow(/cannot type/);
    expect(() => contributionFromArgs(['-v', 'h:c:rw:extra'], 'g1')).toThrow(/cannot type/);
  });
});

describe('withLocalProxyBypass', () => {
  it('adds NO_PROXY for local hops when the SDK injected a proxy', () => {
    const env = withLocalProxyBypass({
      HTTPS_PROXY: 'http://host.docker.internal:10255',
      HTTP_PROXY: 'http://host.docker.internal:10255',
    });
    expect(env.NO_PROXY).toBe(LOCAL_PROXY_BYPASS);
    expect(env.no_proxy).toBe(LOCAL_PROXY_BYPASS);
    expect(LOCAL_PROXY_BYPASS.split(',')).toContain('host.docker.internal');
  });

  it('leaves env alone when there is no proxy, and never overrides an SDK-set NO_PROXY', () => {
    expect(withLocalProxyBypass({ SSL_CERT_FILE: '/tmp/ca.pem' })).toEqual({ SSL_CERT_FILE: '/tmp/ca.pem' });
    const env = withLocalProxyBypass({ HTTP_PROXY: 'http://gw:1', NO_PROXY: 'example.internal' });
    expect(env.NO_PROXY).toBe('example.internal');
    expect(env.no_proxy).toBeUndefined();
  });
});
