/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { shouldRegisterSendMessage } from './mcp-tool-policy.js';

const IPC_DIR = process.env.NANOCLAW_IPC_DIR!;
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';
const senderId = process.env.NANOCLAW_SENDER_ID || '';

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

if (shouldRegisterSendMessage()) {
  server.tool(
    'send_message',
    'Send a message to the current user or group immediately while you are still running. Use this for progress updates or to send multiple messages in the same conversation. Cross-group task dispatch is disabled here; main group must use delegate for work assignment.',
    {
      text: z.string().describe('The message text to send'),
      sender: z
        .string()
        .optional()
        .describe(
          'Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.',
        ),
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

      return {
        content: [{ type: 'text' as const, text: 'Message sent.' }],
      };
    },
  );
}

server.tool(
  'rename_chat',
  '修改当前群聊名称。用于在开始任务时将群名改为任务名称，方便识别。',
  {
    name: z.string().describe('新的群聊名称（建议 20 字以内）'),
  },
  async (args) => {
    writeIpcFile(MESSAGES_DIR, {
      type: 'rename_chat',
      chatJid,
      name: args.name,
      groupFolder,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [{ type: 'text' as const, text: `群名已改为「${args.name}」` }],
    };
  },
);

// --- Commander 协议：派工 / 汇报 ---

server.tool(
  'delegate',
  '派活给指定群，区别于 send_message：delegate 是带账本的"派工"语义，host 会落账本生成 task_id 并注入消息投递给目标群，之后可用 /delegate status 跟踪进度。task_id 完全由 host 生成管理，你不需要也不能自带。任意已注册群都可派给其他已注册群，但不能派给自己。',
  {
    target: z
      .string()
      .describe('目标子群的别名或 JID，如 "3号" 或 "fs:oc_xxx"'),
    text: z.string().describe('派给子群的任务内容/指令'),
    title: z
      .string()
      .optional()
      .describe('任务简述（可选），用于 /delegate status 表格展示'),
  },
  async (args) => {
    const rawTarget = args.target;
    const normalizedTarget = rawTarget.startsWith('oc_')
      ? `fs:${rawTarget}`
      : rawTarget;
    writeIpcFile(MESSAGES_DIR, {
      type: 'delegate',
      // 源群 folder，host 据此写入 task.source_group。
      sourceGroup: groupFolder,
      target: normalizedTarget,
      text: args.text,
      title: args.title || undefined,
      timestamp: new Date().toISOString(),
    });
    return {
      content: [
        {
          type: 'text' as const,
          text: `已派工给 ${normalizedTarget}，host 落账本后投递。用 /delegate status 跟踪进度。`,
        },
      ],
    };
  },
);

function registerReportTool(
  name: 'report_to_source' | 'report_to_main',
  description: string,
) {
  server.tool(
    name,
    description,
    {
      status: z
        .enum(['progress', 'done', 'blocked', 'failed', 'question'])
        .describe(
          '汇报状态：progress=进行中 / done=完成 / blocked=卡住等人工 / failed=失败 / question=有问题需发起群答复',
        ),
      summary: z.string().describe('一句话摘要，发起群一眼能看懂当前状态'),
      details: z.string().optional().describe('详细说明（可选）'),
      artifacts: z
        .array(z.string())
        .optional()
        .describe(
          '产出文件的宿主机绝对路径数组（可选）。仅限本群 workspace / 项目根 / /tmp/nanoclaw-artifacts/ 下的路径，非法路径会被 host 降级为纯文本备注。',
        ),
    },
    async (args) => {
      writeIpcFile(MESSAGES_DIR, {
        type: 'report',
        // 当前执行任务的 reporting group，host 用 target_group=该值反查 task_id。
        sourceGroup: groupFolder,
        status: args.status,
        summary: args.summary,
        details: args.details || undefined,
        artifacts: args.artifacts || undefined,
        timestamp: new Date().toISOString(),
      });
      return {
        content: [
          {
            type: 'text' as const,
            text: `已向任务发起群汇报（${args.status}）。`,
          },
        ],
      };
    },
  );
}

registerReportTool(
  'report_to_source',
  '向当前派工任务的发起群汇报进展。目标群由 host 根据当前群正在执行的 delegation 反查，不能指定任意群；task_id 也由 host 用当前群锁定，你不需要传。status 必须是 progress/done/blocked/failed/question 之一。',
);

registerReportTool(
  'report_to_main',
  '兼容旧名：实际语义已经是 report_to_source，不再固定发唯一主群。用于向当前派工任务的发起群汇报进展；不能指定任意群，task_id 由 host 用当前群锁定，你不需要传。',
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

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
    prompt: z
      .string()
      .describe(
        'What the agent should do when the task runs. For isolated mode, include all necessary context here.',
      ),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .describe(
        'cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time',
      ),
    schedule_value: z
      .string()
      .describe(
        'cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)',
      ),
    context_mode: z
      .enum(['group', 'isolated'])
      .default('group')
      .describe(
        'group=runs with chat history and memory, isolated=fresh session (include context in prompt)',
      ),
    target_group_jid: z
      .string()
      .optional()
      .describe(
        '(Main group only) JID of the group to schedule the task for. Defaults to the current group.',
      ),
    script: z
      .string()
      .optional()
      .describe(
        'Optional bash script to run before waking the agent. Script must output JSON on the last line of stdout: { "wakeAgent": boolean, "data"?: any }. If wakeAgent is false, the agent is not called. Test your script with bash -c "..." before scheduling.',
      ),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).`,
            },
          ],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (
        /[Zz]$/.test(args.schedule_value) ||
        /[+-]\d{2}:\d{2}$/.test(args.schedule_value)
      ) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".`,
            },
          ],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid =
      isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      script: args.script || undefined,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}`,
        },
      ],
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
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter(
            (t: { groupFolder: string }) => t.groupFolder === groupFolder,
          );

      if (tasks.length === 0) {
        return {
          content: [
            { type: 'text' as const, text: 'No scheduled tasks found.' },
          ],
        };
      }

      const formatted = tasks
        .map(
          (t: {
            id: string;
            prompt: string;
            schedule_type: string;
            schedule_value: string;
            status: string;
            next_run: string;
          }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return {
        content: [
          { type: 'text' as const, text: `Scheduled tasks:\n${formatted}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} pause requested.`,
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} resume requested.`,
        },
      ],
    };
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

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} cancellation requested.`,
        },
      ],
    };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z
      .enum(['cron', 'interval', 'once'])
      .optional()
      .describe('New schedule type'),
    schedule_value: z
      .string()
      .optional()
      .describe('New schedule value (see schedule_task for format)'),
    script: z
      .string()
      .optional()
      .describe(
        'New script for the task. Set to empty string to remove the script.',
      ),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (
      args.schedule_type === 'cron' ||
      (!args.schedule_type && args.schedule_value)
    ) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [
              {
                type: 'text' as const,
                text: `Invalid cron: "${args.schedule_value}".`,
              },
            ],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: `Invalid interval: "${args.schedule_value}".`,
            },
          ],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.script !== undefined) data.script = args.script;
    if (args.schedule_type !== undefined)
      data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined)
      data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Task ${args.task_id} update requested.`,
        },
      ],
    };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z
      .string()
      .describe(
        'The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")',
      ),
    name: z.string().describe('Display name for the group'),
    folder: z
      .string()
      .describe(
        'Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")',
      ),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
    requiresTrigger: z
      .boolean()
      .optional()
      .describe(
        'Whether messages must start with the trigger word. Default: false (respond to all messages). Set to true for busy groups with many participants where you only want the agent to respond when explicitly mentioned.',
      ),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [
          {
            type: 'text' as const,
            text: 'Only the main group can register new groups.',
          },
        ],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      requiresTrigger: args.requiresTrigger ?? false,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [
        {
          type: 'text' as const,
          text: `Group "${args.name}" registered. It will start receiving messages immediately.`,
        },
      ],
    };
  },
);

// ─────────────────────────────────────────────────────────────
// Memory tools — request-response via IPC
// ─────────────────────────────────────────────────────────────

const RESPONSES_DIR = path.join(IPC_DIR, 'responses');

async function waitForResponse(
  requestId: string,
  timeoutMs = 30000,
): Promise<object> {
  const responsePath = path.join(RESPONSES_DIR, `${requestId}.json`);
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (fs.existsSync(responsePath)) {
      const data = JSON.parse(fs.readFileSync(responsePath, 'utf-8'));
      try {
        fs.unlinkSync(responsePath);
      } catch {
        // 文件可能已被清理
      }
      return data;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`IPC request ${requestId} timed out after ${timeoutMs}ms`);
}

server.tool(
  'memory_recall',
  '搜索记忆库。返回与查询相关的记忆条目。query 为空时返回全部记忆。如果 CLAUDE.md 中注入的记忆不够用，用这个工具搜索更多。',
  {
    query: z
      .string()
      .optional()
      .default('')
      .describe('搜索查询（自然语言），为空返回全部'),
    limit: z.number().optional().default(10).describe('最多返回条数'),
    category: z
      .string()
      .optional()
      .describe(
        '按类别过滤: preference | knowledge | context | behavior | goal',
      ),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    writeIpcFile(TASKS_DIR, {
      type: 'memory_recall',
      requestId,
      query: args.query,
      limit: args.limit,
      category: args.category,
      groupFolder,
      senderId,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await waitForResponse(requestId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `记忆查询失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'memory_remember',
  '存储一条记忆。内容先立即存储，后台异步经 LLM 标准化优化。用于用户明确要求记住的内容，或你观察到的重要偏好/事实。',
  {
    content: z.string().describe('要记住的内容（自然语言）'),
    category: z
      .string()
      .optional()
      .describe('建议类别: preference | knowledge | context | behavior | goal'),
  },
  async (args) => {
    writeIpcFile(TASKS_DIR, {
      type: 'memory_remember',
      content: args.content,
      category: args.category,
      groupFolder,
      senderId,
      timestamp: new Date().toISOString(),
    });
    return { content: [{ type: 'text' as const, text: '已记住。' }] };
  },
);

// ─────────────────────────────────────────────────────────────
// Task ledger — 结构化任务账本
// ─────────────────────────────────────────────────────────────

const taskStatusSchema = z.enum([
  'draft',
  'draft_prd',
  'ready',
  'effect_locked',
  'e2e_defined',
  'tests_planned',
  'in_progress',
  'implementing',
  'blocked',
  'review',
  'testing',
  'verifying',
  'done',
  'cancelled',
]);
const taskTypeSchema = z.enum([
  'bug',
  'feature',
  'refactor',
  'review',
  'e2e',
  'research',
  'ops',
  'other',
]);
const checklistStatusSchema = z.enum([
  'todo',
  'doing',
  'done',
  'blocked',
  'skipped',
]);
const testCaseStatusSchema = z.enum([
  'pending',
  'passed',
  'failed',
  'blocked',
  'skipped',
]);

async function callTaskLedger(type: string, payload: Record<string, unknown>) {
  const requestId = crypto.randomUUID();
  writeIpcFile(TASKS_DIR, {
    type,
    requestId,
    ...payload,
    groupFolder,
    chatJid,
    senderId,
    timestamp: new Date().toISOString(),
  });
  return waitForResponse(requestId);
}

server.tool(
  'task_create',
  '创建一条结构化任务账本。用于把需求、Bug 或排查任务的最终效果、验收标准、执行清单、测试用例先固定下来，方便后续 LLM 查询和推进。',
  {
    title: z.string().describe('任务标题，短句即可'),
    project: z
      .string()
      .describe('项目名，如 nine / nanoclaw / nine-recruit-api / other'),
    task_type: taskTypeSchema.describe('任务类型'),
    status: taskStatusSchema
      .optional()
      .default('draft')
      .describe('初始状态，默认 draft'),
    priority: z
      .string()
      .optional()
      .default('normal')
      .describe('优先级，如 low / normal / high / urgent'),
    description: z.string().optional().describe('任务背景和问题描述'),
    desired_outcome: z
      .string()
      .optional()
      .describe('最终效果：做到什么才算这事真的完成'),
    acceptance_criteria: z
      .array(z.string())
      .optional()
      .default([])
      .describe('验收标准列表'),
    checklist: z
      .array(
        z.object({
          title: z.string(),
          status: checklistStatusSchema.optional(),
          notes: z.string().optional(),
        }),
      )
      .optional()
      .default([])
      .describe('执行清单，可从最终效果倒推'),
    test_cases: z
      .array(
        z.object({
          title: z.string(),
          description: z.string().optional(),
          status: testCaseStatusSchema.optional(),
          evidence: z.string().optional(),
        }),
      )
      .optional()
      .default([])
      .describe('测试或 E2E 用例：跑完哪些能证明效果成立'),
    artifact_root: z
      .string()
      .optional()
      .describe(
        '任务产物根目录；默认写入全局 groups/global/task-ledger/{task_id}',
      ),
    prd_path: z.string().optional().describe('关联 PRD 文件路径'),
    spec_path: z.string().optional().describe('关联 OpenSpec 或设计文档路径'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_create', args);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `创建任务失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_get',
  '查看一条任务账本详情，包含主任务、执行清单、测试用例和过程日志。',
  {
    task_id: z.string().describe('任务 ID'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_get', {
        taskId: args.task_id,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `查询任务失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_list',
  '列出任务账本。默认只看当前群未完成任务；主群可传 owner_group 看指定群。',
  {
    owner_group: z.string().optional().describe('主群可用：按群 folder 过滤'),
    project: z.string().optional().describe('按项目过滤'),
    status: taskStatusSchema.optional().describe('按状态过滤'),
    task_type: taskTypeSchema.optional().describe('按任务类型过滤'),
    include_done: z
      .boolean()
      .optional()
      .default(false)
      .describe('是否包含 done/cancelled'),
    limit: z.number().optional().default(20).describe('最多返回条数，最大 100'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_list', args);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `列任务失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_update',
  '更新任务账本主任务的非状态字段，如标题、描述、最终效果、验收标准、PRD/Spec 路径。状态推进必须使用 task_lock_effect 等 workflow 工具。',
  {
    task_id: z.string().describe('任务 ID'),
    title: z.string().optional(),
    project: z.string().optional(),
    task_type: taskTypeSchema.optional(),
    priority: z.string().optional(),
    description: z.string().optional(),
    desired_outcome: z.string().optional(),
    acceptance_criteria: z.array(z.string()).optional(),
    artifact_root: z.string().optional(),
    prd_path: z.string().optional(),
    spec_path: z.string().optional(),
  },
  async (args) => {
    try {
      const { task_id, ...updates } = args;
      const response = await callTaskLedger('task_update', {
        taskId: task_id,
        ...updates,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `更新任务失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_lock_effect',
  '锁定任务最终效果。必须先明确 desired_outcome 和 acceptance_criteria，后续才能定义 E2E 用例。用于防止 LLM 未对齐目标就开始实现。',
  {
    task_id: z.string().describe('任务 ID'),
    desired_outcome: z
      .string()
      .describe('最终效果：完成后用户/系统应该看到什么变化'),
    acceptance_criteria: z
      .array(z.string())
      .min(1)
      .describe('验收标准：满足哪些条件才算效果成立'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_lock_effect', {
        taskId: args.task_id,
        desired_outcome: args.desired_outcome,
        acceptance_criteria: args.acceptance_criteria,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `锁定效果失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_define_e2e',
  '定义端到端验收用例。必须在 task_lock_effect 之后调用，用例要能证明最终效果真的达成。',
  {
    task_id: z.string().describe('任务 ID'),
    test_cases: z
      .array(
        z.object({
          title: z.string(),
          description: z.string().optional(),
        }),
      )
      .min(1)
      .describe('端到端验收用例列表'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_define_e2e', {
        taskId: args.task_id,
        test_cases: args.test_cases,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `定义 E2E 失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_plan_tests',
  '拆解测试与执行清单。必须在 task_define_e2e 之后调用，用于从 E2E 倒推集成测试、单元测试和实现步骤。',
  {
    task_id: z.string().describe('任务 ID'),
    checklist: z
      .array(
        z.object({
          title: z.string(),
          notes: z.string().optional(),
        }),
      )
      .min(1)
      .describe('测试/执行清单'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_plan_tests', {
        taskId: args.task_id,
        checklist: args.checklist,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `规划测试失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_start_implementation',
  '进入实现阶段。只有最终效果、E2E 用例、测试/执行清单都完成后才能调用。',
  {
    task_id: z.string().describe('任务 ID'),
    summary: z.string().optional().describe('进入实现阶段的说明'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_start_implementation', {
        taskId: args.task_id,
        summary: args.summary,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `进入实现阶段失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_record_verification',
  '记录验证结果。用于把测试/E2E 结果和证据写回账本；调用后任务进入 verifying。',
  {
    task_id: z.string().describe('任务 ID'),
    test_case_id: z.string().optional().describe('测试用例 ID，可选'),
    title: z.string().describe('验证项标题'),
    description: z.string().optional(),
    status: testCaseStatusSchema.describe('验证状态'),
    evidence: z
      .string()
      .optional()
      .describe('验证证据，如命令输出、截图路径、trace 链接'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_record_verification', {
        taskId: args.task_id,
        test_case_id: args.test_case_id,
        title: args.title,
        description: args.description,
        status: args.status,
        evidence: args.evidence,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `记录验证失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_mark_done',
  '将任务标记完成。只有任务进入 verifying，且清单没有未完成项、测试用例没有 pending/failed/blocked 时才能成功。',
  {
    task_id: z.string().describe('任务 ID'),
    summary: z.string().optional().describe('完成说明'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_mark_done', {
        taskId: args.task_id,
        summary: args.summary,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `标记完成失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_add_log',
  '给任务账本追加过程记录。用于记录根因、决策、风险、验证证据、卡点和人工确认。',
  {
    task_id: z.string().describe('任务 ID'),
    event_type: z
      .string()
      .optional()
      .default('progress')
      .describe(
        '事件类型，如 progress / decision / evidence / risk / blocked / done',
      ),
    summary: z.string().describe('一句话摘要'),
    details: z.string().optional().describe('详细说明或证据'),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_add_log', {
        taskId: args.task_id,
        event_type: args.event_type,
        summary: args.summary,
        details: args.details,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `追加日志失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_update_checklist',
  '新增或更新任务执行清单项。传 item_id 精确更新；不传时按同名 title 更新或创建。',
  {
    task_id: z.string().describe('任务 ID'),
    item_id: z.string().optional().describe('清单项 ID，可选'),
    title: z.string().describe('清单项标题'),
    status: checklistStatusSchema.optional().default('todo'),
    notes: z.string().optional(),
    position: z.number().optional(),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_update_checklist', {
        taskId: args.task_id,
        item_id: args.item_id,
        title: args.title,
        status: args.status,
        notes: args.notes,
        position: args.position,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `更新清单失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'task_update_test_case',
  '新增或更新任务测试/验收用例。传 test_case_id 精确更新；不传时按同名 title 更新或创建。',
  {
    task_id: z.string().describe('任务 ID'),
    test_case_id: z.string().optional().describe('测试用例 ID，可选'),
    title: z.string().describe('测试用例标题'),
    description: z.string().optional(),
    status: testCaseStatusSchema.optional().default('pending'),
    evidence: z
      .string()
      .optional()
      .describe('验证证据，如命令输出、截图路径、E2E trace'),
    position: z.number().optional(),
  },
  async (args) => {
    try {
      const response = await callTaskLedger('task_update_test_case', {
        taskId: args.task_id,
        test_case_id: args.test_case_id,
        title: args.title,
        description: args.description,
        status: args.status,
        evidence: args.evidence,
        position: args.position,
      });
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `更新测试用例失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// Chat search — 双路检索聊天历史
// ─────────────────────────────────────────────────────────────

server.tool(
  'search_chat',
  '搜索聊天历史记录。支持自然语言语义搜索和关键词搜索，双路融合排序。默认过滤工具调用等过程噪音，主要返回过程文本和结果；调试时可用 include_tool_calls=true 查看全量。',
  {
    query: z.string().describe('搜索关键词或自然语言描述'),
    group: z
      .string()
      .optional()
      .describe('限定搜索的群组 folder，默认搜索所有群'),
    sender: z.string().optional().describe('按发送人名称过滤'),
    days: z
      .number()
      .optional()
      .describe('限定最近 N 天（与 startTime/endTime 互斥，优先使用后者）'),
    startTime: z
      .string()
      .optional()
      .describe('起始时间（ISO 8601），如 "2026-05-15T00:00:00"'),
    endTime: z
      .string()
      .optional()
      .describe('截止时间（ISO 8601），如 "2026-05-20T23:59:59"'),
    limit: z.number().optional().default(10).describe('返回条数，默认 10'),
    include_tool_calls: z
      .boolean()
      .optional()
      .default(false)
      .describe('是否包含工具调用/工具进度等调试信息，默认 false'),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    writeIpcFile(TASKS_DIR, {
      type: 'search_chat',
      requestId,
      query: args.query,
      options: {
        group: args.group,
        sender: args.sender,
        days: args.days,
        startTime: args.startTime,
        endTime: args.endTime,
        limit: args.limit,
        includeToolCalls: args.include_tool_calls,
      },
      groupFolder,
      senderId,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await waitForResponse(requestId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `聊天搜索失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// Chat context — 根据锚点时间戳获取前后 N 条消息
// ─────────────────────────────────────────────────────────────

server.tool(
  'get_chat_context',
  '获取指定消息前后的聊天记录。先用 search_chat 找到目标消息，再用此工具展开上下文。默认过滤工具调用等过程噪音，调试时可用 include_tool_calls=true 查看全量。',
  {
    chat_jid: z
      .string()
      .describe(
        '消息所在的会话 JID（从 search_chat 结果的 chat_jid 字段获取）',
      ),
    timestamp: z
      .string()
      .describe(
        '锚点消息的时间戳（ISO 8601），从 search_chat 结果的 time_range 获取',
      ),
    before: z
      .number()
      .optional()
      .default(5)
      .describe('锚点前 N 条消息，默认 5'),
    after: z.number().optional().default(5).describe('锚点后 N 条消息，默认 5'),
    include_tool_calls: z
      .boolean()
      .optional()
      .default(false)
      .describe('是否包含工具调用/工具进度等调试信息，默认 false'),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    writeIpcFile(TASKS_DIR, {
      type: 'get_chat_context',
      requestId,
      chat_jid: args.chat_jid,
      timestamp: args.timestamp,
      before: args.before,
      after: args.after,
      include_tool_calls: args.include_tool_calls,
      groupFolder,
      senderId,
      timestamp_now: new Date().toISOString(),
    });

    try {
      const response = await waitForResponse(requestId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `获取上下文失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// get_message_by_id — 按消息 ID 精确定位并展开前后上下文
// ─────────────────────────────────────────────────────────────

server.tool(
  'get_message_by_id',
  '按消息 ID 精确定位一条消息，并返回其前后 N 条上下文。消息 ID 是数据库主键（全局唯一，可从 search_chat 结果或飞书引用中获取），无需额外提供 chat_jid。默认过滤工具调用等过程噪音，调试时可用 include_tool_calls=true 查看全量。',
  {
    message_id: z.string().describe('消息 ID（messages 表主键，全局唯一）'),
    before: z
      .number()
      .optional()
      .default(5)
      .describe('锚点前 N 条消息，默认 5'),
    after: z.number().optional().default(5).describe('锚点后 N 条消息，默认 5'),
    include_tool_calls: z
      .boolean()
      .optional()
      .default(false)
      .describe('是否包含工具调用/工具进度等调试信息，默认 false'),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    writeIpcFile(TASKS_DIR, {
      type: 'get_message_by_id',
      requestId,
      message_id: args.message_id,
      before: args.before,
      after: args.after,
      include_tool_calls: args.include_tool_calls,
      groupFolder,
      senderId,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await waitForResponse(requestId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `按 ID 查询失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────
// get_message_range — 按位置区间（OFFSET）查询会话消息
// ─────────────────────────────────────────────────────────────

server.tool(
  'get_message_range',
  '按位置区间查询某个会话的历史消息。offset=0 表示从最新一条开始，倒数跳过 offset 条后取 limit 条，结果按时间正序返回（最早的在前）。默认过滤工具调用等过程噪音，调试时可用 include_tool_calls=true 查看全量。',
  {
    chat_jid: z
      .string()
      .describe('会话 JID（从 search_chat 结果的 chat_jid 字段获取）'),
    offset: z
      .number()
      .optional()
      .default(0)
      .describe('跳过最新的 N 条，offset=0 表示从最新开始，默认 0'),
    limit: z
      .number()
      .optional()
      .default(20)
      .describe('返回条数，默认 20，上限 200'),
    include_tool_calls: z
      .boolean()
      .optional()
      .default(false)
      .describe('是否包含工具调用/工具进度等调试信息，默认 false'),
  },
  async (args) => {
    const requestId = crypto.randomUUID();
    writeIpcFile(TASKS_DIR, {
      type: 'get_message_range',
      requestId,
      chat_jid: args.chat_jid,
      offset: args.offset,
      limit: args.limit,
      include_tool_calls: args.include_tool_calls,
      groupFolder,
      senderId,
      timestamp: new Date().toISOString(),
    });

    try {
      const response = await waitForResponse(requestId);
      return {
        content: [
          { type: 'text' as const, text: JSON.stringify(response, null, 2) },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `区间查询失败: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
