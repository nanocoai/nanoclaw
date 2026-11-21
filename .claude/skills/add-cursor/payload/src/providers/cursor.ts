/**
 * Host-side container config for the `cursor` provider.
 *
 * On a contract core every agent-facing surface — the composed AGENTS.md, the
 * `.cursor-shared` state volume at ~/.cursor, and the Cursor-native skill
 * directories — is declared in src/provider-contracts/cursor.ts and realized by
 * core, which tells this adapter so through `coreOwnsProviderSurfaces`. What
 * remains here is the one thing a contract cannot declare: the environment.
 *
 * The long-lived credential stays in the vault. The container receives
 * `CURSOR_API_KEY=cursor_placeholder_nanoclaw` so `@cursor/sdk` emits an
 * Authorization header that the credential gateway rewrites on the user-key
 * exchange and model-discovery routes. Whether the vaulted value came from
 * Cursor-account sign-in or a pasted dashboard key is invisible inside the
 * container.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

/** Sentinel so the SDK always sends Authorization for the gateway to overwrite. */
export const CURSOR_API_KEY_PLACEHOLDER = 'cursor_placeholder_nanoclaw';

registerProviderContainerConfig(
  'cursor',
  (ctx) => {
    const coreOwnsProviderSurfaces = (ctx as typeof ctx & { coreOwnsProviderSurfaces?: true }).coreOwnsProviderSurfaces;
    const env = { CURSOR_API_KEY: CURSOR_API_KEY_PLACEHOLDER };
    if (coreOwnsProviderSurfaces) return { env };

    // Pre-contract core only: the per-group state directory the SDK's local
    // agent store lives in, mounted at ~/.cursor. The project document and
    // skill directories are contract surfaces and are not composed here.
    const cursorDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.cursor-shared');
    fs.mkdirSync(cursorDir, { recursive: true });
    return {
      mounts: [{ hostPath: cursorDir, containerPath: '/home/node/.cursor', readonly: false }],
      env,
    };
  },
  { providesAgentSurfaces: true },
);
