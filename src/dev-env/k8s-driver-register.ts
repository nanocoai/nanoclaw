/**
 * Registration side-effect module for the k8s dev-env driver (D11: the seam's
 * first real implementation). Imported by installed.ts; selected with
 * NANOCLAW_DEV_ENV_DRIVER=k8s.
 *
 * Imports only types + the registry — importing the dev-env index from here
 * would be circular (index imports installed imports this).
 *
 * Driver shape comes from environment, all optional:
 *   NANOCLAW_DEV_ENV_K8S_PREFIX        namespace prefix (default nanoclaw-dev)
 *   NANOCLAW_DEV_ENV_K8S_STAMPS       JSON map of stampId -> stamp config; unset
 *     means the built-in stamp table (BUILTIN_STAMPS). Setting it REPLACES
 *     that table. Entries are K8sStampConfig ({app: …} and/or
 *     {childManifests, readiness}); an entry with neither is a bare vcluster,
 *     which is a legal stamp. Legacy entries that ARE an app spec
 *     ({image, port, …}) still parse — they wrap as {app: …}.
 *   NANOCLAW_DEV_ENV_K8S_POOLS        JSON map of stampId -> warm slot count
 *   NANOCLAW_DEV_ENV_K8S_MATERIALS    kubeconfig materials dir
 *   NANOCLAW_DEV_ENV_K8S_HOST_SUBJECT JSON RBAC subject; when set, the driver
 *     mints a Role+RoleBinding for it into every instance namespace (the
 *     narrow-cluster-grant posture — object permissions stay namespace-scoped)
 *   NANOCLAW_DEV_ENV_K8S_PLACEMENT_PROXY     the gateway proxy registry pulls
 *     ride (C15, ruling 1). Placement is refused with the gateway-egress
 *     reason while unset — nothing pulls around the gateway.
 *   NANOCLAW_DEV_ENV_K8S_PLACER_IMAGE        node-present placer image; set
 *     together with the proxy or not at all (a half-wired placement is a
 *     boot-time config error, not a per-row mystery)
 *   NANOCLAW_DEV_ENV_K8S_PLACEMENT_PROXY_CA  node path of the gateway CA
 *   NANOCLAW_DEV_ENV_K8S_CONTAINERD_SOCK     node containerd socket (default
 *     the k3s path — see k8s-place.ts)
 */
import { readEnvFile } from '../env.js';
import { configuredParentGovernedDevEnvRelay } from '../nanoco/dev-env-relay.js';

import { registerDevEnvDriver } from './driver-registry.js';
import { K8sDevEnvDriver, type K8sAccessSubject, type K8sStampConfig } from './k8s-driver.js';
import type { PlacementEgress } from './k8s-place.js';
import type { AppStampSpec } from './stamps.js';

/**
 * process.env first, then `.env` — the same precedence `NANOCLAW_DEV_ENV_DRIVER`
 * itself resolves under. Reading only process.env here was a real deployment
 * bug, and a quiet one: the driver was selected from `.env` while every knob
 * beside it read undefined, so a configured pool silently never filled.
 */
function envValue(name: string): string | undefined {
  return process.env[name]?.trim() || readEnvFile([name])[name]?.trim() || undefined;
}

function jsonEnv<T>(name: string): T | undefined {
  const raw = envValue(name);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new Error(`${name} is not valid JSON: ${String(error)}`);
  }
}

/**
 * `NANOCLAW_DEV_ENV_K8S_STAMPS` predates `childManifests`: a legacy entry IS
 * the app spec. `image` is the discriminator — required on AppStampSpec,
 * absent from every K8sStampConfig shape — so a legacy entry wraps as
 * `{app: …}` and current shapes pass through byte-identical. The refusals are
 * named because the alternative is not: `in` on a primitive entry throws a
 * bare TypeError at registration, and an entry mixing the two grammars would
 * wrap WHOLE — its childManifests/readiness silently discarded, past the
 * constructor refusals that exist to catch exactly that config lie.
 */
function normalizeStamps(
  raw: Record<string, K8sStampConfig | AppStampSpec> | undefined,
): Record<string, K8sStampConfig> | undefined {
  if (!raw) return undefined;
  return Object.fromEntries(
    Object.entries(raw).map(([id, entry]): [string, K8sStampConfig] => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        throw new Error(`NANOCLAW_DEV_ENV_K8S_STAMPS entry '${id}' must be a JSON object`);
      }
      if (!('image' in entry)) return [id, entry];
      if ('app' in entry || 'childManifests' in entry || 'readiness' in entry) {
        throw new Error(
          `NANOCLAW_DEV_ENV_K8S_STAMPS entry '${id}' mixes the legacy app-spec shape with stamp-config fields; wrap the app as {app: {image, port, …}}`,
        );
      }
      // The legacy grammar predates image origins (C15) and its meaning
      // always WAS node-local — the wrap says so explicitly, because a bare
      // qualified ref now reads as the pull origin and a code-provided table
      // cannot carry one. A CURRENT-shape entry declares its own presence.
      return [id, { app: { ...(entry as AppStampSpec), presence: 'node-local' } }];
    }),
  );
}

/**
 * Both-or-neither: a proxy without a placer image (or the reverse) is a
 * deployment that half-decided to place — refused at registration, in the
 * boot log, instead of surfacing one placement row at a time.
 */
function placementFromEnv(): PlacementEgress | undefined {
  const proxyUrl = envValue('NANOCLAW_DEV_ENV_K8S_PLACEMENT_PROXY');
  const placerImage = envValue('NANOCLAW_DEV_ENV_K8S_PLACER_IMAGE');
  if (!proxyUrl && !placerImage) return undefined;
  if (!proxyUrl || !placerImage) {
    throw new Error(
      'NANOCLAW_DEV_ENV_K8S_PLACEMENT_PROXY and NANOCLAW_DEV_ENV_K8S_PLACER_IMAGE wire placement together — set both or neither',
    );
  }
  return {
    proxyUrl,
    placerImage,
    proxyCaPath: envValue('NANOCLAW_DEV_ENV_K8S_PLACEMENT_PROXY_CA'),
    containerdSocket: envValue('NANOCLAW_DEV_ENV_K8S_CONTAINERD_SOCK'),
  };
}

registerDevEnvDriver('k8s', (config) => {
  return new K8sDevEnvDriver({
    installScope: config.installScope,
    stampSource: config.stampSource,
    namespacePrefix: envValue('NANOCLAW_DEV_ENV_K8S_PREFIX'),
    stamps: normalizeStamps(jsonEnv<Record<string, K8sStampConfig | AppStampSpec>>('NANOCLAW_DEV_ENV_K8S_STAMPS')),
    pools: jsonEnv<Record<string, number>>('NANOCLAW_DEV_ENV_K8S_POOLS'),
    materialsDir: envValue('NANOCLAW_DEV_ENV_K8S_MATERIALS'),
    hostAccessSubject: jsonEnv<K8sAccessSubject>('NANOCLAW_DEV_ENV_K8S_HOST_SUBJECT'),
    placement: placementFromEnv(),
    instanceRelay: configuredParentGovernedDevEnvRelay(),
  });
});
