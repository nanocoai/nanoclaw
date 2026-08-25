/**
 * Project the agent's central `agent_destinations` rows into its per-session
 * `inbound.db` so the running container can resolve names locally. Called on
 * every container wake and after admin-time destination edits (e.g. create_agent).
 *
 * Core container-runner calls this via a dynamic import guarded by a
 * `hasTable('agent_destinations')` check — without the agent-to-agent module
 * installed, the central table doesn't exist and the projection is skipped.
 */
import { getAgentGroup } from '../../db/agent-groups.js';
import { getMessagingGroup, getMessagingGroupsByAgentGroup } from '../../db/messaging-groups.js';
import type { Destination } from '../../mailbox/index.js';
import { log } from '../../log.js';
import { withMailboxSession } from '../../session-manager.js';
import { getDestinations } from './db/agent-destinations.js';

/**
 * Resolve the agent's central destination rows against their targets. A row
 * whose target no longer resolves is dropped — the projection carries the
 * target's routing address, not just its local name, and there is none to
 * carry.
 */
async function resolveDestinations(agentGroupId: string): Promise<Destination[]> {
  const rows = await getDestinations(agentGroupId);
  const resolved: Destination[] = [];

  for (const row of rows) {
    if (row.target_type === 'channel') {
      const mg = await getMessagingGroup(row.target_id);
      if (!mg) continue;
      resolved.push({
        name: row.local_name,
        displayName: mg.name ?? row.local_name,
        type: 'channel',
        channelType: mg.channel_type,
        platformId: mg.platform_id,
        agentGroupId: null,
      });
    } else if (row.target_type === 'agent') {
      const ag = await getAgentGroup(row.target_id);
      if (!ag) continue;
      resolved.push({
        name: row.local_name,
        displayName: ag.name,
        type: 'agent',
        channelType: null,
        platformId: null,
        agentGroupId: ag.id,
      });
    }
  }

  return resolved;
}

export async function writeDestinations(agentGroupId: string, sessionId: string): Promise<Destination[]> {
  const resolved = await resolveDestinations(agentGroupId);
  await withMailboxSession(agentGroupId, sessionId, (db) => {
    db.replaceDestinations(resolved);
  });
  log.debug('Destination map written', { sessionId, count: resolved.length });
  return resolved;
}

/** A chat's routing address, as the projection and the delivery side see it. */
function addressKey(channelType: string, platformId: string): string {
  return `${channelType} ${platformId}`;
}

/**
 * Report chats the agent is wired to but has no destination for.
 *
 * Everything the agent addresses is resolved by name against the projection
 * and against nothing else (`findByName`), so a wired chat absent from the
 * projection is a chat the agent cannot address: its `<message to="…">` blocks
 * are dropped at `[poll-loop] Unknown destination …` and its `send_message` /
 * `send_file` calls come back as tool errors. The turn is still acked as
 * processed either way.
 *
 * Not everything the container writes goes through a name. `send_card`,
 * `ask_user_question`, and the runner's own notices (`/clear`, `/upload-trace`,
 * a failed turn) address the session's routing directly, and delivery lets an
 * origin-chat send through without an ACL row (`isOriginChat`) — so those still
 * land. What is lost is the agent's composed reply, which is the part a user
 * is waiting on.
 *
 * A turn whose blocks all drop is nudged to retry with the names it does have,
 * so the outcome is not always silence: the reply can end up in a different
 * chat instead of the one it was meant for.
 *
 * That drop is not invisible, just quiet: the container writes it to stderr,
 * the driver forwards every attached stderr line to the host, and the host
 * logs it at `debug`. A default install runs at `LOG_LEVEL=info` and never
 * sees it. This warning is the same failure, reported at a level the default
 * install does see.
 *
 * Keyed on wirings rather than on any one session, because a session's
 * `messaging_group_id` is not the set of chats it serves — an `agent-shared`
 * session handles every chat wired to the agent while staying pinned to
 * whichever one created it.
 *
 * Matched by `(channel_type, platform_id)` rather than messaging-group id,
 * because that pair is what the projection carries and what delivery resolves
 * against. Two messaging-group rows can share one address (migration 016 keyed
 * uniqueness on `instance` as well), and a destination pointing at either of
 * them gives the agent a name delivery will accept. Whether the send then
 * lands is a separate question — delivery uses the resolved row's `instance`
 * to pick the adapter, and a sibling instance need not be in the chat.
 *
 * `warn`, not `error`: an absent row also means "not authorized" — this table
 * is the ACL, and removing a row is a deliberate act either way (approval-gated
 * from an agent, immediate for an operator on the socket). A revoked
 * destination looks identical from here, so this reports the consequence
 * without asserting a misconfiguration or prescribing a fix.
 *
 * Detached chats are skipped: our bot has left them, and delivery refuses them
 * outright, so no reply was reaching them regardless of the destination map.
 * `denied_at` is deliberately *not* skipped — the router only consults it on a
 * group with no wirings at all, which by construction is not in this set, so
 * filtering on it would drop true positives and report nothing else.
 *
 * `resolved` is the projection this agent's sessions were just given; pass it
 * to reuse that work. Omitting it resolves the destinations again.
 */
export async function reportUnreachableWiredChats(
  agentGroupId: string,
  resolved?: readonly Destination[],
): Promise<void> {
  resolved ??= await resolveDestinations(agentGroupId);
  const reachable = new Set(
    resolved
      .filter((d) => d.type === 'channel' && d.channelType !== null && d.platformId !== null)
      .map((d) => addressKey(d.channelType as string, d.platformId as string)),
  );

  const unreachable = (await getMessagingGroupsByAgentGroup(agentGroupId))
    .filter((mg) => !mg.detached_at)
    .filter((mg) => !reachable.has(addressKey(mg.channel_type, mg.platform_id)))
    .map((mg) => ({ messagingGroupId: mg.id, channelType: mg.channel_type, name: mg.name }));

  if (unreachable.length === 0) return;
  log.warn('Wired chats have no destination — the agent cannot address them, so its replies there are dropped', {
    agentGroupId,
    chats: unreachable,
  });
}
