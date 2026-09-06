import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { startPortalRuntime } from '../../../setup/portal-runtime.mjs';

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
