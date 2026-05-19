/**
 * Host-side container config for the `codex` provider.
 *
 * Codex reads auth and MCP config from ~/.codex. We give each session its
 * own private copy of that directory so:
 *
 * - The user's host ~/.codex/auth.json reaches the container without us
 *   touching their host config.toml (which the host's own `codex` CLI
 *   might be using).
 * - The in-container provider can rewrite config.toml freely on every
 *   wake with container-appropriate MCP server paths, without racing
 *   other sessions or leaking per-session paths back to the host.
 *
 * Auth modes:
 *   - Subscription / native: auth.json is copied from ~/.codex and mounted
 *     into the container (file mount, no plaintext secret in env).
 *   - API-key: handled entirely by the credential resolver. When the resolver
 *     returns `{ kind: 'gateway_secret', providerId: 'openai' }`,
 *     `applyCredentialDecisions` sets OPENAI_BASE_URL=<gateway> and
 *     OPENAI_API_KEY=placeholder in the container env. This provider must NOT
 *     pass through OPENAI_API_KEY or OPENAI_BASE_URL from hostEnv — doing so
 *     would override the placeholder set by the resolver and leak the real key
 *     into the container environment (merge order: provider contribution wins).
 *
 * Only CODEX_MODEL is passed through (it is not a secret).
 */
import fs from 'fs';
import path from 'path';

import { registerProviderContainerConfig } from './provider-container-registry.js';

registerProviderContainerConfig('codex', (ctx) => {
  const codexDir = path.join(ctx.sessionDir, 'codex');
  fs.mkdirSync(codexDir, { recursive: true });

  // Copy the host's auth.json into the per-session dir if it exists.
  // We only copy auth.json, not the full ~/.codex — config.toml would
  // get clobbered by the container on every wake anyway.
  const hostHome = ctx.hostEnv.HOME;
  if (hostHome) {
    const hostAuth = path.join(hostHome, '.codex', 'auth.json');
    if (fs.existsSync(hostAuth)) {
      fs.copyFileSync(hostAuth, path.join(codexDir, 'auth.json'));
    }
  }

  const env: Record<string, string> = {};
  for (const key of ['CODEX_MODEL'] as const) {
    const value = ctx.hostEnv[key];
    if (value) env[key] = value;
  }

  return {
    mounts: [{ hostPath: codexDir, containerPath: '/home/node/.codex', readonly: false }],
    env,
  };
});
