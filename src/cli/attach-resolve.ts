/**
 * Attach resolution — the shared host-side path from an agent group to the
 * exec spec the ncl client runs . Extracted
 * mechanically from the `groups attach` handler so the sandbox sandbox verbs
 * (`ncl sandboxes new/attach`) resolve attaches through the exact same
 * policy; error texts are pinned by groups-attach.test.ts and must not drift.
 *
 * Attachment always execs the image's tmux client against the runner's
 * private socket. Detach is Ctrl-b then d; exit codes are tmux's. Keep the
 * socket and session literals aligned with the runner's tmux-session.ts.
 */
import { wakeContainer } from '../container-runner.js';
import { getContainerConfig } from '../db/container-configs.js';
import { findAttachableSessions } from '../db/sessions.js';
import { getSessionDriver, type SessionExecSpec, type SessionHandle } from '../drivers/index.js';
import { getInstallSlug } from '../install-slug.js';
import type { AgentGroup, Session } from '../types.js';

/** How long attach waits for a lazily-woken session's runtime to report running. */
export const ATTACH_WAKE_WAIT_MS = 90_000;

/**
 * Attach-exec evidence (liveness v2). Hand-synced with the runner's
 * ATTACH_ACTIVITY_PATH (code-runner/agent-state.ts) — the same lockstep
 * discipline as the tmux-socket literal below.
 */
const ATTACH_ACTIVITY_PATH = '/tmp/code-runner/attach-activity';

/**
 * Wrap an exec the attach path routes into the container so it stamps the attach-activity
 * file on the way in; the runner reads the stamp's mtime as liveness
 * activity (the reaper case closed at the one choke point every
 * attach-routed exec passes through, so any future sandbox verb inherits the
 * evidence for free). The stamp is best-effort by construction: a failed
 * mkdir/write still execs the client — evidence is never worth the attach.
 * Stamped content is a UTC second for debuggability; only the mtime is read.
 */
function withAttachActivityStamp(command: string[]): string[] {
  // Runtime readiness can precede the runner's terminal. Wait for the actual
  // tmux session on the same path used by local, SSH and relayed attachments.
  const wait =
    'n=0; until tmux -S /tmp/code-runner/tmux.sock has-session -t agent 2>/dev/null; do ' +
    'n=$((n+1)); if [ "$n" -ge 90 ]; then echo "code mode: terminal did not become ready within 90s; check the Host logs" >&2; exit 1; fi; sleep 1; done; ';
  return [
    'sh',
    '-c',
    `{ mkdir -p /tmp/code-runner && date -u +%Y-%m-%dT%H:%M:%SZ > ${ATTACH_ACTIVITY_PATH}; } 2>/dev/null; ${wait}exec "$@"`,
    'attach',
    ...command,
  ];
}

/** What the ncl client needs to hand its terminal over (cli/attach-exec.ts). */
export interface AttachResolution {
  attachExec: SessionExecSpec;
  group: string;
  containerName: string;
}

/**
 * Resolve the live runtime handle for the first of `sessions` that has one.
 * Resolution goes through the session driver's own discovery (the adoption
 * contract): the host's in-memory container name is a lineage label, not the
 * runtime name — under some drivers the two never match, and even under
 * docker the real name is key-derived (`ncl-<session>`), not the label.
 */
async function findLiveSessionHandle(sessions: Session[]): Promise<SessionHandle | undefined> {
  if (sessions.length === 0) return undefined;
  const snapshots = await getSessionDriver().listSessions(getInstallSlug());
  const bySession = new Map(snapshots.map((s) => [s.handle.key.sessionId, s]));
  for (const session of sessions) {
    const snapshot = bySession.get(session.id);
    if (!snapshot) continue;
    // The snapshot's phase is the listing's own truth (corpse-honest): no
    // per-handle status() round trip, and a self-exited runtime never
    // resolves as attachable.
    if (snapshot.phase === 'running') return snapshot.handle;
  }
  return undefined;
}

/**
 * Resolve an attach for `group`: gate on code mode, find (or lazily wake)
 * a live session runtime, and return the exec spec the driver's handle
 * composed. Group lookup stays with the callers — verbs differ in how they
 * name a group (id-or-folder) and in their not-found texts.
 */
export async function resolveAttachForGroup(
  group: AgentGroup,
  opts?: { wakeWaitMs?: number },
): Promise<AttachResolution> {
  const cfg = await getContainerConfig(group.id);
  if (cfg?.code_mode !== 1) {
    throw new Error(
      `${group.name} is not a code-mode group — flip it with: ` +
        `ncl groups config update --id ${group.id} --code-mode true (takes effect on respawn)`,
    );
  }
  // Host-only dispatch and the local socket establish operator authority.
  // A group can hold several active sessions (one per wired messaging
  // group/thread, plus system task and sandbox sessions — a schedule-driven
  // box may hold ONLY those); attach to the one that actually has a live
  // runtime, not merely the newest row.
  const sessions = await findAttachableSessions(group.id);
  let live = await findLiveSessionHandle(sessions);
  if (!live && sessions.length > 0) {
    // the sandbox entry lazily spawns — wake the preferred session
    // (channel-wired first, else the newest task session) instead
    // of refusing, then wait for the runtime to come up (a container needs a
    // few seconds; the attach client separately retries the socket).
    if (await wakeContainer(sessions[0])) {
      const deadline = Date.now() + (opts?.wakeWaitMs ?? ATTACH_WAKE_WAIT_MS);
      live = await findLiveSessionHandle(sessions);
      while (!live && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 500));
        live = await findLiveSessionHandle(sessions);
      }
    }
  }
  if (!live) {
    throw new Error(
      sessions.length === 0
        ? `${group.name} has no session yet — message the agent once to create one, then re-attach`
        : `${group.name}'s session container did not come up — check the host logs, then re-attach`,
    );
  }
  // The client (which owns the terminal) execs this; policy — which
  // container, which entry — is decided here, host-side. The argv comes
  // from the driver's handle: only the driver knows its exec dialect.
  // The tmux client's own environment is the exec transport's, not the
  // operator's: an exec transport may forward neither TERM nor the locale, so a
  // bare `tmux attach` announces TERM=xterm (no 256-color/truecolor output)
  // and runs non-UTF-8 (filled blocks and box drawing render as junk).
  // `env TERM=…` restores the color floor and `-u` forces UTF-8 regardless
  // of what the transport dropped. Both were measured on a prototype.
  const clientCmd = [
    'env',
    'TERM=xterm-256color',
    'tmux',
    '-u',
    '-S',
    '/tmp/code-runner/tmux.sock',
    'attach-session',
    '-t',
    'agent',
  ];
  return {
    attachExec: live.execSpec(withAttachActivityStamp(clientCmd)),
    group: group.name,
    containerName: live.name,
  };
}
