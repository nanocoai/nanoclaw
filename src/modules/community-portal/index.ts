/**
 * Community portal module — keeps the host connected to its account cell.
 *
 * Optional tier. Does nothing until the setup wizard has signed this checkout
 * in at the portal (data/community-portal.json). Registers the runtime with
 * the host lifecycle so perk changes made in the browser reach the running
 * host, and the saved Slack install worker is resumed after a restart.
 *
 * The module also carries the remote terminal (door/): an in-process SSH
 * server on loopback that lands an approved key in a code-mode sandbox,
 * with its `ncl sandboxes remote …` verbs. It is off until an operator
 * enables it, and needs no sign-in to work on loopback.
 */
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { startPortalRuntime } from './runtime.js';
// The door registers its host lifecycle; the verbs extend `ncl sandboxes`;
// the address registration listens on the sandbox lifecycle.
import './door/index.js';
import './door/verbs.js';
import './remote/index.js';

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
