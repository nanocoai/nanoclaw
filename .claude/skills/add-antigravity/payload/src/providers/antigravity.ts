/**
 * Host-side container config for the `antigravity` provider (Google's
 * Antigravity CLI, `agy`).
 *
 * On a contract core every agent-facing surface (the composed AGENTS.md, the
 * `.gemini-shared` state volume at ~/.gemini and the skills directory inside
 * it) is declared in src/provider-contracts/antigravity.ts and realized by
 * core, which says so through `coreOwnsProviderSurfaces`. This adapter only
 * adds the environment, which a contract cannot declare.
 *
 * agy runs in Gemini API key mode. It refuses to start without a non-empty
 * GEMINI_API_KEY, but checks nothing else locally, and sends the value as the
 * `x-goog-api-key` header on every model call. The container gets a
 * placeholder; the credential gateway swaps it for the real key that setup
 * stored for generativelanguage.googleapis.com. The real key never enters the
 * container, the env or `.env`.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/**
 * Non-secret marker agy sends as its API key, matched by the gateway. Setup
 * registers the same value as the connection's `proxyValue`.
 */
export const ANTIGRAVITY_API_KEY_PLACEHOLDER = 'nc-antigravity-placeholder';

/**
 * The env every Antigravity container gets. agy's self-updater only stays off
 * when this variable is the literal string `true`; an update would replace the
 * pinned binary the image was built and verified with.
 */
export function antigravityContainerEnv(): Record<string, string> {
  return {
    GEMINI_API_KEY: ANTIGRAVITY_API_KEY_PLACEHOLDER,
    AGY_CLI_DISABLE_AUTO_UPDATE: 'true',
  };
}

registerProviderContainerConfig(
  'antigravity',
  (ctx) => {
    const coreOwnsProviderSurfaces = (ctx as typeof ctx & { coreOwnsProviderSurfaces?: true }).coreOwnsProviderSurfaces;
    const env = antigravityContainerEnv();
    if (coreOwnsProviderSurfaces) return { env };

    // Pre-contract core only: the per-group agy home (settings, MCP config,
    // rules, skills and the conversation database), mounted at ~/.gemini. The
    // project document and skill links are contract surfaces and are not
    // composed here.
    const geminiDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.gemini-shared');
    fs.mkdirSync(geminiDir, { recursive: true });
    return {
      mounts: [{ hostPath: geminiDir, containerPath: '/home/node/.gemini', readonly: false }],
      env,
    };
  },
  { providesAgentSurfaces: true },
);
