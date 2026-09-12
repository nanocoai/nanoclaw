/**
 * Sandboxes — the in-process API behind `ncl sandboxes new | list | attach`
 * and `ncl groups attach`.
 *
 * A sandbox IS a code-mode agent group. The verbs here are the one place the
 * lifecycle is decided: `create` composes the existing group-creation
 * machinery with code_mode written before the first spawn (runner selection
 * happens only at spawn, so a creation-time config write needs no restart)
 * and creates the group's sandbox session; `list` is the reap-visibility
 * surface (containers reap on the in-container idle lease, the group and
 * workspace stay durable); `attach` resolves — lazily waking — the live
 * session runtime and returns the handle and the command an attaching
 * client runs inside it. The CLI resource renders and execs; anything else
 * on the host that needs to land a terminal in a sandbox calls the same
 * functions and holds the bytes itself.
 *
 * Authority is the caller's: the ncl socket admits only host operators to
 * these verbs, and nothing here re-checks it.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { GROUPS_DIR } from '../config.js';
import { wakeContainer } from '../container-runner.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../db/agent-groups.js';
import { getDb } from '../db/connection.js';
import { getContainerConfig, updateContainerConfigScalars } from '../db/container-configs.js';
import { findAttachableSessions } from '../db/sessions.js';
import { getSessionDriver, labelValueLegal, type SessionHandle } from '../drivers/index.js';
import { groupFolderExistsOnDisk, isValidGroupFolder } from '../group-folder.js';
import { initGroupFilesystem } from '../group-init.js';
import { getInstallSlug } from '../install-slug.js';
import { log } from '../log.js';
import { fireSandboxCreated } from './hooks.js';
import { resolveSandboxSession } from '../session-manager.js';
import { isValidTimezone } from '../timezone.js';
import type { AgentGroup, Session } from '../types.js';

/** How long attach waits for a lazily-woken session's runtime to report running. */
export const ATTACH_WAKE_WAIT_MS = 90_000;

/**
 * The first-ever spawn of a brand-new group is the slow path — a cold session
 * runtime can take ~10s to come up and an image pull blows a short attach
 * wait — so `create` waits longer than plain attach when it lands attached.
 */
export const NEW_SANDBOX_WAKE_WAIT_MS = 30_000;

/**
 * Attach-exec evidence (liveness). Hand-synced with the runner's
 * ATTACH_ACTIVITY_PATH (code-runner/agent-state.ts) — the same lockstep
 * discipline as the tmux-socket literal below.
 */
const ATTACH_ACTIVITY_PATH = '/tmp/code-runner/attach-activity';

/** The runner's tmux socket and session name (code-runner/tmux-session.ts). */
export const TMUX_SOCKET_PATH = '/tmp/code-runner/tmux.sock';
export const TMUX_SESSION_NAME = 'agent';

const GENERATED_NAME_BASE = 'sandbox';

/**
 * The live handle and the command behind an attach — for a caller that holds
 * the bytes itself. `handle.execSpec(command)` is the argv a client program
 * runs; `handle.execStream?.(command, …)` is the same exec held in-process,
 * when the driver offers it (drivers/types.ts SessionExecStream).
 */
export interface AttachTarget {
  handle: SessionHandle;
  /** The argv to run inside the session: the attach-activity stamp, then the tmux client. */
  command: string[];
  /** The group's display name. */
  group: string;
  /** The session runtime's own name (the driver's, not the host's lineage label). */
  containerName: string;
}

export interface CreateSandboxInput {
  /** The sandbox name (the group folder); generated when omitted. */
  name?: string;
  provider?: string;
  permissionMode?: string;
  timezone?: string;
}

export interface CreatedSandbox {
  group: AgentGroup;
  session: Session;
}

export interface SandboxListRow {
  sandbox: string;
  id: string;
  status: 'running' | 'cold';
  sessions: number;
  container_status: string | null;
  last_active: string | null;
  created_at: string;
}

/**
 * A sandbox name is the group folder AND rides the session driver's
 * group-folder label VERBATIM (SessionSpec label `nanoclaw-group-folder`,
 * refused at composition when label-illegal) — so both grammars must hold at
 * creation, not at first spawn. isValidGroupFolder alone would admit 64 chars
 * and a trailing underscore, both label-illegal.
 */
export function validateSandboxName(name: string): void {
  if (!isValidGroupFolder(name) || !labelValueLegal(name)) {
    throw new Error(
      `invalid sandbox name "${name}" — up to 63 chars of [A-Za-z0-9_-], starting and ending ` +
        `alphanumeric ('global' is reserved; the name is the group folder and rides the session ` +
        `driver's group-folder label verbatim)`,
    );
  }
}

/**
 * Suffix-dedupe name generation (create-agent.ts precedent), globally across
 * agent_groups.folder AND the on-disk groups/ dir: a folder on disk with no
 * claiming DB row is deleted-group residue and must never be adopted.
 */
export async function generateSandboxName(): Promise<string> {
  let folder = GENERATED_NAME_BASE;
  let suffix = 2;
  while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
    folder = `${GENERATED_NAME_BASE}-${suffix}`;
    suffix++;
  }
  return folder;
}

/** id-first, then folder — the attach resolution order. Undefined when neither matches. */
export async function findSandboxGroup(nameOrId: string): Promise<AgentGroup | undefined> {
  return (await getAgentGroup(nameOrId)) ?? (await getAgentGroupByFolder(nameOrId));
}

/** Every code-mode group, oldest first. */
export async function listSandboxGroups(): Promise<Pick<AgentGroup, 'id' | 'folder' | 'created_at'>[]> {
  return getDb().all<Pick<AgentGroup, 'id' | 'folder' | 'created_at'>>(
    `SELECT g.id, g.folder, g.created_at
       FROM agent_groups g
       JOIN container_configs c ON c.agent_group_id = g.id
      WHERE c.code_mode = 1
      ORDER BY g.created_at`,
  );
}

/**
 * Create a sandbox: the exact creation machinery of `groups create` (fresh
 * branch) — agent_groups row, workspace folder, container_configs row — with
 * code mode written before any spawn, then the group's sandbox session.
 *
 * Collision is a refusal, deliberately NOT groups-create's idempotent
 * return: `new` promises a FRESH box, and silently landing someone in an
 * existing agent's workspace would hand over that agent's memory and
 * materials.
 */
export async function createSandbox(input: CreateSandboxInput = {}): Promise<CreatedSandbox> {
  const requested = input.name;
  if (requested !== undefined) validateSandboxName(requested);

  const provider = input.provider ?? 'claude';
  if (provider !== 'claude') {
    throw new Error('code mode currently supports only Claude Code');
  }

  const permissionMode = input.permissionMode;
  if (permissionMode !== undefined && permissionMode !== 'auto' && permissionMode !== 'bypass') {
    throw new Error('--permission-mode must be auto or bypass');
  }

  const timezone = input.timezone;
  if (timezone !== undefined && !isValidTimezone(timezone)) {
    throw new Error(`invalid --timezone: "${timezone}" is not an IANA timezone id (e.g. "Europe/Lisbon")`);
  }

  if (requested !== undefined) {
    if (await getAgentGroupByFolder(requested)) {
      throw new Error(`sandbox '${requested}' already exists — attach to it: ncl sandboxes attach ${requested}`);
    }
    if (groupFolderExistsOnDisk(requested)) {
      throw new Error(
        `group folder 'groups/${requested}' already exists on disk but no sandbox claims it — ` +
          `deleted-group residue is never adopted under a new identity. Move or remove the folder, ` +
          `or pick a different --name.`,
      );
    }
  }
  const folder = requested ?? (await generateSandboxName());

  const id = `ag-${randomUUID()}`;
  const group: AgentGroup = {
    id,
    name: folder,
    folder,
    agent_provider: null,
    created_at: new Date().toISOString(),
  };
  await createAgentGroup(group);
  let session: Session;
  try {
    await initGroupFilesystem(group, { provider });

    // Creation-time code mode — written BEFORE the first spawn, so no restart
    // is needed: spawn reads the flag for entrypoint selection, code-mode
    // mounts and code env. No other creation path sets it.
    await updateContainerConfigScalars(id, {
      code_mode: 1,
      ...(permissionMode !== undefined ? { permission_mode: permissionMode } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
    });

    session = (await resolveSandboxSession(id)).session;
  } catch (error) {
    // All or nothing: a half-made sandbox (a row without its workspace, a
    // folder without its config) would be refused as residue by the next
    // `new` and adopted by nothing. Undo what this call created, then say why.
    await getDb().run('DELETE FROM agent_groups WHERE id = ?', id); // container_configs and sessions cascade
    fs.rmSync(path.join(GROUPS_DIR, folder), { recursive: true, force: true });
    log.warn('Sandbox not created — rolled back', { sandbox: folder, agentGroupId: id, error: String(error) });
    throw error;
  }
  log.info('Sandbox created', { sandbox: folder, agentGroupId: id, sessionId: session.id });
  // Modules learn of the new sandbox here — after the rows exist and before
  // the first wake. A listener that throws is logged, never the verb's problem.
  await fireSandboxCreated(group);
  return { group, session };
}

function newestActivity(sessions: Session[]): { container_status: string | null; last_active: string | null } {
  let best: Session | undefined;
  for (const s of sessions) {
    const stamp = s.last_active ?? s.created_at;
    if (!best || stamp > (best.last_active ?? best.created_at)) best = s;
  }
  return { container_status: best?.container_status ?? null, last_active: best?.last_active ?? null };
}

/**
 * Every sandbox with its live runtime status. Live phase comes through the
 * driver's own discovery (the adoption contract — lineage names lie): one
 * listSessions sweep, where each snapshot carries the phase the listing
 * itself observed, grouped by owning agent group. No reaper runs here: TTL
 * posture is the in-container lease, list only shows the result.
 */
export async function listSandboxes(): Promise<SandboxListRow[]> {
  const groups = await listSandboxGroups();
  const running = new Set<string>();
  for (const snapshot of await getSessionDriver().listSessions(getInstallSlug())) {
    if (snapshot.phase === 'running') running.add(snapshot.handle.key.agentGroupId);
  }
  return Promise.all(
    groups.map(async (g): Promise<SandboxListRow> => {
      const sessions = await findAttachableSessions(g.id);
      const { container_status, last_active } = newestActivity(sessions);
      return {
        sandbox: g.folder,
        id: g.id,
        status: running.has(g.id) ? 'running' : 'cold',
        sessions: sessions.length,
        container_status,
        last_active,
        created_at: g.created_at,
      };
    }),
  );
}

/**
 * Wrap an exec the attach path routes into the container so it stamps the
 * attach-activity file on the way in; the runner reads the stamp's mtime as
 * liveness activity (the reaper case closed at the one choke point every
 * attach-routed exec passes through, so any future sandbox verb inherits the
 * evidence for free). The stamp is best-effort by construction: a failed
 * mkdir/write still execs the client — evidence is never worth the attach.
 * Stamped content is a UTC second for debuggability; only the mtime is read.
 */
function withAttachActivityStamp(command: string[]): string[] {
  // Runtime readiness can precede the runner's terminal. Wait for the actual
  // tmux session on the same path every attachment takes.
  const wait =
    `n=0; until tmux -S ${TMUX_SOCKET_PATH} has-session -t ${TMUX_SESSION_NAME} 2>/dev/null; do ` +
    'n=$((n+1)); if [ "$n" -ge 90 ]; then echo "code mode: terminal did not become ready within 90s; check the Host logs" >&2; exit 1; fi; sleep 1; done; ';
  return [
    'sh',
    '-c',
    `{ mkdir -p /tmp/code-runner && date -u +%Y-%m-%dT%H:%M:%SZ > ${ATTACH_ACTIVITY_PATH}; } 2>/dev/null; ${wait}exec "$@"`,
    'attach',
    ...command,
  ];
}

/**
 * The tmux client command an attachment runs inside the session. The
 * client's own environment is the exec transport's, not the operator's: an
 * exec transport may forward neither TERM nor the locale, so a bare
 * `tmux attach` announces TERM=xterm (no 256-color/truecolor output) and
 * runs non-UTF-8 (filled blocks and box drawing render as junk).
 * `env TERM=…` restores the color floor and `-u` forces UTF-8 regardless
 * of what the transport dropped. Both were measured on a prototype.
 */
export function attachClientCommand(): string[] {
  return withAttachActivityStamp([
    'env',
    'TERM=xterm-256color',
    'tmux',
    '-u',
    '-S',
    TMUX_SOCKET_PATH,
    'attach-session',
    '-t',
    TMUX_SESSION_NAME,
  ]);
}

/**
 * Resolve the live runtime handle for the first of `sessions` that has one.
 * Resolution goes through the session driver's own discovery (the adoption
 * contract): the host's in-memory container name is a lineage label, not the
 * runtime name — under some drivers the two never match, and even under
 * docker the real name is key-derived (`ncl-<session>`), not the label.
 */
export async function findLiveSessionHandle(sessions: Session[]): Promise<SessionHandle | undefined> {
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
 * a live session runtime, and return its handle with the command to run in
 * it. Group lookup stays with the callers — verbs differ in how they name a
 * group (id-or-folder) and in their not-found texts.
 */
export async function attachSandbox(group: AgentGroup, opts?: { wakeWaitMs?: number }): Promise<AttachTarget> {
  const cfg = await getContainerConfig(group.id);
  if (cfg?.code_mode !== 1) {
    throw new Error(
      `${group.name} is not a code-mode group — flip it with: ` +
        `ncl groups config update --id ${group.id} --code-mode true (takes effect on respawn)`,
    );
  }
  // A group can hold several active sessions (one per wired messaging
  // group/thread, plus system task and sandbox sessions — a schedule-driven
  // box may hold ONLY those); attach to the one that actually has a live
  // runtime, not merely the newest row.
  const sessions = await findAttachableSessions(group.id);
  let live = await findLiveSessionHandle(sessions);
  if (!live && sessions.length > 0) {
    // A cold sandbox wakes on attach: wake the preferred session
    // (channel-wired first, else the newest task session, else the sandbox
    // session) instead of refusing, then wait for the runtime to come up (a
    // container needs a few seconds; the attach client separately retries
    // the socket).
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
  return { handle: live, command: attachClientCommand(), group: group.name, containerName: live.name };
}

/** The verbs as one object, for a caller that wants to hold them (or a test that swaps them). */
export interface SandboxVerbs {
  list(): Promise<SandboxListRow[]>;
  create(input?: CreateSandboxInput): Promise<CreatedSandbox>;
  attach(group: AgentGroup, opts?: { wakeWaitMs?: number }): Promise<AttachTarget>;
  find(nameOrId: string): Promise<AgentGroup | undefined>;
}

export function sandboxVerbs(): SandboxVerbs {
  return { list: listSandboxes, create: createSandbox, attach: attachSandbox, find: findSandboxGroup };
}
