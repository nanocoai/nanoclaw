/**
 * Where access material lives, resolved in ONE place.
 *
 * Two sides have to agree on this arithmetic and they run in different worlds:
 * the driver MINTS a child kubeconfig to a host path and hands it out by
 * reference (`ncl envs get` prints it), and the host MOUNTS the claiming
 * sandbox's slice of that tree at the same absolute path, so the path the
 * agent is told to use is a path the agent can open. A second implementation of
 * the layout anywhere would not fail loudly — it would print a valid-looking
 * path at a file that is not there.
 *
 * The layout is per-OWNER on purpose: `<root>/<scope>/<instanceId>/kubeconfig`.
 * A child kubeconfig is cluster-admin of that child, so one owner's material
 * must not be reachable from another's sandbox. Per-owner directories are what
 * make the mount a SLICE — mounting the root would hand every group every other
 * group's children.
 *
 * The driver-kind resolver lives here too, for the same reason: composition
 * needs to know whether dev-env is on at all, and importing the service barrel
 * to ask would drag migration and host-lifecycle registration into the mount
 * composer.
 */
import { createHash } from 'node:crypto';
import path from 'node:path';

import { DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';

const DRIVER_ENV_KEY = 'NANOCLAW_DEV_ENV_DRIVER';
const MATERIALS_ENV_KEY = 'NANOCLAW_DEV_ENV_K8S_MATERIALS';
/** The k8s label-value bound: a slug is written onto the runtime, not just onto disk. */
const MAX_SLUG = 63;
const DIGEST_LEN = 8;

/** process.env first, then `.env` — the precedence every dev-env knob resolves under. */
function envValue(name: string, env: NodeJS.ProcessEnv): string | undefined {
  return env[name]?.trim() || readEnvFile([name])[name]?.trim() || undefined;
}

/** Empty when no driver is configured: dev-env ships dormant, and callers cope. */
export function configuredDevEnvDriverKind(env: NodeJS.ProcessEnv = process.env): string {
  return (envValue(DRIVER_ENV_KEY, env) ?? '').toLowerCase();
}

export function devEnvMaterialsRoot(env: NodeJS.ProcessEnv = process.env): string {
  const configured = envValue(MATERIALS_ENV_KEY, env);
  return configured ? path.resolve(configured) : path.join(DATA_DIR, 'dev-env');
}

/**
 * A path segment that is safe on a filesystem, legal as a k8s label value, and
 * COLLISION-FREE: anything the sanitizer had to change carries a digest of the
 * original, so `a/b` and `a-b` cannot land in one directory and share their
 * children's credentials. Idempotent — a slug slugs to itself, which is what
 * lets the driver store one on the runtime and re-derive paths from it.
 */
export function materialsScopeSlug(scope: string): string {
  const cleaned = scope
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/[^a-z0-9]+$/, '');
  if (cleaned === scope && cleaned.length > 0 && cleaned.length <= MAX_SLUG) return cleaned;
  // 54 + '-' + 8 == 63: the truncated form has to stay inside the label bound
  // too, because the driver writes this slug onto the runtime as a label
  // value. Truncating AFTER appending the digest would emit 72 and make the
  // whole claim unrealizable.
  const digest = createHash('sha256').update(scope).digest('hex').slice(0, DIGEST_LEN);
  return `${(cleaned || 'scope').slice(0, MAX_SLUG - DIGEST_LEN - 1)}-${digest}`;
}

/** The owner's whole slice, or one instance's directory inside it. */
export function materialsPath(root: string, scope: string, instanceId?: string): string {
  const dir = path.join(root, materialsScopeSlug(scope));
  return instanceId === undefined ? dir : path.join(dir, materialsScopeSlug(instanceId));
}

/**
 * The scope a claim that named no owner mints under. Driver-side the seam field
 * is optional (the mock ignores it entirely), and adopted instances from before
 * the per-owner layout carry no scope either — they re-mint here, which the
 * missing-file heal path already does for free.
 */
export const UNSCOPED_MATERIALS = 'unscoped';
