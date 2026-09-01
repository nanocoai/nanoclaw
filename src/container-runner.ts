/**
 * Container Runner v2
 *
 * Composes a fully-resolved `SessionSpec` for each session and hands it to the
 * selected `SessionDriver`. Everything runtime-specific — argv, kill/stop,
 * orphan listing — lives behind the driver seam in `src/drivers/`. What stays
 * here is composition and lifecycle policy: which mounts, which env, restart
 * ordering, exit bookkeeping.
 */
import { exec } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

import {
  CONTAINER_CPU_LIMIT,
  CONTAINER_IMAGE,
  CONTAINER_IMAGE_BASE,
  CONTAINER_MEMORY_LIMIT,
  CONTAINER_PIDS_LIMIT,
  DATA_DIR,
  GROUPS_DIR,
  INSTALL_SLUG,
  TIMEZONE,
} from './config.js';
import { CONTAINER_PLUGINS_DIR, materializeContainerJson } from './container-config.js';
import { devEnvMaterialMounts, devInstructionMounts } from './code-mode/compose.js';
import {
  GATEWAY_MANAGED_ENV_MARKER,
  boundaryDecisionMounts,
  deploymentPermissionMode,
  managedSettingsMounts,
  resolveCodePermissionMode,
} from './code-mode/permissions.js';
import { readEnvFile } from './env.js';
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { composeGroupProjectDoc, DEFAULT_PROJECT_DOC } from './project-doc-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import {
  getLiveHostInstance,
  getSessionClaim,
  listSessionsWithStopIntent,
  releaseSessionClaim,
  setStopIntent,
  shadowWrite,
  tryClaimSession,
  type SessionClaimRow,
} from './db/coordination.js';
import { getHostInstanceId } from './host-instance.js';
import { getDb, hasTable } from './db/connection.js';
import { getSession } from './db/sessions.js';
import {
  configuredDriverKind,
  configuredRuntimeTier,
  configuredWorkspaceReplicaRoot,
  getSessionDriver,
  isSessionEventsDriver,
} from './drivers/index.js';
import {
  HostWorkspaceRuntime,
  WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER,
  installWorkspaceQuiescer,
} from './storage/workspace-runtime-factory.js';
import {
  ENCRYPTED_WORKSPACE_DORMANT_ON_CONTAINER_TIER,
  workspaceMounterContainers,
} from './workspace-mounter.js';

let workspaceRuntimePromise: Promise<HostWorkspaceRuntime> | undefined;
let workspaceDormancyAnnounced = false;

/**
 * Announce, once per host process, that the two REQUIRED workspace skills are
 * composed into this tree and doing nothing.
 *
 * Deliberately an announcement and not a refusal: the container tier is a
 * supported tier, not a misconfiguration, so throwing here would take down the
 * running runc deployment over its own normal state. What was wrong was the
 * silence — a skill that composes and then does nothing reads exactly like a
 * skill that works, which is how a policy grant with no effect and a missing
 * Slack redirect both survived until the point of use.
 */
function announceWorkspaceDormancy(): void {
  if (workspaceDormancyAnnounced) return;
  workspaceDormancyAnnounced = true;
  log.warn('Encrypted workspace skills are composed but DORMANT on this deployment', {
    driver: configuredDriverKind(),
    tier: configuredRuntimeTier(),
    'encrypted-kata-workspace': ENCRYPTED_WORKSPACE_DORMANT_ON_CONTAINER_TIER,
    'fenced-workspace-checkpoints': WORKSPACE_CHECKPOINTS_DORMANT_ON_CONTAINER_TIER,
  });
}

function workspaceRuntime(): Promise<HostWorkspaceRuntime> | undefined {
  if (configuredStatelessK8sHost()) return undefined;
  // Every spawn passes through here, on both tiers, which is what makes this
  // the one gate that can speak for the dormant pair.
  if (configuredDriverKind() !== 'pod' || configuredRuntimeTier() !== 'vm') {
    announceWorkspaceDormancy();
    return undefined;
  }
  return (workspaceRuntimePromise ??= HostWorkspaceRuntime.fromEnv());
}
import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';
import { GROUP_FOLDER_LABEL, labelValueLegal, specInvalid } from './drivers/types.js';
import type { ContainerSpec, MountSpec, SessionFailure, SessionSpec } from './drivers/types.js';
import {
  getGatewayProvider,
  type GatewayContribution,
  type GatewaySessionLifecycle,
} from './gateway-providers/index.js';
import { initGroupFilesystem } from './group-init.js';
import { getAgentMailbox } from './mailbox/index.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { requestCapabilityFromContext } from './nanoco/mailbox-capability.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerRequiresHostFilesystem,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
  DEFAULT_PROJECT_DOCUMENT,
  type ProviderProjectDocument,
  type VolumeMount,
} from './providers/provider-container-registry.js';
import {
  heartbeatPath,
  markContainerRunning,
  markContainerStopped,
  sessionContextPath,
  sessionDir,
  writeSessionContext,
  writeSessionRouting,
} from './session-manager.js';
import type { AgentGroup, Session } from './types.js';
import {
  configuredStatelessK8sHost,
  loadContainerConfigWithoutMaterializing,
  statelessAgentMounts,
  workspaceComposerContainer,
  workspaceComposerDbInitContainer,
} from './stateless-k8s/runtime.js';
import { bindWorkspaceSpec, ensureWorkspace, ensureWorkspacePaths, releaseWorkspace, type WorkspaceAssignment } from './storage/workspace-plane.js';
import { prepareStatelessRelay } from './stateless-k8s/session-egress.js';

/**
 * Docker defaults /dev/shm to 64m, which silently short-writes past that size.
 * agent-browser passes --disable-dev-shm-usage, but a third-party puppeteer or
 * Playwright launcher may not.
 */
const SHM_SIZE_MB = 1024;
/** Grace before SIGKILL. One second, as `docker stop -t 1` has always been. */
const STOP_GRACE_SECONDS = 1;

/** Active sessions tracked by session ID. */
interface ActiveSessionRuntime {
  /**
   * The realized session. Was `process: ChildProcess` — a session that is not
   * a child process of the host could not be represented at all, and that
   * single field was what made every runtime other than a locally-spawned
   * docker CLI inexpressible.
   */
  handle: SupervisedHandle;
  containerName: string;
  gatewayLifecycle?: GatewaySessionLifecycle;
  workspace?: HostWorkspaceRuntime;
  workspaceGroupId?: string;
  /** A failed stop may have left the runtime alive; detach instead of revoking. */
  teardownIncomplete?: boolean;
  /**
   * When this host started tracking the runtime. Backs the sweep's ceiling
   * check when no heartbeat file exists yet (see `host-sweep.ts`): a container
   * that finishes its turn without ever reaching an SDK event never writes one,
   * and without this it would sit alive-but-idle forever, immune to the check.
   * An adopted runtime records the adoption, which is the honest answer — this
   * host has no spawn time for a container a previous host started, and leaving
   * it unset would exempt every adopted session from the ceiling.
   */
  startedAtMs: number;
  /** True when this runtime was adopted at startup rather than spawned here. */
  adopted: boolean;
  exitCallbacks: Array<() => void>;
  finished: boolean;
  finishedPromise: Promise<void>;
  resolveFinished: () => void;
  stopReason?: string;
  /** Incarnation this process shadow-claimed in session_claims, if the write landed. */
  claimIncarnation?: number;
  /** A deferred fenced finalization is already queued for this runtime. */
  deferredFinishScheduled?: boolean;
}

const activeContainers = new Map<string, ActiveSessionRuntime>();

installWorkspaceQuiescer(async (groupId) => {
  if ([...activeContainers.values()].some((runtime) =>
    runtime.workspaceGroupId === groupId && !runtime.finished)) {
    throw new Error(`workspace ${groupId} still has a live session runtime`);
  }
});

// Claimant identity for the session_claims rows: the host's durable lease
// instance id when the lease is running, else a process-scoped fallback
// (tests, tools). The lease id is what makes claims answerable against
// host_instances liveness below.
function claimantId(): string {
  return getHostInstanceId() ?? `${os.hostname()}:${process.pid}`;
}

/**
 * Claim a session this process is about to run (spawn or adopt). The
 * `session_claims` row is the authority for which process/incarnation owns a
 * session: losing the compare-and-set means another live claimant got there
 * first, and the caller must not start or adopt a container for it. Returns
 * the claimed incarnation, or null when the claim was lost. Throws on a
 * failed write — a claim that cannot be recorded is a claim not held.
 *
 * A claim held by a LIVE peer host (a host_instances row that is not stopped
 * and whose lease is unexpired) is refused outright — two live hosts must
 * never trade a session back and forth. A claim whose holder is stopped,
 * lease-expired, or unknown (older claimant-id schemes) stays takeover-able:
 * a crashed claimant must never wedge a session.
 */
async function claimSessionRun(sessionId: string, containerRef: string): Promise<number | null> {
  const current = await getSessionClaim(sessionId);
  const self = claimantId();
  if (current?.claimed_by && current.claimed_by !== self) {
    const holder = await getLiveHostInstance(current.claimed_by, new Date().toISOString());
    if (holder) {
      log.warn('Refusing session claim held by a live peer host', {
        sessionId,
        holder: current.claimed_by,
        claimant: self,
      });
      return null;
    }
  }
  return tryClaimSession({
    sessionId,
    instanceId: self,
    expectedIncarnation: current?.incarnation ?? 0,
    containerRef,
    now: new Date().toISOString(),
  });
}

/** Release our claim at this incarnation. Never throws — a failed release is
 *  self-healing (the next claimant's CAS supersedes it). */
async function releaseClaimQuietly(sessionId: string, incarnation: number): Promise<void> {
  await shadowWrite('session-claim-release', () =>
    releaseSessionClaim({
      sessionId,
      instanceId: claimantId(),
      incarnation,
      now: new Date().toISOString(),
    }),
  );
}

/**
 * In-flight wake promises, keyed by session id. Deduplicates concurrent
 * `wakeContainer` calls while the first spawn is still mid-setup — otherwise a
 * second wake in that window passes the `activeContainers.has` check and spawns
 * a duplicate container against the same session directory, producing racy
 * double-replies.
 */
const wakePromises = new Map<string, Promise<boolean>>();

export function getActiveContainerCount(): number {
  return activeContainers.size;
}

export function isContainerRunning(sessionId: string): boolean {
  return activeContainers.has(sessionId);
}

export function getContainerStartedAtMs(sessionId: string): number | undefined {
  return activeContainers.get(sessionId)?.startedAtMs;
}

/** Container name of a session's live runtime, if any — for host-mediated attach (D20/D22). */
export function getActiveContainerName(sessionId: string): string | undefined {
  return activeContainers.get(sessionId)?.containerName;
}

/**
 * Sessions whose running container could not be claim-fenced at adoption (the
 * store was unreachable). They are deliberately NOT in the registry — nothing
 * supervises them yet — but they are alive, so the wake path must reclaim them
 * instead of spawning a duplicate. Cleared on a successful retry, on
 * discovering the container gone, or on losing the claim to another live host.
 */
const pendingAdoptions = new Set<string>();

export function _resetAdoptionRetryStateForTesting(): void {
  pendingAdoptions.clear();
}

/**
 * Retry the claim-fenced adoption of a container that survived a failed claim
 * write. Re-lists from the driver (fresher truth than any cached handle):
 * container gone → false, a fresh spawn is correct; claim lost to a live
 * host → throws, no spawn either; store still down → throws, wake retries.
 */
async function retryPendingAdoption(session: Session): Promise<boolean> {
  const driver = getSessionDriver();
  const snapshots = await driver.listSessions(INSTALL_SLUG);
  const snapshot = snapshots.find(({ handle, phase }) => handle.key.sessionId === session.id && phase === 'running');
  if (!snapshot) {
    pendingAdoptions.delete(session.id);
    return false;
  }
  const claimIncarnation = await claimSessionRun(session.id, snapshot.handle.name);
  if (claimIncarnation === null) {
    pendingAdoptions.delete(session.id);
    throw new Error(
      `session ${session.id} is claimed by another live host process — not adopting or spawning a duplicate`,
    );
  }
  const retryAgentGroup = await getAgentGroup(session.agent_group_id);
  const retryGatewayLifecycle = retryAgentGroup
    ? await getGatewayProvider().adopt?.({
        key: snapshot.handle.key,
        groupName: retryAgentGroup.name,
        containerName: snapshot.handle.name,
        capabilities: driver.capabilities(),
      })
    : undefined;
  const runtime = registerRuntime(
    session.id,
    snapshot.handle,
    snapshot.handle.name,
    retryGatewayLifecycle ?? undefined,
    true,
  );
  runtime.claimIncarnation = claimIncarnation;
  runtime.stopReason = undefined;
  armGatewayUnavailable(session.id, runtime);
  snapshot.handle.onTerminal((failure) => {
    void finishAndResolve(session.id, runtime, failure);
  });
  await markContainerRunning(session.id);
  pendingAdoptions.delete(session.id);
  log.info('Adopted surviving container on retry after a failed claim write', { sessionId: session.id });
  return true;
}

/**
 * Wake up a container for a session. If already running or mid-spawn, no-op
 * (the in-flight wake promise is reused).
 *
 * Contract: never throws. Returns `true` on successful spawn, `false` on
 * transient spawn failure (e.g. OneCLI gateway unreachable). Callers don't
 * need to wrap — the inbound row stays pending and host-sweep retries on its
 * next tick.
 */
export function wakeContainer(session: Session): Promise<boolean> {
  if (activeContainers.has(session.id)) {
    log.debug('Container already running', { sessionId: session.id });
    return Promise.resolve(true);
  }
  const existing = wakePromises.get(session.id);
  if (existing) {
    log.debug('Container wake already in-flight — joining existing promise', { sessionId: session.id });
    return existing;
  }
  const promise = spawnContainer(session)
    .then(() => true)
    .catch((err) => {
      log.warn('wakeContainer failed — host-sweep will retry', { sessionId: session.id, err });
      return false;
    })
    .finally(() => {
      wakePromises.delete(session.id);
    });
  wakePromises.set(session.id, promise);
  return promise;
}

async function spawnContainer(session: Session): Promise<void> {
  if (pendingAdoptions.has(session.id)) {
    // A running container is waiting to be re-fenced after a failed adoption
    // claim. Reclaim it rather than spawning a duplicate; its poll loop picks
    // up any pending mail the moment it is ours again.
    if (await retryPendingAdoption(session)) return;
  }
  const agentGroup = await getAgentGroup(session.agent_group_id);
  if (!agentGroup) {
    log.error('Agent group not found', { agentGroupId: session.agent_group_id });
    return;
  }

  // Refresh the destination map and current-thread routing so any admin
  // changes take effect on wake. Destinations come from the agent-to-agent
  // module — skip when the module isn't installed (table absent).
  if (await hasTable(getDb(), 'agent_destinations')) {
    const { writeDestinations } = await import('./modules/agent-to-agent/write-destinations.js');
    await writeDestinations(agentGroup.id, session.id);
  }
  await writeSessionRouting(agentGroup.id, session.id);
  const mailboxKey = { agentGroupId: agentGroup.id, sessionId: session.id };
  const mailbox = getAgentMailbox();
  const mailboxContext = await mailbox.runnerContext(mailboxKey);
  const requestCapability = requestCapabilityFromContext(mailboxContext);
  const stateless = configuredStatelessK8sHost();
  if (!stateless) writeSessionContext(agentGroup.id, session.id, mailboxContext);

  // In stateless Kubernetes mode the Host reads configuration but writes no
  // agent-owned file. The pod-local materializer uses the existing writers.
  const containerConfig = stateless
    ? await loadContainerConfigWithoutMaterializing(agentGroup)
    : await materializeContainerJson(agentGroup.id);

  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  if (!stateless) await initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  if (stateless && providerRequiresHostFilesystem(providerName)) {
    throw new Error(`stateless Kubernetes Host cannot run provider '${providerName}' because it requires Host filesystem setup`);
  }
  const { provider, contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);
  const projectDocument = resolveProjectDocument(provider, contribution);

  const mounts = stateless
    ? statelessAgentMounts(agentGroup, session, containerConfig, projectDocument, contribution)
    : await buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  const mailboxEnvironment = await mailbox.runnerEnvironment(mailboxKey);

  const driver = getSessionDriver();
  // The gateway's per-session contribution — typed env and mounts (and, on a
  // driver that manages them, auxiliary containers), merged into the spec
  // BEFORE validation so admission sees the whole session. Fail-closed exactly
  // as the old wiring was: contribute() throwing aborts the spawn, the inbound
  // row stays pending, and the sweep retries. Network selection is NOT here —
  // topology is driver-private (see `drivers/index.ts`).
  const workspace = await workspaceRuntime();
  if (workspace) await workspace.started(agentGroup.id);
  let gateway: GatewayContribution;
  try {
    gateway = await getGatewayProvider().contribute({
      key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
      groupName: agentGroup.name,
      containerName,
      requestCapability,
      capabilities: driver.capabilities(),
    });
  } catch (error) {
    if (workspace) await workspace.aborted(agentGroup.id);
    throw error;
  }
  let workspaceAssignment: WorkspaceAssignment | undefined;
  if (stateless) {
    const relay = process.env.NANOCLAW_WORKSPACE_S3_TRANSPORT === 'gateway'
      ? await prepareStatelessRelay({
          agentId: agentGroup.id,
          sessionId: session.id,
          requestCapability: requestCapability ?? '',
        })
      : undefined;
    workspaceAssignment = await ensureWorkspace({
      groupId: agentGroup.id,
      sessionId: session.id,
      runtimeTier: containerConfig.runtimeTier ?? configuredRuntimeTier(),
      ...(relay ? { relay } : {}),
    });
  }
  let spec: SessionSpec;
  try {
    if (gateway.containers?.length && !driver.capabilities().auxiliaryContainers) {
      throw specInvalid(
        `gateway provider composed auxiliary containers, but driver '${driver.kind}' does not manage them ` +
          `(capabilities().auxiliaryContainers is false)`,
      );
    }
    spec = composeSessionSpec({
      agentGroup,
      session,
      containerName,
      mounts,
      containerConfig,
      contribution,
      projectDocument,
      gateway,
      mailboxEnvironment,
    });
    if (stateless) {
      spec.containers.find(({ role }) => role === 'agent')!.env.NANOCLAW_SESSION_CONTEXT =
        `/run/nanoclaw/session-context/${session.id}.json`;
      spec.containers.push(
        workspaceComposerDbInitContainer(spec.runAs),
        workspaceComposerContainer({
          agentGroup,
          session,
          containerConfig,
          projectDocument,
          contribution,
          mailboxContext,
        }),
      );
      spec.stopGraceSeconds = 10;
      bindWorkspaceSpec(spec, workspaceAssignment!);
      await ensureWorkspacePaths(spec, workspaceAssignment!);
    }
  } catch (error) {
    try {
      await gateway.lifecycle?.close('session-compose-failed');
      if (workspaceAssignment) await releaseWorkspace(workspaceAssignment).catch(() => {});
    } finally {
      if (workspace) await workspace.aborted(agentGroup.id);
    }
    throw error;
  }

  log.info('Spawning session', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // The claim is the cross-process spawn fence: winning it is what licenses
  // touching the session's runtime state (the heartbeat clear below included).
  // Losing it means another live claimant runs this session — abort; the wake
  // contract turns the throw into `false` and the sweep re-checks next tick.
  const claimIncarnation = await claimSessionRun(session.id, containerName);
  if (claimIncarnation === null) {
    throw new Error(`session ${session.id} is claimed by another live host process — not spawning a duplicate`);
  }

  // Clear any orphan heartbeat from a previous container instance — the sweep's
  // ceiling check treats a missing file as "fresh spawn, give grace". Without
  // this, the stale mtime can trigger an immediate kill before the new container
  // touches the file itself.
  if (!stateless) fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  let handle;
  try {
    handle = await driver.prepare(spec);
  } catch (err) {
    await releaseClaimQuietly(session.id, claimIncarnation);
    try {
      await gateway.lifecycle?.close('session-prepare-failed');
    } finally {
      if (workspace) await workspace.aborted(agentGroup.id);
    }
    throw err;
  }

  const runtime = registerRuntime(session.id, handle, containerName, gateway.lifecycle, false);
  if (workspace) {
    runtime.workspace = workspace;
    runtime.workspaceGroupId = agentGroup.id;
  }
  runtime.claimIncarnation = claimIncarnation;
  armGatewayUnavailable(session.id, runtime);

  try {
    await armSessionLifecycle({
      handle,
      onTerminal: (failure) => {
        void finishAndResolve(session.id, runtime, failure);
      },
      afterStart: () => {
        return markContainerRunning(session.id);
      },
    });
  } catch (err) {
    if (activeContainers.get(session.id) === runtime && !runtime.finished) {
      await runtime.gatewayLifecycle?.close('session-start-failed');
      activeContainers.delete(session.id);
      runtime.resolveFinished();
      await releaseClaimQuietly(session.id, claimIncarnation);
    } else {
      await runtime.finishedPromise;
    }
    throw err;
  }
}

/**
 * Wire a session's lifecycle in the one order that is safe, as executable code
 * rather than as a comment a refactor can silently invert.
 *
 * Terminal handling is armed before the session starts, so a failure that lands
 * during startup finds a runtime that already knows how to finalize. If
 * `start()` throws, the post-start bookkeeping never runs — there is nothing
 * running for it to record.
 */
export async function armSessionLifecycle(deps: {
  handle: Pick<SupervisedHandle, 'onTerminal' | 'start'>;
  onTerminal: (failure?: SessionFailure) => void;
  afterStart?: () => void | Promise<void>;
}): Promise<void> {
  deps.handle.onTerminal(deps.onTerminal);
  await deps.handle.start();
  await deps.afterStart?.();
}

function registerRuntime(
  sessionId: string,
  handle: SupervisedHandle,
  containerName: string,
  gatewayLifecycle: GatewaySessionLifecycle | undefined,
  adopted: boolean,
): ActiveSessionRuntime {
  let resolveFinished!: () => void;
  const finishedPromise = new Promise<void>((resolve) => {
    resolveFinished = resolve;
  });
  const runtime: ActiveSessionRuntime = {
    handle,
    containerName,
    startedAtMs: Date.now(),
    gatewayLifecycle,
    adopted,
    exitCallbacks: [],
    finished: false,
    finishedPromise,
    resolveFinished,
  };
  activeContainers.set(sessionId, runtime);
  return runtime;
}

function armGatewayUnavailable(sessionId: string, runtime: ActiveSessionRuntime): void {
  runtime.gatewayLifecycle?.onUnavailable((error) => {
    if (runtime.finished) return;
    log.warn('Session gateway became unavailable; stopping agent', {
      sessionId,
      containerName: runtime.containerName,
      error: error?.message,
    });
    killContainer(sessionId, 'session-gateway-unavailable');
  });
}

/**
 * Single-shot finalization: only the first terminal event resolves shutdown,
 * and only for the runtime the event belongs to. A terminal event is always
 * bound to the runtime that armed it — a late event from a runtime that a
 * fresh spawn has already replaced resolves its own waiters and touches
 * nothing else (the in-process half of the stale-finish fence).
 */
async function finishAndResolve(
  sessionId: string,
  runtime: ActiveSessionRuntime,
  failure?: SessionFailure,
): Promise<void> {
  if (runtime.finished) return;
  runtime.finished = true;
  if (activeContainers.get(sessionId) !== runtime) {
    log.warn('Ignoring stale session finish — a newer runtime is registered', {
      sessionId,
      containerName: runtime.containerName,
    });
    runtime.resolveFinished();
    return;
  }
  try {
    await finish(sessionId, runtime, failure);
  } finally {
    if (runtime.workspace && runtime.workspaceGroupId) {
      try {
        if (runtime.teardownIncomplete) await runtime.workspace.uncertain(runtime.workspaceGroupId);
        else await runtime.workspace.stopped(runtime.workspaceGroupId);
      } catch (error) {
        log.error('Workspace finalization failed after session finish', { sessionId, error });
      }
    }
    runtime.resolveFinished();
  }
}

// Fence-read schedule: brief in-line retries (~30s), then the whole
// finalization defers to the resync cadence. A store outage never forces a
// choice between clobbering a newer incarnation and leaking the runtime.
let fenceRetryDelaysMs = [5_000, 10_000, 15_000];
let deferredFinishDelayMs = 60_000;
export function _setFinishFenceScheduleForTesting(retryDelaysMs?: number[], deferDelayMs?: number): void {
  fenceRetryDelaysMs = retryDelaysMs ?? [5_000, 10_000, 15_000];
  deferredFinishDelayMs = deferDelayMs ?? 60_000;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms).unref?.());

/** Re-run finalization once the store may be back. One timer per runtime. */
function scheduleDeferredFinish(sessionId: string, runtime: ActiveSessionRuntime, failure?: SessionFailure): void {
  if (runtime.deferredFinishScheduled) return;
  runtime.deferredFinishScheduled = true;
  const timer = setTimeout(() => {
    runtime.deferredFinishScheduled = false;
    finish(sessionId, runtime, failure).catch((err: unknown) => {
      log.error('Deferred finalization failed', { sessionId, err });
    });
  }, deferredFinishDelayMs);
  timer.unref?.();
}

async function finish(sessionId: string, runtime: ActiveSessionRuntime, failure?: SessionFailure): Promise<void> {
  const { containerName } = runtime;

  // Durable fence: the claim row is the authority for which incarnation owns
  // this session. A finish racing a fresh spawn — possibly from another
  // process — must not stomp the fresh incarnation's bookkeeping (the status
  // write, the exit callbacks, the claim release are all skipped; only this
  // runtime's own registry entry is dropped).
  if (runtime.claimIncarnation !== undefined) {
    let fenced: boolean | 'unreadable' = 'unreadable';
    /* eslint-disable no-catch-all/no-catch-all -- an unreadable fence defers finalization; it never licenses unfenced writes */
    for (let attempt = 0; attempt <= fenceRetryDelaysMs.length; attempt++) {
      if (attempt > 0) await sleep(fenceRetryDelaysMs[attempt - 1]);
      try {
        const claim = await getSessionClaim(sessionId);
        fenced = claim !== undefined && claim.incarnation !== runtime.claimIncarnation;
        break;
      } catch (err) {
        log.warn('Claim fence check failed', { sessionId, attempt: attempt + 1, err });
      }
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (fenced === 'unreadable') {
      // Fail closed: no status write, no claim release, no exit callbacks —
      // none of it may happen unfenced. The registry entry stays, so wakes
      // see the session as occupied and nothing double-spawns; an unref'd
      // timer re-runs finalization at the resync cadence until the store
      // answers. Exit callbacks are deferred, not dropped — and a pending
      // respawn is carried by its durable stop-intent row even if this
      // process dies first.
      log.warn('Claim fence unreadable — deferring finalization until the store answers', {
        sessionId,
        containerName,
        incarnation: runtime.claimIncarnation,
      });
      scheduleDeferredFinish(sessionId, runtime, failure);
      return;
    }
    if (fenced) {
      log.warn('Ignoring stale session finish — a newer incarnation holds the claim', {
        sessionId,
        containerName,
        staleIncarnation: runtime.claimIncarnation,
      });
      if (activeContainers.get(sessionId) === runtime) {
        activeContainers.delete(sessionId);
      }
      return;
    }
  }

  try {
    await markContainerStopped(sessionId);
  } catch (err) {
    log.error('Failed to record stopped container', { sessionId, containerName, err });
  }
  try {
    stopTypingRefresh(sessionId);
  } catch (err) {
    log.error('Failed to stop typing refresh', { sessionId, containerName, err });
  }
  try {
    if (runtime.teardownIncomplete) await runtime.gatewayLifecycle?.detach();
    else await runtime.gatewayLifecycle?.close(runtime.stopReason ?? 'session-ended');
  } catch (err) {
    log.error('Session gateway cleanup failed', { sessionId, containerName, err });
  }

  if (failure && failure.kind !== 'started-then-died') {
    log.error('Session failed', { sessionId, containerName, kind: failure.kind, retryable: failure.retryable });
  } else {
    log.info('Session ended', {
      sessionId,
      containerName,
      exitCode: failure && failure.kind === 'started-then-died' ? failure.exitCode : undefined,
    });
  }

  if (activeContainers.get(sessionId) === runtime) {
    activeContainers.delete(sessionId);
  }
  if (runtime.claimIncarnation !== undefined) {
    await releaseClaimQuietly(sessionId, runtime.claimIncarnation);
  }
  for (const callback of runtime.exitCallbacks) {
    try {
      callback();
    } catch (err) {
      log.error('Container exit callback failed', { sessionId, containerName, err });
    }
  }
}

/** Kill a container for a session. */
export function killContainer(sessionId: string, reason: string, onExit?: () => void): void {
  const entry = activeContainers.get(sessionId);
  if (!entry) return;

  if (onExit) {
    entry.exitCallbacks.push(onExit);
  }

  entry.stopReason = reason;
  log.info('Killing container', { sessionId, reason, containerName: entry.containerName });
  void entry.handle.stop(reason).then(
    () => {
      // A handle whose supervision channel is gone (an adopted handle whose
      // attach process belonged to the previous host) would otherwise never
      // finalize, and the session would stay in the registry forever.
      if (!entry.finished) void finishAndResolve(sessionId, entry, undefined);
    },
    (err: unknown) => {
      log.error('Failed to stop session', { sessionId, reason, err });
      entry.teardownIncomplete = true;
      if (!entry.finished) void finishAndResolve(sessionId, entry, undefined);
    },
  );
}

/** Detach gateway supervision without stopping sessions that a successor adopts. */
export async function detachGatewaySessions(): Promise<void> {
  await Promise.all(
    [...activeContainers.values()].map(async (runtime) => {
      try {
        await runtime.gatewayLifecycle?.detach();
      } catch (err) {
        log.error('Session gateway detach failed', { containerName: runtime.containerName, err });
      }
    }),
  );
}

/**
 * Startup reconciliation: adopt what is still alive, stop what is not ours.
 *
 * This replaces the old reap-everything `cleanupOrphans()`. A surviving session
 * used to be destroyed on every host restart and its work recovered only
 * through the DB; now the host re-registers it and delivery resumes. The OneCLI
 * gateway resolves credentials per request on the host side, so an adopted
 * session's egress keeps working without any per-process state to rebuild.
 */
export async function adoptRunningSessions(): Promise<{ adopted: number; stopped: number }> {
  const driver = getSessionDriver();
  let snapshots: SupervisedSnapshot[];
  try {
    snapshots = await driver.listSessions(INSTALL_SLUG);
  } catch (err) {
    log.warn('Failed to list existing sessions for adoption', { err });
    return { adopted: 0, stopped: 0 };
  }

  let adopted = 0;
  let stopped = 0;
  for (const { handle, phase } of snapshots) {
    const session = handle.key.sessionId ? await getSession(handle.key.sessionId) : undefined;
    // The snapshot's phase is the listing's own truth: a corpse arrives as
    // 'terminal' (or not at all), so telling adoptable sessions apart needs
    // no per-handle status() round trip. `stop()` on a corpse is still full
    // teardown — a self-exited runtime needs its residue cleaned up.
    if (!session || session.status !== 'active' || phase !== 'running') {
      await handle.stop('orphan-at-startup').catch(() => {});
      stopped += 1;
      continue;
    }
    // Claim before adopting: a lost CAS means another live process already
    // owns this session — leave its container strictly alone. A failed claim
    // WRITE also fails closed: an unfenced adoption could stomp a newer
    // claimant's session, while an unadopted-but-running container is safe to
    // leave — the spawn path is claim-first fail-closed too, so nothing can
    // start a duplicate while the store is down, and the wake path reclaims
    // the container (`retryPendingAdoption`) once the store answers.
    let claimIncarnation: number | null;
    /* eslint-disable no-catch-all/no-catch-all -- fail closed: leave the container unadopted and let the wake path retry, never adopt unfenced */
    try {
      claimIncarnation = await claimSessionRun(session.id, handle.name);
    } catch (err) {
      log.error('Session claim write failed during adoption — leaving the container unadopted for retry', {
        sessionId: session.id,
        err,
      });
      pendingAdoptions.add(session.id);
      continue;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (claimIncarnation === null) {
      log.warn('Session adoption skipped — another live host process holds the claim', { sessionId: session.id });
      continue;
    }
    pendingAdoptions.delete(session.id);
    const agentGroup = await getAgentGroup(session.agent_group_id);
    const gatewayLifecycle = agentGroup
      ? await getGatewayProvider().adopt?.({
          key: handle.key,
          groupName: agentGroup.name,
          containerName: handle.name,
          capabilities: driver.capabilities(),
        })
      : undefined;
    const workspace = await workspaceRuntime();
    if (agentGroup && workspace) await workspace.adopted(agentGroup.id);
    const runtime = registerRuntime(session.id, handle, handle.name, gatewayLifecycle ?? undefined, true);
    if (agentGroup && workspace) {
      runtime.workspace = workspace;
      runtime.workspaceGroupId = agentGroup.id;
    }
    runtime.claimIncarnation = claimIncarnation;
    runtime.stopReason = undefined;
    armGatewayUnavailable(session.id, runtime);
    handle.onTerminal((failure) => {
      void finishAndResolve(session.id, runtime, failure);
    });
    await markContainerRunning(session.id);
    adopted += 1;
  }

  await driver.reapResidue?.(INSTALL_SLUG).catch?.(() => {});
  // Reconcile terminals the watch stream missed while no host was listening —
  // adoption is the one place a full re-list is already cheap, so the hub's
  // resync wires here rather than into new periodic machinery.
  if (isSessionEventsDriver(driver)) await driver.resync(INSTALL_SLUG).catch(() => {});

  if (adopted > 0 || stopped > 0) {
    log.info('Reconciled sessions at startup', { adopted, stopped });
  }

  await honorPendingStopIntents();

  return { adopted, stopped };
}

/**
 * Honor stop intents that outlived their process. A kill-with-respawn used to
 * live only in a volatile onExit callback: a host dying between the kill and
 * the respawn forgot the restart entirely ("rebuild applied" and nothing came
 * back). The durable `respawn_after_stop` row is consumed here at startup —
 * a session whose container is still up gets its kill re-issued with the
 * respawn re-armed; one without a container gets the respawn directly. The
 * intent clears only once the respawn wake actually succeeds, so a failed
 * wake is retried at the next startup while the sweep retries it sooner.
 */
export async function honorPendingStopIntents(
  wake: (session: Session) => Promise<boolean> = wakeContainer,
): Promise<void> {
  let intents: SessionClaimRow[];
  try {
    intents = await listSessionsWithStopIntent();
  } catch (err) {
    log.warn('Failed to read pending stop intents', { err });
    return;
  }
  for (const intent of intents) {
    if (intent.stop_intent !== 'respawn_after_stop') continue;
    if (pendingAdoptions.has(intent.session_id)) {
      // The session's container is alive but not yet re-fenced; acting on the
      // intent now could kill or respawn the wrong incarnation. The row stays
      // for the next recovery pass.
      log.warn('Deferring stop intent — session awaits claim-fenced adoption', { sessionId: intent.session_id });
      continue;
    }
    const session = await getSession(intent.session_id);
    if (!session || session.status !== 'active') {
      await shadowWrite('stop-intent-clear', () => setStopIntent(intent.session_id, null, new Date().toISOString()));
      continue;
    }
    const respawn = async (): Promise<void> => {
      const woke = await wake(session);
      if (woke) {
        await shadowWrite('stop-intent-clear', () => setStopIntent(session.id, null, new Date().toISOString()));
      }
    };
    if (activeContainers.has(session.id)) {
      // The kill never completed — the container outlived the host that
      // ordered it. Re-issue the kill with the respawn re-armed.
      log.info('Re-issuing interrupted restart', { sessionId: session.id });
      killContainer(session.id, 'restart-intent-recovery', () => void respawn());
    } else {
      await respawn();
    }
  }
}

/**
 * Resolve the provider name for a session:
 *
 *   sessions.agent_provider → container_configs.provider → 'claude'
 */
export function resolveProviderName(
  sessionProvider: string | null | undefined,
  containerConfigProvider: string | null | undefined,
): string {
  return (sessionProvider || containerConfigProvider || 'claude').toLowerCase();
}

export function resolveProjectDocument(
  provider: string,
  contribution: ProviderContainerContribution,
): ProviderProjectDocument {
  if (contribution.projectDocument) return contribution.projectDocument;
  if (providerProvidesAgentSurfaces(provider)) {
    throw new Error(`provider '${provider}' owns agent surfaces but supplied no project document`);
  }
  return DEFAULT_PROJECT_DOCUMENT;
}

async function resolveProviderContribution(
  session: Session,
  agentGroup: AgentGroup,
  containerConfig: import('./container-config.js').ContainerConfig,
): Promise<{ provider: string; contribution: ProviderContainerContribution }> {
  const provider = resolveProviderName(session.agent_provider, containerConfig.provider);
  const fn = getProviderContainerConfig(provider);
  const contribution = fn
    ? await fn({
        sessionDir: sessionDir(agentGroup.id, session.id),
        agentGroupId: agentGroup.id,
        groupDir: path.resolve(GROUPS_DIR, agentGroup.folder),
        selectedSkills: selectedSkillNames(containerConfig),
        hostEnv: process.env,
      })
    : {};
  return { provider, contribution };
}

export async function buildMounts(
  agentGroup: AgentGroup,
  session: Session,
  containerConfig: import('./container-config.js').ContainerConfig,
  provider: string,
  providerContribution: ProviderContainerContribution,
): Promise<VolumeMount[]> {
  const projectRoot = process.cwd();

  // Default agent surfaces (composed project doc, skill links, provider state
  // dir) apply unless the provider's registration declares it provides its own.
  const defaultSurfaces = !providerProvidesAgentSurfaces(provider);
  // D16: code mode strips chat COMPOSITION, not capabilities — the composed
  // instructions, fragments, shared CLAUDE.md, chat skills and stamped plugin
  // surfaces stay host-side; provider state (~/.claude: settings, credentials
  // state) still mounts, because the coding agent is still a Claude session.
  const chatSurfaces = defaultSurfaces && !containerConfig.codeMode;

  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (chatSurfaces) {
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn: every instruction source inlined
    // into one flat file. See `project-doc-compose.ts`.
    await composeGroupProjectDoc(agentGroup, groupDir, DEFAULT_PROJECT_DOC);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const scope = agentGroup.id;

  // Session workspace: mailbox-selected state plus outbox and heartbeat files.
  mounts.push({ hostPath: sessDir, containerPath: '/workspace', readonly: false, mountClass: 'group-state', scope });
  mounts.push({
    hostPath: sessionContextPath(agentGroup.id, session.id),
    containerPath: '/app/.nanoclaw-session.json',
    readonly: true,
    mountClass: 'group-state',
    scope,
  });

  // Agent group folder at /workspace/agent (RW for working files + shared memory)
  mounts.push({
    hostPath: groupDir,
    containerPath: '/workspace/agent',
    readonly: false,
    mountClass: 'group-state',
    scope,
  });

  // Kata-safe container config projection. A file hostPath nested over the RW
  // group directory reads as empty inside the guest, including with subPath.
  // Reuse the group directory at a non-overlapping RO path instead.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({
      hostPath: groupDir,
      containerPath: '/run/nanoclaw/group-config',
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }

  // Stamped plugin content is immutable at runtime (the Agent Plugins
  // contract: writes go to plugin-data/, which stays RW via the group mount).
  // Same nested-RO pattern as container.json; initGroupFilesystem creates the
  // dir before mounts are built, so the mount is unconditional.
  //
  // Classed 'install-surface' rather than 'group-state' because what is stamped
  // here is code the agent EXECUTES, and install-surface is the only class
  // whose read-only rule is enforced instead of chosen. It lives under the
  // group folder rather than an install root, so the mount policy pins it
  // through the group-folder label — see `stampedPluginsRoot`.
  //
  // Gated on chatSurfaces (D16): stamped plugins are chat-agent composition
  // (skills, MCP servers, persona) — code mode strips them with the rest of
  // the composed surface; plugin-data/ stays reachable through the group
  // mount either way.
  if (chatSurfaces) {
    mounts.push({
      hostPath: path.join(groupDir, 'plugins'),
      containerPath: CONTAINER_PLUGINS_DIR,
      readonly: true,
      mountClass: 'install-surface',
      scope,
    });
  }

  // The composed project document — one nested RO mount on top of the RW group
  // dir, holding the full text of every instruction source. `container/CLAUDE.md`
  // is read on the host at compose time, so nothing needs it inside the container.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (chatSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({
      hostPath: composedClaudeMd,
      containerPath: '/workspace/agent/CLAUDE.md',
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }

  // Code-mode operating manual — the code runner starts the interactive CLI
  // at /workspace/group, whose CLAUDE.md is the one instruction surface the
  // D16 strip leaves. Host-stamped from the install tree and nested-RO-mounted
  // over the RW session workspace (the container.json pattern), so the agent
  // reads it but cannot edit it; the helper also creates the backing dir the
  // runner's cwd needs (nothing else makes it exist host-side).
  if (containerConfig.codeMode) {
    mounts.push(...devInstructionMounts(sessDir, scope));
    // Host-owned permission posture (D17/T7) — stamped per spawn, RO-mounted
    // at the CLI's admin policy tier; group override wins over the deployment.
    mounts.push(
      ...managedSettingsMounts(
        sessDir,
        scope,
        resolveCodePermissionMode(containerConfig.codePermissionMode, deploymentPermissionMode()),
      ),
    );
    // D17 decision channel — host-writes-only by nested RO mount, so the
    // boundary hook polls a dir the agent cannot forge into.
    mounts.push(...boundaryDecisionMounts(sessDir, scope));
    // Dev-env access materials — this group's slice only, at the same absolute
    // path host-side and container-side, so the kubeconfig `ncl envs get`
    // names is one an agent in here can actually open. Empty when dev-env is off.
    mounts.push(...devEnvMaterialMounts(scope));
  }

  // Per-group .claude-shared at /home/node/.claude (provider state, settings,
  // skill symlinks). Per agent group, not per session.
  if (defaultSurfaces) {
    mounts.push({
      hostPath: claudeDir,
      containerPath: '/home/node/.claude',
      readonly: false,
      mountClass: 'group-state',
      scope,
    });
  }

  // Shared agent-runner source — read-only, same code for all groups.
  const agentRunnerSrc = path.join(projectRoot, 'container', 'agent-runner', 'src');
  mounts.push({
    hostPath: agentRunnerSrc,
    containerPath: '/app/src',
    readonly: true,
    mountClass: 'install-surface',
    scope,
  });

  // Shared skills — read-only, symlinks in .claude-shared/skills/ point here.
  // Chat skills are composition, not capability (D16): code mode doesn't mount
  // them — dev skills arrive workspace-installed by their own route (D22).
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (chatSurfaces && fs.existsSync(skillsSrc)) {
    mounts.push({
      hostPath: skillsSrc,
      containerPath: '/app/skills',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    });
  }

  // Additional mounts from container config — already vetted by the allowlist.
  if (containerConfig.additionalMounts && containerConfig.additionalMounts.length > 0) {
    const validated = validateAdditionalMounts(containerConfig.additionalMounts, agentGroup.name);
    mounts.push(...validated.map((m) => ({ ...m, mountClass: 'allowlisted-extra' as const, scope })));
  }

  // Provider-contributed mounts (e.g. opencode-xdg). Vetted upstream by the
  // in-tree provider registration, which is exactly the 'allowlisted-extra'
  // contract — classing them group-state would deny any provider whose state
  // root sits outside the group subtree.
  if (providerContribution.mounts) {
    mounts.push(...providerContribution.mounts.map((m) => ({ ...m, mountClass: 'allowlisted-extra' as const, scope })));
  }

  return mounts;
}

/** VolumeMount (host vocabulary) → MountSpec (seam vocabulary). */
export function toMountSpecs(mounts: readonly VolumeMount[], defaultScope: string): MountSpec[] {
  return mounts.map((mount) => ({
    class: mount.mountClass ?? 'allowlisted-extra',
    hostPath: mount.hostPath,
    containerPath: mount.containerPath,
    mode: mount.readonly ? ('ro' as const) : ('rw' as const),
    groupScope: mount.scope ?? defaultScope,
    ...(mount.source ? { source: mount.source } : {}),
    ...(mount.subPath ? { subPath: mount.subPath } : {}),
  }));
}

export interface ComposeSessionSpecInput {
  agentGroup: AgentGroup;
  session: Session;
  containerName: string;
  mounts: VolumeMount[];
  containerConfig: import('./container-config.js').ContainerConfig;
  contribution: ProviderContainerContribution;
  projectDocument?: ProviderProjectDocument;
  /**
   * The gateway provider's typed per-session contribution. No argv-shaped
   * input reaches composition anymore: network selection is driver-private,
   * and everything the gateway used to append as raw flags arrives here as
   * env, mounts, and (capability-gated) auxiliary containers.
   */
  gateway: GatewayContribution;
  /** Non-secret configuration supplied by the selected mailbox implementation. */
  mailboxEnvironment: Record<string, string>;
}

/**
 * One source per target: contributed mounts shadow composed mounts on a
 * containerPath collision (a gateway-served stub landing inside a composed
 * tree replaces that path's source — the effect Docker's last-wins `-v` rule
 * used to produce, resolved here so the spec a driver sees is collision-free
 * and `validateSpec` can refuse ambiguity outright).
 */
export function mergeMounts(composed: MountSpec[], contributed: MountSpec[]): MountSpec[] {
  const contributedTargets = new Set(contributed.map((m) => m.containerPath));
  return [...composed.filter((m) => !contributedTargets.has(m.containerPath)), ...contributed];
}

/**
 * Compose the session spec. This is the tail of the old `buildContainerArgs`,
 * with argv assembly removed: the host says what a session *is*, the driver
 * says how it is realized.
 */
export function composeSessionSpec(input: ComposeSessionSpecInput): SessionSpec {
  const { agentGroup, session, containerName, mounts, containerConfig, contribution, projectDocument, gateway, mailboxEnvironment } =
    input;

  const env: Record<string, string> = {
    TZ: containerConfig.timezone ?? TIMEZONE,
    ...mailboxEnvironment,
  };
  // The contributed lane (ContainerSpec.contributedEnv): registry-sourced env,
  // exempt from the credential-NAME check and still refused credential VALUES.
  // The model provider's contribution fills first, the gateway's second — a
  // gateway wins a key collision, the override the old raw-argv append got
  // from Docker's last-wins rule.
  const contributedEnv: Record<string, string> = {
    ...(contribution.env ?? {}),
    ...(gateway.env ?? {}),
  };

  // Trusted runners read the host-authored config through the non-overlapping
  // read-only alias above, never through the agent-writable group path.
  env.NANOCLAW_CONTAINER_JSON = '/run/nanoclaw/group-config/container.json';

  // Code-mode knobs the RUNNER reads from its own process env, which only
  // composition can put there — an operator setting them host-side
  // (process.env or .env, the standard precedence) would otherwise configure
  // nothing, silently. NANOCLAW_CODE_IDLE_TTL_MS and its attach sibling are
  // D14's two lease windows (the activity TTL and the connected-client TTL);
  // NANOCLAW_CODE_ENV is a JSON object forwarded verbatim, which is how a
  // governed deployment supplies the agent CLI's posture — measured on the
  // POC: telemetry (`/api/event_logging/v2/batch`) is an unclassified
  // operation at the gateway and its 403 is FATAL to the CLI, so a governed
  // sandbox sets CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 and the
  // gateway-managed API-key sentinel here rather than baking either in.
  if (containerConfig.codeMode) {
    const settings = [
      'NANOCLAW_CODE_IDLE_TTL_MS',
      'NANOCLAW_CODE_ATTACH_IDLE_TTL_MS',
      'NANOCLAW_CODE_ENV',
      // D17 posture: 'auto' (the CLI prompts) or 'bypass' (it does not,
      // because the gateway is the approver). Whether anything governs the
      // agent's requests is a property of the deployment; a group whose
      // container_configs row sets permission_mode overrides it (T7) — the
      // same value also selects the managed-settings policy buildMounts stamps.
      'NANOCLAW_CODE_PERMISSION_MODE',
    ] as const;
    const fromFile = readEnvFile([...settings]);
    const setting = (name: (typeof settings)[number]): string | undefined =>
      process.env[name]?.trim() || fromFile[name]?.trim() || undefined;

    const idleTtl = setting('NANOCLAW_CODE_IDLE_TTL_MS');
    if (idleTtl) env.NANOCLAW_CODE_IDLE_TTL_MS = idleTtl;

    const attachIdleTtl = setting('NANOCLAW_CODE_ATTACH_IDLE_TTL_MS');
    if (attachIdleTtl) env.NANOCLAW_CODE_ATTACH_IDLE_TTL_MS = attachIdleTtl;

    const permissionMode = containerConfig.codePermissionMode ?? setting('NANOCLAW_CODE_PERMISSION_MODE');
    if (permissionMode) env.NANOCLAW_CODE_PERMISSION_MODE = permissionMode;

    const extra = setting('NANOCLAW_CODE_ENV');
    if (extra) {
      try {
        const parsed = JSON.parse(extra) as Record<string, unknown>;
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value !== 'string') continue;
          if (/(_KEY|_TOKEN|_SECRET|PASSWORD)$/i.test(key)) {
            // Credential-NAMED knobs (the governed POC sets the API-key
            // sentinel this way) ride the contributed lane: the composed
            // lane's key-name check would deny the whole spawn. The lane's
            // value check still applies — a real credential refuses; the
            // public marker passes. Earlier lane entries win: a knob must
            // never shadow the gateway's own contribution.
            if (!(key in contributedEnv)) contributedEnv[key] = value;
          } else if (!(key in env)) {
            // Composed values win: a knob must never shadow TZ or the mailbox
            // environment — and the contributed lane still wins over BOTH at
            // realization, so a knob can never shadow the gateway either.
            env[key] = value;
          }
        }
      } catch (error) {
        log.warn('NANOCLAW_CODE_ENV is not a JSON object of strings — ignored', { error: String(error) });
      }
    }

    // The gateway-managed sentinel, DEFAULTED rather than remembered. On a
    // governed deployment (NANOCO_GATEWAY_ADDRESS present host-side) the CLI
    // must boot in API-key mode carrying the fixed public marker the policy
    // layer exempts; the gateway swaps the header on policy Allow, so the
    // runtime never holds a credential. Measured 2026-08-17: the marker lived
    // only in a manual restart's process env — the first clean systemd
    // restart dropped it from every new pod and the CLI died at
    // "apiKeyHelper failed: did not return a value". Rides the CONTRIBUTED
    // lane: the key name is credential-shaped by necessity (the CLI looks it
    // up by name), and that lane is the sanctioned channel for exactly this —
    // the marker value itself is public and passes the value check anywhere.
    // Anything the deployment set above (NANOCLAW_CODE_ENV or a provider
    // contribution) wins.
    const gatewayAddress =
      process.env.NANOCO_GATEWAY_ADDRESS?.trim() ||
      readEnvFile(['NANOCO_GATEWAY_ADDRESS']).NANOCO_GATEWAY_ADDRESS?.trim();
    if (gatewayAddress && !('ANTHROPIC_API_KEY' in env) && !('ANTHROPIC_API_KEY' in contributedEnv)) {
      contributedEnv.ANTHROPIC_API_KEY = GATEWAY_MANAGED_ENV_MARKER;
    }
  }

  const hostUid = process.getuid?.();
  const hostGid = process.getgid?.();
  // The spec contract (drivers/types.ts, `runAs`): the identity that must read
  // 0600 host-owned material is explicit in the spec for every non-root host,
  // never inherited from an image USER. uid 1000 matches the agent image's
  // node user, so the Docker realization is a no-op there — but a driver whose
  // auxiliary image runs as 65532 needs it said, or that container cannot open
  // its own 0600 session material. uid 0 stays excluded: the hardened posture pins
  // non-root, and Docker's root behavior is unchanged trunk behavior.
  // HOME travels with the mapping, exactly as it did in the old argv: a uid
  // the image has no passwd entry for resolves HOME to '/', and the provider
  // SDK's `mkdir ~/.claude` dies EACCES; /home/node is chmod 777 in the agent
  // image, so it is writable by any uid under both drivers.
  const runAs = hostUid != null && hostUid !== 0 ? { uid: hostUid, gid: hostGid ?? hostUid } : undefined;
  if (runAs) env.HOME = '/home/node';

  const agent: ContainerSpec = {
    role: 'agent',
    // Composition resolves the image; drivers never build and never resolve.
    image: containerConfig.imageTag || CONTAINER_IMAGE,
    env,
    // Run the v2 entry point directly (no tsc, no stdin). The driver maps the
    // 'standard' posture's PID-1 requirement onto this: Docker adds `--init`.
    // Runner-type selection happens HERE and nowhere else (D22): both runners
    // ride the same image and the same /app/src mount; a code-mode group gets
    // the code runner's entrypoint, the chat runner stays untouched.
    command: ['bash', '-c'],
    args: [containerConfig.codeMode ? 'exec bun run /app/src/code-runner/index.ts' : 'exec bun run /app/src/index.ts'],
    mounts: mergeMounts(toMountSpecs(mounts, agentGroup.id), gateway.mounts ?? []),
    contributedEnv,
    labels: { ...(gateway.labels ?? {}) },
  };

  // The folder label (D9) rides the spec so an admission-side check can pin
  // the `groups/<folder>` mount subtree to the session that carries it — the
  // id→folder mapping lives only in the central DB, which no admission-side
  // check can read. It is VERBATIM by contract, deliberately the opposite of
  // the projection lineage labels get: the policy pins hostPaths by
  // concatenating this label into the required prefix
  // (`path.startsWith(GROUPS + '/' + label + '/')` shape), and no
  // admission-side check can invert a hash-suffix projection — a projected
  // value would have the policy compare the real folder against a truncated
  // stand-in and deny every session of the group while naming the wrong
  // culprit. So a folder no driver can carry verbatim refuses HERE, loudly
  // and non-retryably, where the error can say what is actually wrong.
  if (!labelValueLegal(agentGroup.folder)) {
    throw specInvalid(
      `group folder '${agentGroup.folder}' cannot be carried verbatim as the ${GROUP_FOLDER_LABEL} label ` +
        `(label values: <=63 bytes of [A-Za-z0-9._-], alphanumeric at both ends); admission joins ` +
        `on this label verbatim so it is never projected — rename the group folder ` +
        `(\`bun scripts/detect-driver-migration.ts\` enumerates affected groups and the fix)`,
    );
  }

  const workspaceContainers =
    !configuredStatelessK8sHost() && configuredDriverKind() === 'pod' && configuredRuntimeTier() === 'vm'
      ? workspaceMounterContainers({
          groupId: agentGroup.id,
          replicaRoot: configuredWorkspaceReplicaRoot(),
          image: agent.image,
        })
      : [];
  return {
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
    labels: { 'nanoclaw-container-name': containerName, [GROUP_FOLDER_LABEL]: agentGroup.folder },
    projectDocument: projectDocument ?? DEFAULT_PROJECT_DOCUMENT,
    // The gateway's auxiliary containers ride beside the agent; capability-
    // gated in the spawn path before composition ever runs.
    containers: [agent, ...(gateway.containers ?? []), ...workspaceContainers],
    network: 'shared-private',
    hardening: 'standard',
    resources: {
      cpus: CONTAINER_CPU_LIMIT || undefined,
      memoryMb: parseMemoryMb(CONTAINER_MEMORY_LIMIT),
      pidsLimit: parsePidsLimit(CONTAINER_PIDS_LIMIT),
      shmSizeMb: SHM_SIZE_MB,
    },
    // The group's configured tier; the driver refuses one it cannot realize
    // (validateSpec, against capabilities().isolationTiers).
    runtimeTier: containerConfig.runtimeTier ?? configuredRuntimeTier(),
    runAs,
    stopGraceSeconds: STOP_GRACE_SECONDS,
  };
}

/**
 * `CONTAINER_MEMORY_LIMIT` is an operator-facing docker size string ("8g",
 * "512m"). Empty stays undefined — no cap, today's behavior.
 *
 * A bare number is bytes, which is Docker's own rule and therefore what an
 * operator's existing value already means. It is preserved rather than
 * reinterpreted as megabytes: guessing the friendlier meaning would quietly
 * multiply a limit by a million.
 */
export function parseMemoryMb(value: string): number | undefined {
  if (!value.trim()) return undefined;
  const match = /^(\d+(?:\.\d+)?)\s*([bkmg]?)b?$/i.exec(value.trim());
  if (!match) {
    // Fail-closed, like the raw pass-through this replaced: an invalid value
    // used to make Docker reject the spawn, and returning undefined here would
    // silently REMOVE the operator's cap instead — the one wrong direction for
    // a resource limit to fail in.
    throw specInvalid(`CONTAINER_MEMORY_LIMIT '${value}' is not a docker size string ("8g", "512m", "1073741824")`);
  }
  const size = Number(match[1]);
  if (!Number.isFinite(size)) {
    throw specInvalid(`CONTAINER_MEMORY_LIMIT '${value}' is not a docker size string ("8g", "512m", "1073741824")`);
  }
  if (size === 0) return undefined; // Docker's own meaning for 0: no cap.
  switch (match[2].toLowerCase()) {
    case 'g':
      return Math.floor(size * 1024);
    case 'k':
      return Math.max(1, Math.floor(size / 1024));
    case 'b':
    case '':
      return Math.max(1, Math.floor(size / (1024 * 1024)));
    default:
      return Math.floor(size);
  }
}

/** cgroups v2 rejects a pids limit of 0 with EINVAL, so blank/0/garbage means no cap. */
export function parsePidsLimit(value: string): number | undefined {
  const pids = Number(value);
  return Number.isFinite(pids) && pids > 0 ? Math.floor(pids) : undefined;
}

/**
 * Sync skill symlinks in .claude-shared/skills/ to match the container.json
 * selection. Each symlink points to a container path (/app/skills/<name>) so
 * it's dangling on the host but valid inside the container.
 *
 * Not the mechanism the composer stopped using: skill discovery is a directory
 * scan that follows a link wherever it lands, and only `@` imports are gated on
 * resolving inside the project directory.
 */
export function syncSkillSymlinks(
  claudeDir: string,
  containerConfig: import('./container-config.js').ContainerConfig,
): void {
  const skillsDir = path.join(claudeDir, 'skills');
  if (!fs.existsSync(skillsDir)) {
    fs.mkdirSync(skillsDir, { recursive: true });
  }

  const desired = selectedSkillNames(containerConfig);
  const desiredSet = new Set(desired);

  // Remove symlinks not in the desired set
  for (const entry of fs.readdirSync(skillsDir)) {
    const entryPath = path.join(skillsDir, entry);
    let isSymlink = false;
    try {
      isSymlink = fs.lstatSync(entryPath).isSymbolicLink();
    } catch {
      continue;
    }
    if (isSymlink && !desiredSet.has(entry)) {
      fs.unlinkSync(entryPath);
    }
  }

  // Create symlinks for desired skills (container path targets)
  for (const skill of desired) {
    const linkPath = path.join(skillsDir, skill);
    let entry: fs.Stats | undefined;
    try {
      entry = fs.lstatSync(linkPath);
    } catch {
      /* missing */
    }
    if (!entry) {
      fs.symlinkSync(`/app/skills/${skill}`, linkPath);
    } else if (!entry.isSymbolicLink()) {
      // A real entry here is either a template overlay (intentional; see
      // src/group-skills.ts) or a stale pre-refactor skill copy that shadows
      // the shared skill (#3001). No marker distinguishes them yet, so
      // surface the skip instead of staying silent.
      log.warn(
        'Shared skill not symlinked: real entry occupies the path (template overlay or stale pre-refactor copy)',
        {
          skill,
          path: linkPath,
        },
      );
    }
  }
}

/**
 * Resolve the group's skill selection to concrete names — `'all'` recomputes
 * from `container/skills/` so newly-added upstream skills appear automatically.
 */
function selectedSkillNames(containerConfig: import('./container-config.js').ContainerConfig): string[] {
  if (containerConfig.skills !== 'all') return containerConfig.skills;
  const sharedSkillsDir = path.join(process.cwd(), 'container', 'skills');
  return fs.existsSync(sharedSkillsDir)
    ? fs.readdirSync(sharedSkillsDir).filter((e) => {
        try {
          return fs.statSync(path.join(sharedSkillsDir, e)).isDirectory();
        } catch {
          return false;
        }
      })
    : [];
}

const execAsync = promisify(exec);

/** Build a per-agent-group Docker image with custom packages. */
export async function buildAgentGroupImage(agentGroupId: string): Promise<void> {
  const agentGroup = await getAgentGroup(agentGroupId);
  if (!agentGroup) throw new Error('Agent group not found');

  const configRow = await getContainerConfig(agentGroup.id);
  if (!configRow) throw new Error('Container config not found');
  const aptPackages = JSON.parse(configRow.packages_apt) as string[];
  const npmPackages = JSON.parse(configRow.packages_npm) as string[];
  if (aptPackages.length === 0 && npmPackages.length === 0) {
    throw new Error('No packages to install. Use install_packages first.');
  }

  // Image building is not on the runtime path (drivers never build) and shells
  // the local Docker daemon. Both call sites gate on the `imageBuild`
  // capability; this is the backstop for any future caller that forgets.
  if (!getSessionDriver().capabilities().imageBuild) {
    throw new Error('Per-agent-group image builds are unavailable on this runtime driver');
  }

  // Which bytes this is built on. Recorded on the derived image so an operator
  // can tell which base a group's packages were layered onto — the image id
  // rather than a RepoDigest, because a locally built base has no RepoDigest at
  // all and an id is unambiguous either way.
  let baseId = '';
  try {
    const { stdout } = await execAsync(`${CONTAINER_RUNTIME_BIN} image inspect --format '{{.Id}}' ${CONTAINER_IMAGE}`);
    baseId = stdout.trim();
  } catch {
    // Non-fatal: the build below fails on its own if the base is really absent.
  }

  let dockerfile = `FROM ${CONTAINER_IMAGE}\nUSER root\n`;
  if (aptPackages.length > 0) {
    dockerfile += `RUN apt-get update && apt-get install -y ${aptPackages.join(' ')} && rm -rf /var/lib/apt/lists/*\n`;
  }
  if (npmPackages.length > 0) {
    // pnpm skips build scripts unless packages are allowlisted. Append each
    // to /root/.npmrc (base image sets it up for agent-browser) so packages
    // with postinstall — e.g. playwright, puppeteer, native addons — don't
    // install silently broken.
    const allowlist = npmPackages.map((p) => `echo 'only-built-dependencies[]=${p}' >> /root/.npmrc`).join(' && ');
    dockerfile += `RUN ${allowlist} && pnpm install -g ${npmPackages.join(' ')}\n`;
  }
  dockerfile += 'USER node\n';

  // Overwrite the provenance label rather than letting it be inherited.
  //
  // `dev.nanoclaw.image-source` is documented as the one claim a retag cannot
  // forge, and --status treats it as the trustworthy answer. But a derived
  // build inherits the base's labels, so without this a group that has just
  // added arbitrary apt/npm packages would keep asserting `hardened` — the
  // vendor's claim, over bytes the vendor never saw. `derived` is the honest
  // answer, and `derived-from` says what it was layered onto.
  dockerfile += 'LABEL dev.nanoclaw.image-source="derived"\n';
  if (baseId) dockerfile += `LABEL dev.nanoclaw.derived-from="${baseId}"\n`;

  const imageTag = `${CONTAINER_IMAGE_BASE}:${agentGroupId}`;

  log.info('Building per-agent-group image', { agentGroupId, imageTag, apt: aptPackages, npm: npmPackages });

  const tmpDockerfile = path.join(DATA_DIR, `Dockerfile.${agentGroupId}`);
  fs.writeFileSync(tmpDockerfile, dockerfile);
  try {
    // Awaited async exec so the single-threaded host stays responsive during
    // the build (can take minutes) instead of blocking on execSync.
    await execAsync(`${CONTAINER_RUNTIME_BIN} build -t ${imageTag} -f ${tmpDockerfile} .`, {
      cwd: DATA_DIR,
      timeout: 900_000,
    });
  } finally {
    fs.unlinkSync(tmpDockerfile);
  }

  // Store the image tag in the DB
  await updateContainerConfigScalars(agentGroup.id, { image_tag: imageTag });

  log.info('Per-agent-group image built', { agentGroupId, imageTag });
}
