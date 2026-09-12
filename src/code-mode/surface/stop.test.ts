/**
 * Stop → interrupt: the keystroke rides the driver's exec dialect into the
 * session's tmux pane; no live session means nothing to press; a thread
 * stop is not a stop.
 */
import { describe, expect, it, vi } from 'vitest';

import type { SessionExecSpec, SessionHandle } from '../../drivers/types.js';
import { INTERRUPT_COMMAND, interruptCodingSession, isStopEvent } from './stop.js';

function handle(name: string): SessionHandle {
  return {
    key: { installSlug: 'i', agentGroupId: 'ag-1', sessionId: 's-1' },
    name,
    start: async () => {},
    status: async () => ({ phase: 'running' }),
    stop: async () => {},
    execSpec: (command: string[]) => ({
      bin: 'fake-runtime',
      argsTty: ['exec', '-it', name, ...command],
      argsPlain: ['exec', '-i', name, ...command],
    }),
  };
}

describe('interruptCodingSession', () => {
  it('presses Escape in the live session through the plain exec argv', async () => {
    const run = vi.fn(async (_spec: SessionExecSpec) => {});
    const ok = await interruptCodingSession('ag-1', { findLiveHandle: async () => handle('ncl-s-1'), run });
    expect(ok).toBe(true);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][0]).toEqual({
      bin: 'fake-runtime',
      argsTty: ['exec', '-it', 'ncl-s-1', ...INTERRUPT_COMMAND],
      argsPlain: ['exec', '-i', 'ncl-s-1', ...INTERRUPT_COMMAND],
    });
    expect(INTERRUPT_COMMAND).toEqual([
      'tmux',
      '-S',
      '/tmp/code-runner/tmux.sock',
      'send-keys',
      '-t',
      'agent',
      'Escape',
    ]);
  });

  it('no live session → false, nothing run', async () => {
    const run = vi.fn(async () => {});
    expect(await interruptCodingSession('ag-1', { findLiveHandle: async () => undefined, run })).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it('a failed exec surfaces', async () => {
    await expect(
      interruptCodingSession('ag-1', {
        findLiveHandle: async () => handle('x'),
        run: async () => {
          throw new Error('exec failed');
        },
      }),
    ).rejects.toThrow('exec failed');
  });
});

describe('isStopEvent', () => {
  it('a surface-wide stop is a stop; a thread stop or another type is not', () => {
    expect(isStopEvent({ type: 'stop' })).toBe(true);
    expect(isStopEvent({ type: 'stop', threadId: '1.2' })).toBe(false);
    expect(isStopEvent({ type: 'command', command: '/x' })).toBe(false);
  });
});
