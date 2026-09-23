/**
 * Egress lockdown — force ALL agent traffic through the OneCLI gateway.
 * Agents run on a Docker `--internal` network (no internet route) with the
 * gateway attached as host.docker.internal and gateway, so the injected proxy
 * is the only reachable hop across OneCLI versions. Non-root, no NET_ADMIN —
 * the agent can't undo it.
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

/** Does the existing attachment expose every proxy hostname OneCLI may emit? */
function gatewayHasProxyAliases(): boolean {
  try {
    const out = execFileSync(CONTAINER_RUNTIME_BIN, ['inspect', ONECLI_GATEWAY_CONTAINER], {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 15000,
    });
    const inspected = JSON.parse(out) as Array<{
      NetworkSettings?: { Networks?: Record<string, { Aliases?: string[] }> };
    }>;
    const aliases = inspected[0]?.NetworkSettings?.Networks?.[EGRESS_NETWORK]?.Aliases ?? [];
    return aliases.includes('host.docker.internal') && aliases.includes('gateway');
  } catch {
    return false;
  }
}

/**
 * Ensure the egress network exists with the OneCLI gateway attached under both
 * proxy hostnames OneCLI emits. Idempotent + self-healing. Returns false when lockdown
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

  if (gatewayAttached() && gatewayHasProxyAliases()) return true;

  // Older NanoClaw versions attached only host.docker.internal. Docker cannot
  // mutate aliases on an existing endpoint, so replace just this attachment;
  // the gateway remains up on its own sandbox network throughout.
  if (gatewayAttached() && !dockerOk(['network', 'disconnect', EGRESS_NETWORK, ONECLI_GATEWAY_CONTAINER])) {
    throw new EgressLockdownError(`the stale OneCLI gateway attachment on "${EGRESS_NETWORK}" could not be refreshed`);
  }

  if (dockerOk(gatewayNetworkConnectArgs()) && gatewayAttached() && gatewayHasProxyAliases()) {
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

/** Docker argv for attaching OneCLI to the locked-down session network. */
export function gatewayNetworkConnectArgs(): string[] {
  return [
    'network',
    'connect',
    '--alias',
    'host.docker.internal',
    '--alias',
    'gateway',
    EGRESS_NETWORK,
    ONECLI_GATEWAY_CONTAINER,
  ];
}

/** CLI args placing a container on the locked-down egress network. */
export function egressNetworkArgs(): string[] {
  return ['--network', EGRESS_NETWORK];
}
