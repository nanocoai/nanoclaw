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
const MEMORY_DIR = path.join(IPC_DIR, 'memory');

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

async function pollForResponse(requestId: string, timeoutMs = 5000): Promise<string> {
  const responseFile = path.join(MEMORY_DIR, `res-${requestId}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (fs.existsSync(responseFile)) {
        const data = fs.readFileSync(responseFile, 'utf-8');
        fs.unlinkSync(responseFile);
        return data;
      }
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return JSON.stringify({ error: 'Memory search timed out' });
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
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
  'react_to_message',
  'React to a message with an emoji. Omit message_id to react to the most recent message in the chat.',
  {
    emoji: z.string().describe('The emoji to react with (e.g. "\ud83d\udc4d", "\u2764\ufe0f", "\ud83d\udd25")'),
    message_id: z.string().optional().describe('The message ID to react to. If omitted, reacts to the latest message in the chat.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MESSAGES_DIR, data);
    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji} sent.` }] };
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
  'update_task',
  `Update an existing scheduled task without canceling and recreating it. Preserves the task ID and history.

Only provide the fields you want to change — unspecified fields remain unchanged.

If you change schedule_type or schedule_value, the next execution time will be recalculated automatically.

SCHEDULE VALUE FORMAT (same as schedule_task, all times are LOCAL timezone):
• cron: Standard cron expression (e.g., "*/5 * * * *", "0 9 * * *")
• interval: Milliseconds between runs (e.g., "300000" for 5 minutes)
• once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00")`,
  {
    task_id: z.string().describe('The ID of the task to update (e.g., "task-1772008617164-yhg6ws")'),
    prompt: z.string().optional().describe('New prompt/instructions for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (must match schedule_type format)'),
    context_mode: z.enum(['group', 'isolated']).optional().describe('New context mode: group=with chat history, isolated=fresh session'),
  },
  async (args) => {
    // Must provide at least one field to update
    if (!args.prompt && !args.schedule_type && !args.schedule_value && !args.context_mode) {
      return {
        content: [{ type: 'text' as const, text: 'No fields to update. Provide at least one of: prompt, schedule_type, schedule_value, context_mode.' }],
        isError: true,
      };
    }

    // If schedule_type is changing, schedule_value must also be provided (and vice versa)
    if ((args.schedule_type && !args.schedule_value) || (!args.schedule_type && args.schedule_value)) {
      return {
        content: [{ type: 'text' as const, text: 'When changing the schedule, both schedule_type and schedule_value must be provided together.' }],
        isError: true,
      };
    }

    // Validate schedule values if provided
    if (args.schedule_type && args.schedule_value) {
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
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: isMain ? '1' : '0',
      timestamp: new Date().toISOString(),
    };

    // Only include fields that were provided
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;
    if (args.context_mode !== undefined) data.context_mode = args.context_mode;

    writeIpcFile(TASKS_DIR, data);

    const updatedFields = [
      args.prompt && 'prompt',
      args.schedule_type && 'schedule',
      args.context_mode && 'context_mode',
    ].filter(Boolean).join(', ');

    return {
      content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested (${updatedFields}).` }],
    };
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

// Memory tools — explicit agent-driven memory operations via IPC

server.tool(
  'memory_save',
  `Save a fact, preference, or important information to long-term memory.
Use this proactively when the user shares personal information, makes decisions, or states preferences.
Categories: preference, contact, account, fact, decision, instruction.`,
  {
    content: z.string().describe('The fact or information to remember'),
    category: z.enum(['preference', 'contact', 'account', 'fact', 'decision', 'instruction']).describe('Category of the memory'),
  },
  async (args) => {
    const data = {
      type: 'memory_add',
      content: args.content,
      category: args.category,
      user_id: undefined,
      run_id: `${groupFolder}:ipc:live`,
      metadata: { category: args.category, source: 'agent' },
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    return { content: [{ type: 'text' as const, text: `Memory saved: "${args.content.slice(0, 50)}..."` }] };
  },
);

server.tool(
  'memory_search',
  'Search past memories, conversations, and knowledge graph. Use when the user asks about something that may have been discussed before or when you need context.',
  {
    query: z.string().describe('What to search for'),
    limit: z.number().default(10).describe('Max results to return'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'memory_search',
      query: args.query,
      limit: args.limit || 10,
      request_id: requestId,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    const response = await pollForResponse(requestId);
    return { content: [{ type: 'text' as const, text: response }] };
  },
);

server.tool(
  'memory_update',
  'Update an existing memory entry with new content. Use when information has changed or needs correction.',
  {
    memory_id: z.string().describe('The ID of the memory to update'),
    content: z.string().describe('The new content for this memory'),
  },
  async (args) => {
    const data = {
      type: 'memory_update',
      memory_id: args.memory_id,
      content: args.content,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    return { content: [{ type: 'text' as const, text: `Memory ${args.memory_id} update requested.` }] };
  },
);

server.tool(
  'memory_remove',
  'Remove a memory entry permanently. Use when the user asks to forget something or information is no longer relevant.',
  {
    memory_id: z.string().describe('The ID of the memory to remove'),
  },
  async (args) => {
    const data = {
      type: 'memory_remove',
      memory_id: args.memory_id,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    return { content: [{ type: 'text' as const, text: `Memory ${args.memory_id} removal requested.` }] };
  },
);

server.tool(
  'memory_forget_session',
  'Forget all memories from a specific session/conversation run. Use when the user wants to erase a conversation from memory.',
  {
    run_id: z.string().describe('The run/session ID to forget'),
  },
  async (args) => {
    const data = {
      type: 'memory_forget_session',
      run_id: args.run_id,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    return { content: [{ type: 'text' as const, text: `Session ${args.run_id} forget requested.` }] };
  },
);

server.tool(
  'memory_forget_timerange',
  'Forget all memories within a time range. Use when the user wants to erase memories from a specific period.',
  {
    before: z.string().optional().describe('ISO timestamp upper bound (forget memories before this time)'),
    after: z.string().optional().describe('ISO timestamp lower bound (forget memories after this time)'),
  },
  async (args) => {
    if (!args.before && !args.after) {
      return {
        content: [{ type: 'text' as const, text: 'At least one of "before" or "after" must be provided.' }],
        isError: true,
      };
    }
    const data = {
      type: 'memory_forget_timerange',
      before: args.before,
      after: args.after,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    return { content: [{ type: 'text' as const, text: `Timerange forget requested (before: ${args.before || 'N/A'}, after: ${args.after || 'N/A'}).` }] };
  },
);

server.tool(
  'memory_history',
  'Get the edit history of a specific memory entry. Shows how a memory has evolved over time.',
  {
    memory_id: z.string().describe('The ID of the memory to get history for'),
  },
  async (args) => {
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const data = {
      type: 'memory_history',
      memory_id: args.memory_id,
      request_id: requestId,
      timestamp: new Date().toISOString(),
    };
    writeIpcFile(MEMORY_DIR, data);
    const response = await pollForResponse(requestId);
    return { content: [{ type: 'text' as const, text: response }] };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
