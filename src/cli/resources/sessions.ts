import { isContainerRunning, wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { writeSessionMessage } from '../../session-manager.js';
import { registerResource } from '../crud.js';

registerResource({
  name: 'session',
  plural: 'sessions',
  table: 'sessions',
  description:
    'Session — the runtime unit. Maps one (agent_group, messaging_group, thread) combination to a container with its own inbound.db and outbound.db. Created automatically by the router when a message arrives.',
  idColumn: 'id',
  scopeField: 'agent_group_id',
  columns: [
    { name: 'id', type: 'string', description: 'UUID.', generated: true },
    { name: 'agent_group_id', type: 'string', description: 'Agent group this session runs.' },
    {
      name: 'messaging_group_id',
      type: 'string',
      description: 'Messaging group this session serves. Null for agent-shared sessions.',
    },
    {
      name: 'thread_id',
      type: 'string',
      description: 'Thread ID. Only set for per-thread session mode.',
    },
    {
      name: 'agent_provider',
      type: 'string',
      description: 'Provider override. Null means inherit from agent group.',
    },
    {
      name: 'status',
      type: 'string',
      description: '"active" receives messages. "closed" is archived.',
      enum: ['active', 'closed'],
    },
    {
      name: 'container_status',
      type: 'string',
      description:
        '"running" — container alive and polling. "stopped" — container exited; the sweep will restart it automatically when due messages arrive. "idle" — reserved, currently unused.',
      enum: ['running', 'idle', 'stopped'],
    },
    { name: 'last_active', type: 'string', description: 'Last message or heartbeat. Used for stale detection.' },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open' },
  customOperations: {
    wake: {
      access: 'approval',
      description:
        'Wake a stopped session — spawn its container now instead of waiting for the next inbound ' +
        'message or the 60s host sweep. Use --id <session-id> [--message <text>]. From inside a ' +
        'container, --id defaults to the calling session. --message delivers an on-wake instruction ' +
        'the fresh container picks up on its first poll (e.g. why it was woken, what to do). ' +
        'No-ops if the session is already running. Use this to revive a session reaped by the ' +
        'absolute-ceiling watchdog; `groups restart` cannot, since it only bounces running containers.',
      args: [
        {
          name: 'id',
          type: 'string',
          description: 'Session ID to wake. From inside a container, defaults to the calling session.',
        },
        {
          name: 'message',
          type: 'string',
          description: 'Optional on-wake instruction delivered to the fresh container on its first poll.',
        },
      ],
      handler: async (args, ctx) => {
        const sessionId = (args.id as string) || (ctx.caller === 'agent' ? ctx.sessionId : undefined);
        if (!sessionId) throw new Error('--id is required');

        const session = getSession(sessionId);
        // Group-scope enforcement: unlike groups/destinations, the dispatcher
        // does NOT cross-group-check --id for session custom ops, so we do it
        // here. Mirror sessions-get's fail-closed "not found" so a group-scoped
        // agent can't use this as an existence oracle for other groups' sessions.
        if (!session || (ctx.caller === 'agent' && session.agent_group_id !== ctx.agentGroupId)) {
          throw new Error(`session not found: ${sessionId}`);
        }
        if (session.status !== 'active') {
          throw new Error(`session is "${session.status}", not active — cannot wake`);
        }

        if (isContainerRunning(session.id)) {
          return { woken: false, alreadyRunning: true, sessionId: session.id };
        }

        const message = args.message as string | undefined;
        if (message) {
          writeSessionMessage(session.agent_group_id, session.id, {
            id: `wake-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            kind: 'chat',
            timestamp: new Date().toISOString(),
            platformId: session.agent_group_id,
            channelType: 'agent',
            threadId: null,
            content: JSON.stringify({ text: message, sender: 'system', senderId: 'system' }),
            onWake: 1,
          });
        }

        // dispatch() always runs host-side (socket server for host callers, the
        // host's DB poller for agent callers), so wakeContainer mutates the
        // host's own activeContainers map in-process — no split-brain.
        const ok = await wakeContainer(session);
        return { woken: ok, alreadyRunning: false, sessionId: session.id, message: message ?? null };
      },
    },
  },
});
