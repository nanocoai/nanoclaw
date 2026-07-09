/**
 * Egress lockdown — force ALL agent traffic through the OneCLI gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal, so the injected proxy is the only
 * reachable hop. Non-root, no NET_ADMIN — the agent can't undo it.
 *
 * Fail-fast: when the flag is on but the network/gateway can't be set up, throw
 * rather than silently spawn an agent with open egress.
 */
import { execFileSync } from 'child_process';

import { EGRESS_LOCKDOWN, EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { log } from './log.js';

// Perimeter knobs (locked-down network, gateway container, on/off flag) are read
// via config.ts so they honor .env under the shipped service, not just process.env.
export { EGRESS_NETWORK };

/** Raised when lockdown is requested but can't be established. */
export class EgressLockdownError extends Error {
  constructor(reason: string) {
    super(
      `Egress lockdown is on (NANOCLAW_EGRESS_LOCKDOWN=true) but ${reason}. ` +
        `Refusing to spawn with open egress. Start the OneCLI gateway container ` +
        `"${ONECLI_GATEWAY_CONTAINER}", or set NANOCLAW_EGRESS_LOCKDOWN=false to opt out.`,
    );
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

/** Is the OneCLI gateway currently attached to the egress network? */
function gatewayAttached(): boolean {
  try {
    const out = execFileSync(
      CONTAINER_RUNTIME_BIN,
      ['network', 'inspect', EGRESS_NETWORK, '--format', '{{range .Containers}}{{.Name}} {{end}}'],
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 15000 },
    );
    return out.split(/\s+/).includes(ONECLI_GATEWAY_CONTAINER);
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the OneCLI gateway attached (aliased
 * host.docker.internal). Idempotent + self-healing. Returns false when lockdown
 * is disabled (caller uses the host gateway), true when it's active. Throws
 * EgressLockdownError when enabled but unestablishable — fail fast rather than
 * spawn an agent with open egress.
 */
export function ensureEgressNetwork(): boolean {
  if (!EGRESS_LOCKDOWN) return false;

  if (
    !dockerOk(['network', 'inspect', EGRESS_NETWORK]) &&
    !dockerOk(['network', 'create', '--internal', EGRESS_NETWORK])
  ) {
    throw new EgressLockdownError(`the "${EGRESS_NETWORK}" internal network could not be created`);
  }

  if (gatewayAttached()) return true;

  if (
    dockerOk(['network', 'connect', '--alias', 'host.docker.internal', EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER]) &&
    gatewayAttached()
  ) {
    log.info('Egress lockdown: OneCLI gateway attached', {
      network: EGRESS_NETWORK,
      gateway: ONECLI_GATEWAY_CONTAINER,
    });
    return true;
  }

  throw new EgressLockdownError(
    `the OneCLI gateway "${ONECLI_GATEWAY_CONTAINER}" could not be attached to "${EGRESS_NETWORK}"`,
  );
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
