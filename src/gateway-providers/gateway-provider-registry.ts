/**
 * Gateway provider registry.
 *
 * The fourth member of the registry family (session drivers, provider
 * container configs, session egress): an install's gateway contributes to
 * every session it spawns — proxy env, trust anchors, credential stubs — and
 * that contribution is TYPED spec content merged before validation, never raw
 * argv appended after it. A gateway that cannot say what it contributes in
 * spec vocabulary does not get to contribute.
 *
 * Its own module, not part of `index.ts`, for the same reason
 * `driver-registry.ts` is separate from the driver barrel: the file an overlay
 * appends an import to must not be the file that owns the map (temporal dead
 * zone on the one path nobody exercises until an overlay is installed).
 *
 * "Gateway provider" is spelled out everywhere on this surface: "provider"
 * alone already means model provider in this tree (`src/providers/`).
 */
import type { ContainerSpec, DriverCapabilities, MountSpec, SessionKey } from '../drivers/types.js';

/**
 * What a gateway contributes to one session, in spec vocabulary.
 *
 * - `env` lands on the agent's contributed lane (`ContainerSpec.contributedEnv`),
 *   filled after the model provider's contribution, so the gateway wins a key
 *   collision — the override the old raw-argv append got from Docker's
 *   last-wins rule, now stated as contract.
 * - `mounts` are ordinary MountSpecs: same classes, same admission as every
 *   other mount. Composition dedupes by containerPath with the gateway
 *   winning, so the spec a driver sees is collision-free.
 * - `containers` are auxiliary containers (a per-session proxy). Never role
 *   'agent'. Gated on the driver's `capabilities().auxiliaryContainers` before
 *   a spec is ever built.
 */
export interface GatewayContribution {
  env?: Record<string, string>;
  mounts?: MountSpec[];
  containers?: ContainerSpec[];
}

export interface GatewayProviderInput {
  key: SessionKey;
  /** The agent group's display name — gateway-side agent registration wants it. */
  groupName: string;
  /**
   * The selected driver's capabilities. `sharedNetworkNamespace` decides the
   * proxy URL shape a contribution puts in the agent's env; a provider that
   * composes containers checks `auxiliaryContainers` and degrades or refuses.
   */
  capabilities: DriverCapabilities;
}

/**
 * A credentialed request held by the gateway awaiting a human decision, in
 * provider-neutral vocabulary (the shape every credential-proxy gateway
 * shares: what is being called, by which agent, until when).
 */
export interface GatewayApprovalRequest {
  /** The gateway's own request id — the dedupe key across reconnects. */
  id: string;
  /** ISO-8601: when the gateway gives up waiting for a decision. */
  expiresAt: string;
  method: string;
  host: string;
  path: string;
  bodyPreview?: string;
  /** The requesting agent; `externalId` is the agent group id when set. */
  agent: { externalId?: string; name: string };
  /** Optional structured summary (action + labeled fields) for the card. */
  summary?: { action?: string; details?: { label: string; value: string }[] };
}

export type GatewayApprovalDecision = 'approve' | 'deny';

export interface GatewayApprovalSubscription {
  stop(): void;
}

/**
 * The manual-approvals capability of a gateway. `subscribe` is the one
 * required member: the handler is invoked per held request and its resolved
 * value is the decision. The optional members are capability flags —
 * implement them only when the gateway genuinely supports the operation:
 *
 * - `listPending` — enumerate requests still held gateway-side, for
 *   reconnect reconciliation. A gateway that does not redeliver un-decided
 *   requests on reconnect and offers no enumeration omits it.
 * - `decide` — deliver a decision outside the subscribe callback (a late
 *   decision for a request whose original callback did not survive a
 *   restart). Returns false when the gateway no longer holds the request.
 */
export interface GatewayApprovalSource {
  subscribe(
    handler: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>,
  ): GatewayApprovalSubscription;
  listPending?(): Promise<GatewayApprovalRequest[]>;
  decide?(requestId: string, decision: GatewayApprovalDecision): Promise<boolean>;
}

export interface GatewayProvider {
  /** Identity, for logs and selection — never a branch above the seam. */
  readonly kind: string;
  /**
   * Called per spawn, before composition validates the spec. Fail-closed: a
   * throw aborts the spawn, the inbound message stays pending, and the next
   * sweep tick retries — a session without its gateway is a session without
   * credentials, and it must not launch.
   */
  contribute(input: GatewayProviderInput): Promise<GatewayContribution>;
  /**
   * Manual-approvals capability. Absent when the gateway has no held-request
   * approval flow; the approvals module consumes this seam and never imports
   * a gateway SDK directly.
   */
  approvals?(): GatewayApprovalSource;
}

/** Not a union: overlays bring their own kinds (see `DriverKind`). */
export type GatewayProviderKind = string;

export type GatewayProviderFactory = () => GatewayProvider;

const registry = new Map<GatewayProviderKind, GatewayProviderFactory>();

/**
 * Install a gateway provider under a kind. Overlays call this at module scope
 * from a file reached via `installed.ts`; a duplicate registration is a wiring
 * bug and throws rather than letting the last import silently win.
 */
export function registerGatewayProvider(kind: GatewayProviderKind, factory: GatewayProviderFactory): void {
  if (registry.has(kind)) {
    throw new Error(`Gateway provider already registered: ${kind}`);
  }
  registry.set(kind, factory);
}

export function getGatewayProviderFactory(kind: GatewayProviderKind): GatewayProviderFactory | undefined {
  return registry.get(kind);
}

/** The kinds this build can actually run — what the failure message reports. */
export function listGatewayProviderKinds(): GatewayProviderKind[] {
  return [...registry.keys()];
}
