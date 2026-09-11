/**
 * Bind a sandbox to its chat surface.
 *
 * Three idempotent steps, each safe to repeat after a crash between them:
 *   1. create-or-get the channel at the service (idempotent on sessionId,
 *      which is the agent group id — one coding session per sandbox);
 *   2. remember `{ agent group, channel, session }` in code_session_channels
 *      (db.ts) so the mirror and the stop watcher find it after a restart;
 *   3. wire the group to the channel through the ordinary group ↔ chat
 *      mechanism — a messaging_groups row for the channel and a
 *      messaging_group_agents row in session mode 'sandbox' (session-manager
 *      resolveSession routes it into the coding session), engaging on every
 *      message with threads off — then point the coding session's default
 *      outbound route at it (writeSessionRouting), so a reply AND a
 *      standalone `ncl outbox send` both land in the channel. From there
 *      inbound delivery and outbox replies are the existing paths; nothing
 *      here carries a message.
 *
 * The messaging_groups row must be the one the adapter's inbound path
 * resolves, so its platform id is the ADAPTER'S spelling of the channel
 * (ChannelAdapter.conversationPlatformId) on the adapter's instance, never a
 * bare id. When the adapter got there first — the bot was invited and a
 * message arrived before this ran, so the router auto-created the row and
 * may have raised a registration card — that row is ADOPTED: wired to the
 * sandbox, its pending registration retired, no second row.
 *
 * Only the binding row and the wiring are ours to remove (archive.ts is the
 * explicit wrap-up); a deleted group takes the row with it (FK cascade).
 */
import { randomUUID } from 'node:crypto';

import { getDb, hasTable } from '../../db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { findSandboxSessions } from '../../db/sessions.js';
import { projectDestinationsToSessions } from '../../cli/resources/destinations.js';
import { log } from '../../log.js';
import { writeSessionRouting } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup } from '../../types.js';
import type { SessionChannelClient } from './client.js';
import {
  deleteSessionChannel,
  getSessionChannelByGroup,
  insertSessionChannel,
  updateSessionChannel,
  type SessionChannelRow,
} from './db.js';
import type { BotIdentity } from './bot-identity.js';
import type { SessionChannelCredentials } from './install.js';

/** The chat platform whose channel this is — the one adapter key the wiring names. */
export const SESSION_CHANNEL_TYPE = 'slack';

/** How the live adapter names the channel: its platform id spelling and its instance key. */
export interface ChannelAddress {
  platformId: string;
  instance: string;
}

export interface BindSessionChannelInput {
  group: Pick<AgentGroup, 'id' | 'name' | 'folder'>;
  credentials: Pick<SessionChannelCredentials, 'serviceBase' | 'appId'>;
  client: Pick<SessionChannelClient, 'create'>;
  /** The adapter's spelling of a channel id (index.ts asks the live adapter). */
  address: (channelId: string) => ChannelAddress;
  /** Channel title; defaults to the sandbox name. */
  title?: string;
  /**
   * The host's own bot identity for the invite (bot-identity.ts), consulted
   * only when a channel is actually created. Null or absent: the create goes
   * without it and the service names the bot from its own record.
   */
  resolveBotIdentity?: () => Promise<BotIdentity | null>;
}

export interface BoundSessionChannel {
  row: SessionChannelRow;
  /** True when this call created the channel (false: found an existing binding or channel). */
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
 * Ensure the group is wired to the channel: messaging group (adopted when
 * the adapter created it first, else created in the adapter's spelling) +
 * wiring row, both create-if-absent; then the coding session's default
 * route. Returns the messaging group the channel maps to.
 */
export async function ensureSessionChannelWiring(
  agentGroupId: string,
  channelId: string,
  title: string,
  address: ChannelAddress,
): Promise<MessagingGroup> {
  const at = new Date().toISOString();
  let mg = await getMessagingGroupByPlatform(SESSION_CHANNEL_TYPE, address.platformId, address.instance);
  let adopted = false;
  if (!mg) {
    mg = {
      id: `mg-${randomUUID()}`,
      channel_type: SESSION_CHANNEL_TYPE,
      platform_id: address.platformId,
      instance: address.instance,
      name: title,
      is_group: 1,
      // Everyone in the channel was invited there for this session; the
      // service admits members, not the sender gate.
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
      log.info('Session channel adopted the adapter-created conversation', {
        agentGroupId,
        channelId,
        messagingGroupId: mg.id,
        platformId: address.platformId,
        registrationRetired: retired,
      });
    }
  }
  return mg;
}

/**
 * Point the coding session's default outbound route at its channel: the
 * resolver index.ts registers answers writeSessionRouting from the binding
 * row, so this runs once the row names its messaging group. A running
 * container picks the new route up on its next send.
 */
export async function refreshSandboxRouting(agentGroupId: string): Promise<void> {
  for (const session of await findSandboxSessions(agentGroupId)) {
    await writeSessionRouting(agentGroupId, session.id);
  }
}

/** Create-or-get the channel for a sandbox and wire the group to it. */
export async function bindSessionChannel(input: BindSessionChannelInput): Promise<BoundSessionChannel> {
  const { group, credentials, client } = input;
  const title = input.title ?? group.folder;

  const existing = await getSessionChannelByGroup(group.id);
  if (existing && !existing.archived_at) {
    const mg = await ensureSessionChannelWiring(
      group.id,
      existing.channel_id,
      existing.title,
      input.address(existing.channel_id),
    );
    if (existing.messaging_group_id !== mg.id) {
      await updateSessionChannel(group.id, { messaging_group_id: mg.id });
      existing.messaging_group_id = mg.id;
    }
    await refreshSandboxRouting(group.id);
    return { row: existing, created: false };
  }

  // The service keys idempotency on sessionId and refuses a new channel for
  // an archived one, so a sandbox whose channel was archived binds again
  // under a suffixed id — derived from the archive time, so a retry after a
  // crash between create and insert converges on the same channel.
  const sessionId = existing?.archived_at ? `${group.id}.${Date.parse(existing.archived_at).toString(36)}` : group.id;
  // Belt and braces for the invite: name the bot ourselves when we can.
  // Resolved only here, on the create path, so the once-per-install lookup
  // never runs for a sandbox that already has its channel.
  let identity: BotIdentity | null = null;
  if (input.resolveBotIdentity) {
    try {
      identity = await input.resolveBotIdentity();
    } catch (err) {
      log.warn('Session channel: bot identity lookup failed — creating without it', { agentGroupId: group.id, err });
    }
  }
  const { channel, created } = await client.create({
    appId: credentials.appId,
    sessionId,
    title,
    ...(identity ? { botUserId: identity.botUserId, ...(identity.teamId ? { teamId: identity.teamId } : {}) } : {}),
  });
  // The binding row before the wiring: a crash between the two leaves a row
  // the next bind completes, never a channel nothing remembers.
  if (existing) await deleteSessionChannel(group.id);
  const row = await insertSessionChannel({
    agent_group_id: group.id,
    channel_id: channel.channelId,
    session_id: channel.sessionId,
    messaging_group_id: null,
    service_base: credentials.serviceBase,
    app_id: credentials.appId,
    title,
    last_status: null,
    last_status_at: null,
    stopped_at: null,
    last_turn_seq: 0,
    events_cursor: null,
    archived_at: null,
  });
  const mg = await ensureSessionChannelWiring(group.id, channel.channelId, title, input.address(channel.channelId));
  await updateSessionChannel(group.id, { messaging_group_id: mg.id });
  row.messaging_group_id = mg.id;
  await refreshSandboxRouting(group.id);
  log.info('Session channel bound', { agentGroupId: group.id, channelId: channel.channelId, created });
  return { row, created };
}
