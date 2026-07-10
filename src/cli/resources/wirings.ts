import { ensureAgentDestinationForWiring } from '../../db/messaging-groups.js';
import type { MessagingGroupAgent } from '../../types.js';
import { registerResource } from '../crud.js';
import { projectDestinationsToSessions } from './destinations.js';

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
        'When the agent engages. "mention" — only when @mentioned or in DMs. "mention-sticky" — once mentioned in a thread, the agent subscribes and responds to all subsequent messages in that thread without needing further mentions. "pattern" — matches every message against engage_pattern regex.',
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
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
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
