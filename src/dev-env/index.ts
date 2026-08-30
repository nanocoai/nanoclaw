/**
 * Dev-env wiring: migration + lifecycle registration and driver selection.
 *
 * Selection mirrors the session driver's, with one deliberate difference:
 * there is NO default kind. An install that never sets
 * `NANOCLAW_DEV_ENV_DRIVER` runs no dev-env machinery at all — the seam ships
 * dormant until a driver overlay lands (the k8s driver arrives in T3; the mock
 * registers only from test wiring). A configured kind with no registered
 * driver still throws, uniformly: a host configured for a runtime it cannot
 * run is an operator error, not a fallback opportunity.
 */
import { INSTALL_SLUG } from '../config.js';
import type { DbDriver } from '../db/driver.js';
import { registerMigration } from '../db/migrations/index.js';
import { configuredDriverKind } from '../drivers/index.js';
import { readEnvFile } from '../env.js';
import { onHostShutdown, onHostStart } from '../host-lifecycle.js';
import { controllerPlane } from '../modules/process-split/role.js';
import { log } from '../log.js';

import { wireClaimReadinessPush } from './claim-notify.js';
import { claimantSessionMigration, devEnvMigration, envFailureReasonMigration, reservedOwnerRefMigration } from './db.js';
import { getDevEnvDriverFactory, listDevEnvDriverKinds } from './driver-registry.js';
import { envExposuresDropEnvIndexMigration, envExposuresMigration } from './exposure.js';
import { getExposureProviderFactory, listExposureProviderKinds } from './exposure-provider.js';
import { EnvExposureService, wireExposurePush } from './exposure-service.js';
// Side-effect import: registers the v1 `tailnet` exposure provider. A second
// provider (the `dns` one C7 needs) lands beside it the same way — registration,
// never selection editing, and the grant model never learns it exists.
import './exposure-tailnet.js';
import { gatewayImageResolver, type ImageResolver } from './image-resolve.js';
// Side-effect import: the barrel driver overlays append their registration to.
import './installed.js';
import { configuredDevEnvDriverKind } from './materials.js';
import { DevEnvService } from './service.js';
import { StampImageStore, stampImagesMigration } from './stamp-images.js';
import { StampPlacementReconciler, makeStampImageGate, wireStampPlacementPush } from './stamp-placement.js';
import {
  RegistryStampSource,
  StampRegistryStore,
  readPools,
  stampRegistryMigration,
  type PoolReading,
} from './stamp-registry.js';
import { BUILTIN_STAMPS } from './stamps.js';
import type { DevEnvDriver, DevEnvDriverCapabilities } from './types.js';

registerMigration(devEnvMigration);
registerMigration(reservedOwnerRefMigration);
registerMigration(stampRegistryMigration);
registerMigration(envFailureReasonMigration);
registerMigration(claimantSessionMigration);
registerMigration(stampImagesMigration);
registerMigration(envExposuresMigration);
registerMigration(envExposuresDropEnvIndexMigration);

/**
 * Everything the stamps CLI surface needs in one handle: the C12 store +
 * source, the C15 placement ledger, the create-time resolver (ruling 1: it
 * rides the governed egress path), and the driver's capabilities — a THUNK,
 * because the registry is built before the driver so the factory can take the
 * source, and capability answers must come from the driver that actually
 * registered (null = no driver yet, refuse nothing on capability grounds).
 */
export interface StampRegistryHandle {
  store: StampRegistryStore;
  source: RegistryStampSource;
  images: StampImageStore;
  resolveImage: ImageResolver;
  driverCapabilities: () => DevEnvDriverCapabilities | null;
  /**
   * The pool's observed half, keyed by stamp — a thunk for the same reason
   * `driverCapabilities` is. `unpooled` covers both "no driver yet" and "a
   * driver that pools nothing"; `unreadable` is kept apart from them on
   * purpose (see `PoolReading`), because a runtime nobody could reach is not
   * a runtime holding nothing.
   */
  observePools: () => PoolReading;
}

let service: DevEnvService | null = null;
let stampRegistry: StampRegistryHandle | null = null;
let placement: StampPlacementReconciler | null = null;
/**
 * The registered driver. Shutdown reads it to stop what `ensureReady` started;
 * the registry's `driverCapabilities` / `observePools` thunks and the stamp
 * source's node-image probe read it lazily, because all three are built BEFORE
 * the driver (the factory takes the source) and must answer from the driver
 * that actually registered. Driver SELECTION never reads it.
 */
let exposures: EnvExposureService | null = null;
/** Held only so shutdown can stop what `ensureReady` started; selection never reads it. */
let driver: DevEnvDriver | null = null;

/** Null when no driver is configured — dev-env is off and callers must cope. */
export function getDevEnvService(): DevEnvService | null {
  return service;
}

/**
 * The C14 exposure surface (`ncl envs expose`). Null when dev-env is off OR
 * when no exposure provider is configured: exposing a port is a hole in a
 * perimeter, so it ships OFF and an install opts in by naming a provider —
 * the same dormant discipline the driver seam itself uses.
 */
export function getEnvExposureService(): EnvExposureService | null {
  return exposures;
}

/** Test seam. */
export function resetEnvExposureService(next: EnvExposureService | null = null): void {
  exposures = next;
}

/**
 * The stamps registry (C12) — rides the same on/off switch as the service: a
 * dormant seam registers stamps nobody could ever claim, so the CLI answers
 * "dev-env is off" instead of pretending.
 */
export function getStampRegistry(): StampRegistryHandle | null {
  return stampRegistry;
}

/** Test seam. */
export function resetDevEnvService(next: DevEnvService | null = null): void {
  service = next;
}

/** Test seam. */
export function resetStampRegistry(next: StampRegistryHandle | null = null): void {
  stampRegistry = next;
}

/**
 * The claimant namespace the service passes at claim (D19): where this
 * install's agent session pods live, or undefined when they are not
 * netpol-governed pods at all.
 *
 * Gated on the configured session-driver KIND, exceptionally — the capability
 * that would express "my sessions are pods in namespace X" does not exist on
 * the session seam, and growing it would put a placement concept on every
 * driver for one consumer. 'pod' is the kind trunk already names as the
 * documented overlay driver (driver-selection.test.ts pins the refusal), so
 * the string is trunk's to read. The key and its 'agents' default mirror
 * `podNamespace()` in the overlay's pod-driver.ts, which trunk cannot import;
 * both read process.env before `.env` — the precedence whose absence was a
 * measured deployment bug on the k8s driver knobs.
 */
export function devEnvClaimantNamespace(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (configuredDriverKind(env) !== 'pod') return undefined;
  return (
    env.NANOCLAW_POD_NAMESPACE?.trim() ||
    readEnvFile(['NANOCLAW_POD_NAMESPACE']).NANOCLAW_POD_NAMESPACE?.trim() ||
    'agents'
  );
}

/**
 * Which exposure provider carries names to browsers on this install (C14), or
 * empty when none does. Same on/off discipline as the driver kind, and for a
 * sharper reason: an exposure is a hole in a perimeter, so the surface ships
 * OFF and an install OPTS IN by naming a provider. A named kind nothing
 * registered still throws — a host configured for a transport it cannot run
 * is an operator error, not a fallback opportunity.
 */
export function configuredExposureProviderKind(env: NodeJS.ProcessEnv = process.env): string {
  const key = 'NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER';
  return (env[key]?.trim() || readEnvFile([key])[key]?.trim() || '').toLowerCase();
}

onHostStart(async (ctx) => {
  if (!controllerPlane()) return;
  const kind = configuredDevEnvDriverKind();
  if (!kind) return;
  const factory = getDevEnvDriverFactory(kind);
  if (!factory) {
    throw new Error(
      `NANOCLAW_DEV_ENV_DRIVER='${kind}' but no dev-env driver is registered for '${kind}'; ` +
        `installed: ${listDevEnvDriverKinds().join(', ') || '(none)'}. ` +
        'Drivers arrive as overlays — install the driver skill or unset the variable.',
    );
  }
  // The stamps registry (C12): rows join the driver's static table through
  // the source's snapshot; the store refuses ids the code-provided table
  // owns. Built before the driver so the factory can hand the source over.
  // The C15 image ledger rides the same construction: the source snapshot
  // carries placement rows, and the claim gate below reads the same stores.
  const images = new StampImageStore(ctx.db);
  const store = new StampRegistryStore(ctx.db, () => Object.keys(BUILTIN_STAMPS));
  // Declared BEFORE the source: the node-image probe is the driver's, and the
  // driver is built from the source — so the thunk reads the MODULE binding
  // below, lazily, the same way `driverCapabilities` and `observePools` do.
  const probeNodeImages = (refs: string[]): Promise<string[]> =>
    driver?.missingNodeImages?.(refs) ?? Promise.resolve([]);
  const source = new RegistryStampSource(
    store,
    (stampId, error) =>
      log.warn('Dev-env: registered stamp failed validation; excluded from the table', { stamp: stampId, error }),
    images,
    // Null until a driver that answers the question is registered; a driver
    // without the verb leaves every nodeImages assertion ungated (declared).
    () => (driver?.missingNodeImages ? probeNodeImages : null),
  );
  stampRegistry = {
    store,
    source,
    images,
    resolveImage: gatewayImageResolver(),
    // Both thunks read lazily off the module binding below: the registry is
    // built BEFORE the driver so the factory can take its source, and a
    // capability or pool answer must come from the driver that actually
    // registered.
    driverCapabilities: () => driver?.capabilities() ?? null,
    observePools: () => readPools(driver),
  };
  const selected = factory({ installScope: INSTALL_SLUG, stampSource: source });
  driver = selected;
  // AFTER the binding is assigned, not before: the boot snapshot is the one
  // the first pool reconcile and the first claim read, and a refresh taken
  // while `driver` was still null would answer every node-image assertion
  // "unchecked" — the gate silently absent for its first cycle. The factory
  // itself only stores the source (its reads are lazy), so nothing between
  // here and there needed a populated snapshot.
  await source.refresh();
  await selected.ensureReady?.();
  service = new DevEnvService({
    db: ctx.db,
    driver: selected,
    installScope: INSTALL_SLUG,
    claimantNamespace: devEnvClaimantNamespace(),
    // Provenance: which approved definition a claim's stamp id means right
    // now — null for code-provided stamps, which the registry never shadows.
    resolveStampVersion: async (stampId) =>
      stampId in BUILTIN_STAMPS ? null : (await store.get(stampId))?.version ?? null,
    // The C15 approve-to-place gate: a pull-origin stamp is claimable exactly
    // while its current version's image row says `placed` (refusals answer in
    // seconds with the state, never as a boot timeout).
    imageGate: makeStampImageGate({
      registry: store,
      images,
      reservedIds: () => Object.keys(BUILTIN_STAMPS),
      codeProvided: (stampId) => BUILTIN_STAMPS[stampId],
      probeNodeImages,
    }),
  });
  // The D18 readiness push: claim completions reach the CLAIMING session on
  // the same system-message path approvals answer held commands over. Wired
  // BEFORE adopt(), so a claim that settles during adoption — including one
  // failed because its instance did not survive the restart — is still told.
  wireClaimReadinessPush(service);
  // The placement reconciler (C15), beside the pool reconciler in spirit:
  // pending image rows place through the driver's verb; completions notify
  // the registering session over the SAME push transport. adopt() first —
  // `placing` rows cannot survive a host death and must fail loudly before
  // the interval could mistake one for in-flight work.
  placement = new StampPlacementReconciler({
    images,
    registry: store,
    driver: selected,
    installScope: INSTALL_SLUG,
    source,
  });
  wireStampPlacementPush(placement);
  await placement.adopt();
  placement.start(ctx.signal);
  // Boot-scoped marker, same reasoning as the session driver's: a crash-looping
  // unit reports `active`, and this line is how an operator tells the loops apart.
  log.info('Dev-env driver selected', { driver: selected.kind, capabilities: selected.capabilities() });
  await service.adopt();
  service.startReaper(ctx.signal);
  exposures = startExposures(ctx.db, service, ctx.signal);
  // Heal AFTER the env adopt: pending grants realize against instances the
  // env adoption has just re-attached, and strays are attributed against a
  // ledger that already knows which envs survived.
  await exposures?.heal();
});

/**
 * The C14 exposure surface, when an install has opted into one. Kept beside
 * the claim wiring rather than inside it because exposure is a HOST/box
 * concern: the provider carries a name over a transport the cluster knows
 * nothing about, and C8's non-k8s drivers will want the same one.
 */
function startExposures(db: DbDriver, envs: DevEnvService, signal: AbortSignal): EnvExposureService | null {
  const kind = configuredExposureProviderKind();
  if (!kind) return null;
  const factory = getExposureProviderFactory(kind);
  if (!factory) {
    throw new Error(
      `NANOCLAW_DEV_ENV_EXPOSURE_PROVIDER='${kind}' but no exposure provider is registered for '${kind}'; ` +
        `installed: ${listExposureProviderKinds().join(', ') || '(none)'}. Unset the variable to keep exposure off.`,
    );
  }
  const provider = factory({ installScope: INSTALL_SLUG });
  const unavailable = provider.unavailableReason?.();
  if (unavailable) {
    // Boot-time honesty: a provider that cannot serve says so HERE, so a
    // missing wire-host step is an operator's line in the log rather than an
    // agent's refused grant hours later.
    log.warn('Dev-env exposure: provider configured but not usable on this box; grants will refuse', {
      provider: provider.kind,
      reason: unavailable,
    });
  } else {
    log.info('Dev-env exposure provider selected', { provider: provider.kind });
  }
  const exposureService = new EnvExposureService({ db, envs, provider });
  exposureService.wireLifecycle();
  // Unasked transitions reach the requesting session on the claim push's
  // transport (#223): one notification mechanism, three subscribers.
  wireExposurePush(exposureService);
  exposureService.start(signal);
  return exposureService;
}

onHostShutdown(() => {
  service?.stopReaper();
  placement?.stop();
  // stop() drops the process's relays; it is NOT a revocation — the grants
  // survive the restart and heal rebuilds them from the rows. Before the
  // driver goes, because a relay is pointed at an instance the driver owns.
  exposures?.stop();
  // The driver's own background work stops here too. Until this line the seam
  // had no sanctioned stop at all: every driver with a subscription process
  // (a pod watch, a `docker events` stream) leaked one past shutdown, which
  // is a child per host restart and a test runner that never drains.
  try {
    driver?.dispose?.();
  } catch (error) {
    log.warn('Dev-env: driver dispose failed at shutdown', { error: String(error) });
  }
  driver = null;
  placement = null;
  service = null;
  exposures = null;
  stampRegistry = null;
});

export * from './types.js';
export * from './driver-registry.js';
// Resolved in materials.ts so the mount composer can ask "is dev-env on, and
// where does its material live?" without importing this barrel's side effects.
export { configuredDevEnvDriverKind, devEnvMaterialsRoot, materialsPath } from './materials.js';
export {
  BUILTIN_STAMPS,
  INSTANCE_TOKEN,
  STAMP_IDENTITY_EXAMPLE,
  fullyQualifiedImageRef,
  imageRefDigest,
  isIdentityEnvKey,
  readinessGates,
  stampImageOrigin,
  substituteInstance,
  validateStampEntry,
  type AppStampSpec,
  type K8sStampConfig,
  type StampBuildSpec,
  type StampImageOrigin,
  type StampReadiness,
} from './stamps.js';
export { StampRegistryStore, RegistryStampSource, readPools, stampRegistryMigration } from './stamp-registry.js';
export type {
  NodeImageProbe,
  NodeImageStatus,
  PoolObservation,
  PoolObserver,
  PoolReading,
  StampRow,
  StampSource,
  StampState,
} from './stamp-registry.js';
export { StampImageStore, imageGateNoRecord, imageGateRefusal, placeRef, stampImagesMigration } from './stamp-images.js';
export type { StampImageRow, StampImageState } from './stamp-images.js';
export { StampPlacementReconciler, makeStampImageGate, wireStampPlacementPush } from './stamp-placement.js';
export type { StampPlacementEvent } from './stamp-placement.js';
export { gatewayImageResolver, pinImageConfig } from './image-resolve.js';
export type { ImageResolver } from './image-resolve.js';
export { DevEnvService } from './service.js';
export type { ClaimRequest, DevEnvEvent, DevEnvServiceConfig, EnvEndingHook, EnvSnapshot } from './service.js';
export {
  EnvExposureStore,
  EXPOSURE_REVOKE_CAUSES,
  assertExposureName,
  defaultExposureName,
  envExposuresMigration,
  exposureIsLive,
} from './exposure.js';
export type { ExposureRevokeCause, ExposureRow, ExposureState } from './exposure.js';
export {
  exposureRefusal,
  isExposureRefusal,
  listExposureProviderKinds,
  registerExposureProvider,
} from './exposure-provider.js';
export type {
  ExposureBinding,
  ExposureDialer,
  ExposureDraft,
  ExposureGrant,
  ExposureProvider,
  ExposureProviderConfig,
} from './exposure-provider.js';
export { EnvExposureService, grantOf, wireExposurePush } from './exposure-service.js';
export type { ExposeRequest, ExposureEvent } from './exposure-service.js';
export { TAILNET_EXT_PORT, TailnetExposureProvider, tailnetConfigFromEnv } from './exposure-tailnet.js';
export { DevEnvStore, devEnvMigration } from './db.js';
export type { EnvRow, EnvState, InstanceState, ReleaseCause } from './db.js';
