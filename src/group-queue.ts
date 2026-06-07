import { ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';

import { DATA_DIR, MAX_CONCURRENT_AGENTS } from './config.js';
import { clearContextHash } from './memory/inject.js';
import type { MessageContext } from './memory/inject.js';
import { logger } from './logger.js';

interface QueuedTask {
  id: string;
  groupJid: string;
  fn: () => Promise<void>;
}

const MAX_RETRIES = 5;
const BASE_RETRY_MS = 5000;

interface GroupState {
  active: boolean;
  idleWaiting: boolean;
  isTaskContainer: boolean;
  runningTaskId: string | null;
  stopRequested: boolean;
  pendingMessages: boolean;
  pendingTasks: QueuedTask[];
  process: ChildProcess | null;
  containerName: string | null;
  groupFolder: string | null;
  retryCount: number;
}

export class GroupQueue {
  private groups = new Map<string, GroupState>();
  private activeCount = 0;
  private waitingGroups: string[] = [];
  private processMessagesFn: ((groupJid: string) => Promise<boolean>) | null =
    null;
  private shuttingDown = false;

  private getGroup(groupJid: string): GroupState {
    let state = this.groups.get(groupJid);
    if (!state) {
      state = {
        active: false,
        idleWaiting: false,
        isTaskContainer: false,
        runningTaskId: null,
        stopRequested: false,
        pendingMessages: false,
        pendingTasks: [],
        process: null,
        containerName: null,
        groupFolder: null,
        retryCount: 0,
      };
      this.groups.set(groupJid, state);
    }
    return state;
  }

  setProcessMessagesFn(fn: (groupJid: string) => Promise<boolean>): void {
    this.processMessagesFn = fn;
  }

  enqueueMessageCheck(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    if (state.active) {
      state.pendingMessages = true;
      logger.info(
        {
          groupJid,
          groupFolder: state.groupFolder,
          idleWaiting: state.idleWaiting,
        },
        'Container active, message queued',
      );
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingMessages = true;
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.info(
        { groupJid, activeCount: this.activeCount },
        'At concurrency limit, message queued',
      );

      // 踢掉一个 idle 容器来腾出位子（drainGroup → drainWaiting 会拉起等待的群）
      this.evictIdleContainer(groupJid);
      return;
    }

    this.runForGroup(groupJid, 'messages').catch((err) =>
      logger.error({ groupJid, err }, 'Unhandled error in runForGroup'),
    );
  }

  enqueueTask(groupJid: string, taskId: string, fn: () => Promise<void>): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Prevent double-queuing: check both pending and currently-running task
    if (state.runningTaskId === taskId) {
      logger.debug({ groupJid, taskId }, 'Task already running, skipping');
      return;
    }
    if (state.pendingTasks.some((t) => t.id === taskId)) {
      logger.debug({ groupJid, taskId }, 'Task already queued, skipping');
      return;
    }

    if (state.active) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (state.idleWaiting) {
        this.closeStdin(groupJid);
      }
      logger.debug({ groupJid, taskId }, 'Container active, task queued');
      return;
    }

    if (this.activeCount >= MAX_CONCURRENT_AGENTS) {
      state.pendingTasks.push({ id: taskId, groupJid, fn });
      if (!this.waitingGroups.includes(groupJid)) {
        this.waitingGroups.push(groupJid);
      }
      logger.info(
        { groupJid, taskId, activeCount: this.activeCount },
        'At concurrency limit, task queued',
      );
      this.evictIdleContainer(groupJid);
      return;
    }

    // Run immediately
    this.runTask(groupJid, { id: taskId, groupJid, fn }).catch((err) =>
      logger.error({ groupJid, taskId, err }, 'Unhandled error in runTask'),
    );
  }

  registerProcess(
    groupJid: string,
    proc: ChildProcess,
    containerName: string,
    groupFolder?: string,
  ): void {
    const state = this.getGroup(groupJid);
    state.process = proc;
    state.containerName = containerName;
    if (groupFolder) state.groupFolder = groupFolder;
    logger.info(
      {
        groupJid,
        containerName,
        groupFolder: state.groupFolder,
        active: state.active,
      },
      'registerProcess',
    );
  }

  /**
   * 检查 group 的 container 是否 active（可用于决定是否做动态注入）
   */
  isActive(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    return !!state?.active && !!state?.groupFolder && !state?.isTaskContainer;
  }

  /**
   * 杀掉指定 group 的活跃容器进程。
   * 用于 /account 切换账号时立即终止旧容器，让新消息用新 key 起新容器。
   * 进程退出后 runForGroup 的 finally 块会自动 drain 后续消息。
   */
  killGroup(groupJid: string, forceKillAfterMs = 2000): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.active || !state.process) return false;

    const pid = state.process.pid;
    if (!pid) return false;
    const name = state.containerName || groupJid;
    logger.info({ groupJid, pid, name }, 'killGroup: 终止容器进程');

    // 清除 pending 状态，防止 drainGroup 在进程退出后自动拉起新容器
    state.pendingMessages = false;

    this.signalProcess(pid, 'SIGTERM');

    const timer = setTimeout(() => {
      if (!this.isProcessAlive(pid)) return;
      logger.warn({ groupJid, pid, name }, 'killGroup: 进程未退出，发送 SIGKILL');
      this.signalProcess(pid, 'SIGKILL');
    }, forceKillAfterMs);
    timer.unref?.();

    return true;
  }

  /**
   * 用户主动停止当前运行中的 Codex 任务。
   * 与 killGroup 不同：这里会记录 stopRequested，让上层不要把主动停止当失败重试。
   */
  stopGroup(groupJid: string, forceKillAfterMs = 2000): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.active || !state.process) return false;

    const pid = state.process.pid;
    if (!pid) return false;

    const name = state.containerName || groupJid;
    logger.info({ groupJid, pid, name }, 'stopGroup: 用户主动停止当前任务');

    state.pendingMessages = false;
    state.stopRequested = true;

    this.signalProcess(pid, 'SIGTERM');

    const timer = setTimeout(() => {
      if (!this.isProcessAlive(pid)) return;
      logger.warn({ groupJid, pid, name }, 'stopGroup: 进程未退出，发送 SIGKILL');
      this.signalProcess(pid, 'SIGKILL');
    }, forceKillAfterMs);
    timer.unref?.();

    return true;
  }

  consumeStopRequested(groupJid: string): boolean {
    const state = this.groups.get(groupJid);
    if (!state?.stopRequested) return false;
    state.stopRequested = false;
    return true;
  }

  /**
   * Mark the container as idle-waiting (finished work, waiting for IPC input).
   * If tasks are pending, preempt the idle container immediately.
   */
  notifyIdle(groupJid: string): void {
    const state = this.getGroup(groupJid);
    state.idleWaiting = true;
    if (state.pendingTasks.length > 0) {
      this.closeStdin(groupJid);
    }
  }

  /**
   * Send a follow-up message to the active container via IPC file.
   * Returns true if the message was written, false if no active container.
   */
  sendMessage(
    groupJid: string,
    text: string,
    modelOverride?: { model?: string; thinking?: 'adaptive' | 'disabled' },
    context?: MessageContext | null,
    senderId?: string,
  ): boolean {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder || state.isTaskContainer) {
      logger.info(
        {
          groupJid,
          active: state.active,
          groupFolder: state.groupFolder,
          isTaskContainer: state.isTaskContainer,
        },
        'queue.sendMessage rejected',
      );
      return false;
    }

    // 消息驱动健康检查：写 IPC 前确认 runner 子进程还活着
    if (state.process?.pid) {
      try {
        process.kill(state.process.pid, 0); // 不发信号，仅检查进程存在
      } catch {
        // 进程已死，标记为非活跃，让调用方走 enqueueMessageCheck 起新 runner
        logger.warn(
          { groupJid, pid: state.process.pid },
          'queue.sendMessage: runner 进程已死，标记非活跃',
        );
        state.active = false;
        state.process = null;
        return false;
      }
    }

    state.idleWaiting = false; // Agent is about to receive work, no longer idle

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.json`;
      const filepath = path.join(inputDir, filename);
      const tempPath = `${filepath}.tmp`;
      fs.writeFileSync(
        tempPath,
        JSON.stringify({
          type: 'message',
          text,
          modelOverride,
          context: context || undefined,
          senderId,
        }),
      );
      fs.renameSync(tempPath, filepath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Signal the active container to wind down by writing a close sentinel.
   */
  closeStdin(groupJid: string): void {
    const state = this.getGroup(groupJid);
    if (!state.active || !state.groupFolder) return;

    const inputDir = path.join(DATA_DIR, 'ipc', state.groupFolder, 'input');
    try {
      fs.mkdirSync(inputDir, { recursive: true });
      fs.writeFileSync(path.join(inputDir, '_close'), '');
    } catch {
      // ignore
    }
  }

  private async runForGroup(
    groupJid: string,
    reason: 'messages' | 'drain',
  ): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = false;
    state.pendingMessages = false;
    this.activeCount++;

    logger.debug(
      { groupJid, reason, activeCount: this.activeCount },
      'Starting container for group',
    );

    try {
      if (this.processMessagesFn) {
        const success = await this.processMessagesFn(groupJid);
        if (success) {
          state.retryCount = 0;
        } else {
          this.scheduleRetry(groupJid, state);
        }
      }
    } catch (err) {
      logger.error({ groupJid, err }, 'Error processing messages for group');
      this.scheduleRetry(groupJid, state);
    } finally {
      if (state.groupFolder) clearContextHash(state.groupFolder);
      state.active = false;
      state.stopRequested = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private async runTask(groupJid: string, task: QueuedTask): Promise<void> {
    const state = this.getGroup(groupJid);
    state.active = true;
    state.idleWaiting = false;
    state.isTaskContainer = true;
    state.runningTaskId = task.id;
    this.activeCount++;

    logger.debug(
      { groupJid, taskId: task.id, activeCount: this.activeCount },
      'Running queued task',
    );

    try {
      await task.fn();
    } catch (err) {
      logger.error({ groupJid, taskId: task.id, err }, 'Error running task');
    } finally {
      if (state.groupFolder) clearContextHash(state.groupFolder);
      state.active = false;
      state.isTaskContainer = false;
      state.runningTaskId = null;
      state.stopRequested = false;
      state.process = null;
      state.containerName = null;
      state.groupFolder = null;
      this.activeCount--;
      this.drainGroup(groupJid);
    }
  }

  private scheduleRetry(groupJid: string, state: GroupState): void {
    state.retryCount++;
    if (state.retryCount > MAX_RETRIES) {
      logger.error(
        { groupJid, retryCount: state.retryCount },
        'Max retries exceeded, dropping messages (will retry on next incoming message)',
      );
      state.retryCount = 0;
      return;
    }

    const delayMs = BASE_RETRY_MS * Math.pow(2, state.retryCount - 1);
    logger.info(
      { groupJid, retryCount: state.retryCount, delayMs },
      'Scheduling retry with backoff',
    );
    setTimeout(() => {
      if (!this.shuttingDown) {
        this.enqueueMessageCheck(groupJid);
      }
    }, delayMs);
  }

  private drainGroup(groupJid: string): void {
    if (this.shuttingDown) return;

    const state = this.getGroup(groupJid);

    // Tasks first (they won't be re-discovered from SQLite like messages)
    if (state.pendingTasks.length > 0) {
      const task = state.pendingTasks.shift()!;
      this.runTask(groupJid, task).catch((err) =>
        logger.error(
          { groupJid, taskId: task.id, err },
          'Unhandled error in runTask (drain)',
        ),
      );
      return;
    }

    // Then pending messages
    if (state.pendingMessages) {
      this.runForGroup(groupJid, 'drain').catch((err) =>
        logger.error(
          { groupJid, err },
          'Unhandled error in runForGroup (drain)',
        ),
      );
      return;
    }

    // Nothing pending for this group; check if other groups are waiting for a slot
    this.drainWaiting();
  }

  private drainWaiting(): void {
    while (
      this.waitingGroups.length > 0 &&
      this.activeCount < MAX_CONCURRENT_AGENTS
    ) {
      const nextJid = this.waitingGroups.shift()!;
      const state = this.getGroup(nextJid);

      // Prioritize tasks over messages
      if (state.pendingTasks.length > 0) {
        const task = state.pendingTasks.shift()!;
        this.runTask(nextJid, task).catch((err) =>
          logger.error(
            { groupJid: nextJid, taskId: task.id, err },
            'Unhandled error in runTask (waiting)',
          ),
        );
      } else if (state.pendingMessages) {
        this.runForGroup(nextJid, 'drain').catch((err) =>
          logger.error(
            { groupJid: nextJid, err },
            'Unhandled error in runForGroup (waiting)',
          ),
        );
      }
      // If neither pending, skip this group
    }
  }

  private signalProcess(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch {
      try {
        process.kill(pid, signal);
      } catch {
        // 进程已退出
      }
    }
  }

  private isProcessAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 并发满时，踢掉一个 idle 容器来腾出位子。
   * 优先踢别的群（不踢请求者自己），找最久没活动的 idle 容器。
   */
  private evictIdleContainer(requesterJid: string): void {
    let candidate: { jid: string; state: GroupState } | null = null;

    for (const [jid, s] of this.groups) {
      if (jid === requesterJid) continue;
      if (!s.active || !s.idleWaiting) continue;
      candidate = { jid, state: s };
      break; // 找到第一个就够了
    }

    if (candidate) {
      logger.info(
        { evicted: candidate.jid, forGroup: requesterJid },
        'Evicting idle container to free concurrency slot',
      );
      this.closeStdin(candidate.jid);
    }
  }

  async shutdown(gracePeriodMs: number): Promise<void> {
    this.shuttingDown = true;

    const killPromises: Promise<void>[] = [];
    for (const [jid, state] of this.groups) {
      if (state.process && !state.process.killed && state.process.pid) {
        const pid = state.process.pid;
        const name = state.containerName || jid;
        logger.info({ jid, pid, name }, 'Killing agent process on shutdown');
        killPromises.push(
          new Promise<void>((resolve) => {
            try {
              process.kill(-pid, 'SIGTERM');
            } catch {
              try {
                process.kill(pid, 'SIGTERM');
              } catch {
                /* already dead */
              }
            }
            const forceKill = setTimeout(() => {
              try {
                process.kill(-pid, 'SIGKILL');
              } catch {
                try {
                  process.kill(pid, 'SIGKILL');
                } catch {
                  /* already dead */
                }
              }
              resolve();
            }, gracePeriodMs);
            state.process!.once('close', () => {
              clearTimeout(forceKill);
              resolve();
            });
          }),
        );
      }
    }

    if (killPromises.length > 0) {
      await Promise.all(killPromises);
      logger.info(
        { killed: killPromises.length },
        'All agent processes terminated',
      );
    } else {
      logger.info('No active agent processes to kill');
    }
  }
}
