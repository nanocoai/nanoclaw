/**
 * Registration side-effect module for the docker dev-env driver. Imported by
 * installed.ts; selected with NANOCLAW_DEV_ENV_DRIVER=docker.
 *
 * Imports only types + the registry — importing the dev-env index from here
 * would be circular (index imports installed imports this).
 *
 * Driver shape comes from environment, all optional:
 *   NANOCLAW_DEV_ENV_DOCKER_STAMPS       JSON map of stampId -> stamp config;
 *     unset means the built-in stamp table. Setting it REPLACES that table.
 *     Entries are the shared stamp config ({app: …}); a childManifests entry
 *     constructs fine and is refused at CLAIM, because the refusal that a
 *     manifest stream has no docker meaning belongs to the claim path until
 *     the seam grows a shape capability (see the driver).
 *   NANOCLAW_DEV_ENV_DOCKER_PROBE_IMAGE  node-local image the readiness
 *     prober runs from; defaults to the ref the builtin app stamp already
 *     requires to be present.
 *   NANOCLAW_DEV_ENV_DOCKER_BOOT_TIMEOUT_MS  first-boot budget, ms.
 *
 * NOTE the knob PREFIX. Every dev-env knob beside `NANOCLAW_DEV_ENV_DRIVER`
 * was spelled `..._K8S_...`, including the one shared file (`materials.ts`)
 * that no driver owns. These are named for the driver that reads them, which
 * is what the k8s ones meant to be.
 */
import { readEnvFile } from '../env.js';

import { DockerDevEnvDriver, type K8sStampConfig } from './docker-driver.js';
import { registerDevEnvDriver } from './driver-registry.js';

/**
 * process.env first, then `.env` — the same precedence `NANOCLAW_DEV_ENV_DRIVER`
 * itself resolves under. Reading only process.env was a real deployment bug on
 * the k8s knobs, and a quiet one: the driver was selected from `.env` while
 * every knob beside it read undefined.
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

function stampsFromEnv(): Record<string, K8sStampConfig> | undefined {
  const raw = jsonEnv<Record<string, unknown>>('NANOCLAW_DEV_ENV_DOCKER_STAMPS');
  if (!raw) return undefined;
  for (const [id, entry] of Object.entries(raw)) {
    // Named, because the alternative is not: the driver's constructor would
    // throw a bare TypeError on a primitive entry, naming neither the key nor
    // the rule. This driver is new, so there is no legacy app-spec grammar to
    // unwrap — the current shape is the only shape.
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`NANOCLAW_DEV_ENV_DOCKER_STAMPS entry '${id}' must be a JSON object`);
    }
  }
  return raw as Record<string, K8sStampConfig>;
}

function positiveIntEnv(name: string): number | undefined {
  const raw = envValue(name);
  if (!raw) return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number of milliseconds`);
  return value;
}

registerDevEnvDriver('docker', (config) => {
  return new DockerDevEnvDriver({
    installScope: config.installScope,
    stampSource: config.stampSource,
    stamps: stampsFromEnv(),
    probeImage: envValue('NANOCLAW_DEV_ENV_DOCKER_PROBE_IMAGE'),
    bootTimeoutMs: positiveIntEnv('NANOCLAW_DEV_ENV_DOCKER_BOOT_TIMEOUT_MS'),
  });
});
