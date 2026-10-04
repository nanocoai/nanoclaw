/**
 * Persistence for `agent-browser`'s own credential vault and session state
 * across container restarts — and the per-group key that encrypts both at
 * rest. `agent-browser` already implements the vault (`auth save`/`auth
 * login`) and session persistence (`--session-name`) natively; this module
 * only keeps its state directory from being lost to `docker create --rm`
 * and gives each group's vault its own encryption key.
 *
 * Opt-in via the SAME flag as direct browser egress
 * (`container_configs.direct_browser_egress`) — there is no separate flag.
 * A group with no real internet route has nothing here worth persisting.
 */
import { randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from './config.js';
import type { MountSpec } from './drivers/types.js';

/** Container path confirmed against the real image in Task 1 Step 1 — HOME=/home/node when `runAs` maps a non-root uid (see composeSessionSpec). */
const AGENT_BROWSER_HOME = '/home/node/.agent-browser';

/** Host directory holding the per-group encryption keys. Never mounted — read host-side only, into `contributedEnv`. */
export const AGENT_BROWSER_KEY_HOST_DIR = path.join(DATA_DIR, 'agent-browser-keys');

export function agentBrowserStateMount(agentGroupId: string, dataRoot: string = DATA_DIR): MountSpec {
  const hostPath = path.join(dataRoot, 'v2-sessions', agentGroupId, 'agent-browser-state');
  fs.mkdirSync(hostPath, { recursive: true });
  return {
    class: 'group-state',
    hostPath,
    containerPath: AGENT_BROWSER_HOME,
    mode: 'rw',
    groupScope: agentGroupId,
  };
}

/**
 * One key per group, generated once and reused forever. A 64-char hex
 * string never matches `looksLikeCredential`'s issuer-prefix patterns, so it
 * is safe to carry in `contributedEnv` (the sanctioned lane) despite the
 * `AGENT_BROWSER_ENCRYPTION_KEY` name ending in `_KEY` — `validateSpec`
 * only name-checks plain `env`, never `contributedEnv`.
 */
export function agentBrowserEncryptionKey(agentGroupId: string, hostDir: string = AGENT_BROWSER_KEY_HOST_DIR): string {
  fs.mkdirSync(hostDir, { recursive: true });
  const keyPath = path.join(hostDir, `${agentGroupId}.key`);
  if (fs.existsSync(keyPath)) return fs.readFileSync(keyPath, 'utf-8').trim();
  const key = randomBytes(32).toString('hex');
  fs.writeFileSync(keyPath, key, { mode: 0o600 });
  return key;
}
