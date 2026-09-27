import { afterEach, expect, it, vi } from 'vitest';
import { startGatewayAvailabilityMonitor } from './gateway-availability.js';
import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

const stops: Array<() => void> = [];
afterEach(() => {
  stops.splice(0).forEach((stop) => stop());
  vi.useRealTimers();
});

it('propagates an approval-plane fault to both runtime observers without starting another human flow', async () => {
  vi.useFakeTimers();
  let healthy = false;
  let expiresAt = 0;
  const subscribe = vi.fn();
  const gateway = {
    availability: {
      publish: vi.fn(async (value: boolean) => {
        healthy = value;
        expiresAt = Date.now() + 100;
      }),
      read: vi.fn(async () => healthy && expiresAt > Date.now()),
    },
    approvals: { subscribe },
  } as unknown as GatewayProviderDefinition;
  const first = { stop: vi.fn(), resume: vi.fn() };
  const second = { stop: vi.fn(), resume: vi.fn() };
  stops.push(await startGatewayAvailabilityMonitor(gateway, first.stop, first.resume, { intervalMs: 10 }));
  stops.push(await startGatewayAvailabilityMonitor(gateway, second.stop, second.resume, { intervalMs: 10 }));
  expect(first.stop).toHaveBeenCalledTimes(1);
  expect(second.stop).toHaveBeenCalledTimes(1);
  await gateway.availability!.publish(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(first.resume).toHaveBeenCalledTimes(1);
  expect(second.resume).toHaveBeenCalledTimes(1);
  await gateway.availability!.publish(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(first.stop).toHaveBeenCalledTimes(2);
  expect(second.stop).toHaveBeenCalledTimes(2);
  expect(subscribe).not.toHaveBeenCalled();
  await gateway.availability!.publish(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(second.resume).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(110);
  expect(second.stop).toHaveBeenCalledTimes(3);
  expect(second.resume).toHaveBeenCalledTimes(2);
});

it('closes admission when the shared read fails and only reopens after a successful healthy read', async () => {
  vi.useFakeTimers();
  const read = vi.fn().mockResolvedValue(true);
  const gateway = { availability: { read, publish: vi.fn() } } as unknown as GatewayProviderDefinition;
  const stop = vi.fn();
  const resume = vi.fn();
  stops.push(await startGatewayAvailabilityMonitor(gateway, stop, resume, { intervalMs: 10 }));
  expect(resume).toHaveBeenCalledTimes(1);
  read.mockRejectedValue(new Error('coordination unavailable'));
  await vi.advanceTimersByTimeAsync(20);
  expect(stop).toHaveBeenCalledTimes(1);
  expect(resume).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(false);
  await vi.advanceTimersByTimeAsync(10);
  expect(resume).toHaveBeenCalledTimes(1);
  read.mockResolvedValue(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(resume).toHaveBeenCalledTimes(2);
});

it('bounds a stalled shared read and never opens admission on a late result', async () => {
  vi.useFakeTimers();
  let resolve!: (value: boolean) => void;
  const read = vi.fn(
    () =>
      new Promise<boolean>((done) => {
        resolve = done;
      }),
  );
  const gateway = { availability: { read, publish: vi.fn() } } as unknown as GatewayProviderDefinition;
  const stop = vi.fn();
  const resume = vi.fn();
  const started = startGatewayAvailabilityMonitor(gateway, stop, resume, { intervalMs: 100, timeoutMs: 5 });
  await vi.advanceTimersByTimeAsync(5);
  stops.push(await started);
  expect(stop).toHaveBeenCalledTimes(1);
  resolve(true);
  await Promise.resolve();
  expect(resume).not.toHaveBeenCalled();
});
