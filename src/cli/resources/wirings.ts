import {
  resolveWiringDefaults,
  validateEngageAgainstChannel,
  type EngageValues,
} from '../../channels/channel-defaults.js';
import { hasDeclaredChannelDefaults } from '../../channels/channel-registry.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { ensureAgentDestinationForWiring, getMessagingGroup } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { registerResource } from '../crud.js';
import { projectDestinationsToSessions } from './destinations.js';

function requireMessagingGroup(id: unknown): MessagingGroup {
  const mg = getMessagingGroup(String(id));
  if (!mg) throw new Error(`messaging group not found: ${id}`);
  return mg;
}

/** --threads accepts true/false (or 1/0); stored as INTEGER 1/0. Omitted =
 *  column NULL = inherit the channel declaration. */
function normalizeThreads(v: unknown): number {
  if (v === true || v === 'true' || v === '1' || v === 1) return 1;
  if (v === false || v === 'false' || v === '0' || v === 0) return 0;
  throw new Error(`--threads must be true or false, got "${v}"`);
}

registerResource({
  name: 'wiring',
  plural: 'wirings',
  table: 'messaging_group_agents',
  description:
    'Wiring — connects a messaging group to an agent group. Determines which agent handles messages from which chat. The same messaging group can be wired to multiple agents; the same agent can be wired to multiple messaging groups.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'The chat/channel to route from. References messaging_groups.id.',
      required: true,
    },
    {
      name: 'agent_group_id',
      type: 'string',
      description: 'The agent that handles messages. References agent_groups.id.',
      required: true,
    },
    {
      name: 'engage_mode',
      type: 'string',
      description:
        'When the agent engages. "mention" — only when @mentioned or in DMs. "mention-sticky" — once mentioned in a thread, the agent subscribes and responds to all subsequent messages in that thread without needing further mentions. "pattern" — matches every message against engage_pattern regex. Default: declared by the channel adapter for the target chat (DM vs group); "mention" when the channel has no declaration.',
      enum: ['pattern', 'mention', 'mention-sticky'],
      default: 'mention',
      updatable: true,
    },
    {
      name: 'engage_pattern',
      type: 'string',
      description:
        'Regex for engage_mode=pattern. Required when mode is pattern. Use "." to match every message (always-on). Ignored for mention modes.',
      updatable: true,
    },
    {
      name: 'sender_scope',
      type: 'string',
      description:
        '"all" — any sender (subject to unknown_sender_policy). "known" — only users with a role or membership in this agent group.',
      enum: ['all', 'known'],
      default: 'all',
      updatable: true,
    },
    {
      name: 'ignored_message_policy',
      type: 'string',
      description:
        'What happens to messages that don\'t trigger engagement. "drop" — agent never sees them. "accumulate" — stored as background context (trigger=0) so the agent has prior context when eventually triggered.',
      enum: ['drop', 'accumulate'],
      default: 'drop',
      updatable: true,
    },
    {
      name: 'session_mode',
      type: 'string',
      description:
        '"shared" — one session per (agent, messaging group). "per-thread" — separate session per thread/topic. "agent-shared" — one session across all messaging groups wired to this agent. Note: threaded adapters in group chats force per-thread regardless of this setting.',
      enum: ['shared', 'per-thread', 'agent-shared'],
      default: 'shared',
      updatable: true,
    },
    {
      name: 'threads',
      type: 'boolean',
      description:
        'Per-wiring thread override: honor platform thread ids for this wiring (per-thread sessions in groups; replies, typing, and cards land in-thread). NULL = inherit channel default. Can disable threads on a threaded platform, never enable them on a non-threaded one.',
      updatable: true,
    },
    {
      name: 'priority',
      type: 'number',
      description: 'Fanout order when multiple agents are wired to the same messaging group — higher priority first.',
      default: 0,
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  resolveDefaults: (values) => {
    const mg = requireMessagingGroup(values.messaging_group_id);
    if (values.threads !== undefined) values.threads = normalizeThreads(values.threads);

    const channelKey = mg.instance ?? mg.channel_type;
    // Undeclared (stale) channels: leave engage_mode unset so the static
    // 'mention' default applies afterwards — a trunk update alone must not
    // change ncl's creation defaults for adapters without a declaration.
    if (values.engage_mode === undefined) {
      if (hasDeclaredChannelDefaults(channelKey, mg.channel_type)) {
        const ag = getAgentGroup(String(values.agent_group_id));
        if (!ag) throw new Error(`agent group not found: ${values.agent_group_id}`);
        const resolved = resolveWiringDefaults(channelKey, mg.is_group === 1, ag.name, mg.channel_type);
        values.engage_mode = resolved.engage_mode;
        if (values.engage_pattern === undefined && resolved.engage_pattern !== null) {
          values.engage_pattern = resolved.engage_pattern;
        }
      } else {
        log.warn(
          `wiring create: channel '${channelKey}' has no declared defaults (adapter not installed or stale) — using legacy static defaults`,
        );
      }
    }
    validateEngageAgainstChannel(values, mg);
  },
  preUpdate: (updates, current) => {
    const mg = requireMessagingGroup(current.messaging_group_id);
    if (updates.threads !== undefined) updates.threads = normalizeThreads(updates.threads);

    const merged: EngageValues = { ...current, ...updates };
    // Legacy rows can be engage_mode='pattern' with a NULL pattern (the
    // router treats that as match-all). Don't reject unrelated updates to
    // them — only enforce the pairing when the pattern fields change.
    if (
      updates.engage_mode === undefined &&
      updates.engage_pattern === undefined &&
      merged.engage_mode === 'pattern' &&
      (merged.engage_pattern === undefined || merged.engage_pattern === null)
    ) {
      merged.engage_pattern = '.';
    }
    validateEngageAgainstChannel(merged, mg);
    // Carry the sticky→mention coercion (if any) back into the update set.
    if (merged.engage_mode !== (updates.engage_mode ?? current.engage_mode)) {
      updates.engage_mode = merged.engage_mode;
    }
  },
  postCreate: (row) => {
    // Create the companion `agent_destinations` row so the agent has a
    // local name it can address this chat by. Without this, the agent
    // generates a response, but delivery's ACL drops the outbound message
    // (no destination matches the target) and the reply is silently lost.
    // `createMessagingGroupAgent` does this automatically; the generic
    // CRUD path doesn't, hence this hook. See issue #2389.
    ensureAgentDestinationForWiring(row as unknown as MessagingGroupAgent);
  },
  postCommit: async (row) => {
    // Live-refresh parity with `ncl destinations add`: `postCreate` above
    // only wrote the central `agent_destinations` row. Any container already
    // running for this agent keeps serving its stale session projection, so
    // it would drop replies to this chat as "unknown destination" until the
    // next spawn (the exact symptom operators hit running `ncl wirings
    // create` against a live instance — it needed a group restart). Project
    // the new destination into live sessions now so the fix takes effect
    // without a restart. Runs after commit because it writes to session
    // `inbound.db` files (outside the central-DB transaction) and is async.
    await projectDestinationsToSessions((row as unknown as MessagingGroupAgent).agent_group_id);
  },
});
