import type { GatewayProviderDefinition } from './gateway-providers/gateway-provider-registry.js';

/** Each runtime observes the same lease-backed approval availability; observers never start approvals. */
export async function startGatewayAvailabilityMonitor(
  provider: GatewayProviderDefinition,
  unavailable: (reason: string) => void,
  available: () => void,
  options: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<() => void> {
  const source = provider.availability;
  if (!source) return () => {};
  let stopped = false;
  let previous: boolean | undefined;
  let timer: NodeJS.Timeout | undefined;
  const check = async () => {
    let healthy = false;
    let timeout: NodeJS.Timeout | undefined;
    try {
      healthy = await Promise.race([
        source.read(),
        new Promise<false>((resolve) => {
          timeout = setTimeout(() => resolve(false), options.timeoutMs ?? 5_000);
        }),
      ]);
    } catch {
      healthy = false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    if (stopped) return;
    if (healthy !== previous) {
      previous = healthy;
      if (healthy) available();
      else unavailable('Gateway approval availability is absent, expired, or unhealthy');
    }
    timer = setTimeout(() => void check(), options.intervalMs ?? 1_000);
    timer.unref();
  };
  await check();
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
