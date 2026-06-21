import { describe, expect, it } from 'vitest';

import { classifyPingResult, waitForPing, type PingResult } from './agent-ping.js';

describe('classifyPingResult', () => {
  it('treats a normal text reply as ok', () => {
    expect(classifyPingResult(0, 'pong\n')).toBe('ok');
  });

  it('detects Anthropic auth errors printed as a chat reply', () => {
    expect(
      classifyPingResult(
        0,
        'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
      ),
    ).toBe('auth_error');
  });

  it('detects auth errors on stderr too', () => {
    expect(classifyPingResult(1, '', 'Authentication error')).toBe('auth_error');
  });

  it('detects Claude Code login banners printed as a chat reply', () => {
    expect(
      classifyPingResult(0, 'Invalid API key · Please run /login'),
    ).toBe('auth_error');
    expect(
      classifyPingResult(0, 'Not logged in · Please run /login'),
    ).toBe('auth_error');
  });

  it('preserves socket errors', () => {
    expect(classifyPingResult(2, '')).toBe('socket_error');
  });

  it('treats empty output as no reply', () => {
    expect(classifyPingResult(0, '')).toBe('no_reply');
  });
});

describe('waitForPing', () => {
  // Injected clock so the bounded window is exercised without real sleeping.
  function fakeClock() {
    let t = 0;
    return {
      now: () => t,
      sleep: (ms: number) => {
        t += ms;
        return Promise.resolve();
      },
    };
  }

  it('retries past early socket_error and returns ok once the socket is ready', async () => {
    const sequence: PingResult[] = ['socket_error', 'socket_error', 'ok'];
    let calls = 0;
    const clock = fakeClock();
    const result = await waitForPing(() => Promise.resolve(sequence[calls++]), {
      windowMs: 45_000,
      intervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toBe('ok');
    expect(calls).toBe(3);
  });

  it('gives up with socket_error after the window if the socket never binds', async () => {
    const clock = fakeClock();
    const result = await waitForPing(() => Promise.resolve<PingResult>('socket_error'), {
      windowMs: 5_000,
      intervalMs: 1_000,
      now: clock.now,
      sleep: clock.sleep,
    });
    expect(result).toBe('socket_error');
    // The loop advanced the clock to (or past) the deadline before giving up.
    expect(clock.now()).toBeGreaterThanOrEqual(5_000);
  });
});
