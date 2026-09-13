---
name: add-heartbeat
description: Add proactive heartbeat monitoring to NanoClaw. Agent automatically runs periodic checks and only notifies when something needs attention. Use when user wants proactive monitoring, periodic checks, autonomous alerts, or OpenClaw-style heartbeat. Triggers on "heartbeat", "proactive monitoring", "periodic checks", "autonomous alerts".
---

# Add Heartbeat

This skill adds proactive heartbeat monitoring to NanoClaw. Instead of waiting for user messages, the agent periodically runs a checklist and only sends a notification when something needs attention. Routine "all clear" responses are automatically suppressed.

**How it works:**
1. A `heartbeat-config.json` in the group folder enables heartbeat for that group
2. On startup, the system reads the config and creates a scheduled task
3. Every N minutes (during active hours), the agent reads `HEARTBEAT.md` and runs its checklist
4. If `HEARTBEAT.md` is empty or missing, the agent turn is skipped entirely (zero token cost)
5. If nothing needs attention, the agent responds `HEARTBEAT_OK` — this is suppressed (not sent to user)
6. If something needs attention, the agent sends a brief notification
7. The agent can trigger an immediate heartbeat run via IPC (`trigger_heartbeat`)

## Initial Questions

Ask the user:

> How often should the heartbeat run?
>
> - **Every 60 minutes** (recommended — low cost, good coverage)
> - **Every 30 minutes** (more responsive, ~2x token cost)
> - **Every 2 hours** (minimal cost, less responsive)

Then ask:

> What are your active hours? (Heartbeat only runs during these hours)
>
> - **9 AM – 6 PM** (standard work hours)
> - **8 AM – 10 PM** (extended hours)
> - **Always on** (24/7 monitoring)

Then ask:

> What timezone?
>
> - **America/Los_Angeles** (Pacific)
> - **America/New_York** (Eastern)
> - **UTC**
> - Other (ask for IANA timezone name)

Store their choices for use in the configuration steps below.

---

## 1. Create the Heartbeat Scheduler Module

Create `src/heartbeat-scheduler.ts`:

```typescript
/**
 * Heartbeat Scheduler for NanoClaw
 *
 * Implements proactive monitoring by scheduling periodic agent runs
 * that check HEARTBEAT.md for standing instructions. Automatically suppresses
 * HEARTBEAT_OK responses to avoid notification spam.
 */

import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';
import { GROUPS_DIR, TIMEZONE } from './config.js';
import { createTask } from './db.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface HeartbeatConfig {
  enabled: boolean;
  every: string; // e.g., "60m", "30m", "2h"
  activeHours?: {
    start: number; // 0-23
    end: number; // 0-23
    timezone: string;
  };
  suppressOk: boolean;
  maxSuppressedChars: number;
  prompt?: string;
}

/**
 * Parse interval string (e.g., "60m", "2h") to milliseconds
 */
function parseInterval(interval: string): number {
  const match = interval.match(/^(\d+)([mh])$/);
  if (!match) {
    throw new Error(`Invalid interval format: ${interval}. Use format like "60m" or "2h"`);
  }

  const value = parseInt(match[1], 10);
  const unit = match[2];

  if (unit === 'm') return value * 60 * 1000;
  if (unit === 'h') return value * 60 * 60 * 1000;

  throw new Error(`Invalid interval unit: ${unit}`);
}

/**
 * Generate cron expression from interval. Falls back to interval mode
 * if the interval can't be expressed as cron.
 */
function generateHeartbeatCron(intervalMs: number): string {
  const minutes = Math.floor(intervalMs / (60 * 1000));

  if (minutes === 60) return '0 * * * *';
  if (minutes < 60 && 60 % minutes === 0) return `*/${minutes} * * * *`;

  throw new Error(
    `Interval ${minutes}m cannot be expressed as cron (use 1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, or 60 minutes)`
  );
}

/**
 * Check if HEARTBEAT.md is effectively empty (missing, blank, or only headers/comments).
 * If empty, we skip the agent turn entirely to save tokens.
 */
export function isHeartbeatFileEmpty(groupFolder: string): boolean {
  const heartbeatPath = path.join(GROUPS_DIR, groupFolder, 'HEARTBEAT.md');

  if (!fs.existsSync(heartbeatPath)) return true;

  try {
    const content = fs.readFileSync(heartbeatPath, 'utf-8');
    // Strip markdown headers, comments, blank lines, and whitespace
    const meaningful = content
      .split('\n')
      .filter((line) => {
        const trimmed = line.trim();
        if (!trimmed) return false;               // blank
        if (trimmed.startsWith('#')) return false; // header
        if (trimmed.startsWith('<!--')) return false; // HTML comment
        if (trimmed.startsWith('//')) return false;   // line comment
        return true;
      })
      .join('')
      .trim();

    return meaningful.length === 0;
  } catch {
    return true;
  }
}

/**
 * Load heartbeat configuration from group folder
 */
function loadHeartbeatConfig(groupFolder: string): HeartbeatConfig | null {
  const configPath = path.join(GROUPS_DIR, groupFolder, 'heartbeat-config.json');

  if (!fs.existsSync(configPath)) return null;

  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (!data.heartbeat?.enabled) return null;
    return data.heartbeat as HeartbeatConfig;
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to load heartbeat config');
    return null;
  }
}

/**
 * Wrap prompt with active hours check so the agent skips work outside hours
 */
function wrapPromptWithActiveHoursCheck(config: HeartbeatConfig, basePrompt: string): string {
  if (!config.activeHours) return basePrompt;

  const { start, end, timezone } = config.activeHours;
  const endLabel = end === 12 ? '12 PM' : end > 12 ? `${end - 12} PM` : `${end} AM`;

  return `Check the current time in ${timezone} timezone. If it's between ${start}:00 and ${end}:00 (${start} AM to ${endLabel}), proceed with the heartbeat check. Otherwise, respond with just "HEARTBEAT_OK" (outside active hours).

If within active hours:
${basePrompt}`;
}

/**
 * Initialize heartbeat for a specific group
 */
export function initializeHeartbeat(
  groupFolder: string,
  chatJid: string,
  registeredGroup: RegisteredGroup
): boolean {
  const config = loadHeartbeatConfig(groupFolder);
  if (!config?.enabled) return false;

  // Skip if HEARTBEAT.md is empty or missing — no point running an agent turn
  if (isHeartbeatFileEmpty(groupFolder)) {
    logger.info({ groupFolder }, 'Heartbeat skipped: HEARTBEAT.md is empty or missing');
    return false;
  }

  try {
    const intervalMs = parseInterval(config.every);
    const basePrompt = config.prompt ||
      'Read HEARTBEAT.md and follow the instructions. If nothing needs attention, respond with HEARTBEAT_OK.';
    const prompt = wrapPromptWithActiveHoursCheck(config, basePrompt);

    let scheduleType: 'cron' | 'interval';
    let scheduleValue: string;

    try {
      scheduleValue = generateHeartbeatCron(intervalMs);
      scheduleType = 'cron';
    } catch {
      scheduleValue = intervalMs.toString();
      scheduleType = 'interval';
    }

    const taskId = `heartbeat-${groupFolder}`;

    let nextRun: string | null = null;
    if (scheduleType === 'cron') {
      const interval = CronExpressionParser.parse(scheduleValue, {
        tz: config.activeHours?.timezone || TIMEZONE,
      });
      nextRun = interval.next().toISOString();
    } else {
      nextRun = new Date(Date.now() + intervalMs).toISOString();
    }

    createTask({
      id: taskId,
      group_folder: groupFolder,
      chat_jid: chatJid,
      prompt,
      schedule_type: scheduleType,
      schedule_value: scheduleValue,
      context_mode: 'group',
      next_run: nextRun,
      status: 'active',
      created_at: new Date().toISOString(),
    });

    logger.info({ groupFolder, taskId, scheduleType, scheduleValue }, 'Heartbeat initialized');
    return true;
  } catch (err) {
    logger.error({ err, groupFolder }, 'Failed to initialize heartbeat');
    return false;
  }
}

/**
 * Check if a message is a HEARTBEAT_OK response that should be suppressed
 */
export function isHeartbeatOk(message: string, maxChars: number = 300): boolean {
  const content = message.trim();
  if (!/\bHEARTBEAT_OK\b/i.test(content)) return false;

  const remaining = content
    .replace(/\bHEARTBEAT_OK\b/gi, '')
    .replace(/[^\w\s]/g, '')
    .trim();

  return remaining.length <= maxChars;
}

/**
 * Initialize heartbeat for all registered groups that have heartbeat-config.json
 */
export function initializeAllHeartbeats(
  registeredGroups: Record<string, RegisteredGroup>
): void {
  let count = 0;
  for (const [jid, group] of Object.entries(registeredGroups)) {
    if (initializeHeartbeat(group.folder, jid, group)) count++;
  }
  if (count > 0) logger.info({ count }, 'Heartbeats initialized');
}
```

## 2. Add HEARTBEAT_OK Suppression and Empty-File Skip to Task Scheduler

Read `src/task-scheduler.ts`. This step adds two things: suppressing HEARTBEAT_OK responses, and skipping the agent turn entirely when HEARTBEAT.md is empty.

First, add the import at the top of the file:

```typescript
import { isHeartbeatOk, isHeartbeatFileEmpty } from './heartbeat-scheduler.js';
```

### 2a. Add empty-file skip in runTask()

Inside the `runTask()` function, after the group lookup succeeds and before the tasks snapshot is written, add:

```typescript
// Skip heartbeat tasks if HEARTBEAT.md is empty (saves a full agent turn)
if (task.id.startsWith('heartbeat-') && isHeartbeatFileEmpty(task.group_folder)) {
  logger.info({ taskId: task.id }, 'Heartbeat skipped: HEARTBEAT.md is empty');
  // Calculate next_run normally so the task stays scheduled
  let nextRun: string | null = null;
  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, { tz: TIMEZONE });
    nextRun = interval.next().toISOString();
  } else if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    nextRun = new Date(Date.now() + ms).toISOString();
  }
  updateTaskAfterRun(task.id, nextRun, 'Skipped: HEARTBEAT.md empty');
  return;
}
```

This check runs at execution time (not just initialization), so if the user empties their HEARTBEAT.md, heartbeat runs stop costing tokens immediately — but the task stays scheduled and will resume when the file has content again.

### 2b. Add HEARTBEAT_OK suppression

In the streaming output callback, wrap the `sendMessage` call:

```typescript
// Before:
if (text) {
  await deps.sendMessage(task.chat_jid, text);
}

// After:
if (text && !isHeartbeatOk(text)) {
  await deps.sendMessage(task.chat_jid, text);
}
```

## 3. Add HEARTBEAT_OK Suppression to IPC

Read `src/ipc.ts` and find the message handling block where IPC messages are sent via `deps.sendMessage()`.

Add the import at the top:

```typescript
import { isHeartbeatOk } from './heartbeat-scheduler.js';
```

Then wrap the send call with suppression:

```typescript
// Before:
await deps.sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${data.text}`);

// After:
if (isHeartbeatOk(data.text, 300)) {
  logger.info({ chatJid: data.chatJid, sourceGroup }, 'HEARTBEAT_OK message suppressed');
} else {
  await deps.sendMessage(data.chatJid, `${ASSISTANT_NAME}: ${data.text}`);
}
```

## 4. Add Manual Heartbeat Trigger to IPC

Read `src/ipc.ts`. Add a `trigger_heartbeat` handler so the agent (or user) can force an immediate heartbeat run without waiting for the next scheduled interval.

First, add `getTasksForGroup` to the db import:

```typescript
import { createTask, deleteTask, getTaskById, updateTask, getTasksForGroup } from './db.js';
```

Then add this case to the `processTaskIpc` switch, before `refresh_groups`:

```typescript
case 'trigger_heartbeat': {
  // Trigger an immediate heartbeat run by setting next_run to now.
  // The scheduler will pick it up on its next poll cycle.
  const targetFolder = data.groupFolder || sourceGroup;

  // Authorization: non-main groups can only trigger their own heartbeat
  if (!isMain && targetFolder !== sourceGroup) {
    logger.warn(
      { sourceGroup, targetFolder },
      'Unauthorized trigger_heartbeat attempt blocked',
    );
    break;
  }

  const groupTasks = getTasksForGroup(targetFolder);
  const heartbeatTask = groupTasks.find(
    (t) => t.id.startsWith('heartbeat-') && t.status === 'active',
  );

  if (heartbeatTask) {
    updateTask(heartbeatTask.id, { next_run: new Date().toISOString() });
    logger.info(
      { taskId: heartbeatTask.id, sourceGroup, targetFolder },
      'Heartbeat triggered immediately via IPC',
    );
  } else {
    logger.warn(
      { sourceGroup, targetFolder },
      'No active heartbeat task found for group',
    );
  }
  break;
}
```

The agent can trigger this by writing a JSON file to its IPC tasks directory:

```json
{ "type": "trigger_heartbeat" }
```

Or to trigger another group's heartbeat (main group only):

```json
{ "type": "trigger_heartbeat", "groupFolder": "other-group" }
```

## 5. Initialize Heartbeats on Startup

Read `src/index.ts` and add the import at the top:

```typescript
import { initializeAllHeartbeats } from './heartbeat-scheduler.js';
```

Then in the `main()` function, after `startSchedulerLoop(...)` and before `startMessageLoop()`, add:

```typescript
// Initialize heartbeats for groups that have heartbeat-config.json
initializeAllHeartbeats(registeredGroups);
```

## 6. Install cron-parser Dependency

```bash
npm install cron-parser
```

## 7. Create Heartbeat Configuration

Create `groups/{group-folder}/heartbeat-config.json` using the user's earlier choices:

```json
{
  "heartbeat": {
    "enabled": true,
    "every": "60m",
    "activeHours": {
      "start": 9,
      "end": 18,
      "timezone": "America/Los_Angeles"
    },
    "suppressOk": true,
    "maxSuppressedChars": 300
  }
}
```

Adjust `every`, `activeHours.start`, `activeHours.end`, and `activeHours.timezone` based on user's answers from the initial questions. If user chose "Always on", omit the `activeHours` field entirely.

## 8. Create HEARTBEAT.md Checklist

Create `groups/{group-folder}/HEARTBEAT.md` — this is the standing instructions the agent reads each heartbeat cycle. **This file is the brain of the heartbeat system.** A vague checklist produces vague results. Make every check concrete and actionable.

Ask the user what they want monitored. Then write checks that include:
- **Exact commands** the agent should run (bash, sqlite3, file reads)
- **Specific paths** to check (not "check for errors" but "grep ERROR in /path/to/log")
- **Clear thresholds** for when to alert (not "if something seems wrong" but "if last_run > 24 hours ago")

### Checklist Design Principles

1. **Start with an active-work guard** — if another task is running, skip and respond HEARTBEAT_OK
2. **Give concrete commands** — the agent has Bash, Read, Grep, WebSearch, browser automation. Tell it what to run.
3. **Set clear thresholds** — "flag if >2 days stale" not "flag if it seems old"
4. **Keep it focused** — 3-5 checks that actually matter, not 20 aspirational items
5. **End with self-maintenance** — tell the agent to update the checklist when it becomes stale

### Template

```markdown
# Heartbeat Checklist

## Step 1: Check for Active Work

Before doing anything else, check if you're already handling a user message or task. If so, skip all checks and respond with `HEARTBEAT_OK`.

## Step 2: System Health

- Check logs for errors in the past hour:
  \`\`\`bash
  grep -E "ERROR|WARN" /workspace/project/logs/nanoclaw.log | tail -20
  \`\`\`
- Check scheduled task status:
  \`\`\`bash
  sqlite3 /workspace/project/store/messages.db "SELECT id, status, last_run, last_result FROM scheduled_tasks WHERE status='active' ORDER BY last_run DESC;"
  \`\`\`
  Flag any task with `Error:` in last_result or that hasn't run in >24 hours.

## Step 3: [User-specific checks]

<!-- Examples of concrete checks:
- Check a shared folder for new files: find /workspace/extra/shared/ -type f -mmin -120
- Check email for VIP senders: use mcp__gmail__search_emails with "from:boss@company.com is:unread"
- Check a website for changes: use agent-browser to visit a URL and compare to last snapshot
- Check a project folder for stale deliverables waiting for review
-->

## Response Protocol

**CRITICAL: Only send a message if there's an ACTUAL PROBLEM.**

- Everything normal: Reply ONLY `HEARTBEAT_OK` — nothing else
- Something needs attention: Send brief notification with what, why, and recommended action

DO NOT send status reports. Only interrupt for things that matter.

## Self-Maintenance

If this checklist becomes stale, update it. Keep checks concrete and actionable.
```

Work with the user to replace `[User-specific checks]` with checks tailored to their setup — what data sources do they have mounted? What MCP servers are configured? What matters to them?

## 9. Build and Test

Compile TypeScript:

```bash
npm run build
```

Test with a short interval first (5 minutes) by temporarily setting `"every": "5m"` in the config. Watch logs for heartbeat initialization:

```bash
npm run dev
```

Look for log lines:
- `Heartbeat initialized` — config was loaded and task created
- `HEARTBEAT_OK message suppressed` — suppression is working

After verifying, change the interval back to the user's chosen value and restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
```

## 10. Verify Expected Behavior

**Normal operation (nothing urgent):**
```
[9:00 AM] Heartbeat runs → "HEARTBEAT_OK" → Suppressed (no notification)
[10:00 AM] Heartbeat runs → "HEARTBEAT_OK" → Suppressed
```

**Something needs attention:**
```
[2:00 PM] Heartbeat runs → Agent detects issue → Sends notification to user
```

**Outside active hours:**
```
[8:00 PM] Heartbeat runs → Prompt wrapping detects outside hours → "HEARTBEAT_OK" → Suppressed
```

**HEARTBEAT.md is empty or missing:**
```
[10:00 AM] Heartbeat due → HEARTBEAT.md empty → Skipped (zero tokens, task rescheduled)
```

**Manual trigger:**
```
Agent writes {"type": "trigger_heartbeat"} to IPC → next_run set to now → Runs within 60s
```

## Token Cost

Hourly heartbeat during 9 AM – 6 PM = 9 runs/day:
- ~500 tokens per run (reading HEARTBEAT.md + reasoning)
- ~4,500 tokens/day, ~135,000 tokens/month
- Most runs return HEARTBEAT_OK (suppressed, no user notification)

## Removing Heartbeat

To disable for a group: set `"enabled": false` in `heartbeat-config.json` and restart.

To remove entirely:
1. Delete `src/heartbeat-scheduler.ts`
2. Remove imports and calls from `src/index.ts`, `src/task-scheduler.ts`, `src/ipc.ts`
3. Delete `heartbeat-config.json` and `HEARTBEAT.md` from group folders
4. `npm uninstall cron-parser`
5. `npm run build`
