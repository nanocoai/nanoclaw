import { describe, expect, it, vi } from 'vitest';
import { releaseGatewaySession, type GatewaySessionControl } from './gateway-session-lifecycle.js';

function control(release?: GatewaySessionControl['lease']['release']): GatewaySessionControl {
  return {
    controller: new AbortController(),
    lease: {
      contribution: {
        networkAccess: { endpoint: 'http://proxy:8080', target: { kind: 'runtime', identity: 'proxy' } },
      },
      release,
    },
  };
}

describe('gateway session release', () => {
  it('waits for cleanup before completing a terminal release', async () => {
    let complete!: () => void;
    const release = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const session = control(release);
    const event = { kind: 'session-ended' as const, reason: 'runtime-ended' };
    let finished = false;
    const pending = releaseGatewaySession(session, event).then(() => {
      finished = true;
    });
    await Promise.resolve();
    expect(session.controller.signal.aborted).toBe(true);
    expect(release).toHaveBeenCalledWith(event);
    expect(finished).toBe(false);
    complete();
    await pending;
    expect(finished).toBe(true);
  });

  it('preserves host detachment when a terminal notification races shutdown', async () => {
    const release = vi.fn(async () => {});
    const session = control(release);
    const detached = releaseGatewaySession(session, { kind: 'host-detached', reason: 'host-shutdown' });
    const terminal = releaseGatewaySession(session, { kind: 'session-ended', reason: 'runtime-ended' });
    expect(detached).toBe(terminal);
    await detached;
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith({ kind: 'host-detached', reason: 'host-shutdown' });
  });

  it('propagates cleanup failure and does not execute destructive cleanup twice', async () => {
    const release = vi.fn(async () => {
      throw new Error('revocation unavailable');
    });
    const session = control(release);
    const event = { kind: 'session-ended' as const, reason: 'runtime-ended' };
    await expect(releaseGatewaySession(session, event)).rejects.toThrow('revocation unavailable');
    await expect(releaseGatewaySession(session, event)).rejects.toThrow('revocation unavailable');
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('retains the abort signal contract for existing adapters without release', async () => {
    const session = control();
    await releaseGatewaySession(session, { kind: 'session-ended', reason: 'runtime-ended' });
    expect(session.controller.signal.reason).toBe('runtime-ended');
  });
});
