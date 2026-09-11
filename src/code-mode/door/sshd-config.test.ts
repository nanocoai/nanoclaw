import { describe, expect, it } from 'vitest';

import { renderSshdConfig } from './sshd-config.js';

const options = {
  port: 45123,
  hostKeyFile: '/srv/host/data/door/host_ed25519',
  authorizedKeysCommand: [
    '/usr/bin/env',
    '/opt/node/bin/node',
    '/srv/host/dist/code-mode/door/authorized-keys.js',
    '/srv/host/data/door',
  ],
  user: 'alice',
};

describe('renderSshdConfig', () => {
  it('renders a loopback, keys-only, PTY-only listener routed through the AuthorizedKeysCommand', () => {
    const text = renderSshdConfig(options);
    const lines = text.split('\n');
    expect(lines).toContain('Port 45123');
    expect(lines).toContain('ListenAddress 127.0.0.1');
    expect(lines).toContain('HostKey "/srv/host/data/door/host_ed25519"');
    expect(lines).toContain('PidFile none');
    expect(lines).toContain('AllowUsers alice');
    expect(lines).toContain('AuthorizedKeysFile none');
    expect(lines).toContain(
      'AuthorizedKeysCommand /usr/bin/env "/opt/node/bin/node" "/srv/host/dist/code-mode/door/authorized-keys.js" "/srv/host/data/door" %f %t %k',
    );
    expect(lines).toContain('AuthorizedKeysCommandUser alice');
    for (const required of [
      'PubkeyAuthentication yes',
      'PasswordAuthentication no',
      'KbdInteractiveAuthentication no',
      'PermitTTY yes',
      'AllowTcpForwarding no',
      'X11Forwarding no',
      'AllowAgentForwarding no',
      'ClientAliveInterval 20',
      'DisableForwarding yes',
      'ClientAliveCountMax 3',
      'LogLevel VERBOSE',
      'UsePAM no',
      'PermitUserRC no',
    ]) {
      expect(lines).toContain(required);
    }
    expect(text.endsWith('\n')).toBe(true);
    expect(text).not.toMatch(/Subsystem|ForceCommand|Banner/);
  });

  it('doubles percent signs in paths so the server does not expand them', () => {
    const text = renderSshdConfig({ ...options, hostKeyFile: '/srv/100%/host_ed25519' });
    expect(text).toContain('HostKey "/srv/100%%/host_ed25519"');
  });

  it('refuses ports outside the unprivileged range, odd user names, and unquotable paths', () => {
    expect(() => renderSshdConfig({ ...options, port: 22 })).toThrow(/invalid door port/);
    expect(() => renderSshdConfig({ ...options, port: 70000 })).toThrow(/invalid door port/);
    expect(() => renderSshdConfig({ ...options, user: 'a b' })).toThrow(/local account name/);
    expect(() => renderSshdConfig({ ...options, authorizedKeysCommand: ['env', 'x'] })).toThrow(/absolute path/);
    expect(() => renderSshdConfig({ ...options, hostKeyFile: '/srv/"quoted"/key' })).toThrow(/sshd_config/);
    expect(() => renderSshdConfig({ ...options, hostKeyFile: '/srv/new\nline' })).toThrow(/sshd_config/);
  });
});
