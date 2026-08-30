import { EventEmitter } from 'node:events';

import { describe, expect, it, vi } from 'vitest';

import type { ResolvedPostgresConfig } from './config.js';
import { PostgresDriver } from './index.js';

interface FakeClient extends EventEmitter {
  query: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>;
}

interface DriverInternals {
  pool: {
    connect: ReturnType<typeof vi.fn>;
    end: ReturnType<typeof vi.fn>;
  };
  configuredClients: WeakSet<object>;
  hostLockClient: FakeClient | null;
  hostLockErrorHandler: ((error: Error) => void) | null;
}

function fakeClient(query: FakeClient['query']): FakeClient {
  const client = new EventEmitter() as FakeClient;
  client.query = query;
  client.release = vi.fn();
  return client;
}

function internals(driver: PostgresDriver): DriverInternals {
  return driver as unknown as DriverInternals;
}

function driverWithClient(client: FakeClient): PostgresDriver {
  const config: ResolvedPostgresConfig = {
    pool: { connectionString: 'postgres://unused@localhost/nanoclaw_test' },
    schema: 'nanoclaw',
    statementTimeoutMs: 30_000,
    role: 'test',
    hostLock: false,
    readonly: false,
  };
  const driver = Reflect.construct(PostgresDriver, [config, 25]) as PostgresDriver;
  internals(driver).pool = {
    connect: vi.fn().mockResolvedValue(client),
    end: vi.fn().mockResolvedValue(undefined),
  };
  internals(driver).configuredClients.add(client);
  return driver;
}

describe('PostgresDriver connection lifecycle', () => {
  it('destroys and releases a client when BEGIN fails', async () => {
    const beginError = new Error('BEGIN connection failure');
    const client = fakeClient(vi.fn().mockRejectedValueOnce(beginError));
    const driver = driverWithClient(client);

    await expect(driver.transaction(async () => undefined)).rejects.toBe(beginError);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('preserves the callback error and destroys the client when ROLLBACK fails', async () => {
    const original = Object.assign(new Error('unique violation'), { code: '23505' });
    const rollbackError = new Error('ROLLBACK connection failure');
    const client = fakeClient(
      vi.fn(async (sql: string) => {
        if (sql === 'ROLLBACK') throw rollbackError;
        return { rows: [], rowCount: 0 };
      }),
    );
    const driver = driverWithClient(client);

    await expect(
      driver.transaction(async () => {
        throw original;
      }),
    ).rejects.toBe(original);
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('keeps the reserved-client error listener installed through explicit unlock', async () => {
    let listenerWasInstalled = false;
    const client = fakeClient(
      vi.fn(async () => {
        listenerWasInstalled = client.listenerCount('error') > 0;
        return { rows: [{ unlocked: true }], rowCount: 1 };
      }),
    );
    const driver = driverWithClient(client);
    const errorHandler = vi.fn();
    client.on('error', errorHandler);
    internals(driver).hostLockClient = client;
    internals(driver).hostLockErrorHandler = errorHandler;

    await driver.close();

    expect(listenerWasInstalled).toBe(true);
  });
});
