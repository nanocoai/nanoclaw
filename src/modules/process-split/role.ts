/**
 * Boot role — which plane this process is.
 *
 * Recipes overlay module (process-split skill): the OSS trunk is a single
 * process forever; the role vocabulary exists only in composed enterprise
 * trees. `NANOCLAW_ROLE` selects the plane:
 *
 *   - 'all' (or unset) — one process, every plane. Byte-identical to the
 *     un-split host: every plane predicate is true and the cross-plane
 *     machinery never engages.
 *   - 'gateway'    — channel adapters, inbound routing, outbound delivery
 *     drain + guard, approval cards, typing. Never touches containers or the
 *     runtime API; its wake path writes durable wake signals.
 *   - 'controller' — session driver + container lifecycle, reconcile/sweep,
 *     scheduling, the ncl socket server, workspace init, migrations. Owns
 *     every container.
 *
 * A wrong value fails the boot: half a plane is worse than no process.
 */
import fs from 'fs';

export type HostRole = 'all' | 'gateway' | 'controller';

function parseRole(raw: string | undefined): HostRole {
  const role = raw || 'all';
  if (role === 'all' || role === 'gateway' || role === 'controller') return role;
  throw new Error(`NANOCLAW_ROLE must be 'all', 'gateway', or 'controller' (got '${raw}')`);
}

export const HOST_ROLE: HostRole = parseRole(process.env.NANOCLAW_ROLE);

/** This process serves the gateway plane (adapters, routing, delivery). */
export function gatewayPlane(): boolean {
  return HOST_ROLE !== 'controller';
}

/** This process serves the controller plane (containers, reconcile, cli). */
export function controllerPlane(): boolean {
  return HOST_ROLE !== 'gateway';
}

/** True only in the split gateway process — the plane with no container access. */
export function isSplitGateway(): boolean {
  return HOST_ROLE === 'gateway';
}

/** True only in the split controller process. */
export function isSplitController(): boolean {
  return HOST_ROLE === 'controller';
}

/**
 * The split gateway's readiness signal. The controller plane is probed by
 * connecting to the ncl socket it binds; the gateway binds nothing, so its
 * boot writes this marker once every gateway subsystem is up and the
 * Deployment's readiness probe stats it. /tmp is a per-incarnation emptyDir
 * in the pod, so a marker can never go stale across restarts. No-op outside
 * the split gateway process.
 */
export const GATEWAY_READY_MARKER = '/tmp/nanoclaw-gateway-ready';

export function markGatewayReady(): void {
  if (!isSplitGateway()) return;
  fs.writeFileSync(GATEWAY_READY_MARKER, new Date().toISOString());
}
