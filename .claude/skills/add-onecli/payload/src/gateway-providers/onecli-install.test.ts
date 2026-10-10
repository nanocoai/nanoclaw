import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { describe, expect, it } from 'vitest';

const { withEnvVar, withLinuxHostGateway } = await import(
  pathToFileURL(path.resolve('.claude/skills/add-onecli/scripts/setup.ts')).href
);

const compose = `services:
  onecli:
    image: onecli
    container_name: onecli
    restart: unless-stopped
`;

describe('OneCLI compose setup', () => {
  it('persists the exact gateway image pin and bind host', () => {
    const pinned = withEnvVar('ONECLI_VERSION=latest\nKEEP=yes\n', 'ONECLI_VERSION', '1.41.0');
    expect(withEnvVar(pinned, 'ONECLI_BIND_HOST', '172.17.0.1')).toBe(
      'ONECLI_VERSION=1.41.0\nKEEP=yes\nONECLI_BIND_HOST=172.17.0.1\n',
    );
  });

  it('adds the Linux host gateway once', () => {
    const configured = withLinuxHostGateway(compose, 'linux');
    expect(configured).toContain('extra_hosts:\n      - "host.docker.internal:host-gateway"');
    expect(withLinuxHostGateway(configured, 'linux')).toBe(configured);
    expect(withLinuxHostGateway(compose, 'darwin')).toBe(compose);
  });
});
