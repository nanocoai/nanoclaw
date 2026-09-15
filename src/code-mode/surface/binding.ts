/**
 * Bind a sandbox to a chat surface.
 *
 * Three idempotent steps, each safe to repeat after a crash between them:
 *   1. open (or find) the surface through the platform's provider
 *      (types.ts `open`; the provider keys idempotency on the sandbox's
 *      group id, which is the session id it is given);
 *   2. remember `{ agent group, provider, surface, session }` in
 *      code_session_surfaces (db.ts) so the runtime finds it after a
 *      restart;
 *   3. wire the group to the surface through the ordinary group ↔ chat
 *      mechanism — a messaging_groups row for the surface and a
 *      messaging_group_agents row in session mode 'sandbox' (session-manager
 *      resolveSession routes it into the coding session), engaging on every
 *      message with threads off — then point the coding session's default
 *      outbound route at it (writeSessionRouting), so a reply AND a
 *      standalone `ncl outbox send` both land on the surface. From there
 *      inbound delivery and outbox replies are the existing paths; nothing
 *      here carries a message.
 *
 * The messaging_groups row must be the one the adapter's inbound path
 * resolves, so its platform id is the PROVIDER'S spelling of the surface
 * (`spell`, today `ChannelAdapter.conversationPlatformId`) on the adapter's
 * instance, never a bare id. When the adapter got there first — the bot was
 * invited and a message arrived before this ran, so the router auto-created
 * the row and may have raised a registration card — that row is ADOPTED:
 * wired to the sandbox, its pending registration retired, no second row.
 *
 * Only the binding row and the wiring are ours to remove (the archive is
 * the explicit wrap-up); a deleted group takes the row with it (FK cascade).
 */
import { randomUUID } from 'node:crypto';

import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { getDb, hasTable } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { findSandboxSessions } from '../../db/sessions.js';
import { log } from '../../log.js';
import { writeSessionRouting } from '../../session-manager.js';
import type { MessagingGroup } from '../../types.js';
import { fireSandboxBound, type SandboxGroup } from '../hooks.js';
import {
  deleteSessionSurface,
  getSessionSurfaceByGroup,
  insertSessionSurface,
  updateSessionSurface,
  type SessionSurfaceRow,
} from './db.js';
import type { SessionSurfaceProvider, SurfaceSpelling } from './types.js';

export interface BindSessionSurfaceInput {
  group: SandboxGroup;
  /** The chat platform (the channel type the provider registered under). */
  channelType: string;
  provider: Pick<SessionSurfaceProvider, 'open' | 'spell'>;
  /** Surface title; defaults to the sandbox name. */
  title?: string;
  /** The address a terminal reaches this sandbox at, when the host has one. Never a gate. */
  terminalAddress?: string;
}

export interface BoundSessionSurface {
  row: SessionSurfaceRow;
  /** True when this call opened the surface (false: found an existing binding). */
  created: boolean;
}

/**
 * A registration card the router raised for an adapter-created row is moot
 * once the row is wired to its sandbox: retire the pending row so the card's
 * in-flight dedupe clears and a later click finds nothing to approve.
 */
async function retirePendingRegistration(messagingGroupId: string): Promise<boolean> {
  const db = getDb();
  if (!(await hasTable(db, 'pending_channel_approvals'))) return false;
  const result = await db.run('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?', messagingGroupId);
  return result.changes > 0;
}

/**
 * Ensure the group is wired to the surface: messaging group (adopted when
 * the adapter created it first, else created in the provider's spelling) +
 * wiring row, both create-if-absent; then the coding session's default
 * route. Returns the messaging group the surface maps to.
 */
export async function ensureSessionSurfaceWiring(
  agentGroupId: string,
  channelType: string,
  title: string,
  spelling: SurfaceSpelling,
): Promise<MessagingGroup> {
  const at = new Date().toISOString();
  let mg = await getMessagingGroupByPlatform(channelType, spelling.platformId, spelling.instance);
  let adopted = false;
  if (!mg) {
    mg = {
      id: `mg-${randomUUID()}`,
      channel_type: channelType,
      platform_id: spelling.platformId,
      instance: spelling.instance,
      name: title,
      is_group: 1,
      // Everyone on the surface was invited there for this session; the
      // provider admits members, not the sender gate.
      unknown_sender_policy: 'public',
      created_at: at,
    };
    await createMessagingGroup(mg);
  } else {
    adopted = true;
  }
  const wiring = await getMessagingGroupAgentByPair(mg.id, agentGroupId);
  if (!wiring) {
    await createMessagingGroupAgent({
      id: randomUUID(),
      messaging_group_id: mg.id,
      agent_group_id: agentGroupId,
      // Every message is for the session, no mention needed; one session,
      // never one per thread.
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'sandbox',
      priority: 0,
      threads: 0,
      created_at: at,
    });
    // A container already running for the group keeps serving its stale
    // destination projection until its next spawn — refresh it now so the
    // first reply from the session is not dropped as an unknown destination.
    await projectDestinationsToSessions(agentGroupId);
    if (adopted) {
      const retired = await retirePendingRegistration(mg.id);
      log.info('Session surface adopted the adapter-created conversation', {
        agentGroupId,
        channelType,
        messagingGroupId: mg.id,
        platformId: spelling.platformId,
        registrationRetired: retired,
      });
    }
  }
  return mg;
}

/**
 * Point the coding session's default outbound route at its surface: the
 * resolver index.ts registers answers writeSessionRouting from the binding
 * row, so this runs once the row names its messaging group. A running
 * container picks the new route up on its next send.
 */
export async function refreshSandboxRouting(agentGroupId: string): Promise<void> {
  for (const session of await findSandboxSessions(agentGroupId)) {
    await writeSessionRouting(agentGroupId, session.id);
  }
}

/**
 * Open-or-find the surface for a sandbox and wire the group to it. Null
 * when the provider has no surface to give (its `open` answered null or
 * threw): the sandbox goes on without one, and the reason is a log line.
 */
export async function bindSessionSurface(input: BindSessionSurfaceInput): Promise<BoundSessionSurface | null> {
  const { group, channelType, provider } = input;
  const title = input.title ?? group.folder;

  const existing = await getSessionSurfaceByGroup(group.id);
  if (existing && !existing.archived_at && existing.provider !== channelType) {
    // One surface per coding session: the table holds one row per group, so
    // a second platform cannot bind without repointing the first's binding.
    // The first stays; this platform is told no.
    log.info('Session surface not opened — the sandbox already has one on another platform', {
      agentGroupId: group.id,
      channelType,
      bound: existing.provider,
    });
    return null;
  }
  if (existing && !existing.archived_at) {
    const mg = await ensureSessionSurfaceWiring(
      group.id,
      existing.provider,
      existing.title,
      await provider.spell(existing.surface_id),
    );
    if (existing.messaging_group_id !== mg.id) {
      await updateSessionSurface(group.id, { messaging_group_id: mg.id });
      existing.messaging_group_id = mg.id;
    }
    await refreshSandboxRouting(group.id);
    return { row: existing, created: false };
  }

  let handle;
  try {
    handle = await provider.open(group, {
      title,
      ...(input.terminalAddress ? { terminalAddress: input.terminalAddress } : {}),
    });
  } catch (err) {
    log.warn('Session surface not opened — sandbox continues without one', {
      agentGroupId: group.id,
      channelType,
      err,
    });
    return null;
  }
  if (!handle) {
    log.info('Session surface not available — sandbox continues without one', { agentGroupId: group.id, channelType });
    return null;
  }

  // The binding row before the wiring: a crash between the two leaves a row
  // the next bind completes, never a surface nothing remembers.
  if (existing) await deleteSessionSurface(group.id);
  const row = await insertSessionSurface({
    agent_group_id: group.id,
    provider: channelType,
    surface_id: handle.surfaceId,
    session_id: handle.sessionId,
    messaging_group_id: null,
    title,
    last_status: null,
    last_status_at: null,
    stopped_at: null,
    last_turn_seq: 0,
    events_cursor: null,
    archived_at: null,
  });
  const mg = await ensureSessionSurfaceWiring(group.id, channelType, title, await provider.spell(handle.surfaceId));
  await updateSessionSurface(group.id, { messaging_group_id: mg.id });
  row.messaging_group_id = mg.id;
  await refreshSandboxRouting(group.id);
  log.info('Session surface bound', { agentGroupId: group.id, channelType, surfaceId: handle.surfaceId });
  await fireSandboxBound(group, {
    channelType,
    surfaceId: handle.surfaceId,
    sessionId: handle.sessionId,
    messagingGroupId: mg.id,
  });
  return { row, created: true };
}
