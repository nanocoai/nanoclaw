import os from 'os';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { deriveOneCliRemoteHost } from './config.js';
import { detectHostGateway } from './container-runtime.js';
import { inBridgeSubnet } from './onecli-forwarder.js';

describe('detectHostGateway', () => {
  afterEach(() => vi.restoreAllMocks());

  it('returns the bridge100 IPv4 in the 192.168.64.0/24 subnet when present', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      bridge100: [{ family: 'IPv4', address: '192.168.64.1', internal: false } as os.NetworkInterfaceInfo],
    });
    expect(detectHostGateway()).toBe('192.168.64.1');
  });

  it('falls back to the .1 literal when no bridge interface exists', () => {
    // Regression: NANOCLAW_HOST_GATEWAY_IP normalises to '' (empty string, not
    // null), so a `??` chain would short-circuit on it and return '' — breaking
    // the proxy-host rewrite. `||` must let the literal default win.
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({});
    expect(detectHostGateway()).toBe('192.168.64.1');
  });

  it('ignores bridge addresses outside 192.168.64.0/24', () => {
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      bridge100: [{ family: 'IPv4', address: '10.0.0.5', internal: false } as os.NetworkInterfaceInfo],
    });
    expect(detectHostGateway()).toBe('192.168.64.1');
  });

  it('lets an explicit NANOCLAW_HOST_GATEWAY_IP override win over a detected bridge address', async () => {
    // The override must take precedence even when a real bridge address exists —
    // otherwise the documented override is a no-op on any host with bridge100 up.
    // NANOCLAW_HOST_GATEWAY_IP is frozen at config-import time, so mock config and
    // re-import the runtime module to exercise the override path.
    vi.resetModules();
    vi.doMock('./config.js', async () => ({
      ...(await vi.importActual<typeof import('./config.js')>('./config.js')),
      NANOCLAW_HOST_GATEWAY_IP: '192.168.64.250',
    }));
    const { detectHostGateway: detect } = await import('./container-runtime.js');
    vi.spyOn(os, 'networkInterfaces').mockReturnValue({
      bridge100: [{ family: 'IPv4', address: '192.168.64.1', internal: false } as os.NetworkInterfaceInfo],
    });
    expect(detect()).toBe('192.168.64.250');
    vi.doUnmock('./config.js');
    vi.resetModules();
  });
});

describe('inBridgeSubnet', () => {
  it('accepts a 192.168.64.x address', () => expect(inBridgeSubnet('192.168.64.7')).toBe(true));
  it('accepts an IPv4-mapped IPv6 ::ffff:192.168.64.x', () => expect(inBridgeSubnet('::ffff:192.168.64.7')).toBe(true));
  it('rejects a different subnet', () => expect(inBridgeSubnet('192.168.0.7')).toBe(false));
  it('rejects undefined', () => expect(inBridgeSubnet(undefined)).toBe(false));
});

describe('deriveOneCliRemoteHost', () => {
  it('returns the hostname for a non-loopback URL', () =>
    expect(deriveOneCliRemoteHost('http://192.168.0.99:10254')).toBe('192.168.0.99'));
  it('treats 127.0.0.1 / localhost as local', () => {
    expect(deriveOneCliRemoteHost('http://127.0.0.1:10254')).toBe('');
    expect(deriveOneCliRemoteHost('http://localhost:10254')).toBe('');
  });
  it('treats both ::1 and the bracketed [::1] IPv6 loopback as local', () => {
    // URL.hostname returns IPv6 literals bracketed, so the guard must match "[::1]".
    expect(deriveOneCliRemoteHost('http://[::1]:10254')).toBe('');
  });
  it('keeps a bracketed non-loopback IPv6 literal (valid in a proxy URL)', () =>
    expect(deriveOneCliRemoteHost('http://[fd00::1]:10254')).toBe('[fd00::1]'));
  it('returns empty for unset or malformed URLs', () => {
    expect(deriveOneCliRemoteHost(undefined)).toBe('');
    expect(deriveOneCliRemoteHost('not a url')).toBe('');
  });
});
