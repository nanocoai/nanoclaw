/**
 * WhatsApp group auto-onboarding.
 *
 * Default behavior for this install: any WhatsApp group the bot is added to
 * should just work, with no per-group setup or approval tap. `onMetadata` on
 * the WhatsApp adapter fires both from the periodic full-group sync and from
 * every inbound group message (see src/channels/whatsapp.ts `syncGroupMetadata`
 * / `onMetadata` call sites), so wiring the auto-create + auto-wire logic in
 * here gives us real-time sync for newly-joined groups without touching the
 * router's mention-gated auto-create path (src/router.ts) or the WhatsApp
 * adapter itself.
 *
 * Idempotent: safe to call on every metadata event. Cheap lookups short-
 * circuit once a group has been seen.
 */
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
  updateMessagingGroup,
} from './db/messaging-groups.js';
import { log } from './log.js';
import { readEnvFile } from './env.js';
import type { MessagingGroup } from './types.js';

/**
 * Agent group every new WhatsApp group auto-wires to. Overridable via env for
 * other installs; falls back to Elia's Shellanoo agent group id.
 */
const DEFAULT_AGENT_GROUP_ID =
  (readEnvFile(['WHATSAPP_AUTOWIRE_AGENT_GROUP_ID']).WHATSAPP_AUTOWIRE_AGENT_GROUP_ID ?? '').trim() ||
  'ag-1778670984219-665dop';

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Ensure a WhatsApp group has a messaging_groups row and is wired to the
 * default agent group. Called from onMetadata for every WhatsApp group seen
 * (startup sync, periodic resync, and per inbound group message) — no-ops
 * once both the row and the wiring exist.
 */
export function ensureWhatsAppGroupAutoWired(
  platformId: string,
  name: string | undefined,
  isGroup: boolean | undefined,
): void {
  if (!isGroup) return;

  let mg: MessagingGroup | undefined = getMessagingGroupByPlatform('whatsapp', platformId);

  if (!mg) {
    const id = generateId('mg');
    mg = {
      id,
      channel_type: 'whatsapp',
      platform_id: platformId,
      name: name ?? null,
      is_group: 1,
      // 'public' — group members should never hit an approval tap just for
      // being in the group. This is a group-level default, distinct from
      // per-wiring sender_scope.
      unknown_sender_policy: 'public',
      denied_at: null,
      created_at: new Date().toISOString(),
    };
    createMessagingGroup(mg);
    log.info('Auto-registered WhatsApp group', { id, platformId, name });
  } else if (name && !mg.name) {
    updateMessagingGroup(mg.id, { name });
    mg = { ...mg, name };
  }

  // Respect manual configuration: only auto-wire groups nobody has wired yet.
  // A group that's already wired to any agent (even a different one) was set
  // up deliberately — piling the default agent on top would double-answer.
  if (getMessagingGroupAgents(mg.id).length > 0) return;

  createMessagingGroupAgent({
    id: generateId('mga'),
    messaging_group_id: mg.id,
    agent_group_id: DEFAULT_AGENT_GROUP_ID,
    // 'mention' — reply only when explicitly @mentioned, every time, no
    // stickiness. 'mention-sticky' was tried but its "stay engaged" half
    // only makes sense per-thread; WhatsApp has no threads (adapter
    // collapses every group to one session — see router.ts's
    // adapter.supportsThreads handling), so "sticky" here means "once
    // mentioned, reply to literally everything in the group forever" —
    // exactly the always-on chatter behaviour Elia explicitly didn't want in
    // a family group. Plain 'mention' requires a fresh @tag every time,
    // matching "just listen unless addressed directly".
    engage_mode: 'mention',
    engage_pattern: null,
    sender_scope: 'all',
    ignored_message_policy: 'accumulate',
    // 'agent-shared' — every chat wired to this agent converges on ONE
    // session (src/session-manager.ts resolveSession). This is what makes
    // silent accumulation useful: group chatter lands as trigger=0 context
    // in the same conversation the owner's DM lives in, so the agent can
    // be asked "what happened in the family group?" from the DM. With
    // per-chat 'shared' sessions the accumulated context was stranded in a
    // session nobody ever woke.
    session_mode: 'agent-shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Auto-wired WhatsApp group to agent group', {
    messagingGroupId: mg.id,
    agentGroupId: DEFAULT_AGENT_GROUP_ID,
  });
}
