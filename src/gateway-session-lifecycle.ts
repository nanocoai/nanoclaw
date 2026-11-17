import type { GatewaySessionLease, GatewaySessionRelease } from './gateway-providers/index.js';

export interface GatewaySessionControl {
  lease: GatewaySessionLease;
  controller: AbortController;
  releasing?: Promise<void>;
}

/** One awaited release, including when shutdown races a terminal event. */
export function releaseGatewaySession(control: GatewaySessionControl, event: GatewaySessionRelease): Promise<void> {
  if (!control.releasing) {
    // Queue cleanup so the promise is installed before synchronous abort listeners run.
    control.releasing = Promise.resolve().then(async () => {
      control.controller.abort(event.reason);
      await control.lease.release?.(event);
    });
  }
  return control.releasing;
}
