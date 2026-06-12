/**
 * Supply-chain release-age gate for agent-requested npm packages.
 *
 * Mirrors the host's pnpm `minimumReleaseAge` policy (pnpm-workspace.yaml):
 * a package version must have existed on the registry for at least 3 days
 * before it may be installed into an agent container. Fails closed —
 * unresolvable packages are reported and the caller blocks the install.
 */
const NPM_REGISTRY = 'https://registry.npmjs.org';

/** 3 days in ms — matches `minimumReleaseAge: 4320` (minutes) in pnpm-workspace.yaml. */
export const DEFAULT_RELEASE_AGE_MS = 4320 * 60 * 1000;

export interface ResolvedPkg {
  name: string;
  version: string;
  publishedAt: string | null;
}

export interface ReleaseAgeResult {
  resolved: ResolvedPkg[];
  violations: ResolvedPkg[]; // verified but under threshold and not overridden
  unverifiable: string[]; // registry lookup or version resolution failed
}

/** Split a package spec into name + optional version. Handles `@scope/name[@version]`. */
export function parseSpec(spec: string): { name: string; version: string | null } {
  const at = spec.lastIndexOf('@');
  if (at <= 0) return { name: spec, version: null };
  return { name: spec.slice(0, at), version: spec.slice(at + 1) };
}

export async function checkNpmReleaseAge(
  specs: string[],
  opts: { thresholdMs: number; overrides: string[]; now?: number; fetchImpl?: typeof fetch },
): Promise<ReleaseAgeResult> {
  const now = opts.now ?? Date.now();
  const doFetch = opts.fetchImpl ?? fetch;
  const overrides = new Set(opts.overrides);

  const resolved: ResolvedPkg[] = [];
  const violations: ResolvedPkg[] = [];
  const unverifiable: string[] = [];

  for (const spec of specs) {
    const { name, version } = parseSpec(spec);
    type NpmMeta = { 'dist-tags'?: { latest?: string }; time?: Record<string, string> };
    let meta: NpmMeta | null = null;
    try {
      const res = await doFetch(`${NPM_REGISTRY}/${encodeURIComponent(name).replace('%40', '@')}`);
      if (res.ok) meta = (await res.json()) as NpmMeta;
    } catch {
      meta = null;
    }

    if (!meta) {
      unverifiable.push(spec);
      continue;
    }

    const v = version ?? meta['dist-tags']?.latest;
    const publishedAt = v && meta.time ? (meta.time[v] ?? null) : null;
    if (!v || !publishedAt) {
      unverifiable.push(spec);
      continue;
    }

    const pkg: ResolvedPkg = { name, version: v, publishedAt };
    resolved.push(pkg);

    const pinned = `${name}@${v}`;
    if (overrides.has(pinned) || overrides.has(spec)) continue; // explicit human-pinned exemption

    if (now - new Date(publishedAt).getTime() < opts.thresholdMs) {
      violations.push(pkg);
    }
  }

  return { resolved, violations, unverifiable };
}
