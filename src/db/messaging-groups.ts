import type { MessagingGroup, MessagingGroupAgent } from '../types.js';
// Transitional tier violation: core imports from optional agent-to-agent module.
// `createMessagingGroupAgent` auto-creates a destination row on wiring — the
// two concerns are currently bundled. When agent-to-agent isn't installed,
// the table doesn't exist and this import chain remains dormant because
// `createMessagingGroupAgent` is only called from setup/admin paths that
// also only run when wiring channels to agents (which implicitly requires
// agent-to-agent for the destination ACL to mean anything). A cleaner split
// (or making the destination side effect module-owned) is tracked in the
// refactor plan.
import {
  createDestination,
  getDestinationByTarget,
  normalizeName,
} from '../modules/agent-to-agent/db/agent-destinations.js';
import { getDb, hasTable } from './connection.js';
import { isUniqueViolation } from './errors.js';

// ── Messaging Groups ──

export async function createMessagingGroup(group: MessagingGroup): Promise<void> {
  await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @instance, @name, @is_group, @unknown_sender_policy, @created_at)`,
    { ...group, instance: group.instance ?? group.channel_type },
  );
}

/** Router-only idempotent insert for concurrent first messages. */
export async function createMessagingGroupIfAbsent(group: MessagingGroup): Promise<boolean> {
  const result = await getDb().run(
    `INSERT INTO messaging_groups (id, channel_type, platform_id, instance, name, is_group, unknown_sender_policy, created_at)
       VALUES (@id, @channel_type, @platform_id, @instance, @name, @is_group, @unknown_sender_policy, @created_at)
       ON CONFLICT (channel_type, platform_id, instance) DO NOTHING`,
    { ...group, instance: group.instance ?? group.channel_type },
  );
  return result.changes > 0;
}

export async function getMessagingGroup(id: string): Promise<MessagingGroup | undefined> {
  return getDb().get<MessagingGroup>('SELECT * FROM messaging_groups WHERE id = ?', id);
}

/**
 * Outbound / cold-DM / setup lookup by platform address.
 *
 * Instance semantics are deliberately ASYMMETRIC with the router's
 * `getMessagingGroupWithAgentCount` (exact-only): outbound callers usually
 * don't know (or care) which adapter instance owns a chat, so an unset
 * `instance` resolves the default instance first (instance = channel_type),
 * falling back deterministically to the lexically-first named instance.
 * A set `instance` is exact-only — unknown instance returns undefined.
 */
export async function getMessagingGroupByPlatform(
  channelType: string,
  platformId: string,
  instance?: string,
): Promise<MessagingGroup | undefined> {
  if (instance !== undefined) {
    return getDb().get<MessagingGroup>(
      'SELECT * FROM messaging_groups WHERE channel_type = ? AND platform_id = ? AND instance = ?',
      channelType,
      platformId,
      instance,
    );
  }
  return getDb().get<MessagingGroup>(
    `SELECT * FROM messaging_groups
        WHERE channel_type = ? AND platform_id = ?
     ORDER BY (instance = channel_type) DESC, instance ASC
        LIMIT 1`,
    channelType,
    platformId,
  );
}

/**
 * Instance-exact messaging group for a channel a given agent group is
 * sending to, resolved through THAT agent's own `agent_destinations` entry
 * rather than by platform address alone.
 *
 * Needed because `getMessagingGroupByPlatform`'s no-instance fallback picks
 * one row deterministically (default instance, else lexically-first named
 * instance) when several sibling-instance rows share one `(channel_type,
 * platform_id)` pair — i.e. multiple adapter instances sharing one channel
 * address, each owning its own row for the same physical channel. That pick
 * is arbitrary with respect to who's actually sending: it need not be the
 * row the sending agent is wired to, which silently breaks both destination
 * authorization (`src/delivery.ts`) and any per-instance state on the
 * resolved row (e.g. the `instance` used to pick the delivering adapter).
 * Every caller resolving a non-origin-chat send should prefer this over the
 * platform-only lookup, falling back to it only when the sender has no
 * matching destination (e.g. the agent-to-agent module isn't installed).
 */
export async function getMessagingGroupForOwnDestination(
  agentGroupId: string,
  channelType: string,
  platformId: string,
): Promise<MessagingGroup | undefined> {
  if (!(await hasTable(getDb(), 'agent_destinations'))) return undefined;
  return getDb().get<MessagingGroup>(
    `SELECT mg.* FROM agent_destinations ad
         JOIN messaging_groups mg ON mg.id = ad.target_id
        WHERE ad.agent_group_id = ? AND ad.target_type = 'channel'
          AND mg.channel_type = ? AND mg.platform_id = ?
     ORDER BY ad.created_at ASC
        LIMIT 1`,
    agentGroupId,
    channelType,
    platformId,
  );
}

/**
 * Combined lookup for the router's fast-drop path. Returns the messaging
 * group (if it exists) and a count of wired agents in one query — lets
 * `routeInbound` short-circuit messages for unwired / unknown channels
 * with a single DB read instead of four (mg lookup, sender upsert, agents
 * lookup, dropped_messages insert).
 *
 * Returns `null` when no messaging_groups row exists for this channel.
 * Returns `{ mg, agentCount: 0 }` when the row exists but has no wired
 * agents. Uses the `UNIQUE(channel_type, platform_id, instance)` index plus
 * the `UNIQUE(messaging_group_id, agent_group_id)` index for the JOIN — both
 * covered by existing SQLite auto-indexes from the UNIQUE constraints.
 *
 * `instance` is EXACT-ONLY, with no fallback — deliberately asymmetric with
 * `getMessagingGroupByPlatform`'s default-instance-first resolution. An
 * unknown named instance must return null so the router auto-creates a
 * per-instance group instead of hijacking a sibling instance's row. The
 * default param (= channelType) keeps instance-less callers resolving the
 * default instance, identical to pre-instance behavior.
 */
export async function getMessagingGroupWithAgentCount(
  channelType: string,
  platformId: string,
  instance: string = channelType,
): Promise<{ mg: MessagingGroup; agentCount: number } | null> {
  const row = await getDb().get<MessagingGroup & { agent_count: number }>(
    `SELECT mg.*, COUNT(mga.id) AS agent_count
         FROM messaging_groups mg
    LEFT JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
        WHERE mg.channel_type = ? AND mg.platform_id = ? AND mg.instance = ?
     GROUP BY mg.id`,
    channelType,
    platformId,
    instance,
  );
  if (!row) return null;
  const { agent_count, ...mg } = row;
  return { mg: mg as MessagingGroup, agentCount: agent_count };
}

export async function getAllMessagingGroups(): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>('SELECT * FROM messaging_groups ORDER BY name');
}

/**
 * All messaging groups on a platform, across every adapter instance.
 * Semantics intentionally unchanged by the instance dimension — channel_type
 * stays the semantic platform key. No live caller today; if a caller needs
 * a single instance's rows, filter on `mg.instance`.
 */
export async function getMessagingGroupsByChannel(channelType: string): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>('SELECT * FROM messaging_groups WHERE channel_type = ?', channelType);
}

export async function updateMessagingGroup(
  id: string,
  updates: Partial<Pick<MessagingGroup, 'name' | 'is_group' | 'unknown_sender_policy'>>,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE messaging_groups SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function deleteMessagingGroup(id: string): Promise<void> {
  await getDb().run('DELETE FROM messaging_groups WHERE id = ?', id);
}

/**
 * Mark a messaging group as denied by the owner (channel-registration flow).
 * Future mentions on this channel silently drop until an admin explicitly
 * wires it via `createMessagingGroupAgent`, which implicitly clears the
 * denied state by making `agentCount > 0` — the router's denied-channel
 * check sits on the `agentCount === 0` branch.
 *
 * Passing null unsets the flag (used by tests or a future "unblock channel"
 * admin command).
 */
export async function setMessagingGroupDeniedAt(id: string, deniedAt: string | null): Promise<void> {
  await getDb().run('UPDATE messaging_groups SET denied_at = ? WHERE id = ?', deniedAt, id);
}

/**
 * Mark a messaging group as detached — our own bot left the platform channel
 * this row maps to (written by a channel membership module, migration 022).
 * The wiring, sessions, and destinations all survive detachment;
 * delivery/typing should skip the row until the bot rejoins. Passing null
 * clears the flag (rejoin), restoring the room with zero re-setup.
 */
export async function setMessagingGroupDetachedAt(id: string, detachedAt: string | null): Promise<void> {
  await getDb().run('UPDATE messaging_groups SET detached_at = ? WHERE id = ?', detachedAt, id);
}

/** True when the bot has left this conversation (detached_at set). The check
 *  delivery-side callers should consult before attempting a send. */
export async function isMessagingGroupDetached(id: string): Promise<boolean> {
  const row = await getDb().get<{ detached_at: string | null }>(
    'SELECT detached_at FROM messaging_groups WHERE id = ?',
    id,
  );
  return typeof row?.detached_at === 'string' && row.detached_at.length > 0;
}

// ── Messaging Group Agents ──

/**
 * Wire a messaging group to an agent group. Also auto-creates the matching
 * `agent_destinations` row so the agent can deliver to this chat as a
 * target, not just reply to the origin. Without this, routing to chats that
 * aren't the session's origin (agent-shared sessions, cross-channel sends)
 * would require an operator to hand-insert destination rows every time.
 *
 * The destination row is skipped if one already exists for the same target,
 * so re-wiring is a no-op. The local_name uses the messaging group's `name`
 * field when set, falling back to `${channel_type}-${mg_id prefix}`, with
 * a numeric suffix to break collisions within the agent's namespace. This
 * mirrors the backfill logic in migration 004.
 */
export async function createMessagingGroupAgent(mga: MessagingGroupAgent): Promise<void> {
  await getDb().run(
    `INSERT INTO messaging_group_agents (
         id, messaging_group_id, agent_group_id,
         engage_mode, engage_pattern, sender_scope, ignored_message_policy,
         session_mode, priority, created_at
       )
       VALUES (
         @id, @messaging_group_id, @agent_group_id,
         @engage_mode, @engage_pattern, @sender_scope, @ignored_message_policy,
         @session_mode, @priority, @created_at
       )`,
    mga,
  );

  // `threads` (migration 019) is written separately so existing callers that
  // omit it keep passing named-param sets that match the INSERT exactly
  // (better-sqlite3 rejects missing named params). Omitted/NULL = column
  // stays NULL = inherit the channel declaration at fanout time.
  if (mga.threads !== undefined && mga.threads !== null) {
    await getDb().run('UPDATE messaging_group_agents SET threads = ? WHERE id = ?', mga.threads, mga.id);
  }

  await ensureAgentDestinationForWiring(mga);
}

/**
 * Create the `agent_destinations` row that lets the agent address this chat
 * as a delivery target. Idempotent — no-op when the destination already
 * exists, the agent-to-agent module isn't installed, or the messaging group
 * has been deleted out from under the wiring.
 *
 * Split out from `createMessagingGroupAgent` so callers that already wrote
 * the `messaging_group_agents` row directly (e.g. the generic ncl CRUD path)
 * can still get the companion destination without re-inserting the wiring.
 *
 * ⚠️  DESTINATION PROJECTION NOTE: this function only writes the central
 * `agent_destinations` row. It does NOT project into any running agent's
 * session inbound.db (see top-of-file invariant in
 * src/modules/agent-to-agent/db/agent-destinations.ts). In practice this is
 * fine because the only real callers are one-shot setup paths
 * (setup/register.ts, scripts/init-first-agent.ts, /manage-channels skill,
 * ncl wirings create) that run in a separate process from the host. Any
 * already-running container for `mga.agent_group_id` will keep serving the
 * stale projection until its next wake (idle timeout or next inbound
 * message) at which point spawnContainer's writeDestinations call refreshes
 * from central. If you call this from code that runs INSIDE the host
 * process and need the refresh to happen immediately, explicitly call the
 * module's `writeDestinations(mga.agent_group_id, <sessionId>)` afterwards.
 */
export async function ensureAgentDestinationForWiring(mga: MessagingGroupAgent): Promise<void> {
  // Guarded: when the agent-to-agent module isn't installed the table
  // doesn't exist — skip silently. Without the module, the ACL check in
  // delivery is also skipped (same guard), so channel sends still work.
  if (!(await hasTable(getDb(), 'agent_destinations'))) return;

  const mg = await getMessagingGroup(mga.messaging_group_id);
  if (!mg) return;

  const base = normalizeName(mg.name || `${mg.channel_type}-${mga.messaging_group_id.slice(0, 8)}`);
  let localName = base;
  let suffix = 2;
  for (;;) {
    const existing = await getDestinationByTarget(mga.agent_group_id, 'channel', mga.messaging_group_id);
    if (existing) return;
    try {
      // The nested transaction is a savepoint when the wiring itself is being
      // created transactionally. Some remote backends mark a transaction
      // failed after a unique violation, so the retry needs this boundary.
      await getDb().transaction(async () => {
        await createDestination({
          agent_group_id: mga.agent_group_id,
          local_name: localName,
          target_type: 'channel',
          target_id: mga.messaging_group_id,
          created_at: mga.created_at,
        });
      });
      return;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
      localName = `${base}-${suffix}`;
      suffix++;
    }
  }
}

export async function getMessagingGroupAgents(messagingGroupId: string): Promise<MessagingGroupAgent[]> {
  return getDb().all<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? ORDER BY priority DESC, id',
    messagingGroupId,
  );
}

export async function getMessagingGroupAgentByPair(
  messagingGroupId: string,
  agentGroupId: string,
): Promise<MessagingGroupAgent | undefined> {
  return getDb().get<MessagingGroupAgent>(
    'SELECT * FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?',
    messagingGroupId,
    agentGroupId,
  );
}

export async function getMessagingGroupAgent(id: string): Promise<MessagingGroupAgent | undefined> {
  return getDb().get<MessagingGroupAgent>('SELECT * FROM messaging_group_agents WHERE id = ?', id);
}

export async function updateMessagingGroupAgent(
  id: string,
  updates: Partial<
    Pick<
      MessagingGroupAgent,
      | 'engage_mode'
      | 'engage_pattern'
      | 'sender_scope'
      | 'ignored_message_policy'
      | 'session_mode'
      | 'priority'
      | 'threads'
    >
  >,
): Promise<void> {
  const fields: string[] = [];
  const values: Record<string, unknown> = { id };

  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      fields.push(`${key} = @${key}`);
      values[key] = value;
    }
  }
  if (fields.length === 0) return;

  await getDb().run(`UPDATE messaging_group_agents SET ${fields.join(', ')} WHERE id = @id`, values);
}

export async function deleteMessagingGroupAgent(id: string): Promise<void> {
  await getDb().run('DELETE FROM messaging_group_agents WHERE id = ?', id);
}

/** Get all messaging groups wired to an agent group (reverse lookup). */
export async function getMessagingGroupsByAgentGroup(agentGroupId: string): Promise<MessagingGroup[]> {
  return getDb().all<MessagingGroup>(
    `SELECT mg.* FROM messaging_groups mg
       JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
       WHERE mga.agent_group_id = ?`,
    agentGroupId,
  );
}
