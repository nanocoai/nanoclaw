import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { log } from './log.js';
import { registerOperationalErrorSink, reportOperationalError, type OperationalError } from './operational-errors.js';

const unregister: Array<() => void> = [];

afterEach(() => {
  while (unregister.length) unregister.pop()!();
  vi.mocked(log.warn).mockClear();
});

const sample = { kind: 'delivery.failed', message: 'boom', key: 'delivery.failed:s1' } as const;

describe('reportOperationalError', () => {
  it('is a no-op with no sink registered', () => {
    expect(() => reportOperationalError(sample)).not.toThrow();
    expect(log.warn).not.toHaveBeenCalled();
  });

  it('hands every registered sink the event with a timestamp', async () => {
    const a = vi.fn();
    const b = vi.fn();
    unregister.push(registerOperationalErrorSink(a), registerOperationalErrorSink(b));

    reportOperationalError(sample);

    await vi.waitFor(() => expect(b).toHaveBeenCalledTimes(1));
    expect(a).toHaveBeenCalledTimes(1);
    const event = a.mock.calls[0][0] as OperationalError;
    expect(event).toMatchObject(sample);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
  });

  it('does not wait on a sink and survives a throwing or rejecting one', async () => {
    let release!: () => void;
    const slow = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const throwing = vi.fn(() => {
      throw new Error('sync');
    });
    const rejecting = vi.fn(async () => {
      throw new Error('async');
    });
    const healthy = vi.fn();
    unregister.push(
      registerOperationalErrorSink(slow),
      registerOperationalErrorSink(throwing),
      registerOperationalErrorSink(rejecting),
      registerOperationalErrorSink(healthy),
    );

    expect(() => reportOperationalError(sample)).not.toThrow();

    await vi.waitFor(() => expect(log.warn).toHaveBeenCalledTimes(2));
    expect(healthy).toHaveBeenCalledTimes(1);
    release();
  });

  it('stops calling a sink once it is unregistered', async () => {
    const sink = vi.fn();
    const off = registerOperationalErrorSink(sink);
    off();

    reportOperationalError(sample);
    await new Promise((resolve) => setImmediate(resolve));
    expect(sink).not.toHaveBeenCalled();
  });
});
