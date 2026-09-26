/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');
const THINGS_REQUESTS_DIR = path.join(IPC_DIR, 'things-requests');
const THINGS_RESPONSES_DIR = path.join(IPC_DIR, 'things-responses');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times. Note: when running as a scheduled task, your final output is NOT sent to the user — use this tool if you need to communicate with the user or group.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const data = {
      type: 'schedule_task',
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    const filename = writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task scheduled (${filename}): ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new WhatsApp group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name should be lowercase with hyphens (e.g., "family-chat").`,
  {
    jid: z.string().describe('The WhatsApp JID (e.g., "120363336345536173@g.us")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Folder name for group files (lowercase, hyphens, e.g., "family-chat")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// ── Things 3 integration ─────────────────────────────────────────────────────

async function thingsRequest(
  command: string,
  cliArgs: string[],
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  writeIpcFile(THINGS_REQUESTS_DIR, {
    requestId,
    command,
    cliArgs,
    groupFolder,
    timestamp: new Date().toISOString(),
  });

  const responseFile = path.join(THINGS_RESPONSES_DIR, `${requestId}.json`);
  const deadline = Date.now() + 10000;

  while (Date.now() < deadline) {
    if (fs.existsSync(responseFile)) {
      try {
        const response = JSON.parse(fs.readFileSync(responseFile, 'utf-8'));
        try { fs.unlinkSync(responseFile); } catch { /* ignore */ }
        if (response.error) {
          return { content: [{ type: 'text' as const, text: `Error: ${response.error}` }] };
        }
        return { content: [{ type: 'text' as const, text: response.result || '(no output)' }] };
      } catch {
        // File may still be mid-write — retry
      }
    }
    await new Promise((r) => setTimeout(r, 200));
  }

  return {
    content: [{ type: 'text' as const, text: 'Error: Things request timed out after 10 seconds' }],
  };
}

server.tool(
  'things_list',
  'List todos from Things 3. Views: today, inbox, upcoming, anytime, someday, logbook, logtoday, all, projects, areas, tags. Returns JSON with UUID, title, project, area, status, deadline, notes.',
  {
    view: z
      .enum(['today', 'inbox', 'upcoming', 'anytime', 'someday', 'logbook', 'logtoday', 'all', 'projects', 'areas', 'tags'])
      .default('today')
      .describe('Which Things view to list'),
    project: z.string().optional().describe('Filter by project name or ID'),
    area: z.string().optional().describe('Filter by area name or ID'),
    tag: z.string().optional().describe('Filter by tag'),
    search: z.string().optional().describe('Case-insensitive substring match on title or notes'),
    limit: z.number().int().positive().optional().describe('Max results (default: 50)'),
    sort: z.string().optional().describe('Sort fields, e.g. "-deadline,title"'),
  },
  async (args) => {
    const cliArgs = ['--json'];
    if (args.project) cliArgs.push(`--project=${args.project}`);
    if (args.area) cliArgs.push(`--area=${args.area}`);
    if (args.tag) cliArgs.push(`--tag=${args.tag}`);
    if (args.search) cliArgs.push(`--search=${args.search}`);
    if (args.limit) cliArgs.push(`--limit=${args.limit}`);
    if (args.sort) cliArgs.push(`--sort=${args.sort}`);
    return thingsRequest(args.view || 'today', cliArgs);
  },
);

server.tool(
  'things_search',
  'Search todos in Things 3 by keyword. Searches title and notes. Returns JSON with UUID, title, project, area, status, deadline.',
  {
    query: z.string().describe('Search query (case-insensitive substring match)'),
    limit: z.number().int().positive().optional().describe('Max results (default: 50)'),
    status: z.enum(['incomplete', 'completed', 'canceled', 'any']).optional().describe('Filter by status (default: incomplete)'),
  },
  async (args) => {
    const cliArgs = ['--json'];
    if (args.limit) cliArgs.push(`--limit=${args.limit}`);
    if (args.status) cliArgs.push(`--status=${args.status}`);
    cliArgs.push('--', args.query);
    return thingsRequest('search', cliArgs);
  },
);

server.tool(
  'things_add',
  'Add a new todo to Things 3.',
  {
    title: z.string().describe('Todo title'),
    notes: z.string().optional().describe('Notes for the todo'),
    deadline: z.string().optional().describe('Deadline date (YYYY-MM-DD)'),
    list: z.string().optional().describe('Project or area name to add to'),
    tags: z.string().optional().describe('Comma-separated tag names, e.g. "work,urgent"'),
    when: z.string().optional().describe('When to schedule: today, tomorrow, evening, anytime, someday, or a date/datetime string'),
  },
  async (args) => {
    const cliArgs: string[] = [];
    if (args.notes) cliArgs.push(`--notes=${args.notes}`);
    if (args.deadline) cliArgs.push(`--deadline=${args.deadline}`);
    if (args.list) cliArgs.push(`--list=${args.list}`);
    if (args.tags) cliArgs.push(`--tags=${args.tags}`);
    if (args.when) cliArgs.push(`--when=${args.when}`);
    cliArgs.push('--', args.title);
    return thingsRequest('add', cliArgs);
  },
);

server.tool(
  'things_update',
  'Update an existing todo in Things 3. Use to rename, reschedule, complete, cancel, or move a todo. Requires THINGS_AUTH_TOKEN in .env.',
  {
    id: z.string().describe('Todo UUID (from things_list or things_search)'),
    title: z.string().optional().describe('New title for the todo'),
    notes: z.string().optional().describe('Replace notes with this text'),
    append_notes: z.string().optional().describe('Append text to existing notes'),
    deadline: z.string().optional().describe('New deadline date (YYYY-MM-DD)'),
    list: z.string().optional().describe('Move to this project or area name'),
    tags: z.string().optional().describe('Replace all tags with this comma-separated list'),
    add_tags: z.string().optional().describe('Add these comma-separated tags without removing existing ones'),
    when: z.string().optional().describe('Reschedule: today, tomorrow, evening, someday, or a date/datetime string'),
    completed: z.boolean().optional().describe('Mark as completed (true) or incomplete (false)'),
    canceled: z.boolean().optional().describe('Mark as canceled (true) or incomplete (false)'),
  },
  async (args) => {
    const cliArgs: string[] = [`--id=${args.id}`];
    if (args.notes !== undefined) cliArgs.push(`--notes=${args.notes}`);
    if (args.append_notes) cliArgs.push(`--append-notes=${args.append_notes}`);
    if (args.deadline) cliArgs.push(`--deadline=${args.deadline}`);
    if (args.list) cliArgs.push(`--list=${args.list}`);
    if (args.tags !== undefined) cliArgs.push(`--tags=${args.tags}`);
    if (args.add_tags) cliArgs.push(`--add-tags=${args.add_tags}`);
    if (args.when) cliArgs.push(`--when=${args.when}`);
    if (args.completed === true) cliArgs.push('--completed');
    if (args.completed === false) cliArgs.push('--completed=false');
    if (args.canceled === true) cliArgs.push('--canceled');
    if (args.canceled === false) cliArgs.push('--canceled=false');
    if (args.title) cliArgs.push('--', args.title);
    return thingsRequest('update', cliArgs);
  },
);

server.tool(
  'things_delete',
  'Delete (trash) a todo in Things 3 by UUID.',
  {
    id: z.string().describe('Todo UUID to delete (from things_list or things_search)'),
  },
  async (args) => {
    return thingsRequest('delete', [`--id=${args.id}`, `--confirm=${args.id}`]);
  },
);

// ── End Things 3 integration ──────────────────────────────────────────────────

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
