/**
 * The `remote-mailbox` session driver: the install's `docker` driver (or the
 * driver NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER names), wrapped so agent groups
 * listed in NANOCLAW_REMOTE_MAILBOX_GROUPS reach their mailbox over HTTP
 * instead of a mounted session directory. Selected with
 * `NANOCLAW_RUNTIME_DRIVER=remote-mailbox`; registered by the import appended
 * to `src/drivers/installed.ts`.
 *
 * For an opted-in group, `prepare()` rewrites the agent container's spec
 * before delegating:
 *   - `/workspace` comes from a per-session scratch dir, not the session dir;
 *   - the mailbox URL, a fresh per-spawn token and the session ride the
 *     contributed env lane (the token is credential-named);
 *   - the heartbeat is a file in a per-session directory mount, hard-linked
 *     to the host's `<sessionDir>/.heartbeat` and named by
 *     NANOCLAW_HEARTBEAT_PATH. A directory, not a single-file mount, so
 *     runtimes that mount only directories (MicroVMs) carry it too.
 * If the inner prepare refuses, only this spawn's token is withdrawn.
 *
 * Release: every handle of a session with remote-mailbox state (prepared or
 * adopted) is wrapped so a successful `stop()` revokes the session's tokens and
 * deletes its scratch dir. Core's `finish()` stops the handle before any other
 * bookkeeping on every container end — self-exit, kill, failed start, adopted
 * runtimes alike — and never on host shutdown, so this fires exactly where
 * core's own release did.
 *
 * Every other group: the spec and handles pass through untouched.
 *
 * Egress lockdown: an agent that joins the locked network gets the mailbox
 * forwarder's alias as its mailbox host (forwarder.ts).
 *
 * Lifecycle: the service (and under lockdown the forwarder) starts in
 * `ensureReady()` and registers its own shutdown callback once it is
 * listening (startup.ts) — nothing registers at import. Listing groups without selecting this driver is reported at import,
 * since those groups would otherwise silently keep the mounted session
 * directory.
 */
import { getSessionDriverFactory, registerSessionDriver } from '../../drivers/driver-registry.js';
import {
  specInvalid,
  type ContainerSpec,
  type MountPolicy,
  type SessionDriver,
  type SessionExecSpec,
  type SessionHandle,
  type SessionKey,
  type SessionSpec,
  type SessionStatus,
} from '../../drivers/types.js';
import { EGRESS_LOCKDOWN } from '../../config.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { REMOTE_MAILBOX_GROUPS, REMOTE_MAILBOX_INNER_DRIVER } from './config.js';
import { ensureRemoteMailboxService } from './startup.js';
import {
  hasRemoteMailboxState,
  isRemoteMailboxGroup,
  issueRemoteMailboxEnv,
  prepareRemoteHeartbeat,
  prepareRemoteWorkspace,
  REMOTE_HEARTBEAT_FILE,
  releaseRemoteMailbox,
  remoteMailboxEnabled,
  withdrawRemoteMailboxEnv,
} from './spawn.js';

export const REMOTE_MAILBOX_DRIVER_KIND = 'remote-mailbox';
/** Where the heartbeat directory is bound in the agent container. */
export const REMOTE_HEARTBEAT_CONTAINER_DIR = '/opt/nanoclaw-heartbeat';
/** The file inside it the runner touches (NANOCLAW_HEARTBEAT_PATH). */
export const REMOTE_HEARTBEAT_CONTAINER_PATH = `${REMOTE_HEARTBEAT_CONTAINER_DIR}/${REMOTE_HEARTBEAT_FILE}`;

/** Rewrite an opted-in session's agent container. Pure apart from the paths it is handed. */
export function rewriteRemoteMailboxSpec(
  spec: SessionSpec,
  paths: { workspace: string; heartbeatDir: string },
  mailboxEnv: Record<string, string>,
): SessionSpec {
  const agents = spec.containers.filter((c) => c.role === 'agent');
  if (agents.length !== 1) throw specInvalid('remote mailbox: spec must carry exactly one agent container');
  const rewrite = (container: ContainerSpec): ContainerSpec => {
    if (container.role !== 'agent') return container;
    if (!container.mounts.some((m) => m.containerPath === '/workspace')) {
      throw specInvalid('remote mailbox: agent container has no /workspace mount to replace');
    }
    if (container.mounts.some((m) => m.containerPath === REMOTE_HEARTBEAT_CONTAINER_DIR)) {
      throw specInvalid(`remote mailbox: ${REMOTE_HEARTBEAT_CONTAINER_DIR} is already mounted`);
    }
    return {
      ...container,
      mounts: [
        ...container.mounts.map((m) => (m.containerPath === '/workspace' ? { ...m, hostPath: paths.workspace } : m)),
        {
          class: 'group-state',
          hostPath: paths.heartbeatDir,
          containerPath: REMOTE_HEARTBEAT_CONTAINER_DIR,
          mode: 'rw',
          groupScope: spec.key.agentGroupId,
        },
      ],
      env: { ...container.env, NANOCLAW_HEARTBEAT_PATH: REMOTE_HEARTBEAT_CONTAINER_PATH },
      contributedEnv: { ...(container.contributedEnv ?? {}), ...mailboxEnv },
    };
  };
  return { ...spec, containers: spec.containers.map(rewrite) };
}

function remoteKey(key: SessionKey) {
  return { agentGroupId: key.agentGroupId, sessionId: key.sessionId };
}

/** Release the session's remote-mailbox state once a stop has actually succeeded. */
class ReleasingHandle implements SessionHandle {
  constructor(private readonly inner: SessionHandle) {}

  get key(): SessionKey {
    return this.inner.key;
  }
  get name(): string {
    return this.inner.name;
  }
  start(): Promise<void> {
    return this.inner.start();
  }
  status(): Promise<SessionStatus> {
    return this.inner.status();
  }
  execSpec(command: string[]): SessionExecSpec {
    return this.inner.execSpec(command);
  }
  async stop(reason: string): Promise<void> {
    await this.inner.stop(reason);
    releaseRemoteMailbox(remoteKey(this.inner.key));
  }
}

function track(handle: SessionHandle): SessionHandle {
  const key = remoteKey(handle.key);
  return isRemoteMailboxGroup(key.agentGroupId) || hasRemoteMailboxState(key) ? new ReleasingHandle(handle) : handle;
}

export function withRemoteMailbox(inner: SessionDriver): SessionDriver {
  const driver: SessionDriver = {
    kind: `${REMOTE_MAILBOX_DRIVER_KIND}(${inner.kind})`,
    capabilities: () => inner.capabilities(),
    // Before adoption: the host calls this once at startup, and containers
    // adopted from a previous host may already be retrying against the port.
    ensureReady: async () => {
      await inner.ensureReady?.();
      await ensureRemoteMailboxService();
    },
    prepare: async (spec) => {
      if (!isRemoteMailboxGroup(spec.key.agentGroupId)) return inner.prepare(spec);
      const key = remoteKey(spec.key);
      // Same rule as the docker driver's network choice: under lockdown every
      // agent not routed to a session container joins the locked network.
      const viaForwarder = EGRESS_LOCKDOWN && spec.networkAccess.target.kind !== 'session-container';
      const mailboxEnv = issueRemoteMailboxEnv(key, viaForwarder);
      try {
        const rewritten = rewriteRemoteMailboxSpec(
          spec,
          { workspace: prepareRemoteWorkspace(key), heartbeatDir: prepareRemoteHeartbeat(key) },
          mailboxEnv,
        );
        return track(await inner.prepare(rewritten));
      } catch (err) {
        withdrawRemoteMailboxEnv(key, mailboxEnv);
        throw err;
      }
    },
    listSessions: async (installSlug) =>
      (await inner.listSessions(installSlug)).map((snapshot) => ({ ...snapshot, handle: track(snapshot.handle) })),
    watchSessions: (installSlug, onEvent) => inner.watchSessions(installSlug, onEvent),
  };
  if (inner.reconcileNetworkAccess) {
    driver.reconcileNetworkAccess = (access, handle) => inner.reconcileNetworkAccess!(access, handle);
  }
  if (inner.reapResidue) driver.reapResidue = (installSlug) => inner.reapResidue!(installSlug);
  return driver;
}

/**
 * Wraps the driver NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER names (default
 * `docker`). Looked up when the driver is built, not at import: `docker`
 * registers after the overlays load.
 */
export function createRemoteMailboxDriver(policy: MountPolicy): SessionDriver {
  const innerKind = REMOTE_MAILBOX_INNER_DRIVER;
  if (innerKind === REMOTE_MAILBOX_DRIVER_KIND) {
    throw new Error('NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER cannot name the remote-mailbox driver itself');
  }
  const factory = getSessionDriverFactory(innerKind);
  if (!factory) {
    throw new Error(
      `remote-mailbox driver: no '${innerKind}' driver is registered to wrap (NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER)`,
    );
  }
  return withRemoteMailbox(factory(policy));
}

registerSessionDriver(REMOTE_MAILBOX_DRIVER_KIND, createRemoteMailboxDriver);

/** The groups are listed but another driver is selected: say which setting is missing. */
export function warnIfDriverNotSelected(env: NodeJS.ProcessEnv = process.env): void {
  if (!remoteMailboxEnabled()) return;
  const kind = (
    env.NANOCLAW_RUNTIME_DRIVER?.trim() ||
    readEnvFile(['NANOCLAW_RUNTIME_DRIVER']).NANOCLAW_RUNTIME_DRIVER?.trim() ||
    ''
  ).toLowerCase();
  if (kind === REMOTE_MAILBOX_DRIVER_KIND) return;
  log.error(
    `NANOCLAW_REMOTE_MAILBOX_GROUPS is set but NANOCLAW_RUNTIME_DRIVER is not '${REMOTE_MAILBOX_DRIVER_KIND}': ` +
      'the listed groups keep the mounted session directory',
    { groups: REMOTE_MAILBOX_GROUPS },
  );
}

warnIfDriverNotSelected();
