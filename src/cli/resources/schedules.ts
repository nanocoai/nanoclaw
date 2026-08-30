/**
 * `ncl schedules` — read + manage scheduled tasks across an agent group's
 * sessions.
 *
 * Tasks live behind the mailbox seam; there is no central table. `list`
 * aggregates the live series (pending | paused) across the group's sessions;
 * mutations locate the series' session and use the same mailbox implementation
 * as delivery (SQLite, S3, or another registered backend).
 *
 * Deliberately no create verb: task creation stays conversational (the
 * agent's schedule_task MCP tool). Built for the governance service's
 * Slack-home Scheduled-tasks tab; not in the container group-scope allowlist
 * (agents keep using their session-scoped MCP tools).
 */
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import type { InboundMailbox, TaskRecord, TaskUpdate } from '../../mailbox/index.js';
import { withExistingMailboxSession, withMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { registerResource } from '../crud.js';

export interface ScheduledTaskRow {
  series_id: string;
  /** The live row's id (differs from series_id after the first recurrence). */
  id: string;
  session_id: string;
  agent_group_id: string;
  status: 'pending' | 'paused';
  process_after: string | null;
  recurrence: string | null;
  prompt: string;
  has_script: boolean;
  channel_type: string | null;
  platform_id: string | null;
  created: string;
}

function parsePrompt(content: string): { prompt: string; hasScript: boolean } {
  try {
    const parsed = JSON.parse(content) as { prompt?: unknown; script?: unknown };
    return {
      prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
      hasScript: typeof parsed.script === 'string' && parsed.script.length > 0,
    };
  } catch {
    return { prompt: '', hasScript: false };
  }
}

/** A missing mailbox contributes nothing; list remains fail-soft for old rows. */
async function collectSessionTasks(session: Session): Promise<ScheduledTaskRow[]> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox
        .listLiveTasks()
        .filter(
          (task): task is TaskRecord & { status: 'pending' | 'paused' } =>
            task.status === 'pending' || task.status === 'paused',
        )
        .map((task) => {
          const { prompt, hasScript } = parsePrompt(task.content);
          return {
            series_id: task.seriesId ?? task.id,
            id: task.id,
            session_id: session.id,
            agent_group_id: session.agent_group_id,
            status: task.status,
            process_after: task.processAfter,
            recurrence: task.recurrence,
            prompt,
            has_script: hasScript,
            channel_type: null,
            platform_id: null,
            created: task.timestamp,
          };
        }),
    )) ?? []
  );
}

function requireGroup(args: Record<string, unknown>): string {
  const group = (args.group ?? args.id) as string | undefined;
  if (!group) throw new Error('--group <agent-group-id> is required');
  return group;
}

async function listGroupTasks(agentGroupId: string): Promise<ScheduledTaskRow[]> {
  const tasks = (
    await Promise.all((await getSessionsByAgentGroup(agentGroupId)).map(collectSessionTasks))
  ).flat();
  // One live row per series is the invariant (recurrence inserts the next
  // occurrence only after the prior completes); if a DB ever violates it,
  // keep the soonest-due row rather than duplicating the series in the UI.
  const bySeries = new Map<string, ScheduledTaskRow>();
  for (const t of tasks) {
    const existing = bySeries.get(t.series_id);
    if (!existing || (t.process_after ?? '') < (existing.process_after ?? '')) {
      bySeries.set(t.series_id, t);
    }
  }
  return [...bySeries.values()].sort((a, b) => (a.process_after ?? '').localeCompare(b.process_after ?? ''));
}

/** Find which of the group's existing mailboxes holds the series, then mutate it. */
async function mutateSeries(
  agentGroupId: string,
  taskId: string,
  apply: (mailbox: InboundMailbox) => number,
): Promise<{ session_id: string; rows: number }> {
  for (const session of await getSessionsByAgentGroup(agentGroupId)) {
    const found = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      Boolean(mailbox.getTask(taskId) ?? mailbox.listLiveTasks().find((task) => task.seriesId === taskId)),
    );
    if (!found) continue;
    const rows = await withMailboxSession(session.agent_group_id, session.id, apply);
    return { session_id: session.id, rows };
  }
  throw new Error(`schedules: task ${taskId} not found in agent group ${agentGroupId}`);
}

registerResource({
  name: 'schedule',
  plural: 'schedules',
  // Session-DB-backed — no central table; only the custom verbs below exist.
  table: '',
  description:
    "Scheduled tasks across an agent group's sessions (messages_in kind='task'). " +
    'Read + manage only — creation stays conversational via the agent. ' +
    'Drives the Slack-home Scheduled-tasks tab.',
  idColumn: 'series_id',
  columns: [],
  operations: {},
  customOperations: {
    list: {
      access: 'open',
      description:
        "Live (pending/paused) task series across the group's sessions, one row per series, soonest first. --group <agent-group-id>.",
      handler: async (args) => ({ tasks: await listGroupTasks(requireGroup(args as Record<string, unknown>)) }),
    },
    pause: {
      access: 'open',
      description: 'Pause a pending series. --group <agent-group-id> --task-id <series-or-task-id>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        const taskId = a.task_id as string | undefined;
        if (!taskId) throw new Error('--task-id <series-or-task-id> is required');
        return { paused: taskId, ...(await mutateSeries(requireGroup(a), taskId, (mailbox) => mailbox.pauseTask(taskId))) };
      },
    },
    resume: {
      access: 'open',
      description: 'Resume a paused series. --group <agent-group-id> --task-id <series-or-task-id>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        const taskId = a.task_id as string | undefined;
        if (!taskId) throw new Error('--task-id <series-or-task-id> is required');
        return { resumed: taskId, ...(await mutateSeries(requireGroup(a), taskId, (mailbox) => mailbox.resumeTask(taskId))) };
      },
    },
    cancel: {
      access: 'open',
      description:
        'Cancel a live series (marks completed, clears recurrence). --group <agent-group-id> --task-id <series-or-task-id>.',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        const taskId = a.task_id as string | undefined;
        if (!taskId) throw new Error('--task-id <series-or-task-id> is required');
        return {
          cancelled: taskId,
          ...(await mutateSeries(requireGroup(a), taskId, (mailbox) => mailbox.cancelTask(taskId))),
        };
      },
    },
    update: {
      access: 'open',
      description:
        'Update a live series in place. --group <agent-group-id> --task-id <id> [--prompt <text>] [--recurrence <cron|null>] [--process-after <iso>].',
      handler: async (args) => {
        const a = args as Record<string, unknown>;
        const taskId = a.task_id as string | undefined;
        if (!taskId) throw new Error('--task-id <series-or-task-id> is required');
        const update: TaskUpdate = {};
        if (typeof a.prompt === 'string') update.prompt = a.prompt;
        if (a.recurrence !== undefined) update.recurrence = a.recurrence === 'null' ? null : (a.recurrence as string);
        if (typeof a.process_after === 'string') update.processAfter = a.process_after;
        if (Object.keys(update).length === 0) {
          throw new Error('nothing to update — pass --prompt, --recurrence, or --process-after');
        }
        return {
          updated: taskId,
          ...(await mutateSeries(requireGroup(a), taskId, (mailbox) => mailbox.updateTask(taskId, update))),
        };
      },
    },
  },
});
