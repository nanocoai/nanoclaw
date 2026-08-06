import { ChildProcess } from 'child_process';
import { CronExpressionParser } from 'cron-parser';
import fs from 'fs';

import { ASSISTANT_NAME, SCHEDULER_POLL_INTERVAL, TIMEZONE } from './config.js';
import {
  ContainerOutput,
  detectRateLimit,
  detectRateLimitResult,
  getSecretCount,
  resolveCliMode,
  rotateAccount,
  runContainerAgent,
  shouldAutoRotateAnthropicAccount,
  writeTasksSnapshot,
} from './container-runner.js';
import {
  getAllTasks,
  getDueTasks,
  getTaskById,
  logTaskRun,
  updateTask,
  updateTaskAfterRun,
} from './db.js';
import { GroupQueue } from './group-queue.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';
import { RegisteredGroup, ScheduledTask } from './types.js';

/**
 * Compute the next run time for a recurring task, anchored to the
 * task's scheduled time rather than Date.now() to prevent cumulative
 * drift on interval-based tasks.
 *
 * Co-authored-by: @community-pr-601
 */
export function computeNextRun(task: ScheduledTask): string | null {
  if (task.schedule_type === 'once') return null;

  const now = Date.now();

  if (task.schedule_type === 'cron') {
    const interval = CronExpressionParser.parse(task.schedule_value, {
      tz: TIMEZONE,
    });
    return interval.next().toISOString();
  }

  if (task.schedule_type === 'interval') {
    const ms = parseInt(task.schedule_value, 10);
    if (!ms || ms <= 0) {
      // Guard against malformed interval that would cause an infinite loop
      logger.warn(
        { taskId: task.id, value: task.schedule_value },
        'Invalid interval value',
      );
      return new Date(now + 60_000).toISOString();
    }
    // Anchor to the scheduled time, not now, to prevent drift.
    // Skip past any missed intervals so we always land in the future.
    let next = new Date(task.next_run!).getTime() + ms;
    while (next <= now) {
      next += ms;
    }
    return new Date(next).toISOString();
  }

  return null;
}

export interface SchedulerDependencies {
  registeredGroups: () => Record<string, RegisteredGroup>;
  getSessions: () => Record<string, string>;
  queue: GroupQueue;
  onProcess: (
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder: string,
  ) => void;
  sendMessage: (jid: string, text: string) => Promise<string | undefined>;
}

async function runTask(
  task: ScheduledTask,
  deps: SchedulerDependencies,
): Promise<void> {
  const startTime = Date.now();
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(task.group_folder);
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    // Stop retry churn for malformed legacy rows.
    updateTask(task.id, { status: 'paused' });
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder, error },
      'Task has invalid group folder',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error,
    });
    return;
  }
  fs.mkdirSync(groupDir, { recursive: true });

  logger.info(
    { taskId: task.id, group: task.group_folder },
    'Running scheduled task',
  );

  const groups = deps.registeredGroups();
  const group = Object.values(groups).find(
    (g) => g.folder === task.group_folder,
  );

  if (!group) {
    logger.error(
      { taskId: task.id, groupFolder: task.group_folder },
      'Group not found for task',
    );
    logTaskRun({
      task_id: task.id,
      run_at: new Date().toISOString(),
      duration_ms: Date.now() - startTime,
      status: 'error',
      result: null,
      error: `Group not found: ${task.group_folder}`,
    });
    return;
  }

  // Update tasks snapshot for container to read (filtered by group)
  const isMain = group.isMain === true;
  const tasks = getAllTasks();
  writeTasksSnapshot(
    task.group_folder,
    isMain,
    tasks.map((t) => ({
      id: t.id,
      groupFolder: t.group_folder,
      prompt: t.prompt,
      script: t.script,
      schedule_type: t.schedule_type,
      schedule_value: t.schedule_value,
      status: t.status,
      next_run: t.next_run,
    })),
  );

  let result: string | null = null;
  let error: string | null = null;

  // For group context mode, use the group's current session
  const sessions = deps.getSessions();
  const sessionId =
    task.context_mode === 'group' ? sessions[task.group_folder] : undefined;

  // After the task produces a result, close the container promptly.
  // Tasks are single-turn — no need to wait IDLE_TIMEOUT (30 min) for the
  // query loop to time out. A short delay handles any final MCP calls.
  const TASK_CLOSE_DELAY_MS = 10000;
  let closeTimer: ReturnType<typeof setTimeout> | null = null;

  const scheduleClose = () => {
    if (closeTimer) return; // already scheduled
    closeTimer = setTimeout(() => {
      logger.debug({ taskId: task.id }, 'Closing task container after result');
      deps.queue.closeStdin(task.chat_jid);
    }, TASK_CLOSE_DELAY_MS);
  };

  // 限流自动轮换（与消息路径 src/index.ts 的 streaming 限流逻辑对齐）：
  // 检测到 "hit your limit" 等文本 → 抑制发送 + kill 子进程 → rotateAccount 换号重跑，
  // 直到成功或试完所有备用账号。夜班等定时任务不再因单账号限额直接躺平（2026-08-06 首班阵亡复盘）。
  const taskCliMode = resolveCliMode(group.containerConfig);
  const canRotateOnLimit = shouldAutoRotateAnthropicAccount(taskCliMode);
  const maxRotations = canRotateOnLimit ? Math.max(0, getSecretCount() - 1) : 0;
  let rateLimitDetected = false;

  try {
    for (let attempt = 0; ; attempt++) {
    rateLimitDetected = false;
    result = null;
    error = null;
    const output = await runContainerAgent(
      group,
      {
        prompt: task.prompt,
        sessionId,
        groupFolder: task.group_folder,
        chatJid: task.chat_jid,
        isMain,
        isScheduledTask: true,
        assistantName: ASSISTANT_NAME,
        script: task.script || undefined,
        cliMode: taskCliMode,
      },
      (proc, containerName) =>
        deps.onProcess(task.chat_jid, proc, containerName, task.group_folder),
      async (streamedOutput: ContainerOutput) => {
        // 进度消息（tool_use/thinking 等）不转发给用户，定时任务只发最终结果
        logger.info(
          {
            taskId: task.id,
            status: streamedOutput.status,
            hasResult: !!streamedOutput.result,
            resultLen: streamedOutput.result?.toString().slice(0, 80),
            progressType: streamedOutput.progressType,
          },
          '[task] onOutput received',
        );
        if (streamedOutput.status === 'progress') {
          return;
        }
        if (streamedOutput.result) {
          const raw =
            typeof streamedOutput.result === 'string'
              ? streamedOutput.result
              : JSON.stringify(streamedOutput.result);
          // 限流假成功：抑制发送 + kill，交给外层循环换号重试
          if (canRotateOnLimit && detectRateLimitResult(raw)) {
            rateLimitDetected = true;
            logger.warn(
              { taskId: task.id, text: raw.slice(0, 120) },
              '[task][rate-limit] 输出含限流文本，抑制发送并 kill，准备轮换账号',
            );
            deps.queue.killGroup(task.chat_jid);
            return;
          }
          // 剥掉 <internal> 标签
          const text = raw
            .replace(/<internal>[\s\S]*?<\/internal>/g, '')
            .trim();
          if (text) {
            result = text;
            // Forward result to user (sendMessage handles formatting)
            await deps.sendMessage(task.chat_jid, text);
          }
          scheduleClose();
        }
        if (streamedOutput.status === 'success') {
          deps.queue.notifyIdle(task.chat_jid);
          scheduleClose(); // Close promptly even when result is null (e.g. IPC-only tasks)
        }
        if (streamedOutput.status === 'error') {
          error = streamedOutput.error || 'Unknown error';
          if (canRotateOnLimit && detectRateLimit(error)) {
            rateLimitDetected = true;
          }
        }
      },
    );

    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }

    if (!rateLimitDetected) {
      if (output.status === 'error') {
        error = output.error || 'Unknown error';
      } else if (output.result) {
        // Result was already forwarded to the user via the streaming callback above
        result = output.result;
      }
      logger.info(
        { taskId: task.id, attempt, durationMs: Date.now() - startTime },
        'Task completed',
      );
      break;
    }

    // 限流：换号重试或认输
    if (attempt >= maxRotations) {
      error = `rate limited; account rotation exhausted after ${attempt} rotation(s)`;
      logger.warn({ taskId: task.id, attempt }, '[task][rate-limit] 备用账号用尽，放弃');
      break;
    }
    const agentId = task.group_folder.toLowerCase().replace(/_/g, '-');
    const rotated = rotateAccount(agentId, task.group_folder);
    if (!rotated?.success) {
      error = 'rate limited; account rotation failed';
      logger.warn({ taskId: task.id }, '[task][rate-limit] 轮换账号失败，放弃');
      break;
    }
    logger.info(
      {
        taskId: task.id,
        from: rotated.oldSecretName,
        to: rotated.newSecretName,
        attempt: attempt + 1,
      },
      '[task][rate-limit] 已轮换账号，重试任务',
    );
    }
  } catch (err) {
    if (closeTimer) clearTimeout(closeTimer);
    error = err instanceof Error ? err.message : String(err);
    logger.error({ taskId: task.id, error }, 'Task failed');
  }

  const durationMs = Date.now() - startTime;

  logTaskRun({
    task_id: task.id,
    run_at: new Date().toISOString(),
    duration_ms: durationMs,
    status: error ? 'error' : 'success',
    result,
    error,
  });

  const nextRun = computeNextRun(task);
  const resultSummary = error
    ? `Error: ${error}`
    : result
      ? result.slice(0, 200)
      : 'Completed';
  updateTaskAfterRun(task.id, nextRun, resultSummary);
}

let schedulerRunning = false;

export function startSchedulerLoop(deps: SchedulerDependencies): void {
  if (schedulerRunning) {
    logger.debug('Scheduler loop already running, skipping duplicate start');
    return;
  }
  schedulerRunning = true;
  logger.info('Scheduler loop started');

  const loop = async () => {
    try {
      const dueTasks = getDueTasks();
      if (dueTasks.length > 0) {
        logger.info({ count: dueTasks.length }, 'Found due tasks');
      }

      for (const task of dueTasks) {
        // Re-check task status in case it was paused/cancelled
        const currentTask = getTaskById(task.id);
        if (!currentTask || currentTask.status !== 'active') {
          continue;
        }

        deps.queue.enqueueTask(currentTask.chat_jid, currentTask.id, () =>
          runTask(currentTask, deps),
        );
      }
    } catch (err) {
      logger.error({ err }, 'Error in scheduler loop');
    }

    setTimeout(loop, SCHEDULER_POLL_INTERVAL);
  };

  loop();
}

/** @internal - for tests only. */
export function _resetSchedulerLoopForTests(): void {
  schedulerRunning = false;
}
