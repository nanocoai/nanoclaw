import { randomUUID } from 'crypto';

import { resolveUnknownSenderPolicy } from '../../channels/channel-defaults.js';
import { hasDeclaredChannelDefaults } from '../../channels/channel-registry.js';
import { getDb, hasTable } from '../../db/connection.js';
import { getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { findSessionByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { routeInbound } from '../../router.js';
import { withExistingMailboxSession, writeSessionRouting } from '../../session-manager.js';
import { UNKNOWN_SENDER_POLICIES } from '../../types.js';
import { registerResource } from '../crud.js';
import { projectDestinationsToSessions } from './destinations.js';

registerResource({
  name: 'messaging-group',
  plural: 'messaging-groups',
  table: 'messaging_groups',
  description:
    'Messaging group — one chat or channel on one platform (a Telegram DM, a Discord channel, a Slack thread root, an email address). Identity is the (channel_type, platform_id, instance) triple, which must be unique.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'channel_type',
      type: 'string',
      description:
        'Channel adapter type — matches the adapter registered by /add-<channel> (e.g. telegram, discord, slack, whatsapp).',
      required: true,
    },
    {
      name: 'platform_id',
      type: 'string',
      description:
        'Platform-specific chat ID. Format varies: Telegram chat ID, Discord channel snowflake, Slack channel ID, phone number, email address.',
      required: true,
    },
    {
      name: 'instance',
      type: 'string',
      description:
        'Adapter instance that owns this chat, when running N adapters of one channel type. Defaults to channel_type (the default instance) when omitted.',
      defaultFrom: 'channel_type',
      updatable: true,
    },
    {
      name: 'name',
      type: 'string',
      description: 'Display name. Often auto-populated by the channel adapter.',
      updatable: true,
    },
    {
      name: 'is_group',
      type: 'number',
      description: 'Multi-user group chat (1) or direct message (0). Affects session scoping.',
      default: 0,
      updatable: true,
    },
    {
      name: 'unknown_sender_policy',
      type: 'string',
      description:
        'What happens when an unrecognized sender posts. "strict" drops silently. "request_approval" sends an approval card to an admin. "decline_notify" declines the sender politely and sends the owner a one-line FYI. "public" allows anyone. Default: declared by the channel adapter for this context (DM vs group); "strict" when the channel has no declaration.',
      enum: [...UNKNOWN_SENDER_POLICIES],
      default: 'strict',
      updatable: true,
    },
    {
      name: 'denied_at',
      type: 'string',
      description:
        'Set when the owner explicitly denies registering this channel. While set, the router drops all messages silently without re-escalating. Cleared by any explicit wiring mutation.',
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  // Idempotent create: a skill re-running `ncl messaging-groups create` gets the existing row back.
  naturalKey: ['channel_type', 'platform_id', 'instance'],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval' },
  resolveDefaults: (values) => {
    if (values.unknown_sender_policy !== undefined) return;
    const channelType = String(values.channel_type);
    const channelKey = (values.instance as string | undefined) ?? channelType;
    // Static 'strict' stays the no-declaration fallback: a trunk update alone
    // must not change ncl's creation defaults for stale (undeclared) adapters.
    if (!hasDeclaredChannelDefaults(channelKey, channelType)) {
      log.warn(
        `messaging-group create: channel '${channelKey}' has no declared defaults (adapter not installed or stale) — using legacy static defaults`,
      );
      return;
    }
    // is_group carries its static default (0) only after this hook runs, so
    // treat "not provided" as the same DM context the static default means.
    const isGroup = Number(values.is_group ?? 0) === 1;
    values.unknown_sender_policy = resolveUnknownSenderPolicy(channelKey, isGroup, channelType);
  },
  customOperations: {
    delete: {
      access: 'approval',
      description:
        'Delete a messaging group and the rows that point at it (its sessions with their questions, approvals and ' +
        'host bookkeeping; channel destinations; DM cache entries; pending sender and channel approvals; wirings). ' +
        'FK-ordered cascade in a single transaction. Use --id <messaging-group-id>. ' +
        'The session an agent-shared agent reuses is kept when it started in this chat: it moves to another of ' +
        "the agent's agent-shared chats (or to none), so the conversation carries on there. " +
        'A session in a conversation with another agent (sent or received) is kept too, with no chat, so it carries on; ' +
        'the next agent-shared chat that resumes a session with no chat becomes its chat. ' +
        "The host sweep stops the deleted sessions' containers within about a minute. " +
        'Their folders under data/v2-sessions/ stay on disk on purpose: they hold the conversation history, ' +
        'and a container can still have them mounted until the sweep stops it.',
      handler: async (args) => {
        const id = args.id as string;
        if (!id) throw new Error('--id is required');
        const db = getDb();

        const mg = await db.get<{ channel_type: string; platform_id: string }>(
          'SELECT channel_type, platform_id FROM messaging_groups WHERE id = ?',
          id,
        );
        if (!mg) throw new Error(`messaging-group not found: ${id}`);

        const hasAgentDestinations = await hasTable(db, 'agent_destinations');
        const hasPendingApprovals = await hasTable(db, 'pending_approvals');
        const hasUnregisteredSenders = await hasTable(db, 'unregistered_senders');
        const sessionIds = 'SELECT id FROM sessions WHERE messaging_group_id = ?';
        const kept: Array<{ id: string; agent_group_id: string; messaging_group_id: string | null }> = [];
        let destinationOwners: string[] = [];

        // A peer agent's replies return to the session that messaged it (agent-route.ts),
        // not to the newest one, and its assignments wait in this session's inbox, so every
        // session here in a conversation with another agent stays. Read before the
        // transaction: holding it across mailbox reads can deadlock.
        const peerUsed: Array<{ id: string; agent_group_id: string }> = [];
        const scanStart = new Date().toISOString();
        const scanned = await db.all<{ id: string; agent_group_id: string; last_active: string | null }>(
          'SELECT id, agent_group_id, last_active FROM sessions WHERE messaging_group_id = ?',
          id,
        );
        for (const session of scanned) {
          const self = session.agent_group_id;
          const withPeer = await withExistingMailboxSession(
            self,
            session.id,
            (m) => m.hasMessagesToOtherAgents(self) || m.hasMessagesFromOtherAgents(self),
          );
          if (withPeer) peerUsed.push(session);
        }

        // Same shape as `groups delete`: one transaction, counts from each
        // DELETE's `changes`, rolled back whole if any statement throws.
        const removed = await db.transaction(async () => {
          const counts = {
            pending_questions: 0,
            pending_approvals: 0,
            session_claims: 0,
            delivery_attempts: 0,
            wake_signals: 0,
            sessions: 0,
            agent_destinations: 0,
            user_dms: 0,
            pending_sender_approvals: 0,
            pending_channel_approvals: 0,
            messaging_group_agents: 0,
            unregistered_senders: 0,
          };

          // Lock this chat's session rows first. A last_active bump from a write landing now
          // then waits for this transaction on every driver, not only on SQLite (which holds
          // all other queries anyway); the keep check below relies on that.
          await db.run('UPDATE sessions SET messaging_group_id = messaging_group_id WHERE messaging_group_id = ?', id);

          // Move a kept session off this chat before the session-scoped deletes, so it
          // and its rows stay. Its open question cards sit in this chat, though, and
          // answers from there must not reach it.
          const keep = async (sessionId: string, agentGroupId: string, chat: string | null) => {
            const moved = await db.run(
              'UPDATE sessions SET messaging_group_id = ?, thread_id = NULL WHERE id = ? AND messaging_group_id = ?',
              chat,
              sessionId,
              id,
            );
            if (moved.changes === 0) return;
            counts.pending_questions += (
              await db.run(
                'DELETE FROM pending_questions WHERE session_id = ? AND channel_type = ? AND platform_id = ?',
                sessionId,
                mg.channel_type,
                mg.platform_id,
              )
            ).changes;
            kept.push({ id: sessionId, agent_group_id: agentGroupId, messaging_group_id: chat });
          };

          // Agent-shared chats and agent-to-agent reuse whichever session
          // findSessionByAgentGroup picks, wherever it started. Cards follow the
          // bound chat, so move that one to another agent-shared chat when there is one.
          const sharedAgents = await db.all<{ agent_group_id: string }>(
            `SELECT DISTINCT agent_group_id FROM messaging_group_agents WHERE session_mode = 'agent-shared'
               AND agent_group_id IN (SELECT agent_group_id FROM sessions WHERE messaging_group_id = ?)`,
            id,
          );
          for (const { agent_group_id } of sharedAgents) {
            const reused = await findSessionByAgentGroup(agent_group_id);
            if (reused?.messaging_group_id !== id) continue;
            // Prefer a chat the bot is still in; a detached one only comes back on rejoin.
            const next = await db.get<{ messaging_group_id: string }>(
              `SELECT mga.messaging_group_id FROM messaging_group_agents mga
                 JOIN messaging_groups m ON m.id = mga.messaging_group_id
                 WHERE mga.agent_group_id = ? AND mga.session_mode = 'agent-shared' AND mga.messaging_group_id != ?
                 ORDER BY m.detached_at IS NOT NULL, mga.created_at, mga.messaging_group_id LIMIT 1`,
              agent_group_id,
              id,
            );
            await keep(reused.id, agent_group_id, next?.messaging_group_id ?? null);
          }
          // The rest keep no chat; resolveSession binds one when an agent-shared chat resumes them.
          for (const session of peerUsed) await keep(session.id, session.agent_group_id, null);
          // Every inbox write bumps last_active once it lands, so a session whose last_active
          // moved since the scan read it (or that appeared since) may hold a peer message the
          // scan missed: keep it. A write still landing waits on the lock; agent-route.ts
          // re-routes it. The value check is clock-free; >= scanStart also catches a bump in
          // the same millisecond as the value read, and at worst keeps one more session.
          const scannedActive = new Map(scanned.map((s) => [s.id, s.last_active]));
          for (const session of await db.all<{ id: string; agent_group_id: string; last_active: string | null }>(
            'SELECT id, agent_group_id, last_active FROM sessions WHERE messaging_group_id = ?',
            id,
          )) {
            const moved =
              !scannedActive.has(session.id) ||
              scannedActive.get(session.id) !== session.last_active ||
              (session.last_active !== null && session.last_active >= scanStart);
            if (moved) await keep(session.id, session.agent_group_id, null);
          }
          counts.pending_questions += (
            await db.run(`DELETE FROM pending_questions WHERE session_id IN (${sessionIds})`, id)
          ).changes;
          if (hasPendingApprovals) {
            counts.pending_approvals = (
              await db.run(`DELETE FROM pending_approvals WHERE session_id IN (${sessionIds})`, id)
            ).changes;
          }
          // No FK on the host-coordination tables; cleared here so they don't outlive the session.
          counts.session_claims = (
            await db.run(`DELETE FROM session_claims WHERE session_id IN (${sessionIds})`, id)
          ).changes;
          counts.delivery_attempts = (
            await db.run(`DELETE FROM delivery_attempts WHERE session_id IN (${sessionIds})`, id)
          ).changes;
          counts.wake_signals = (
            await db.run(`DELETE FROM wake_signals WHERE session_id IN (${sessionIds})`, id)
          ).changes;
          counts.sessions = (await db.run('DELETE FROM sessions WHERE messaging_group_id = ?', id)).changes;
          if (hasAgentDestinations) {
            destinationOwners = (
              await db.all<{ agent_group_id: string }>(
                'SELECT DISTINCT agent_group_id FROM agent_destinations WHERE target_type = ? AND target_id = ?',
                'channel',
                id,
              )
            ).map((row) => row.agent_group_id);
            counts.agent_destinations = (
              await db.run('DELETE FROM agent_destinations WHERE target_type = ? AND target_id = ?', 'channel', id)
            ).changes;
          }
          counts.user_dms = (await db.run('DELETE FROM user_dms WHERE messaging_group_id = ?', id)).changes;
          counts.pending_sender_approvals = (
            await db.run('DELETE FROM pending_sender_approvals WHERE messaging_group_id = ?', id)
          ).changes;
          counts.pending_channel_approvals = (
            await db.run('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?', id)
          ).changes;
          counts.messaging_group_agents = (
            await db.run('DELETE FROM messaging_group_agents WHERE messaging_group_id = ?', id)
          ).changes;
          if (hasUnregisteredSenders) {
            // No FK; without this the chat keeps showing in `dropped-messages list`. Rows are
            // keyed by chat, so also clear this chat's row when it carries no id or a deleted
            // group's id; a row naming a surviving group (another adapter instance) stays.
            counts.unregistered_senders = (
              await db.run(
                `DELETE FROM unregistered_senders WHERE messaging_group_id = ?
                   OR (channel_type = ? AND platform_id = ?
                       AND (messaging_group_id IS NULL OR messaging_group_id NOT IN (SELECT id FROM messaging_groups)))`,
                id,
                mg.channel_type,
                mg.platform_id,
              )
            ).changes;
          }
          await db.run('DELETE FROM messaging_groups WHERE id = ?', id);
          return counts;
        });

        // Like `destinations remove`: drop the chat from live session mailboxes now, not at next spawn.
        for (const agentGroupId of destinationOwners) await projectDestinationsToSessions(agentGroupId);
        // A kept session's default reply route still names the deleted chat until rewritten.
        for (const session of kept) {
          try {
            await writeSessionRouting(session.agent_group_id, session.id);
          } catch (err) {
            log.warn('Failed to rewrite session routing after rebind', { sessionId: session.id, err });
          }
        }

        return {
          deleted: id,
          removed,
          kept_sessions: kept.map(({ id: sessionId, messaging_group_id }) => ({ id: sessionId, messaging_group_id })),
        };
      },
    },
    send: {
      access: 'approval',
      description:
        'Inject a message into a messaging group as if a sender posted it, waking the wired agent — used to send a welcome on first wire. Use --channel-type, --platform-id, --text, optionally --instance, --sender-id, --sender.',
      handler: async (args) => {
        const channelType = args.channel_type as string;
        const platformId = args.platform_id as string;
        const text = args.text as string;
        if (!channelType || !platformId || !text) {
          throw new Error('--channel-type, --platform-id and --text are required');
        }
        const instance = (args.instance as string) ?? channelType;
        const mg = await getMessagingGroupByPlatform(channelType, platformId, instance);
        if (!mg) {
          throw new Error(`no messaging group for ${channelType} ${platformId} — create + wire it first`);
        }
        // Build the same InboundEvent the CLI admin transport (src/channels/cli.ts)
        // emits for a routed message, and route it in-process. The sender id should
        // be a wired user (e.g. the owner just granted) so the access gate passes.
        await routeInbound({
          channelType,
          instance,
          platformId,
          threadId: platformId,
          message: {
            id: `send-${randomUUID()}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            content: JSON.stringify({
              text,
              sender: (args.sender as string) ?? 'cli',
              senderId: (args.sender_id as string) ?? 'cli:local',
            }),
          },
        });
        return { sent: { channel_type: channelType, platform_id: platformId } };
      },
    },
  },
});
