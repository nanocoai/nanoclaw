/**
 * Per-session agent egress boundary.
 *
 * The container runner owns session lifecycle, while this handle owns the
 * network/proxy resources for one running session. NanoCo's per-session
 * sidecar is the only supported implementation: it supplies the agent's
 * proxy environment and revokes its channel during close.
 *
 * Decision 1B: what the overlay contributes is now *spec*, not argv. The
 * sidecar arrives as a `ContainerSpec` the session driver realizes — a sibling
 * container in a pod, a netns peer under Docker — and the agent's extra mounts
 * and labels arrive as spec entries too. `applyAfterMounts(args)` is gone: it
 * could only ever describe a docker command line.
 */
import type { ContainerSpec, MountSpec } from './drivers/types.js';
import { log } from './log.js';
import type { AgentGroup, Session } from './types.js';

/**
 * Observable channel health.
 *
 * `degradedSince` is non-null exactly while the lease has lapsed but the
 * certificate is still renewable — the window the renewal budget now spans
 * instead of tearing the session down. Egress genuinely does not work during
 * it, so it must be visible rather than silent.
 */
export interface SessionEgressState {
  degradedSince: string | null;
  leaseExpiresAt: string;
  certificateNotAfter: string;
  renewalAttempts: number;
}

export interface SessionEgressHandle {
  /** Environment variables applied after provider contributions, and winning over them. */
  readonly agentEnvironment: Readonly<Record<string, string>>;
  /**
   * Raw runtime arguments for the agent container.
   *
   * The one place raw flags still cross the seam, and deliberately named so it
   * cannot be mistaken for a permanent part of the contract: it carries the
   * Docker network selection for a topology-gated session. The Pod driver
   * rejects a spec that sets it, which is what forces this to be deleted when
   * the overlay's egress becomes fully pod-shaped.
   */
  readonly agentNetworkArgs: readonly string[];
  /**
   * Containers the overlay contributes to the session spec — `[egress-sidecar]`
   * when the driver realizes the sidecar as part of the session, empty when the
   * overlay creates it out-of-band.
   */
  readonly containers?: readonly ContainerSpec[];
  /** Extra mounts for the agent container — the public proxy trust anchor, never secrets. */
  readonly agentMounts?: readonly MountSpec[];
  /** Immutable lineage labels stamped onto the agent container. */
  readonly agentLabels?: Readonly<Record<string, string>>;
  /** Current channel health, for logging and for the host's runtime record. */
  egressState?(): SessionEgressState;
  /** Stop the agent if its authenticated egress path disappears. */
  onUnavailable(callback: (error?: Error) => void): void;
  /** Release or revoke all egress resources owned by this session runtime. */
  close(reason: string): Promise<void>;
  /**
   * Quiesce renewal and supervision; revoke nothing, release nothing, delete
   * nothing. The stop-with-successor half of the teardown contract (D1): a host
   * that is about to be replaced walks away from a session it expects a
   * successor to adopt, leaving the lease live and the material on disk so
   * `adopt` can reconstruct it. `close` is for sessions that are ending;
   * `detach` is for hosts that are.
   */
  detach(): Promise<void>;
}

export interface PrepareSessionEgressContext {
  session: Session | Pick<Session, 'id'>;
  agentGroup: AgentGroup | Pick<AgentGroup, 'id'>;
  containerName: string;
  /** Host-minted request capability, authenticated only when Gateway binds it
   * to this deployment/group/session lineage. */
  requestCapability?: string;
}

export type SessionEgressFactory = (context: PrepareSessionEgressContext) => Promise<SessionEgressHandle>;

/**
 * The inert handle: no environment, no network, nothing to close. Used where a
 * session genuinely has no live egress state to manage — composition fixtures,
 * and as the base other handles spread from. It is NOT the right handle for an
 * adopted session: the gateway's provision endpoint is an idempotent read-back
 * (identical lineage + identical CSR against an Active channel returns the
 * stored lease at its current version), so a successor host CAN reconstruct a
 * lease it did not create — `adoptSessionEgress` below is that path, and
 * `boundedAdoptedEgress` is the floor when it declines.
 */
export const NULL_SESSION_EGRESS: SessionEgressHandle = {
  agentEnvironment: {},
  agentNetworkArgs: [],
  onUnavailable(): void {},
  async close(): Promise<void> {},
  async detach(): Promise<void> {},
};

/** How long an adopted session without a re-adopted lease may keep running. */
const ADOPTED_EGRESS_HORIZON_MS = 300_000;

/**
 * The D4 floor: an adopted session with mediated egress has a bounded
 * lifetime. When lease re-adoption is unavailable or declined, the runtime
 * carries this handle instead of an inert one — its `onUnavailable` fires at
 * the lease horizon, so the session dies cleanly there (and the next message
 * respawns it with a fresh lease) rather than zombieing: pod Running, egress
 * dead, nothing noticing.
 *
 * The default matches the deployment's lease TTL order of magnitude; it is a
 * ceiling on how long a dead-egress session can linger, not a promise the
 * egress works until then.
 */
export function boundedAdoptedEgress(horizonMs: number = ADOPTED_EGRESS_HORIZON_MS): SessionEgressHandle {
  let callback: ((error?: Error) => void) | null = null;
  let expired = false;
  const horizonError = (): Error =>
    new Error('adopted session reached the lease horizon without a re-adopted lease');
  let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
    timer = null;
    expired = true;
    callback?.(horizonError());
  }, horizonMs);
  timer.unref?.();
  const cancel = (): void => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return {
    agentEnvironment: {},
    agentNetworkArgs: [],
    onUnavailable(cb: (error?: Error) => void): void {
      callback = cb;
      if (expired) cb(horizonError());
    },
    async close(): Promise<void> {
      cancel();
    },
    async detach(): Promise<void> {
      cancel();
    },
  };
}

let installedFactory: SessionEgressFactory | null = null;

/**
 * An adopter reconstructs the egress handle for a session this host did not
 * spawn. `null` means it declines (no persisted lineage for the session, or
 * the material belongs to another agent group); the caller then applies the
 * bounded floor. Gated on adopter availability, never on driver kind.
 */
export type SessionEgressAdopter = (context: PrepareSessionEgressContext) => Promise<SessionEgressHandle | null>;

let installedAdopter: SessionEgressAdopter | null = null;

/** Install the one session-egress adopter, same discipline as the factory. */
export function registerSessionEgressAdopter(adopter: SessionEgressAdopter): void {
  if (installedAdopter) {
    throw new Error('Session egress adopter already registered');
  }
  installedAdopter = adopter;
}

/**
 * Try to re-adopt the lease of a surviving session. Fails closed to `null`:
 * no adopter, an adopter that declines, and an adopter that throws (a revoked
 * channel 409s at the gateway, missing material, a certificate mismatch) all
 * land the caller on the bounded floor rather than crashing adoption.
 */
export async function adoptSessionEgress(context: PrepareSessionEgressContext): Promise<SessionEgressHandle | null> {
  if (!installedAdopter) return null;
  try {
    return await installedAdopter(context);
  } catch (err) {
    log.warn('Session egress adoption failed; the session takes the bounded horizon', {
      sessionId: context.session.id,
      err,
    });
    return null;
  }
}

/**
 * Install the one explicit session-egress implementation for this NanoClaw
 * build. Feature skills call this once during host startup; duplicate
 * registration fails rather than making network identity import-order based.
 */
export function registerSessionEgressFactory(factory: SessionEgressFactory): void {
  if (installedFactory) {
    throw new Error('Session egress factory already registered');
  }
  installedFactory = factory;
}

/**
 * Prepare the NanoCo egress path for one session. An unregistered control
 * plane is a startup defect, so the agent fails closed without a direct or
 * legacy proxy path.
 */
export async function prepareSessionEgress({
  session,
  agentGroup,
  containerName,
  requestCapability,
}: PrepareSessionEgressContext): Promise<SessionEgressHandle> {
  if (!installedFactory) {
    throw new Error('NanoCo session egress is not configured — refusing to start an agent with direct egress');
  }
  return installedFactory({ session, agentGroup, containerName, requestCapability });
}
