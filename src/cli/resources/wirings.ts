import { randomUUID } from 'crypto';

import {
  resolveWiringDefaults,
  validateEngageAgainstChannel,
  type EngageValues,
} from '../../channels/channel-defaults.js';
import { hasDeclaredChannelDefaults } from '../../channels/channel-registry.js';
import { getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getDb } from '../../db/connection.js';
import {
  ensureAgentDestinationForWiring,
  getMessagingGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import type { MessagingGroup, MessagingGroupAgent } from '../../types.js';
import { registerResource } from '../crud.js';
import { projectDestinationsToSessions } from './destinations.js';

/**
 * Pass-1 parity with the generic create: enum validation for explicit flags
 * (the custom `create` below bypasses genericCreate, which would otherwise
 * reject e.g. `--engage-mode bogus`).
 */
const CREATE_ENUMS: Record<string, string[]> = {
  engage_mode: ['pattern', 'mention', 'mention-sticky'],
  sender_scope: ['all', 'known'],
  ignored_message_policy: ['drop', 'accumulate'],
  session_mode: ['shared', 'per-thread', 'agent-shared'],
};

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
  // Generic create is replaced by the custom `create` below — it resolves
  // natural keys (so a skill can wire by channel/platform + agent-group folder
  // without first looking up synthetic ids) and is idempotent on the pair.
  // The generic path's resolveDefaults/postCreate/postCommit hooks would never
  // fire without generic create, so their bodies live inline in the custom
  // handler (declaration-aware defaults, companion destination row, live
  // session projection) — keep them in sync with genericCreate's semantics.
  operations: { list: 'open', get: 'open', update: 'approval', delete: 'approval' },
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
  customOperations: {
    create: {
      access: 'approval',
      description:
        'Wire a messaging group to an agent group. Identify the messaging group by --messaging-group-id OR --channel-type + --platform-id (+ --instance); identify the agent by --agent-group-id OR --agent-group <folder>. Idempotent on (messaging group, agent group). Engagement flags: --engage-mode, --engage-pattern, --session-mode, --sender-scope, --ignored-message-policy, --threads, --priority. Omitted engage flags default from the channel adapter declaration.',
      handler: async (args) => {
        // Resolve the messaging group.
        let mgId = args.messaging_group_id as string | undefined;
        if (!mgId) {
          const channelType = args.channel_type as string;
          const platformId = args.platform_id as string;
          if (!channelType || !platformId) {
            throw new Error('provide --messaging-group-id, or --channel-type and --platform-id to resolve it');
          }
          const mg = getMessagingGroupByPlatform(channelType, platformId, (args.instance as string) ?? channelType);
          if (!mg) throw new Error(`no messaging group for ${channelType} ${platformId} — create it first`);
          mgId = mg.id;
        }

        // Resolve the agent group (by id or by folder).
        let agId = args.agent_group_id as string | undefined;
        if (!agId) {
          const ref = args.agent_group as string;
          if (!ref) throw new Error('provide --agent-group-id or --agent-group <folder>');
          const ag = getAgentGroup(ref) ?? getAgentGroupByFolder(ref);
          if (!ag) throw new Error(`no agent group "${ref}" (by id or folder)`);
          agId = ag.id;
        }

        // Idempotent: a wiring for this pair already exists → return it
        // (defaults/validation/side-effects are skipped — nothing new is written).
        const existing = getMessagingGroupAgentByPair(mgId, agId);
        if (existing) return existing;

        // Pass-1 parity: only defined keys enter `values` (an unset
        // engage_pattern stays absent → column NULL), enums validated.
        const values: Record<string, unknown> = {
          id: randomUUID(),
          messaging_group_id: mgId,
          agent_group_id: agId,
          created_at: new Date().toISOString(),
        };
        for (const [name, allowed] of Object.entries(CREATE_ENUMS)) {
          const v = args[name];
          if (v === undefined) continue;
          if (!allowed.includes(String(v))) {
            throw new Error(`${name} must be one of: ${allowed.join(', ')}`);
          }
          values[name] = v;
        }
        if (args.engage_pattern !== undefined) values.engage_pattern = args.engage_pattern;
        if (args.threads !== undefined) values.threads = args.threads;
        if (args.priority !== undefined) values.priority = Number(args.priority);

        // Pass-2 parity: context-aware defaults + cross-column validation.
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
        // May mutate values.engage_mode (mention-sticky→mention coercion) —
        // must run after declaration resolution and threads normalization.
        validateEngageAgainstChannel(values, mg);

        // Pass-3 parity: static defaults for whatever is still unset. threads
        // is intentionally left absent when omitted — column NULL = inherit
        // the channel declaration.
        if (values.engage_mode === undefined) values.engage_mode = 'mention';
        if (values.sender_scope === undefined) values.sender_scope = 'all';
        if (values.ignored_message_policy === undefined) values.ignored_message_policy = 'drop';
        if (values.session_mode === undefined) values.session_mode = 'shared';
        if (values.priority === undefined) values.priority = 0;

        // postCreate parity, in one transaction with the INSERT (a throw rolls
        // back the parent row). Dynamic INSERT — not createMessagingGroupAgent,
        // which doesn't insert `threads`, so an explicit --threads would be
        // lost. Create the companion `agent_destinations` row so the agent has
        // a local name it can address this chat by. Without this, the agent
        // generates a response, but delivery's ACL drops the outbound message
        // (no destination matches the target) and the reply is silently lost.
        // See issue #2389.
        const colNames = Object.keys(values);
        const placeholders = colNames.map((c) => `@${c}`);
        const db = getDb();
        db.transaction(() => {
          db.prepare(
            `INSERT INTO messaging_group_agents (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`,
          ).run(values);
          ensureAgentDestinationForWiring(values as unknown as MessagingGroupAgent);
        })();

        // postCommit parity — live-refresh with `ncl destinations add`: the
        // transaction above only wrote the central `agent_destinations` row.
        // Any container already running for this agent keeps serving its stale
        // session projection, so it would drop replies to this chat as
        // "unknown destination" until the next spawn (the exact symptom
        // operators hit running `ncl wirings create` against a live instance —
        // it needed a group restart). Project the new destination into live
        // sessions now so the fix takes effect without a restart. Runs after
        // commit because it writes to session `inbound.db` files (outside the
        // central-DB transaction) and is async.
        await projectDestinationsToSessions(agId);

        return values;
      },
    },
  },
});
