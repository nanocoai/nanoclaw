import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { SqliteDriver } from './sqlite.js';

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('SqliteDriver transactions', () => {
  let driver: SqliteDriver;

  beforeEach(async () => {
    driver = new SqliteDriver(new Database(':memory:'), 25);
    await driver.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
  });

  afterEach(async () => {
    await driver.close();
  });

  it('commits successful callbacks and rolls back failed callbacks', async () => {
    await driver.transaction(async () => {
      await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'committed', 'yes');
    });

    await expect(
      driver.transaction(async () => {
        await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'rolled-back', 'no');
        throw new Error('abort');
      }),
    ).rejects.toThrow('abort');

    expect(await driver.all<{ id: string }>('SELECT id FROM items ORDER BY id')).toEqual([{ id: 'committed' }]);
  });

  it('uses savepoints for nested transactions', async () => {
    await driver.transaction(async () => {
      await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'outer-before', 'yes');
      await expect(
        driver.transaction(async () => {
          await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'inner', 'no');
          throw new Error('rollback savepoint');
        }),
      ).rejects.toThrow('rollback savepoint');
      await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'outer-after', 'yes');
    });

    expect(await driver.all<{ id: string }>('SELECT id FROM items ORDER BY id')).toEqual([
      { id: 'outer-after' },
      { id: 'outer-before' },
    ]);
  });

  it('rolls back nested success when the outer transaction fails', async () => {
    await expect(
      driver.transaction(async () => {
        await driver.transaction(async () => {
          await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'inner', 'temporary');
        });
        throw new Error('outer abort');
      }),
    ).rejects.toThrow('outer abort');

    expect(await driver.all('SELECT id FROM items')).toEqual([]);
  });

  it('makes outside statements wait for the active transaction', async () => {
    const started = deferred();
    const release = deferred();
    const events: string[] = [];

    const transaction = driver.transaction(async () => {
      await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'inside', 'first');
      events.push('transaction-started');
      started.resolve();
      await release.promise;
      events.push('transaction-ending');
    });
    await started.promise;

    const outside = driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'outside', 'second').then(() => {
      events.push('outside-finished');
    });
    await Promise.resolve();
    expect(events).toEqual(['transaction-started']);

    release.resolve();
    await transaction;
    await outside;
    expect(events).toEqual(['transaction-started', 'transaction-ending', 'outside-finished']);
  });

  it('rejects a continuation that escapes its transaction callback', async () => {
    const resume = deferred();
    let escaped!: Promise<unknown>;

    await driver.transaction(async () => {
      escaped = resume.promise.then(() => driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'late', 'no'));
    });
    resume.resolve();

    await expect(escaped).rejects.toThrow('transaction scope is closed');
    expect(await driver.all('SELECT id FROM items')).toEqual([]);
  });

  it('watchdog timeout rolls back and releases waiting statements', async () => {
    const release = deferred();
    const timedOut = driver.transaction(async () => {
      await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'timed-out', 'no');
      await release.promise;
    });
    const waiting = driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'after-timeout', 'yes');

    await expect(timedOut).rejects.toThrow('exceeded 25ms watchdog');
    await waiting;
    release.resolve();

    expect(await driver.all<{ id: string }>('SELECT id FROM items ORDER BY id')).toEqual([{ id: 'after-timeout' }]);
  });

  it('watchdog breaks a nested cross-context transaction wait', async () => {
    const startOutside = deferred();
    // Register this continuation outside the transaction scope. Once released,
    // it competes for the driver mutex rather than inheriting the outer scope.
    const outside = startOutside.promise.then(() =>
      driver.transaction(async () => {
        await driver.run('INSERT INTO items (id, value) VALUES (?, ?)', 'outside-after-watchdog', 'yes');
      }),
    );

    const deadlocked = driver.transaction(async () => {
      startOutside.resolve();
      await outside;
    });

    await expect(deadlocked).rejects.toThrow('exceeded 25ms watchdog');
    await outside;
    expect(await driver.all<{ id: string }>('SELECT id FROM items')).toEqual([{ id: 'outside-after-watchdog' }]);
  });

  it('rejects access after close', async () => {
    await driver.close();
    await expect(driver.get('SELECT 1')).rejects.toThrow('driver is closed');
  });

  it('discovers tables that own a column', async () => {
    await driver.exec('CREATE TABLE other (id TEXT PRIMARY KEY, value TEXT NOT NULL)');
    await expect(driver.columnOwners('value')).resolves.toEqual(['items', 'other']);
  });
});
