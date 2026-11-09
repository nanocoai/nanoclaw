import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { getDb, initSqliteTestDb, closeDb, runMigrations } from './db/index.js';
import type { HostInstanceRow } from './db/coordination.js';
import { getHostInstanceId, startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';

async function row(instanceId: string): Promise<HostInstanceRow | undefined> {
  return getDb().get<HostInstanceRow>('SELECT * FROM host_instances WHERE instance_id = ?', instanceId);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(async () => {
  const db = await initSqliteTestDb();
  await runMigrations(db);
});

afterEach(async () => {
  await stopHostInstanceLease();
  await closeDb();
});

describe('host instance lease', () => {
  it('registers on start, renews on the interval, stamps stop on shutdown', async () => {
    const id = await startHostInstanceLease({ renewIntervalMs: 25, leaseTtlMs: 200 });
    expect(getHostInstanceId()).toBe(id);

    const registered = await row(id);
    expect(registered).toBeDefined();
    expect(registered?.pid).toBe(process.pid);
    expect(registered?.stopped_at).toBeNull();

    // At least one renewal fires and pushes the lease expiry forward.
    const before = registered!.lease_expires_at;
    await sleep(80);
    const renewed = await row(id);
    expect(renewed!.lease_expires_at > before).toBe(true);

    await stopHostInstanceLease();
    expect(getHostInstanceId()).toBeNull();
    expect((await row(id))?.stopped_at).not.toBeNull();
  });

  it('refuses a second concurrent start', async () => {
    await startHostInstanceLease({ renewIntervalMs: 1_000 });
    await expect(startHostInstanceLease()).rejects.toThrow(/already started/);
  });

  it('can start again after a stop (restart shape)', async () => {
    const first = await startHostInstanceLease({ renewIntervalMs: 1_000 });
    await stopHostInstanceLease();
    const second = await startHostInstanceLease({ renewIntervalMs: 1_000 });
    expect(second).not.toBe(first);
    expect((await row(second))?.stopped_at).toBeNull();
  });
});
