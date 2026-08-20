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
import { getContainerConfig } from './db/container-configs.js';
import { updateContainerConfigScalars } from './db/container-configs.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import { composeGroupClaudeMd } from './claude-md-compose.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb, hasTable } from './db/connection.js';
import { getSession } from './db/sessions.js';
import { getSessionDriver, isSessionEventsDriver } from './drivers/index.js';
import type { SupervisedHandle, SupervisedSnapshot } from './drivers/session-events.js';
import { GROUP_FOLDER_LABEL, labelValueLegal, specInvalid } from './drivers/types.js';
import type { ContainerSpec, MountSpec, SessionFailure, SessionSpec } from './drivers/types.js';
import { getGatewayProvider, type GatewayContribution } from './gateway-providers/index.js';
import { initGroupFilesystem } from './group-init.js';
import { getAgentMailbox } from './mailbox/index.js';
import { stopTypingRefresh } from './modules/typing/index.js';
import { log } from './log.js';
import { validateAdditionalMounts } from './modules/mount-security/index.js';
// Provider host-side config barrel — each provider that needs host-side
// container setup self-registers on import.
import './providers/index.js';
import {
  getProviderContainerConfig,
  providerProvidesAgentSurfaces,
  type ProviderContainerContribution,
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
}

const activeContainers = new Map<string, ActiveSessionRuntime>();

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
  writeSessionContext(agentGroup.id, session.id, await mailbox.runnerContext(mailboxKey));

  // Materialize container.json from DB — writes fresh file and returns
  // the config object, threaded through provider resolution, buildMounts,
  // and buildContainerArgs so we don't re-read.
  const containerConfig = await materializeContainerJson(agentGroup.id);

  const providerName = resolveProviderName(session.agent_provider, containerConfig.provider);
  await initGroupFilesystem(agentGroup, { provider: providerName });

  // Resolve the effective provider + any host-side contribution it declares
  // (extra mounts, env passthrough). Computed once and threaded through both
  // buildMounts and buildContainerArgs so side effects (mkdir, etc.) fire once.
  const { provider, contribution } = await resolveProviderContribution(session, agentGroup, containerConfig);

  const mounts = await buildMounts(agentGroup, session, containerConfig, provider, contribution);
  const containerName = `nanoclaw-v2-${agentGroup.folder}-${Date.now()}`;
  const mailboxEnvironment = await mailbox.runnerEnvironment(mailboxKey);

  const driver = getSessionDriver();
  // The gateway's per-session contribution — typed env and mounts (and, on a
  // driver that manages them, auxiliary containers), merged into the spec
  // BEFORE validation so admission sees the whole session. Fail-closed exactly
  // as the old wiring was: contribute() throwing aborts the spawn, the inbound
  // row stays pending, and the sweep retries. Network selection is NOT here —
  // topology is driver-private (see `drivers/index.ts`).
  const gateway = await getGatewayProvider().contribute({
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
    groupName: agentGroup.name,
    capabilities: driver.capabilities(),
  });
  if (gateway.containers?.length && !driver.capabilities().auxiliaryContainers) {
    // Named at composition, where the error can say which side to change —
    // not left for the driver's refusal backstop to discover.
    throw specInvalid(
      `gateway provider composed auxiliary containers, but driver '${driver.kind}' does not manage them ` +
        `(capabilities().auxiliaryContainers is false)`,
    );
  }

  const spec = composeSessionSpec({
    agentGroup,
    session,
    containerName,
    mounts,
    containerConfig,
    contribution,
    gateway,
    mailboxEnvironment,
  });

  log.info('Spawning session', { sessionId: session.id, agentGroup: agentGroup.name, containerName });

  // Clear any orphan heartbeat from a previous container instance — the sweep's
  // ceiling check treats a missing file as "fresh spawn, give grace". Without
  // this, the stale mtime can trigger an immediate kill before the new container
  // touches the file itself.
  fs.rmSync(heartbeatPath(agentGroup.id, session.id), { force: true });

  const handle = await driver.prepare(spec);

  const runtime = registerRuntime(session.id, handle, containerName, false);

  try {
    await armSessionLifecycle({
      handle,
      onTerminal: (failure) => {
        void finishAndResolve(session.id, failure);
      },
      afterStart: () => {
        return markContainerRunning(session.id);
      },
    });
  } catch (err) {
    if (activeContainers.get(session.id) === runtime && !runtime.finished) {
      activeContainers.delete(session.id);
      runtime.resolveFinished();
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
    adopted,
    exitCallbacks: [],
    finished: false,
    finishedPromise,
    resolveFinished,
  };
  activeContainers.set(sessionId, runtime);
  return runtime;
}

/** Single-shot finalization: only the first terminal event resolves shutdown. */
async function finishAndResolve(sessionId: string, failure?: SessionFailure): Promise<void> {
  const runtime = activeContainers.get(sessionId);
  if (!runtime || runtime.finished) return;
  runtime.finished = true;
  try {
    await finish(sessionId, runtime, failure);
  } finally {
    runtime.resolveFinished();
  }
}

async function finish(sessionId: string, runtime: ActiveSessionRuntime, failure?: SessionFailure): Promise<void> {
  const { containerName } = runtime;
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
      if (!entry.finished) void finishAndResolve(sessionId, undefined);
    },
    (err: unknown) => {
      log.error('Failed to stop session', { sessionId, reason, err });
      if (!entry.finished) void finishAndResolve(sessionId, undefined);
    },
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
    const runtime = registerRuntime(session.id, handle, handle.name, true);
    runtime.stopReason = undefined;
    handle.onTerminal((failure) => {
      void finishAndResolve(session.id, failure);
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
  return { adopted, stopped };
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

  const claudeDir = path.join(DATA_DIR, 'v2-sessions', agentGroup.id, '.claude-shared');
  if (defaultSurfaces) {
    syncSkillSymlinks(claudeDir, containerConfig);

    // Compose CLAUDE.md fresh every spawn from the shared base, enabled skill
    // fragments, and MCP server instructions. See `claude-md-compose.ts`.
    await composeGroupClaudeMd(agentGroup);
  }

  const mounts: VolumeMount[] = [];
  const sessDir = sessionDir(agentGroup.id, session.id);
  const groupDir = path.resolve(GROUPS_DIR, agentGroup.folder);
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

  // container.json — nested RO mount on top of RW group dir so the agent can
  // read its config but cannot modify it. Composed per group, so 'group-state'
  // read-only rather than 'install-surface': the install-surface rule is an
  // enumerated release-surface allowlist, and this path is under the group.
  const containerJsonPath = path.join(groupDir, 'container.json');
  if (fs.existsSync(containerJsonPath)) {
    mounts.push({
      hostPath: containerJsonPath,
      containerPath: '/workspace/agent/container.json',
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
  mounts.push({
    hostPath: path.join(groupDir, 'plugins'),
    containerPath: CONTAINER_PLUGINS_DIR,
    readonly: true,
    mountClass: 'install-surface',
    scope,
  });

  // Composer-managed CLAUDE.md artifacts — nested RO mounts, regenerated from
  // the shared base + fragments on every spawn.
  const composedClaudeMd = path.join(groupDir, 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(composedClaudeMd)) {
    mounts.push({
      hostPath: composedClaudeMd,
      containerPath: '/workspace/agent/CLAUDE.md',
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }
  const fragmentsDir = path.join(groupDir, '.claude-fragments');
  if (defaultSurfaces && fs.existsSync(fragmentsDir)) {
    mounts.push({
      hostPath: fragmentsDir,
      containerPath: '/workspace/agent/.claude-fragments',
      readonly: true,
      mountClass: 'group-state',
      scope,
    });
  }

  // Shared CLAUDE.md — a release surface, read-only.
  const sharedClaudeMd = path.join(projectRoot, 'container', 'CLAUDE.md');
  if (defaultSurfaces && fs.existsSync(sharedClaudeMd)) {
    mounts.push({
      hostPath: sharedClaudeMd,
      containerPath: '/app/CLAUDE.md',
      readonly: true,
      mountClass: 'install-surface',
      scope,
    });
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
  const skillsSrc = path.join(projectRoot, 'container', 'skills');
  if (fs.existsSync(skillsSrc)) {
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
  }));
}

export interface ComposeSessionSpecInput {
  agentGroup: AgentGroup;
  session: Session;
  containerName: string;
  mounts: VolumeMount[];
  containerConfig: import('./container-config.js').ContainerConfig;
  contribution: ProviderContainerContribution;
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
  const { agentGroup, session, containerName, mounts, containerConfig, contribution, gateway, mailboxEnvironment } =
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
    command: ['bash', '-c'],
    args: ['exec bun run /app/src/index.ts'],
    mounts: mergeMounts(toMountSpecs(mounts, agentGroup.id), gateway.mounts ?? []),
    contributedEnv,
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

  return {
    key: { installSlug: INSTALL_SLUG, agentGroupId: agentGroup.id, sessionId: session.id },
    labels: { 'nanoclaw-container-name': containerName, [GROUP_FOLDER_LABEL]: agentGroup.folder },
    // The gateway's auxiliary containers ride beside the agent; capability-
    // gated in the spawn path before composition ever runs.
    containers: [agent, ...(gateway.containers ?? [])],
    network: 'shared-private',
    hardening: 'standard',
    resources: {
      cpus: CONTAINER_CPU_LIMIT || undefined,
      memoryMb: parseMemoryMb(CONTAINER_MEMORY_LIMIT),
      pidsLimit: parsePidsLimit(CONTAINER_PIDS_LIMIT),
      shmSizeMb: SHM_SIZE_MB,
    },
    runtimeTier: 'container',
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
