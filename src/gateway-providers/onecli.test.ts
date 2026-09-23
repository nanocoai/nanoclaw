import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { ContainerConfig } from '@onecli-sh/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sdk = vi.hoisted(() => ({ ensureAgent: vi.fn(), getContainerConfig: vi.fn(), applyContainerConfig: vi.fn() }));
vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    constructor() {
      return sdk;
    }
  },
}));
vi.mock('../log.js', () => ({ log: { info: vi.fn() } }));
vi.mock('../config.js', () => ({
  ONECLI_URL: 'http://localhost:1',
  ONECLI_API_KEY: 'unused',
  get DATA_DIR() {
    return path.join(os.tmpdir(), 'data');
  },
}));

import { getGatewayProviderFactory, type GatewayProviderInput } from './gateway-provider-registry.js';
import './onecli.js';

const input: GatewayProviderInput = {
  key: { installSlug: 'test', agentGroupId: 'group-1', sessionId: 'session-1' },
  groupName: 'Test group',
  containerName: 'nanoclaw-v2-agent-group-1-session-1',
  capabilities: {
    isolationTiers: ['container'],
    admissionEnforced: true,
    networkPolicy: 'topology',
    encryptedVolumes: false,
    unrealized: [],
    sharedNetworkNamespace: true,
    auxiliaryContainers: false,
    imageBuild: true,
  },
};
const caPath = '/tmp/onecli-proxy-ca.pem';
const systemPaths = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];
let dir: string;
let config: ContainerConfig;
const provider = () => getGatewayProviderFactory('onecli')!();

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-onecli-test-'));
  vi.stubEnv('TMPDIR', dir);
  config = {
    env: { HTTPS_PROXY: 'http://example.invalid:15001', SSL_CERT_FILE: caPath, DENO_CERT: caPath },
    caCertificate: 'SYNTHETIC CA\n',
    caCertificateContainerPath: caPath,
  };
  sdk.ensureAgent.mockReset().mockResolvedValue({});
  sdk.getContainerConfig.mockReset().mockImplementation(async () => config);
  sdk.applyContainerConfig.mockReset().mockRejectedValue(new Error('legacy temporary CA path'));
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('OneCLI gateway contribution', () => {
  it('survives a stale legacy CA directory without touching it or changing TMPDIR', async () => {
    const legacy = path.join(dir, 'onecli-proxy-ca.pem');
    fs.mkdirSync(legacy);
    fs.writeFileSync(path.join(legacy, 'unrelated'), 'keep');
    const result = await provider().contribute(input);
    expect(sdk.ensureAgent).toHaveBeenCalledWith({ name: 'Test group', identifier: 'group-1' });
    expect(sdk.getContainerConfig).toHaveBeenCalledWith({ agent: 'group-1' });
    expect(sdk.applyContainerConfig).not.toHaveBeenCalled();
    expect(process.env.TMPDIR).toBe(dir);
    expect(fs.readFileSync(path.join(legacy, 'unrelated'), 'utf8')).toBe('keep');
    const ca = result.mounts!.find((m) => m.containerPath === caPath)!;
    expect(ca).toMatchObject({ class: 'allowlisted-extra', mode: 'ro', groupScope: 'group-1' });
    expect(ca.hostPath.startsWith(path.join(dir, 'data', 'onecli') + path.sep)).toBe(true);
    expect(fs.readFileSync(ca.hostPath, 'utf8')).toBe(config.caCertificate);
    expect(fs.lstatSync(ca.hostPath).isFile()).toBe(true);
  });

  it('does not follow a symlink at the old temporary CA path', async () => {
    const target = path.join(dir, 'unrelated');
    fs.writeFileSync(target, 'keep');
    fs.symlinkSync(target, path.join(dir, 'onecli-proxy-ca.pem'));
    await provider().contribute(input);
    expect(fs.readFileSync(target, 'utf8')).toBe('keep');
    expect(fs.lstatSync(path.join(dir, 'onecli-proxy-ca.pem')).isSymbolicLink()).toBe(true);
  });

  it('preserves SDK env and combines system trust with the proxy certificate', async () => {
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (file === systemPaths[0]) return 'SYSTEM CA\n\n';
      return Reflect.apply(read, fs, [file, ...args]);
    }) as typeof fs.readFileSync);
    const result = await provider().contribute(input);
    expect(result.env).toEqual({
      HTTPS_PROXY: 'http://example.invalid:15001',
      SSL_CERT_FILE: '/tmp/onecli-combined-ca.pem',
      DENO_CERT: '/tmp/onecli-combined-ca.pem',
    });
    const bundle = result.mounts!.find((m) => m.containerPath === '/tmp/onecli-combined-ca.pem')!;
    expect(fs.readFileSync(bundle.hostPath, 'utf8')).toBe('SYSTEM CA\nSYNTHETIC CA\n');
    expect(config.env.SSL_CERT_FILE).toBe(caPath);
  });

  it('keeps the SDK fallback when no host system trust bundle can be read', async () => {
    const read = fs.readFileSync;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((file: fs.PathOrFileDescriptor, ...args: unknown[]) => {
      if (typeof file === 'string' && systemPaths.includes(file))
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      return Reflect.apply(read, fs, [file, ...args]);
    }) as typeof fs.readFileSync);
    const result = await provider().contribute(input);
    expect(result.env).toEqual(config.env);
    expect(result.mounts).toHaveLength(1);
  });

  it('stages credential stubs independently even when container basenames match', async () => {
    config.credentialStubs = [
      { containerPath: '/first/credentials.json', content: 'FIRST' },
      { containerPath: '/second/credentials.json', content: 'SECOND' },
    ];
    const result = await provider().contribute(input);
    const stubs = result.mounts!.filter((m) => m.containerPath.endsWith('credentials.json'));
    expect(stubs).toHaveLength(2);
    expect(stubs[0].hostPath).not.toBe(stubs[1].hostPath);
    expect(stubs.map((m) => fs.readFileSync(m.hostPath, 'utf8'))).toEqual(['FIRST', 'SECOND']);
    for (const stub of stubs) expect(fs.statSync(stub.hostPath).mode & 0o777).toBe(0o600);
  });

  it('reuses unchanged files and preserves previous mounts when the CA rotates', async () => {
    const first = await provider().contribute(input);
    const second = await provider().contribute({ ...input, key: { ...input.key, sessionId: 'session-2' } });
    expect(first.mounts).toEqual(second.mounts);
    const before = first.mounts!.map((m) => fs.readFileSync(m.hostPath, 'utf8'));
    config.caCertificate = 'ROTATED CA\n';
    const rotated = await provider().contribute(input);
    expect(rotated.mounts![0].hostPath).not.toBe(first.mounts![0].hostPath);
    expect(first.mounts!.map((m) => fs.readFileSync(m.hostPath, 'utf8'))).toEqual(before);
    expect(fs.readFileSync(rotated.mounts![0].hostPath, 'utf8')).toBe('ROTATED CA\n');
    expect(sdk.getContainerConfig).toHaveBeenCalledTimes(3);
  });

  it('fails closed when registration or configuration fetching fails, even after a successful spawn', async () => {
    await provider().contribute(input);
    sdk.getContainerConfig.mockRejectedValueOnce(new Error('gateway unavailable'));
    await expect(provider().contribute(input)).rejects.toThrow('gateway unavailable');
    sdk.ensureAgent.mockRejectedValueOnce(new Error('registration rejected'));
    await expect(provider().contribute(input)).rejects.toThrow('registration rejected');
    expect(sdk.getContainerConfig).toHaveBeenCalledTimes(2);
  });

  it('fails closed when persistent staging is blocked', async () => {
    fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'data', 'onecli'), 'unrelated');
    await expect(provider().contribute(input)).rejects.toThrow();
    expect(fs.readFileSync(path.join(dir, 'data', 'onecli'), 'utf8')).toBe('unrelated');
  });
});
