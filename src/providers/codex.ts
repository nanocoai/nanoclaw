/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private codex dir for config.toml (which the in-container provider
 * rewrites on every wake), but the host's auth.json is bind-mounted directly
 * on top of it.
 *
 * Why bind-mount auth.json instead of copying it: ChatGPT OAuth uses
 * single-use rotating refresh tokens. When a container refreshes its access
 * token, the new refresh token has to reach the host file so the NEXT codex
 * spawn picks it up — otherwise every subsequent spawn copies a stale auth
 * and fails with `refresh_token_reused`. The mount lets the container's
 * in-place writes propagate back to the host.
 *
 * Env passthrough covers the two knobs that are read at runtime:
 *   OPENAI_API_KEY  — fallback auth when auth.json isn't a subscription token
 *   CODEX_MODEL     — model override if the user wants something other than the default
 *   OPENAI_BASE_URL — rare, but supports API-compatible alternates
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig, type VolumeMount } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  const mounts: VolumeMount[] = [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }];

  // Bind-mount host's auth.json directly on top of the per-session codex dir.
  // Docker requires the source file to exist; if the user hasn't run
  // `codex login` yet there's nothing to mount and the container will fall
  // back to OPENAI_API_KEY (or fail loudly if neither is configured).
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      mounts.push({
        hostPath: hostAuth,
        containerPath: '/home/node/.codex/auth.json',
        readonly: false,
      });
    }
  }

  const env: Record<string, string> = {};
  for (const key of ['OPENAI_API_KEY', 'CODEX_MODEL', 'OPENAI_BASE_URL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return { mounts, env };
});
