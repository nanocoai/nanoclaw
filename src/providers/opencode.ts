/**
 * Host-side container config for the `opencode` provider.
 *
 * OpenCode's `opencode serve` process stores state under XDG_DATA_HOME, which
 * we pin to a per-session host directory mounted at /opencode-xdg. The
 * OPENCODE_* env vars tell the CLI which provider/model/endpoint to use at
 * runtime, injected into the container. They are read from the .env FILE
 * (this host keeps .env out of process.env — see env.ts), falling back to a
 * real environment var. NO_PROXY / no_proxy are merged with host values so the
 * in-container OpenCode client can reach 127.0.0.1 and a host-side router via
 * host.docker.internal even when HTTPS_PROXY is set by OneCLI.
 */
import fs from 'fs';
import path from 'path';

import { readEnvFile } from '../env.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const OPENCODE_ENV_KEYS = [
  'OPENCODE_PROVIDER',
  'OPENCODE_MODEL',
  'OPENCODE_SMALL_MODEL',
  // Upstream endpoint for a non-anthropic provider (e.g. a local LiteLLM
  // router). Deliberately its own var, NOT ANTHROPIC_BASE_URL: the Claude SDK
  // reads that one, so sharing it misroutes a Claude fallback turn.
  'OPENCODE_BASE_URL',
] as const;

function mergeNoProxy(current: string | undefined, additions: string): string {
  if (!current?.trim()) return additions;
  const parts = new Set(
    current
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  );
  for (const addition of additions.split(',')) {
    const trimmed = addition.trim();
    if (trimmed) parts.add(trimmed);
  }
  return [...parts].join(',');
}

registerProviderContainerConfig('opencode', (ctx) => {
  const opencodeDir = path.join(ctx.sessionDir, 'opencode-xdg');
  fs.mkdirSync(opencodeDir, { recursive: true });

  const dotenv = readEnvFile([...OPENCODE_ENV_KEYS]);

  const env: Record<string, string> = {
    XDG_DATA_HOME: '/opencode-xdg',
    // host.docker.internal included so calls to a host-side router (e.g. a
    // LiteLLM endpoint via OPENCODE_BASE_URL) bypass the OneCLI HTTPS_PROXY hop
    // instead of being dropped ("socket connection closed unexpectedly").
    NO_PROXY: mergeNoProxy(ctx.hostEnv.NO_PROXY, '127.0.0.1,localhost,host.docker.internal'),
    no_proxy: mergeNoProxy(ctx.hostEnv.no_proxy, '127.0.0.1,localhost,host.docker.internal'),
  };
  for (const key of OPENCODE_ENV_KEYS) {
    const value = dotenv[key] || ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: opencodeDir, containerPath: '/opencode-xdg', readonly: false }],
    env,
  };
});
