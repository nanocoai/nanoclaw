import { afterEach, describe, expect, it, vi } from 'vitest';

import { attachSideband } from './gpt-live-sideband.js';

class Socket extends EventTarget {
  static latest: Socket;
  send = vi.fn();
  close = vi.fn();
  constructor() {
    super();
    Socket.latest = this;
  }
}

const options = () => ({
  wsBase: 'ws://localhost',
  apiKey: 'test-key',
  sessionId: 'live_test',
  onEvent: vi.fn(),
  onClose: vi.fn(),
  timeoutMs: 100,
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('sideband attach lifecycle', () => {
  it('bounds a handshake that never opens and ignores a late open', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Socket);
    const opts = options();
    const result = attachSideband(opts);
    const rejected = expect(result).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(101);
    await rejected;
    expect(Socket.latest.close).toHaveBeenCalled();
    Socket.latest.dispatchEvent(new Event('open'));
    Socket.latest.dispatchEvent(new MessageEvent('message', { data: '{"type":"session.delegation.created"}' }));
    expect(opts.onEvent).not.toHaveBeenCalled();
  });

  it('rejects a close before open instead of leaving the request pending', async () => {
    vi.stubGlobal('WebSocket', Socket);
    const result = attachSideband(options());
    const rejected = expect(result).rejects.toThrow(/closed before/);
    Socket.latest.dispatchEvent(new Event('close'));
    await rejected;
  });

  it('cancels an in-flight handshake when its call is replaced', async () => {
    vi.stubGlobal('WebSocket', Socket);
    const ctl = new AbortController();
    const result = attachSideband({ ...options(), signal: ctl.signal });
    const rejected = expect(result).rejects.toThrow(/cancelled/);
    ctl.abort();
    await rejected;
    expect(Socket.latest.close).toHaveBeenCalled();
  });

  it('clears the deadline after opening and reports transport close once', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', Socket);
    const opts = options();
    const result = attachSideband(opts);
    Socket.latest.dispatchEvent(new Event('open'));
    const socket = await result;
    await vi.advanceTimersByTimeAsync(200);
    expect(Socket.latest.close).not.toHaveBeenCalled();
    socket.send('hello');
    expect(Socket.latest.send).toHaveBeenCalledWith('hello');
    Socket.latest.dispatchEvent(new Event('close'));
    Socket.latest.dispatchEvent(new Event('close'));
    expect(opts.onClose).toHaveBeenCalledTimes(1);
    expect(() => socket.send('late')).toThrow(/closed/);
  });
});
