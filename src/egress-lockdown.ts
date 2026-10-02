/**
 * Egress lockdown — force all agent traffic through the selected gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 */
import { execFileSync } from 'child_process';

import { EGRESS_LOCKDOWN, EGRESS_NETWORK } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import type { NetworkAccessIntent } from './drivers/types.js';
import { log } from './log.js';

// Perimeter knobs (locked-down network, gateway container, on/off flag) are read
// via config.ts so they honor .env under the shipped service, not just process.env.
export { EGRESS_NETWORK };

// The sweep re-heals the last selected gateway after its container is restarted.
let selectedAccess: NetworkAccessIntent | undefined;

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(`Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. Refusing to spawn with open egress.`);
    this.name = 'EgressLockdownError';
  }
}

function dockerOk(args: string[]): boolean {
  try {
    execFileSync(CONTAINER_RUNTIME_BIN, args, { stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** Is the selected gateway currently attached to the egress network? */
function gatewayAttached(identity: string): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(identity);
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the selected gateway attached.
 * Idempotent + self-healing. Returns false when lockdown
 * is disabled (caller uses the host gateway), true when it's active. Throws
 * EgressLockdownError when enabled but unestablishable — fail fast rather than
 * spawn an agent with open egress.
 */
export function ensureEgressNetwork(access = selectedAccess): boolean {
  if (!EGRESS_LOCKDOWN) return false;
  if (!access) return false;
  selectedAccess = access;
  if (access.target.kind !== 'runtime') {
    throw new EgressLockdownError(`the selected gateway target '${access.target.kind}' cannot join a locked network`);
  }

  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached(access.target.identity)) return true;

  if (
    dockerOk(['network', 'connect', '--alias', access.endpoint, EGRESS_NETWORK, access.target.identity]) &&
    gatewayAttached(access.target.identity)
  ) {
    log.info('Egress lockdown: gateway attached', {
      network: EGRESS_NETWORK,
      gateway: access.target.identity,
      endpoint: access.endpoint,
    });
    return true;
  }

  throw new EgressLockdownError(
    `gateway target "${access.target.identity}" could not be attached to "${EGRESS_NETWORK}"`,
  );
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
