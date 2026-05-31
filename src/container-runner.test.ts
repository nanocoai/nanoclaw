import fs from 'fs';
import os from 'os';
import path from 'path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const oneCliMocks = vi.hoisted(() => ({
  applyContainerConfig: vi.fn(() => Promise.resolve(true)),
  ensureAgent: vi.fn(() => Promise.resolve(undefined)),
}));

vi.mock('@onecli-sh/sdk', () => ({
  OneCLI: class {
    applyContainerConfig = oneCliMocks.applyContainerConfig;
    ensureAgent = oneCliMocks.ensureAgent;
  },
}));

import type { ContainerConfig } from './container-config.js';
import { buildContainerArgs, buildContainerRuntimeEnv, resolveProviderName } from './container-runner.js';
import type { ProviderContainerContribution, VolumeMount } from './providers/provider-container-registry.js';
import type { AgentGroup } from './types.js';

const testGroup: AgentGroup = {
  id: 'agent-group-1',
  name: 'Main',
  folder: 'main',
  agent_provider: null,
  created_at: '2026-05-31T00:00:00.000Z',
};

const testConfig: ContainerConfig = {
  mcpServers: {},
  packages: { apt: [], npm: [] },
  additionalMounts: [],
  skills: [],
};

const noMounts: VolumeMount[] = [];
const noContribution: ProviderContainerContribution = {};

function buildSyntheticProxyUrl(password: string): string {
  return ['http://', 'sample-user', ':', password, '@', 'p.webshare.io', ':80'].join('');
}

describe('resolveProviderName', () => {
  it('prefers session over container config', () => {
    expect(resolveProviderName('codex', 'claude')).toBe('codex');
  });

  it('falls back to container config when session is null', () => {
    expect(resolveProviderName(null, 'opencode')).toBe('opencode');
  });

  it('defaults to claude when nothing is set', () => {
    expect(resolveProviderName(null, undefined)).toBe('claude');
  });

  it('lowercases the resolved name', () => {
    expect(resolveProviderName('CODEX', null)).toBe('codex');
    expect(resolveProviderName(null, 'Claude')).toBe('claude');
  });

  it('treats empty string as unset (falls through)', () => {
    expect(resolveProviderName('', 'opencode')).toBe('opencode');
    expect(resolveProviderName(null, '')).toBe('claude');
  });
});

describe('buildContainerArgs sidecar wiring', () => {
  beforeEach(() => {
    oneCliMocks.applyContainerConfig.mockClear();
    oneCliMocks.ensureAgent.mockClear();
    delete process.env.HTTP_PROXY_URL;
  });

  it('preserves image entrypoint for container sidecar startup', async () => {
    const args = await buildContainerArgs(
      noMounts,
      'nanoclaw-test',
      testGroup,
      testConfig,
      'claude',
      noContribution,
      testGroup.id,
    );

    expect(args).not.toContain('--entrypoint');
    expect(args).not.toContain('bash');
    expect(args).not.toContain('-c');
    expect(args).not.toContain('exec bun run /app/src/index.ts');
  });

  it('injects container-managed cf fetch sidecar defaults and key-only proxy env', async () => {
    const password = 'sample-' + 'pass';
    const proxyKey = 'HTTP_PROXY_URL';
    const proxyUrl = buildSyntheticProxyUrl(password);
    process.env[proxyKey] = proxyUrl;

    const args = await buildContainerArgs(
      noMounts,
      'nanoclaw-test',
      testGroup,
      testConfig,
      'claude',
      noContribution,
      testGroup.id,
    );

    expect(args).toContain('CF_FETCH_SIDECAR_URL=http://127.0.0.1:8765');
    expect(args).toContain('CF_FETCH_SIDECAR_ENABLED=1');
    expect(args).toContain('HTTP_PROXY_URL');
    expect(args).not.toContain(process.env.HTTP_PROXY_URL);
    expect(args.join('\n')).not.toContain(password);

    const runtimeEnv = buildContainerRuntimeEnv();
    expect(runtimeEnv.HTTP_PROXY_URL).toBe(process.env.HTTP_PROXY_URL);
  });

  it('ignores HTTP_PROXY_URL in .env so proxy secrets only come from the parent process env', async () => {
    const oldCwd = process.cwd();
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-proxy-env-'));
    const password = 'dotenv-' + 'pass';
    const proxyUrl = buildSyntheticProxyUrl(password);
    fs.writeFileSync(path.join(tempDir, '.env'), `HTTP_PROXY_URL=${proxyUrl}\n`);
    delete process.env.HTTP_PROXY_URL;

    try {
      process.chdir(tempDir);
      vi.resetModules();
      const freshModule = await import('./container-runner.js');
      const args = await freshModule.buildContainerArgs(
        noMounts,
        'nanoclaw-test',
        testGroup,
        testConfig,
        'claude',
        noContribution,
        testGroup.id,
      );

      expect(args).not.toContain('HTTP_PROXY_URL');
      expect(args.join('\n')).not.toContain(password);
      expect(freshModule.buildContainerRuntimeEnv().HTTP_PROXY_URL).toBeUndefined();
    } finally {
      process.chdir(oldCwd);
      fs.rmSync(tempDir, { recursive: true, force: true });
      vi.resetModules();
    }
  });
});

describe('sidecar secret and readiness guards', () => {
  it('does not allow HTTP_PROXY_URL in the dotenv config allowlist', () => {
    const configSource = fs.readFileSync(path.join(process.cwd(), 'src', 'config.ts'), 'utf-8');
    const allowlistMatch = configSource.match(/readEnvFile\(\[([\s\S]*?)\]\)/);

    expect(allowlistMatch?.[1] ?? '').not.toContain('HTTP_PROXY_URL');
  });

  it('requires the entrypoint health check to prove the nodriver backend is ready', () => {
    const entrypointSource = fs.readFileSync(path.join(process.cwd(), 'container', 'entrypoint.sh'), 'utf-8');

    expect(entrypointSource).toContain('backend');
    expect(entrypointSource).toContain('nodriver');
    expect(entrypointSource).toContain('browser_ready');
  });

  it('strips ambient proxy env from the sidecar while preserving HTTP_PROXY_URL for Webshare', () => {
    const entrypointSource = fs.readFileSync(path.join(process.cwd(), 'container', 'entrypoint.sh'), 'utf-8');

    expect(entrypointSource).toContain('-u HTTP_PROXY');
    expect(entrypointSource).toContain('-u HTTPS_PROXY');
    expect(entrypointSource).toContain('-u ALL_PROXY');
    expect(entrypointSource).not.toContain('-u HTTP_PROXY_URL');
  });
});
