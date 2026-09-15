import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse as parseYaml } from 'yaml';
import { describe, expect, it, vi } from 'vitest';

import type { GatewaySessionInput } from './gateway-provider-registry.js';

vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (_bin: string, _args: string[], _opts: unknown, done: (e: unknown, stdout: string, stderr: string) => void) =>
      done(null, 'true\n', ''),
  ),
}));
vi.mock('../container-runtime.js', () => ({ CONTAINER_RUNTIME_BIN: 'docker' }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  defineIronProxyProvider,
  ironProxyConfig,
  ironFrontConfig,
  ironProxyContribution,
  codexPlaceholder,
  readIronProxySettings,
  type IronProxySettings,
} from './iron-proxy.js';

const digest = `ghcr.io/example/iron-proxy@sha256:${'a'.repeat(64)}`;
const root = '/tmp/nanoclaw-iron-test';
const materialRoot = path.join(root, 'data', 'session-materials');
const settings: IronProxySettings = {
  materialRoot,
  image: digest,
  caCert: path.join(materialRoot, 'iron-proxy/shared/ca.crt'),
  caKey: path.join(materialRoot, 'iron-proxy/shared/ca.key'),
  secretFile: path.join(materialRoot, 'iron-proxy/shared/upstream-secret'),
  configFile: path.join(materialRoot, 'iron-proxy/shared/config.yaml'),
  identityKey: path.join(materialRoot, 'iron-proxy/shared/workload-identity.key'),
  containerName: 'nanoclaw-iron-proxy-test',
  port: 8080,
  approvalDir: path.join(materialRoot, 'iron-proxy/approval'),
  approvalSocket: path.join(materialRoot, 'iron-proxy/approval/approval.sock'),
  agentCaCert: path.join(root, 'data/gateway-trust/iron-proxy/ca.crt'),
  allowedHostsFile: path.join(materialRoot, 'iron-proxy/shared/allowed-hosts.json'),
  authEnv: 'ANTHROPIC_API_KEY',
  modelHost: 'api.anthropic.com',
  approvalTimeoutMs: 120_000,
  maxPending: 32,
};
const input: GatewaySessionInput = {
  key: { installSlug: 'install', agentGroupId: 'group', sessionId: 'session' },
  runtimeIdentity: 'install/group/session',
  containerName: 'fixture-session',
  groupName: 'Group',
  capabilities: {
    isolationTiers: ['container'],
    admissionEnforced: false,
    networkPolicy: 'topology' as const,
    encryptedVolumes: false,
    unrealized: [],
    sharedNetworkNamespace: false,
    auxiliaryContainers: true,
    imageBuild: true,
  },
};

describe('Iron Proxy provider', () => {
  it('creates only synthetic Codex login data for either auth mode', () => {
    const api = JSON.parse(codexPlaceholder('api'));
    expect(api.OPENAI_API_KEY).toBe('nc-codex-token-v1');
    const chatgpt = JSON.parse(codexPlaceholder('chatgpt'));
    expect(chatgpt.tokens.access_token).toBe('nc-codex-token-v1');
    expect(chatgpt.tokens.refresh_token).toBe('');
    expect(chatgpt.tokens.account_id).toBe('nc-codex-token-v1');
    expect(chatgpt.tokens.id_token.split('.')).toHaveLength(3);
  });

  it('mounts only a read-only synthetic Codex file scoped to the agent group', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'iron-codex-mount-'));
    const configured = { ...readIronProxySettings({}, projectRoot), managed: true };
    try {
      fs.mkdirSync(path.dirname(configured.identityKey), { recursive: true });
      fs.writeFileSync(configured.identityKey, Buffer.alloc(32, 7));
      const metadata = path.join(projectRoot, 'data/session-materials/iron-control/codex.json');
      fs.mkdirSync(path.dirname(metadata), { recursive: true });
      fs.writeFileSync(metadata, JSON.stringify({ mode: 'chatgpt', secretIds: ['private-id'] }));
      const contribution = ironProxyContribution(configured, input);
      const auth = contribution.mounts!.find((mount) => mount.containerPath.endsWith('/auth.json'))!;
      expect(auth).toMatchObject({ class: 'group-state', mode: 'ro', groupScope: 'group' });
      expect(auth.hostPath).toBe(path.join(projectRoot, 'data/v2-sessions/group/.iron-codex/auth.json'));
      expect(fs.readFileSync(auth.hostPath, 'utf8')).not.toContain('private-id');
      expect(contribution.mounts!.some((mount) => mount.hostPath.includes('session-materials'))).toBe(false);
      expect(() =>
        ironProxyContribution(configured, {
          ...input,
          key: { ...input.key, agentGroupId: '../escape' },
        }),
      ).toThrow('Invalid agent group ID');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('keeps stock managed credentials separate from the immutable approval front', () => {
    const config = parseYaml(ironProxyConfig({ ...settings, managed: true }));
    const front = JSON.parse(ironFrontConfig({ ...settings, managed: true }));
    expect(config.transforms).toEqual([]);
    expect(config.control_plane).toBeUndefined();
    expect(config.proxy.tunnel_listen).toBe('127.0.0.1:18080');
    expect(config.proxy.upstream_deny_cidrs).toContain('127.0.0.0/8');
    expect(config.proxy.upstream_deny_cidrs).toContain('::1/128');
    expect(front.backend).toBe('http://127.0.0.1:18080');
    expect(front.identity_key).toBe('/run/secrets/workload-identity-key');
    expect(front.summary_command).toBe('/usr/local/bin/gateway-approval-summary');
    expect(JSON.stringify(config)).not.toContain('/run/secrets/upstream');
    expect(front).toEqual(JSON.parse(ironFrontConfig(settings)));
  });

  it('uses the configured port for the front listener and agent URL only', () => {
    const configured = readIronProxySettings({ NANOCLAW_IRON_PROXY_PORT: '18081' }, root);
    fs.mkdirSync(path.dirname(configured.identityKey), { recursive: true });
    fs.writeFileSync(configured.identityKey, Buffer.alloc(32, 7));
    try {
      expect(JSON.parse(ironFrontConfig(configured)).listen).toBe(':18081');
      expect(parseYaml(ironProxyConfig(configured)).proxy.tunnel_listen).toBe('127.0.0.1:18080');
      expect(new URL(ironProxyContribution(configured, input).env!.HTTPS_PROXY).port).toBe('18081');
    } finally {
      fs.rmSync(path.join(materialRoot, 'iron-proxy'), { recursive: true, force: true });
    }
  });

  it('uses client certificates for the macOS front approval transport', () => {
    expect(JSON.parse(ironFrontConfig({ ...settings, approvalPort: 20392 }))).toMatchObject({
      approval_target: 'host.docker.internal:20392',
      approval_cert: '/run/secrets/approval-client.crt',
      approval_key: '/run/secrets/approval-client.key',
    });
  });

  it('uses only upstream secret configuration without any patched transforms', () => {
    const config = parseYaml(ironProxyConfig(settings));
    expect(config.transforms.map((entry: { name: string }) => entry.name)).toEqual(['secrets']);
    expect(config.transforms[0].config.secrets[0].source.path).toBe('/run/secrets/upstream');
    const front = JSON.parse(ironFrontConfig(settings));
    expect(front.approval_target).toBe('unix:///run/nanoclaw-gateway/approval.sock');
    expect(front.allowed_hosts).toContain(settings.modelHost);
  });

  it('routes through the central proxy with a signed session identity', () => {
    fs.mkdirSync(path.dirname(settings.identityKey), { recursive: true });
    fs.writeFileSync(settings.identityKey, Buffer.alloc(32, 7));
    const contribution = ironProxyContribution(settings, input);
    expect(contribution.networkAccess).toEqual({
      endpoint: 'iron-proxy',
      target: { kind: 'runtime', identity: settings.containerName },
    });
    expect(contribution.mounts).toEqual([
      {
        class: 'gateway-trust',
        hostPath: settings.agentCaCert,
        containerPath: '/run/nanoclaw-iron-proxy-ca.crt',
        mode: 'ro',
        groupScope: 'group',
      },
    ]);
    expect(contribution.containers).toBeUndefined();
    expect(contribution.env).toMatchObject({
      ANTHROPIC_API_KEY: 'gateway-managed',
      NODE_EXTRA_CA_CERTS: '/run/nanoclaw-iron-proxy-ca.crt',
    });
    expect(contribution.env?.HTTPS_PROXY).toMatch(
      /^http:\/\/workload:iw1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+@iron-proxy:8080$/,
    );
    fs.rmSync(path.join(materialRoot, 'iron-proxy'), { recursive: true, force: true });
  });

  it('keeps its Unix socket portable for long checkout paths', async () => {
    const projectRoot = path.join(os.tmpdir(), 'checkout', 'nested'.repeat(20));
    const configured = readIronProxySettings({ NANOCLAW_IRON_PROXY_IMAGE: digest }, projectRoot);
    const { statePaths } = await import(
      pathToFileURL(path.resolve('.claude/skills/add-iron-proxy/scripts/setup.ts')).href
    );
    expect(Buffer.byteLength(configured.approvalSocket)).toBeLessThanOrEqual(100);
    expect(path.relative(os.tmpdir(), configured.approvalSocket)).not.toMatch(/^\.\./);
    expect(statePaths(projectRoot).approvalSocket).toBe(configured.approvalSocket);
    expect(statePaths(projectRoot).approvalDir).toBe(configured.approvalDir);
  });

  it('uses one idempotent ensure and releases per-session state on abort', async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), 'ip-'));
    const liveSettings: IronProxySettings = {
      ...settings,
      materialRoot: path.join(project, 'materials'),
      caCert: path.join(project, 'materials/iron-proxy/shared/ca.crt'),
      caKey: path.join(project, 'materials/iron-proxy/shared/ca.key'),
      secretFile: path.join(project, 'materials/iron-proxy/shared/upstream-secret'),
      configFile: path.join(project, 'materials/iron-proxy/shared/config.yaml'),
      identityKey: path.join(project, 'materials/iron-proxy/shared/workload-identity.key'),
      containerName: 'nanoclaw-iron-proxy-live',
      approvalDir: path.join(project, 'materials/iron-proxy/approval'),
      approvalSocket: path.join(project, 'materials/iron-proxy/approval/approval.sock'),
      allowedHostsFile: path.join(project, 'materials/iron-proxy/shared/allowed-hosts.json'),
      agentCaCert: path.join(project, 'data/gateway-trust/iron-proxy/ca.crt'),
    };
    for (const file of [
      liveSettings.caCert,
      liveSettings.caKey,
      liveSettings.secretFile,
      liveSettings.configFile,
      liveSettings.identityKey,
      liveSettings.agentCaCert,
    ]) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, file === liveSettings.identityKey ? Buffer.alloc(32, 9) : 'test');
    }

    const provider = defineIronProxyProvider(liveSettings);
    const approvalController = new AbortController();
    const subscription = provider.approvals.subscribe(async () => 'deny', approvalController.signal);
    const firstController = new AbortController();
    await provider.sessions.ensure(input, firstController.signal);
    firstController.abort();

    const secondController = new AbortController();
    const second = await provider.sessions.ensure(input, secondController.signal);

    const unavailable = vi.fn();
    second.onUnavailable?.(unavailable);
    fs.rmSync(liveSettings.secretFile);
    await vi.waitFor(() => expect(unavailable).toHaveBeenCalled(), { timeout: 3_000 });
    secondController.abort();

    approvalController.abort();
    await subscription;
    fs.rmSync(project, { recursive: true, force: true });
  });
});
