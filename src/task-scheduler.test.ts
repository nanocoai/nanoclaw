import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./container-runner.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./container-runner.js')>();
  return {
    ...actual,
    runContainerAgent: vi.fn(),
    rotateAccount: vi.fn(),
    getSecretCount: vi.fn(() => 2),
  };
});

import {
  getSecretCount as _mockedGetSecretCount,
  rotateAccount as mockedRotateAccount,
  runContainerAgent as mockedRunContainerAgent,
} from './container-runner.js';

import { _initTestDatabase, createTask, getTaskById } from './db.js';
import {
  _resetSchedulerLoopForTests,
  computeNextRun,
  startSchedulerLoop,
} from './task-scheduler.js';

describe('task scheduler', () => {
  beforeEach(() => {
    _initTestDatabase();
    _resetSchedulerLoopForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('pauses due tasks with invalid group folders to prevent retry churn', async () => {
    createTask({
      id: 'task-invalid-folder',
      group_folder: '../../outside',
      chat_jid: 'bad@g.us',
      prompt: 'run',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const enqueueTask = vi.fn(
      (_groupJid: string, _taskId: string, fn: () => Promise<void>) => {
        void fn();
      },
    );

    startSchedulerLoop({
      registeredGroups: () => ({}),
      getSessions: () => ({}),
      queue: { enqueueTask } as any,
      onProcess: () => {},
      sendMessage: async () => {},
    });

    await vi.advanceTimersByTimeAsync(10);

    const task = getTaskById('task-invalid-folder');
    expect(task?.status).toBe('paused');
  });


  it('rotates account and retries when scheduled task hits rate limit', async () => {
    createTask({
      id: 'task-rate-limited',
      group_folder: 'fs_test_group',
      chat_jid: 'fs:test@g.us',
      prompt: 'night shift',
      schedule_type: 'once',
      schedule_value: '2026-02-22T00:00:00.000Z',
      context_mode: 'isolated',
      next_run: new Date(Date.now() - 60_000).toISOString(),
      status: 'active',
      created_at: '2026-02-22T00:00:00.000Z',
    });

    const sent: string[] = [];
    const killGroup = vi.fn();

    vi.mocked(mockedRunContainerAgent)
      .mockImplementationOnce(async (_g, _i, _p, onOutput) => {
        await onOutput?.({
          status: 'success',
          result: "You've hit your limit · resets 4am (Asia/Shanghai)",
        } as any);
        return { status: 'success', result: null } as any;
      })
      .mockImplementationOnce(async (_g, _i, _p, onOutput) => {
        await onOutput?.({ status: 'success', result: '夜班完成' } as any);
        return { status: 'success', result: '夜班完成' } as any;
      });
    vi.mocked(mockedRotateAccount).mockReturnValue({
      success: true,
      oldSecretName: 'acct-a',
      newSecretName: 'acct-b',
    } as any);

    startSchedulerLoop({
      registeredGroups: () => ({
        'fs:test@g.us': {
          name: 'test',
          folder: 'fs_test_group',
          chatJid: 'fs:test@g.us',
        } as any,
      }),
      getSessions: () => ({}),
      queue: {
        enqueueTask: vi.fn(
          (_j: string, _t: string, fn: () => Promise<void>) => void fn(),
        ),
        killGroup,
        closeStdin: vi.fn(),
        notifyIdle: vi.fn(),
      } as any,
      onProcess: () => {},
      sendMessage: async (_jid: string, text: string) => {
        sent.push(text);
      },
    });

    await vi.advanceTimersByTimeAsync(20_000);

    // 限流文本被抑制，未发给用户；换号后重试的结果正常送达
    expect(sent.some((t) => t.includes('hit your limit'))).toBe(false);
    expect(sent).toContain('夜班完成');
    expect(mockedRotateAccount).toHaveBeenCalledTimes(1);
    expect(killGroup).toHaveBeenCalled();
    expect(vi.mocked(mockedRunContainerAgent)).toHaveBeenCalledTimes(2);
  });

  it('computeNextRun anchors interval tasks to scheduled time to prevent drift', () => {
    const scheduledTime = new Date(Date.now() - 2000).toISOString(); // 2s ago
    const task = {
      id: 'drift-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: '60000', // 1 minute
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();

    // Should be anchored to scheduledTime + 60s, NOT Date.now() + 60s
    const expected = new Date(scheduledTime).getTime() + 60000;
    expect(new Date(nextRun!).getTime()).toBe(expected);
  });

  it('computeNextRun returns null for once-tasks', () => {
    const task = {
      id: 'once-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'once' as const,
      schedule_value: '2026-01-01T00:00:00.000Z',
      context_mode: 'isolated' as const,
      next_run: new Date(Date.now() - 1000).toISOString(),
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    expect(computeNextRun(task)).toBeNull();
  });

  it('computeNextRun skips missed intervals without infinite loop', () => {
    // Task was due 10 intervals ago (missed)
    const ms = 60000;
    const missedBy = ms * 10;
    const scheduledTime = new Date(Date.now() - missedBy).toISOString();

    const task = {
      id: 'skip-test',
      group_folder: 'test',
      chat_jid: 'test@g.us',
      prompt: 'test',
      schedule_type: 'interval' as const,
      schedule_value: String(ms),
      context_mode: 'isolated' as const,
      next_run: scheduledTime,
      last_run: null,
      last_result: null,
      status: 'active' as const,
      created_at: '2026-01-01T00:00:00.000Z',
    };

    const nextRun = computeNextRun(task);
    expect(nextRun).not.toBeNull();
    // Must be in the future
    expect(new Date(nextRun!).getTime()).toBeGreaterThan(Date.now());
    // Must be aligned to the original schedule grid
    const offset =
      (new Date(nextRun!).getTime() - new Date(scheduledTime).getTime()) % ms;
    expect(offset).toBe(0);
  });
});
