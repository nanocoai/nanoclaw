/**
 * The exposure provider seam (C14) — how a NAME reaches a browser.
 *
 * Host-side, at the service layer, deliberately NOT in the k8s driver:
 * transport is box/world knowledge, not cluster knowledge, and the non-k8s
 * drivers that follow will need exposure too. Four operations, each
 * rebuildable from the ledger row alone, which is what makes adoption a
 * replay rather than a memory.
 *
 * ONE obligation binds every provider, forced by the frozen-instance rule:
 * **dial the target by resolution, never by memory.** Post-first-ready the
 * child is the agent's world — delete and recreate the app's Service and the
 * syncer re-mints the parent Service under a NEW ClusterIP, and the freed
 * address can be reissued to any later Service on the cluster, including
 * another group's env. An address written down at grant time is a memory that
 * can silently come to mean someone else, on a LIVE env, with no ending to
 * hook revocation to. So no provider stores an address: it holds an
 * `ExposureDialer` and asks, per connection, and a MISS refuses the
 * connection instead of dialing a memory.
 *
 * A provider that cannot honestly carry a name REFUSES — loudly, with a named
 * reason, at grant. Never a silent no-op, and never a URL that does not serve.
 */
import type { ExposureRow } from './exposure.js';
import type { ExposureTargetResolution } from './types.js';

/** What the grant model asks a provider to carry, before the row exists. */
export interface ExposureDraft {
  name: string;
  envId: string;
  /** The service as frozen at grant — resolved once, then never re-guessed. */
  service: string;
  port: number;
  /**
   * Whether the TARGET serves TLS on that port.
   *
   * A property of the target, PROBED once at grant against the address the
   * driver has just resolved, then frozen exactly like the service is so every
   * later reassert dials the same way. A provider that proxies at the HTTP
   * layer has to be told: it does not discover the backend's scheme, and
   * getting it wrong is an empty 502 that says nothing about schemes while the
   * target answers perfectly when probed directly.
   *
   * Optional on the type rather than required, because a provider that carries
   * plain TCP has no use for the answer and a draft may be built without one;
   * absent means plaintext, which is what every row written before this key
   * existed meant.
   */
  backendTls?: boolean;
}

/**
 * A granted exposure, as a provider sees it: the ledger row's own fields.
 * `providerDetail` is the provider's private column — the grant model writes
 * whatever `reportUrl` returned and never reads inside it.
 */
export interface ExposureGrant extends ExposureDraft {
  exposureId: string;
  url: string;
  providerDetail: Record<string, string>;
}

/**
 * Resolve the target's address NOW, or null for a MISS (service renamed away,
 * deleted, the port no longer served, the instance not there). Null is
 * fail-closed by contract: a provider that dials on null is dialing a memory.
 */
export type ExposureDialer = () => Promise<ExposureTargetResolution | null>;

/** A grant plus its live resolution — the pair every realize/heal works from. */
export interface ExposureBinding {
  grant: ExposureGrant;
  dial: ExposureDialer;
}

export interface ExposureProvider {
  /** Identity for the card, the row and the logs — never a branch. */
  readonly kind: string;
  /**
   * The URL this name means under this provider, plus whatever the provider
   * needs recorded to rebuild that answer later (the tailnet provider's ext
   * port). Stateable BEFORE the row exists and CONSTANT for the exposure's
   * life: the requester's own answer carries a literal URL, the ledger records
   * it once, and no later call may change it. (It is not on the admin card —
   * that is rendered from the command frame, before this is ever called.)
   *
   * `history` is every row this provider ever wrote, live ones first and
   * ended ones least-recently-revoked first — the allocation record, handed
   * over as history so the grant model never has to understand it.
   *
   * REFUSES (throws) when this box cannot serve the name at all: a granted
   * row carrying a URL that can never serve is intent-first ordering violated.
   */
  reportUrl(draft: ExposureDraft, history: ExposureRow[]): { url: string; detail: Record<string, string> };
  /**
   * Bring the name live against the target. Idempotent — adoption calls it
   * from the row with no other state — and it must never write down the
   * address `dial` returns.
   */
  realize(binding: ExposureBinding): Promise<{ url: string }>;
  /** Tear the transport down. Must not require the env to still exist. */
  revoke(grant: ExposureGrant): Promise<void>;
  /**
   * Reconcile provider state against the live grants BOTH ways: re-assert
   * missing realizations, close strays it can ATTRIBUTE, touch nothing it
   * cannot (the sweepOrphanRoutes posture). Attribution is the provider's
   * problem — a recorded port range, a zone — and the grant model only hands
   * it the live rows. Runs at adopt and on the reaper tick.
   *
   * `bindings` is the COMPLETE live set, every time — never one env's rows,
   * never a filtered slice. That is what entitles a provider to read an
   * absence as a stray, so a partial call would not be a smaller heal: it
   * would be an instruction to close every exposure it left out. No partial
   * form exists; a caller with one env in hand reconciles the whole set.
   */
  heal(bindings: ExposureBinding[]): Promise<void>;
  /**
   * Why this deployment cannot carry an exposure at all, or null when it can
   * — the same sentence `reportUrl` would refuse a grant with, asked at BOOT.
   * An operator learns from the boot log that a wire-host step is missing;
   * without it the first news is an agent's refused grant, hours later.
   */
  unavailableReason?(): string | null;
  /** Release process-held resources at host shutdown. Never a revocation. */
  stop?(): void;
}

/**
 * A refusal with a NAMED reason. Providers refuse for reasons an operator can
 * act on (a privilege the platform does not hold, a tailnet feature nobody
 * enabled), and "expose failed" is not one of them — the reason IS the fix.
 */
export type ExposureRefusalError = Error & { exposureRefusal: string };

export function exposureRefusal(reason: string, detail: string): ExposureRefusalError {
  return Object.assign(new Error(`${reason}: ${detail}`), { exposureRefusal: reason });
}

export function isExposureRefusal(error: unknown): error is ExposureRefusalError {
  return error instanceof Error && 'exposureRefusal' in error;
}

// ---------- registry ----------

export interface ExposureProviderConfig {
  installScope: string;
}

export type ExposureProviderFactory = (config: ExposureProviderConfig) => ExposureProvider;

const providers = new Map<string, ExposureProviderFactory>();

/**
 * Registration, not selection — the driver-registry shape, for the same
 * reason: a second provider (the `dns` one C7 needs) arrives by registering
 * its kind, and the grant model never learns it exists. The DNS-readiness
 * claim is exactly this function plus the four operations above.
 */
export function registerExposureProvider(kind: string, factory: ExposureProviderFactory): void {
  providers.set(kind, factory);
}

export function getExposureProviderFactory(kind: string): ExposureProviderFactory | undefined {
  return providers.get(kind);
}

export function listExposureProviderKinds(): string[] {
  return [...providers.keys()].sort();
}
