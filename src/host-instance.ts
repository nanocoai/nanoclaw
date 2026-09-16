/**
 * Durable host-instance lease.
 *
 * The host registers itself in `host_instances` at startup and renews its
 * lease on an interval, so restarts and overlapping instances become
 * observable durable facts instead of invisible process state (today the
 * only trace of "which host is running" is the process itself). Write-only
 * shadow state: nothing may read these rows to make decisions yet.
 */
import { randomUUID } from 'crypto';
import os from 'os';

import { INSTALL_SLUG } from './config.js';
import { markHostInstanceStopped, registerHostInstance, renewHostInstanceLease } from './db/coordination.js';
import { log } from './log.js';

const RENEW_INTERVAL_MS = 30_000;
// TTL is 3× the renewal interval: two consecutive renewals can fail (slow
// disk, transient DB contention) before the row reads as expired.
const LEASE_TTL_MS = 90_000;

let instanceId: string | null = null;
let renewTimer: NodeJS.Timeout | null = null;

/** The running host's instance id, or null before start / after stop. */
export function getHostInstanceId(): string | null {
  return instanceId;
}

export interface HostInstanceLeaseOptions {
  renewIntervalMs?: number;
  leaseTtlMs?: number;
}

export async function startHostInstanceLease(options: HostInstanceLeaseOptions = {}): Promise<string> {
  if (instanceId) throw new Error('host instance lease already started');
  const renewIntervalMs = options.renewIntervalMs ?? RENEW_INTERVAL_MS;
  const leaseTtlMs = options.leaseTtlMs ?? LEASE_TTL_MS;

  const id = randomUUID();
  await registerHostInstance({
    instanceId: id,
    installId: INSTALL_SLUG,
    hostname: os.hostname(),
    pid: process.pid,
    now: new Date().toISOString(),
    leaseExpiresAt: new Date(Date.now() + leaseTtlMs).toISOString(),
  });
  instanceId = id;

  renewTimer = setInterval(() => {
    void renewLease(id, leaseTtlMs);
  }, renewIntervalMs);
  // The renewal timer must never keep an otherwise-finished process alive.
  renewTimer.unref?.();
  return id;
}

async function renewLease(id: string, leaseTtlMs: number): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- lease writes are shadow state; a failed renewal must never affect the host */
  try {
    const renewed = await renewHostInstanceLease(id, new Date(Date.now() + leaseTtlMs).toISOString());
    if (!renewed) log.warn('Host instance lease row missing on renewal', { instanceId: id });
  } catch (err) {
    log.warn('Host instance lease renewal failed', { instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

export async function stopHostInstanceLease(): Promise<void> {
  if (renewTimer) {
    clearInterval(renewTimer);
    renewTimer = null;
  }
  const id = instanceId;
  instanceId = null;
  if (!id) return;
  /* eslint-disable no-catch-all/no-catch-all -- graceful shutdown must proceed even if the stop stamp cannot be written */
  try {
    await markHostInstanceStopped(id, new Date().toISOString());
  } catch (err) {
    log.warn('Failed to mark host instance stopped', { instanceId: id, err });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
