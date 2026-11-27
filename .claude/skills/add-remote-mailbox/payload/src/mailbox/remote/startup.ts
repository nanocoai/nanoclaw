/**
 * The host's one remote mailbox service. Started by the remote-mailbox session
 * driver's `ensureReady()` — host startup calls it before adopting running
 * containers, which may already be retrying against the port. Once listening
 * it registers its own graceful-shutdown callback; nothing registers at import.
 *
 * Under egress lockdown the service is reachable from the locked network only
 * through the mailbox forwarder (forwarder.ts), established right after the
 * service listens. If it cannot be, the service is stopped and startup fails:
 * listed groups must never be left unable to reach their mailbox.
 */
import { CONTAINER_IMAGE, EGRESS_LOCKDOWN, EGRESS_NETWORK, INSTALL_SLUG } from '../../config.js';
import { onHostShutdown } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { MAILBOX_PORT } from './config.js';
import { ensureMailboxForwarder } from './forwarder.js';
import { remoteMailboxEnabled } from './spawn.js';
import { startRemoteMailboxService } from './service.js';
import type { RemoteMailboxService } from './service.js';

export type { RemoteMailboxService };

let running: Promise<RemoteMailboxService | undefined> | undefined;
let shutdownRegistered = false;

/** Start the service only when at least one agent group opted in; otherwise do nothing. */
export async function startRemoteMailboxServiceIfEnabled(port: number): Promise<RemoteMailboxService | undefined> {
  const forwarder = {
    installSlug: INSTALL_SLUG,
    port,
    image: CONTAINER_IMAGE,
    network: EGRESS_NETWORK,
    lockdown: EGRESS_LOCKDOWN,
  };
  if (!remoteMailboxEnabled()) {
    ensureMailboxForwarder({ ...forwarder, enabled: false });
    return undefined;
  }
  const service = await startRemoteMailboxService({ port });
  log.info('Remote mailbox service listening', { port: service.port });
  try {
    ensureMailboxForwarder({ ...forwarder, enabled: true });
  } catch (err) {
    await service.stop().catch(() => {});
    throw err;
  }
  return service;
}

/** Idempotent: the first call starts the service (when enabled); later calls share it. A failed start can be retried. */
export function ensureRemoteMailboxService(port: number = MAILBOX_PORT): Promise<RemoteMailboxService | undefined> {
  if (!running) {
    running = startRemoteMailboxServiceIfEnabled(port).then((service) => {
      if (service && !shutdownRegistered) {
        shutdownRegistered = true;
        onHostShutdown(stopRemoteMailboxService);
      }
      return service;
    });
    running.catch(() => {
      running = undefined;
    });
  }
  return running;
}

/** Whether the service was started in this process. */
export function remoteMailboxServiceStarted(): boolean {
  return running !== undefined;
}

export async function stopRemoteMailboxService(): Promise<void> {
  const current = running;
  running = undefined;
  const service = await current?.catch(() => undefined);
  await service?.stop();
}
