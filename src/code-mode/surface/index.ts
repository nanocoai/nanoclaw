/**
 * A chat surface for each coding session — module wiring.
 *
 * When a sandbox is created on a host where a chat platform has registered
 * a session-surface provider (registry.ts), the host opens a surface for
 * that session through the provider, binds the sandbox group to it through
 * the ordinary group ↔ chat wiring (binding.ts), mirrors the session's
 * state to it (runtime.ts: status and a diff view after each turn) and
 * honours a Stop from the surface (stop.ts: interrupt the turn, never
 * archive). The diff is read inside the session container (diff-view.ts). With no provider registered nothing opens, and the terminal
 * verbs `ncl sandboxes status | diff | stop` are the surface.
 *
 * Registered here: the table migration (db.ts), the routing resolver that
 * makes a bound surface the coding session's default outbound route, the
 * sandbox-created hook that opens surfaces, and the host lifecycle of the
 * mirror. The sandbox verbs run in the host process (the ncl socket server
 * lives there), so a fresh binding joins the running mirror directly.
 */
import path from 'node:path';

import { getMessagingGroup } from '../../db/messaging-groups.js';
import { findSandboxSessions, SANDBOX_SYSTEM_THREAD_ID } from '../../db/sessions.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerSessionRoutingResolver, sessionDir } from '../../session-manager.js';
import { onSandboxCreated, SANDBOX_HOOKS_SEAM, type SandboxGroup } from '../hooks.js';
import { bindSessionSurface, type BoundSessionSurface } from './binding.js';
import {
  getSessionSurfaceByGroup,
  listOpenSessionSurfaces,
  updateSessionSurface,
  type SessionSurfacePatch,
  type SessionSurfaceRow,
} from './db.js';
import { collectSandboxDiff } from './diff-view.js';
import { mapStatus, type MirrorObservation, type MirrorStatus, type TurnStamp } from './mapper.js';
import { getSessionSurface, listSessionSurfaces, noopSessionSurface, onSessionSurfaceChange } from './registry.js';
import { SessionSurfaceRuntime, type SessionSurfaceRuntimeDeps } from './runtime.js';
import { interruptCodingSession } from './stop.js';
import { readTurnStamp, TURN_STAMP_SUBDIR } from './turn-stamp.js';

export { SESSION_SURFACE_SEAM, registerSessionSurface } from './registry.js';
export type { SessionSurfaceRow } from './db.js';
export type * from './types.js';

let runtime: SessionSurfaceRuntime | null = null;

// A coding session has no origin chat of its own; once bound, its surface is
// its default outbound route: a reply and a standalone `ncl outbox send`
// both post at the surface's top level (thread null — the adapter posts a
// null thread at the conversation itself).
registerSessionRoutingResolver(async (session) => {
  if (session.thread_id !== SANDBOX_SYSTEM_THREAD_ID) return null;
  const row = await getSessionSurfaceByGroup(session.agent_group_id);
  if (!row || row.archived_at || !row.messaging_group_id) return null;
  const mg = await getMessagingGroup(row.messaging_group_id);
  if (!mg) return null;
  return { channelType: mg.channel_type, platformId: mg.platform_id, threadId: null };
});

/** The mirror this process runs, if the host started one (tests install their own). */
export function getSessionSurfaceRuntime(): SessionSurfaceRuntime | null {
  return runtime;
}

export function setSessionSurfaceRuntime(next: SessionSurfaceRuntime | null): void {
  runtime = next;
}

/** The host-side read of the runner's turn stamp for a group's coding session. */
export async function observeSandbox(agentGroupId: string): Promise<MirrorObservation> {
  const sessions = await findSandboxSessions(agentGroupId);
  const session = sessions[0];
  if (!session) return { running: false, turn: null };
  const running = session.container_status === 'running' || session.container_status === 'idle';
  const turn: TurnStamp | null = readTurnStamp(path.join(sessionDir(agentGroupId, session.id), TURN_STAMP_SUBDIR));
  return { running, turn };
}

/**
 * Where the coding session's working tree lives on the host (the
 * container's /workspace/group). A path, for mounts and tests; the host
 * never runs git there — the diff is read inside the session (diff-view.ts).
 */
export async function sandboxWorkspaceDir(agentGroupId: string): Promise<string | null> {
  const session = (await findSandboxSessions(agentGroupId))[0];
  return session ? path.join(sessionDir(agentGroupId, session.id), 'group') : null;
}

export function createSessionSurfaceRuntime(overrides: Partial<SessionSurfaceRuntimeDeps> = {}): SessionSurfaceRuntime {
  return new SessionSurfaceRuntime({
    // A binding whose platform has no provider (yet, or any more) waits in
    // the runtime — nothing sent, nothing persisted — and goes live when
    // the provider registers (the change listener below).
    providerFor: (row) => getSessionSurface(row.provider) ?? null,
    listBindings: listOpenSessionSurfaces,
    observe: (row) => observeSandbox(row.agent_group_id),
    // A cold session has nothing to read and nothing to publish; the runtime
    // only asks while the session runs, so this answers "clean" for it.
    collectDiff: async (row) => {
      const result = await collectSandboxDiff(row.agent_group_id);
      return result.live ? result : { ok: true, view: null };
    },
    interrupt: (agentGroupId) => interruptCodingSession(agentGroupId),
    persist: (agentGroupId, patch: SessionSurfacePatch) => updateSessionSurface(agentGroupId, patch),
    ...overrides,
  });
}

onHostStart(async () => {
  runtime = createSessionSurfaceRuntime();
  await runtime.start();
});

onHostShutdown(async () => {
  await runtime?.stop();
  runtime = null;
});

// The host restores bindings at start, before every module has activated:
// a provider registering later takes over the rows of its platform, and one
// unregistering hands them back to waiting.
onSessionSurfaceChange((channelType) => {
  const active = runtime;
  if (!active) return;
  active.refresh(channelType).catch((err) => log.warn('Session surface refresh failed', { channelType, err }));
});

/**
 * Open (or find) the chat surface for a sandbox on `channelType`. Never
 * throws: no provider, a provider that answers null, or one that fails all
 * resolve null and the sandbox goes on without a surface.
 */
export async function bindSandboxSurface(
  group: SandboxGroup,
  channelType: string,
  options: { title?: string; terminalAddress?: string } = {},
): Promise<BoundSessionSurface | null> {
  const provider = getSessionSurface(channelType);
  if (!provider) return null;
  try {
    const bound = await bindSessionSurface({ group, channelType, provider, ...options });
    const active = runtime;
    if (bound && active) {
      try {
        await active.add(bound.row);
      } catch (err) {
        log.warn('Session surface bound but not mirrored by this process', { agentGroupId: group.id, err });
      }
    }
    return bound;
  } catch (err) {
    log.warn('Session surface not opened — sandbox continues without one', {
      agentGroupId: group.id,
      channelType,
      err,
    });
    return null;
  }
}

// A new sandbox gets one surface: the registered platforms are asked in
// registration order, after the rows exist and before the first wake, and
// the first provider that answers binds. A provider answering null passes
// the turn on; with none registered nothing runs and the sandbox is plain.
onSandboxCreated(
  'session-surface',
  async (group) => {
    for (const { channelType } of listSessionSurfaces()) {
      if (await bindSandboxSurface(group, channelType)) return;
    }
  },
  { seam: SANDBOX_HOOKS_SEAM },
);

export interface SandboxSurfaceSummary {
  provider: string;
  surfaceId: string;
  sessionId: string;
  title: string;
  lastStatus: string | null;
  lastStatusAt: string | null;
  stoppedAt: string | null;
  archivedAt: string | null;
  /** Whether this host process is mirroring the binding right now. */
  mirrored: boolean;
  createdAt: string;
}

export interface SandboxStatus {
  sandbox: string;
  id: string;
  /** The mapper's answer for the session right now. */
  status: MirrorStatus;
  running: boolean;
  turn: TurnStamp | null;
  /** The chat surface bound to the session, when there is one. */
  surface: SandboxSurfaceSummary | null;
}

/** What the sandbox looks like from here: the mapped status and its binding row, if any. */
export async function sandboxStatus(group: SandboxGroup): Promise<SandboxStatus> {
  const observation = await observeSandbox(group.id);
  const row = await getSessionSurfaceByGroup(group.id);
  return {
    sandbox: group.folder,
    id: group.id,
    status: mapStatus(observation),
    running: observation.running,
    turn: observation.turn,
    surface: row ? summarize(row) : null,
  };
}

function summarize(row: SessionSurfaceRow): SandboxSurfaceSummary {
  return {
    provider: row.provider,
    surfaceId: row.surface_id,
    sessionId: row.session_id,
    title: row.title,
    lastStatus: row.last_status,
    lastStatusAt: row.last_status_at,
    stoppedAt: row.stopped_at,
    archivedAt: row.archived_at,
    mirrored: runtime?.has(row.agent_group_id) ?? false,
    createdAt: row.created_at,
  };
}

/**
 * The explicit wrap-up: close the surface through its provider and retire
 * the binding. Throws when there is none. Nothing else archives a surface —
 * not a Stop, not deleting the sandbox.
 */
export async function archiveSandboxSurface(
  group: SandboxGroup,
  options: { summary?: string } = {},
): Promise<{ sandbox: string; provider: string; surfaceId: string; archived: true; archivedAt: string }> {
  const row = await getSessionSurfaceByGroup(group.id);
  if (!row) throw new Error(`sandbox '${group.folder}' has no chat surface`);
  if (row.archived_at) {
    return {
      sandbox: group.folder,
      provider: row.provider,
      surfaceId: row.surface_id,
      archived: true,
      archivedAt: row.archived_at,
    };
  }
  const provider = getSessionSurface(row.provider) ?? noopSessionSurface;
  await provider.close({ surfaceId: row.surface_id, sessionId: row.session_id }, options);
  const archivedAt = new Date().toISOString();
  await updateSessionSurface(group.id, { archived_at: archivedAt });
  runtime?.remove(group.id);
  log.info('Session surface archived', { agentGroupId: group.id, provider: row.provider, surfaceId: row.surface_id });
  return { sandbox: group.folder, provider: row.provider, surfaceId: row.surface_id, archived: true, archivedAt };
}

export { getSessionSurfaceByGroup };
