/**
 * Community portal module — keeps the host connected to its account cell.
 *
 * Optional tier. Does nothing until the setup wizard has signed this checkout
 * in at the portal (data/community-portal.json). Registers the runtime with
 * the host lifecycle so perk changes made in the browser reach the running
 * host, and the saved Slack install worker is resumed after a restart.
 */
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { startPortalRuntime } from './runtime.js';

let runtime: ReturnType<typeof startPortalRuntime> | undefined;

onHostStart(({ signal }) => {
  runtime = startPortalRuntime({
    signal,
    log: (event) => log.info('Community portal', event),
  });
});

onHostShutdown(async () => {
  await runtime?.stop();
  runtime = undefined;
});
