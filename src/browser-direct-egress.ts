/**
 * Direct browser egress — a deliberate, per-group hole in the egress perimeter.
 *
 * ## Why this exists
 *
 * Agent containers sit on a Docker `--internal` network (`egress-lockdown.ts`)
 * whose only hop off-box is the OneCLI gateway, and every client in the
 * container is pointed at it through `HTTPS_PROXY`. That gateway is not a
 * general internet proxy: it is a credential-injection proxy that is
 * deny-by-default, so a request to a host nobody configured a connection or
 * secret for comes back as `resolution_failed`. Today the only configured host
 * is `api.anthropic.com` — which is how the container gets its own model
 * credential — so `agent-browser` can reach essentially nothing.
 *
 * `chromium-ca-policy.ts` fixed the CERT half of that (Chromium now trusts the
 * gateway's interception CA). This module addresses the other half, and it does
 * so by giving up a perimeter property rather than by widening the gateway:
 * the container gets a SECOND network attachment with a real route to the
 * internet, and the browser — and only the browser — is launched with the proxy
 * variables stripped, so its traffic takes that route.
 *
 * ## What is actually given up
 *
 * Be honest about the blast radius. Docker networking is per-container, not
 * per-process: attaching the second network gives the WHOLE container a default
 * route. Everything else keeps using the gateway because its env still says to
 * — not because it is still confined. For an opted-in group the proxy becomes
 * advisory rather than enforced, and a `curl --noproxy '*'` inside that one
 * container reaches the internet with no credential injection, no rule
 * evaluation and no audit trail. That is the cost of the feature, it is why it
 * is opt-in per group and operator-only to set, and it is written down in
 * `docs/SECURITY.md` §7 rather than hidden here.
 *
 * Nothing changes for a group that has not opted in: `nanoclaw-egress` stays
 * `--internal` for everyone, and a container with the flag off never sees this
 * network, this mount, or this PATH entry.
 *
 * ## The mechanism, in three parts
 *
 * 1. A normal (NOT `--internal`) bridge network, created on demand and attached
 *    to the container in addition to `nanoclaw-egress`. `egressNetworkArgs()`
 *    still supplies `--network`; Docker's `create` takes only one, so the second
 *    attachment is a `docker network connect` between create and start — which
 *    is exactly the window `DockerSessionDriver.prepare` owns.
 * 2. A shim named `agent-browser`, mounted read-only, that unsets the proxy
 *    variables and `exec`s the real launcher at `/pnpm/agent-browser`. It
 *    delegates rather than reimplements, so pnpm's own `NODE_PATH` wiring and
 *    the pinned version in `container/cli-tools.json` stay authoritative.
 * 3. A PATH prefix put in place by PID 1's own shell (`export PATH=<dir>:$PATH`)
 *    instead of a container-wide `-e PATH=...`. The image puts `/pnpm` FIRST in
 *    PATH, so the shim has to precede it — and computing the new value inside
 *    the container means the host never has to restate what the image's PATH is.
 *    Every descendant of PID 1 (agent-runner → provider CLI → its Bash tool →
 *    `agent-browser`) inherits it.
 *
 * One consequence of doing it in PID 1's shell rather than as a container-wide
 * `-e PATH=...`: `docker exec` into the container does NOT see it — exec builds
 * its environment from the container's configured env, not from PID 1's. So an
 * operator debugging by hand gets the gateway-proxied browser, while every
 * process the agent actually runs gets the shim. That asymmetry is the safe
 * direction (hand-debugging is the narrower, not the wider, capability) and it
 * is the price of not having the host restate the image's PATH.
 *
 * The shim strips the proxy on EVERY invocation, not only the one that starts
 * agent-browser's daemon. That is deliberate and was verified against the real
 * CLI: a later invocation carrying `HTTPS_PROXY` makes the browser use the proxy
 * again even when the daemon was started without it, so "unset it once at daemon
 * start" would be a fix that silently comes undone.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { BROWSER_EGRESS_NETWORK, DATA_DIR } from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import type { MountSpec } from './drivers/types.js';
import { log } from './log.js';

export { BROWSER_EGRESS_NETWORK };

/** Host directory holding the generated shim. Install-wide: the file carries no group data. */
export const BROWSER_SHIM_HOST_DIR = path.join(DATA_DIR, 'browser-direct-egress');

/** Directory the shim is mounted into, and the PATH entry that makes it win over `/pnpm`. */
export const BROWSER_SHIM_CONTAINER_DIR = '/opt/nanoclaw/browser-direct-egress';

/** Where the real, pnpm-installed launcher lives in the agent image (see container/Dockerfile). */
const REAL_AGENT_BROWSER = '/pnpm/agent-browser';

/**
 * Proxy variables the shim clears. Both cases are listed because the gateway
 * contribution sets both (`HTTPS_PROXY` and `https_proxy`), and Chromium reads
 * the lowercase ones natively on Linux. `NODE_USE_ENV_PROXY` goes too: it is
 * what tells agent-browser's own Node half to honor the env proxy.
 */
const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'NODE_USE_ENV_PROXY',
] as const;

/** The shim's contents. A constant, not a template — nothing group-supplied reaches it. */
export const BROWSER_SHIM_SCRIPT = `#!/bin/sh
# Generated by NanoClaw (src/browser-direct-egress.ts). Do not edit.
#
# This group opted into direct browser egress: the container carries a second
# network attachment with a real internet route, and the browser is the one
# process meant to use it. Everything else in the container keeps the
# container-wide proxy env pointing at the OneCLI gateway, untouched.
unset ${PROXY_ENV_KEYS.join(' ')}
exec ${REAL_AGENT_BROWSER} "$@"
`;

/**
 * Write the shim and return the read-only mount that carries it.
 *
 * Classed `allowlisted-extra` because that is what a path under `data/` can be
 * (`classRequiredByPath` pins only the materials and install-surface roots) —
 * the read-only mode is stated here rather than enforced by the class, so keep
 * it `ro`: this is code the agent executes.
 */
export function browserShimMount(agentGroupId: string, hostDir: string = BROWSER_SHIM_HOST_DIR): MountSpec {
  const hostPath = path.join(hostDir, 'agent-browser');
  fs.mkdirSync(hostDir, { recursive: true });
  fs.writeFileSync(hostPath, BROWSER_SHIM_SCRIPT, { mode: 0o755 });
  // A pre-existing file keeps its old mode through writeFileSync, and a shim
  // that is not executable fails as "permission denied" from inside a `--rm`
  // container with no logs. Restate it.
  fs.chmodSync(hostPath, 0o755);
  return {
    class: 'allowlisted-extra',
    hostPath,
    containerPath: `${BROWSER_SHIM_CONTAINER_DIR}/agent-browser`,
    mode: 'ro',
    groupScope: agentGroupId,
  };
}

/**
 * PID 1's argv with the shim directory prepended to PATH.
 *
 * Computed inside the container (`$PATH` is the image's own) so the host never
 * restates the image's PATH — a container-wide `-e PATH=...` would have to, and
 * would silently drift the day the Dockerfile changes.
 */
export function withBrowserShimOnPath(args: string[]): string[] {
  return args.map((arg) => `export PATH="${BROWSER_SHIM_CONTAINER_DIR}:$PATH"; ${arg}`);
}

/** Raised when a group opted into direct browser egress but the network cannot be established. */
export class BrowserEgressError extends Error {
  constructor(reason: string) {
    super(
      `Direct browser egress is enabled for this agent group but ${reason}. ` +
        `Refusing to start a container that would silently browse nowhere. ` +
        `Fix the container runtime, or turn the flag off with ` +
        `\`ncl groups config set-browser-egress --id <group-id> --enabled false\`.`,
    );
    this.name = 'BrowserEgressError';
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

/**
 * Ensure the direct-egress network exists, as a NORMAL bridge — never
 * `--internal`. Idempotent. Throws `BrowserEgressError` rather than letting a
 * container start believing it has a route it does not.
 */
export function ensureBrowserEgressNetwork(): void {
  if (dockerOk(['network', 'inspect', BROWSER_EGRESS_NETWORK])) return;
  if (dockerOk(['network', 'create', BROWSER_EGRESS_NETWORK])) {
    log.info('Direct browser egress: network created', { network: BROWSER_EGRESS_NETWORK });
    return;
  }
  // Lost a create race with a concurrent spawn? Then it exists now.
  if (dockerOk(['network', 'inspect', BROWSER_EGRESS_NETWORK])) return;
  throw new BrowserEgressError(`the "${BROWSER_EGRESS_NETWORK}" bridge network could not be created`);
}
