/**
 * A chat surface for a coding session — module wiring.
 *
 * When a sandbox is created on a host that has a managed Slack app, the host
 * asks the Slack service to open a channel for that session, binds the
 * sandbox group to the channel through the ordinary group ↔ chat wiring
 * (binding.ts), mirrors the session's state to it (runtime.ts: status and a
 * diff view after each turn) and honours a Stop pressed in the channel
 * (stop.ts: interrupt the turn, never archive). Opting out is
 * `ncl sandboxes new --no-channel`; archiving is the explicit
 * `ncl sandboxes channel archive <sandbox>`.
 *
 * Registered here: the table migration (db.ts), the host lifecycle (start
 * the mirror after DB + delivery are up, stop it on shutdown), and the three
 * entry points the sandbox verbs call. The verbs run in the host process
 * (the ncl socket server lives there), so a fresh binding joins the running
 * mirror directly.
 */
import path from 'node:path';

import { findSandboxSessions } from '../../db/sessions.js';
import { onHostShutdown, onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { sessionDir } from '../../session-manager.js';
import type { AgentGroup } from '../../types.js';
import { bindSessionChannel, type BoundSessionChannel } from './binding.js';
import { isUnavailable, SessionChannelClient, type ChannelRecord } from './client.js';
import {
  getSessionChannelByGroup,
  listOpenSessionChannels,
  updateSessionChannel,
  type SessionChannelPatch,
} from './db.js';
import { collectDiff } from './diff-view.js';
import { readSessionChannelCredentials, type SessionChannelCredentials } from './install.js';
import type { MirrorObservation, TurnStamp } from './mapper.js';
import { SessionChannelRuntime, type SessionChannelRuntimeDeps } from './runtime.js';
import { interruptCodingSession } from './stop.js';
import { readTurnStamp, TURN_STAMP_SUBDIR } from './turn-stamp.js';
import './db.js';

export { SESSION_CHANNEL_TYPE } from './binding.js';
export type { SessionChannelRow } from './db.js';

/** Seams the sandbox verbs go through; tests swap them (setSessionChannelDeps). */
export interface SessionChannelDeps {
  readCredentials(): Promise<SessionChannelCredentials | null>;
  createClient(credentials: SessionChannelCredentials): SessionChannelClient;
}

const defaultDeps: SessionChannelDeps = {
  readCredentials: () => readSessionChannelCredentials(),
  createClient: (credentials) =>
    new SessionChannelClient({ serviceBase: credentials.serviceBase, token: credentials.token, timeoutMs: 20_000 }),
};

let deps: SessionChannelDeps = defaultDeps;
let runtime: SessionChannelRuntime | null = null;

export function setSessionChannelDeps(overrides: Partial<SessionChannelDeps> | null): void {
  deps = overrides ? { ...defaultDeps, ...overrides } : defaultDeps;
}

/** The mirror this process runs, if the host started one (tests install their own). */
export function getSessionChannelRuntime(): SessionChannelRuntime | null {
  return runtime;
}

export function setSessionChannelRuntime(next: SessionChannelRuntime | null): void {
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

/** The coding session's working tree on the host (the container's /workspace/group). */
export async function sandboxWorkspaceDir(agentGroupId: string): Promise<string | null> {
  const session = (await findSandboxSessions(agentGroupId))[0];
  return session ? path.join(sessionDir(agentGroupId, session.id), 'group') : null;
}

export function createSessionChannelRuntime(overrides: Partial<SessionChannelRuntimeDeps> = {}): SessionChannelRuntime {
  let credentials: SessionChannelCredentials | null | undefined;
  const clients = new Map<string, SessionChannelClient>();
  return new SessionChannelRuntime({
    clientFor: (row) => {
      // One bearer per host; rows name the service they were bound against.
      if (credentials === undefined) return null;
      if (!credentials) return null;
      const key = row.service_base;
      let client = clients.get(key);
      if (!client) {
        client = new SessionChannelClient({ serviceBase: row.service_base, token: credentials.token });
        clients.set(key, client);
      }
      return client;
    },
    listBindings: async () => {
      credentials = await deps.readCredentials();
      if (!credentials) {
        log.info('Session channels: no managed Slack app or sign-in on this host — nothing to mirror');
        return [];
      }
      return listOpenSessionChannels();
    },
    observe: (row) => observeSandbox(row.agent_group_id),
    collectDiff: async (row) => {
      const dir = await sandboxWorkspaceDir(row.agent_group_id);
      return dir ? collectDiff(dir) : null;
    },
    interrupt: (agentGroupId) => interruptCodingSession(agentGroupId),
    persist: (agentGroupId, patch: SessionChannelPatch) => updateSessionChannel(agentGroupId, patch),
    ...overrides,
  });
}

onHostStart(async () => {
  runtime = createSessionChannelRuntime();
  await runtime.start();
});

onHostShutdown(async () => {
  await runtime?.stop();
  runtime = null;
});

/**
 * Open (or find) the chat surface for a sandbox. Never throws: no managed
 * app, no sign-in, a workspace that cannot do this yet, or a service that is
 * down all resolve null and the sandbox goes on without a channel.
 */
export async function bindSandboxChannel(
  group: Pick<AgentGroup, 'id' | 'name' | 'folder'>,
  options: { title?: string } = {},
): Promise<BoundSessionChannel | null> {
  let credentials: SessionChannelCredentials | null;
  try {
    credentials = await deps.readCredentials();
  } catch (err) {
    log.warn('Session channel: install state unreadable — sandbox continues without a channel', { err });
    return null;
  }
  if (!credentials) return null;
  try {
    const bound = await bindSessionChannel({
      group,
      credentials,
      client: deps.createClient(credentials),
      ...(options.title ? { title: options.title } : {}),
    });
    const active = runtime;
    if (active) {
      try {
        await active.add(bound.row);
      } catch (err) {
        log.warn('Session channel bound but not mirrored by this process', { agentGroupId: group.id, err });
      }
    }
    return bound;
  } catch (err) {
    if (isUnavailable(err)) {
      log.info('Session channel not available for this workspace — sandbox continues without one', {
        agentGroupId: group.id,
        reason: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
    log.warn('Session channel not opened — sandbox continues without one', { agentGroupId: group.id, err });
    return null;
  }
}

export interface SandboxChannelStatus {
  sandbox: string;
  channelId: string;
  sessionId: string;
  title: string;
  /** The service's view when reachable, else the last status this host sent. */
  status: string | null;
  lastStatusSent: string | null;
  lastStatusAt: string | null;
  stoppedAt: string | null;
  archivedAt: string | null;
  mirrored: boolean;
  views: Array<{ viewKey: string; type: string; updatedAt?: string }>;
  createdAt: string;
  serviceError?: string;
}

/** What the channel looks like from here: the binding row, the live service view when it answers. */
export async function sandboxChannelStatus(
  group: Pick<AgentGroup, 'id' | 'name' | 'folder'>,
): Promise<SandboxChannelStatus | null> {
  const row = await getSessionChannelByGroup(group.id);
  if (!row) return null;
  let live: ChannelRecord | undefined;
  let serviceError: string | undefined;
  const credentials = await deps.readCredentials().catch(() => null);
  if (credentials && !row.archived_at) {
    try {
      live = await deps.createClient({ ...credentials, serviceBase: row.service_base }).get(row.channel_id);
    } catch (err) {
      serviceError = err instanceof Error ? err.message : String(err);
    }
  }
  return {
    sandbox: group.folder,
    channelId: row.channel_id,
    sessionId: row.session_id,
    title: row.title,
    status: live?.status ?? (row.archived_at ? 'closed' : row.last_status),
    lastStatusSent: row.last_status,
    lastStatusAt: row.last_status_at,
    stoppedAt: live?.stoppedAt ?? row.stopped_at,
    archivedAt: live?.archivedAt ?? row.archived_at,
    mirrored: runtime?.has(group.id) ?? false,
    views: (live?.views ?? []).map((v) => ({
      viewKey: v.viewKey,
      type: v.type,
      ...(v.updatedAt ? { updatedAt: v.updatedAt } : {}),
    })),
    createdAt: row.created_at,
    ...(serviceError ? { serviceError } : {}),
  };
}

/** The explicit wrap-up: archive the channel at the service and retire the binding. Throws when there is none. */
export async function archiveSandboxChannel(
  group: Pick<AgentGroup, 'id' | 'name' | 'folder'>,
  options: { summary?: string } = {},
): Promise<{ sandbox: string; channelId: string; archived: true; archivedAt: string }> {
  const row = await getSessionChannelByGroup(group.id);
  if (!row) throw new Error(`sandbox '${group.folder}' has no session channel`);
  if (row.archived_at)
    return { sandbox: group.folder, channelId: row.channel_id, archived: true, archivedAt: row.archived_at };
  const credentials = await deps.readCredentials();
  if (!credentials)
    throw new Error('no sign-in or managed Slack app on this host — cannot reach the service to archive');
  const result = await deps
    .createClient({ ...credentials, serviceBase: row.service_base })
    .archive(row.channel_id, options.summary ? { summary: options.summary } : {});
  const archivedAt = result.archivedAt ?? new Date().toISOString();
  await updateSessionChannel(group.id, { archived_at: archivedAt });
  runtime?.remove(group.id);
  log.info('Session channel archived', { agentGroupId: group.id, channelId: row.channel_id });
  return { sandbox: group.folder, channelId: row.channel_id, archived: true, archivedAt };
}

export { getSessionChannelByGroup };
