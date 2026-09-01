import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
  process: { on: vi.fn() },
}));

vi.mock('child_process', () => ({
  execFileSync: mocks.execFileSync,
  spawn: mocks.spawn,
}));

import { CONTAINER_INSTALL_LABEL } from '../config.js';
import { CONTAINER_RUNTIME_BIN } from '../container-runtime.js';
import { DockerSessionSidecarDriver, type SidecarContainerSpec } from './session-sidecar.js';

const spec: SidecarContainerSpec = {
  name: 'nc-abcd-sidecar',
  image: 'nanoco-sidecar:test',
  uplinkNetwork: 'nc-abcd-uplink',
  privateNetwork: 'nc-abcd-session',
  labels: {
    'nanoclaw-role': 'session-sidecar',
    'nanoclaw-session': 'session-1',
    'nanoco-channel': 'channel-1',
  },
  environment: {
    NANOCO_SIDECAR_GATEWAY_ADDR: 'gateway.example:9443',
    NANOCO_SIDECAR_CLIENT_KEY: '/run/nanoco/session-key.pem',
  },
  mounts: [
    { hostPath: '/host/gateway-ca.pem', containerPath: '/run/nanoco/gateway-ca.pem', class: 'allowlisted-extra' },
    { hostPath: '/host/session-cert.pem', containerPath: '/run/nanoco/session-cert.pem', class: 'identity-material' },
    { hostPath: '/host/session-key.pem', containerPath: '/run/nanoco/session-key.pem', class: 'identity-material' },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.execFileSync.mockReturnValue(Buffer.alloc(0));
  mocks.spawn.mockReturnValue(mocks.process);
});

describe('DockerSessionSidecarDriver', () => {
  it('creates separate install-labeled internal and uplink networks without a shell', () => {
    const driver = new DockerSessionSidecarDriver();

    driver.createNetwork('nc-abcd-session', true);
    driver.createNetwork('nc-abcd-uplink', false);

    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      1,
      CONTAINER_RUNTIME_BIN,
      ['network', 'create', '--internal', '--label', CONTAINER_INSTALL_LABEL, 'nc-abcd-session'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['network', 'create', '--label', CONTAINER_INSTALL_LABEL, 'nc-abcd-uplink'],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('creates the sidecar on its uplink and attaches only it to the private session network', () => {
    const driver = new DockerSessionSidecarDriver();

    driver.createSidecar(spec);

    const createArgs = mocks.execFileSync.mock.calls[0][1] as string[];
    expect(createArgs.slice(0, 5)).toEqual(['create', '--name', spec.name, '--network', spec.uplinkNetwork]);
    expect(createArgs).toContain('host.docker.internal:host-gateway');
    expect(createArgs).toContain(`${process.getuid?.()}:${process.getgid?.()}`);
    expect(createArgs).toContain('--read-only');
    expect(createArgs).toContain('ALL');
    expect(createArgs).toContain('no-new-privileges');
    expect(createArgs).toContain('NANOCO_SIDECAR_CLIENT_KEY=/run/nanoco/session-key.pem');
    expect(createArgs).toContain('/host/session-key.pem:/run/nanoco/session-key.pem:ro');
    expect(createArgs.at(-1)).toBe(spec.image);
    expect(mocks.execFileSync).toHaveBeenNthCalledWith(
      2,
      CONTAINER_RUNTIME_BIN,
      ['network', 'connect', '--alias', 'sidecar', spec.privateNetwork, spec.name],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('removes a partially created sidecar if private-network attachment fails', () => {
    mocks.execFileSync.mockImplementation((_binary: string, args: string[]) => {
      if (args[0] === 'network' && args[1] === 'connect') throw new Error('connect failed');
      return Buffer.alloc(0);
    });
    const driver = new DockerSessionSidecarDriver();

    expect(() => driver.createSidecar(spec)).toThrow('connect failed');
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['rm', '--force', spec.name],
      expect.objectContaining({ stdio: 'pipe' }),
    );
  });

  it('uses argv-safe start, stop, removal, and network cleanup commands', () => {
    const driver = new DockerSessionSidecarDriver();

    expect(driver.startSidecar(spec.name)).toBe(mocks.process);
    driver.stopSidecar(spec.name);
    driver.removeSidecar(spec.name);
    driver.removeNetwork(spec.privateNetwork);

    expect(mocks.spawn).toHaveBeenCalledWith(CONTAINER_RUNTIME_BIN, ['start', '--attach', spec.name], {
      stdio: 'ignore',
    });
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['stop', '-t', '1', spec.name],
      expect.any(Object),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['rm', '--force', spec.name],
      expect.any(Object),
    );
    expect(mocks.execFileSync).toHaveBeenCalledWith(
      CONTAINER_RUNTIME_BIN,
      ['network', 'rm', spec.privateNetwork],
      expect.any(Object),
    );
  });
});
