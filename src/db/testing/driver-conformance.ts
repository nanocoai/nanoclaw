import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { DbDriver } from '../driver.js';

export interface DriverConformanceFactory {
  create(options?: { watchdogMs?: number }): Promise<DbDriver> | DbDriver;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Shared contract that every central DB backend must pass. */
export function defineDriverConformance(name: string, factory: DriverConformanceFactory): void {
  describe(`${name} central DB driver conformance`, () => {
    let db: DbDriver;

    beforeEach(async () => {
      db = await factory.create();
      await db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT, n INTEGER NOT NULL)');
    });

    afterEach(async () => {
      await db.close();
    });

    it('supports positional and named parameters', async () => {
      await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'positional', 'first', 1);
      await db.run('INSERT INTO items (id, value, n) VALUES (@id, @value, @n)', {
        id: 'named',
        value: 'second',
        n: 2,
        unused: 'ignored',
      });

      expect(await db.all('SELECT id, value, n FROM items ORDER BY n')).toEqual([
        { id: 'positional', value: 'first', n: 1 },
        { id: 'named', value: 'second', n: 2 },
      ]);
    });

    it('reports changed rows', async () => {
      expect((await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'one', null, 1)).changes).toBe(1);
      expect((await db.run('UPDATE items SET value = ? WHERE id = ?', 'set', 'one')).changes).toBe(1);
      expect((await db.run('DELETE FROM items WHERE id = ?', 'missing')).changes).toBe(0);
    });

    it('commits, rolls back, and uses nested savepoints', async () => {
      await db.transaction(async () => {
        await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'outer', null, 1);
        await expect(
          db.transaction(async () => {
            await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'inner-rollback', null, 2);
            throw new Error('inner failure');
          }),
        ).rejects.toThrow('inner failure');
        await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'after-savepoint', null, 3);
      });
      await expect(
        db.transaction(async () => {
          await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'outer-rollback', null, 4);
          throw new Error('outer failure');
        }),
      ).rejects.toThrow('outer failure');

      expect(await db.all<{ id: string }>('SELECT id FROM items ORDER BY n')).toEqual([
        { id: 'outer' },
        { id: 'after-savepoint' },
      ]);
    });

    it('executes compound SQL and reports table existence', async () => {
      expect(await db.hasTable('extra')).toBe(false);
      await db.exec("CREATE TABLE extra (id TEXT PRIMARY KEY); INSERT INTO extra (id) VALUES ('x');");
      expect(await db.hasTable('extra')).toBe(true);
      expect(await db.get('SELECT id FROM extra')).toEqual({ id: 'x' });
    });

    it('returns numeric aggregates and deterministic C-style ordering', async () => {
      for (const [id, value, n] of [
        ['null', null, 1],
        ['upper', 'B', 2],
        ['lower', 'a', 3],
      ] as const) {
        await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', id, value, n);
      }
      expect(await db.get('SELECT COUNT(*) AS n FROM items')).toEqual({ n: 3 });
      expect(await db.all<{ value: string | null }>('SELECT value FROM items ORDER BY (value IS NULL), value')).toEqual(
        [{ value: 'B' }, { value: 'a' }, { value: null }],
      );
    });

    it('compares ISO timestamps lexically and returns truthy SELECT 1 rows', async () => {
      await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'earlier', '2026-01-01T00:00:00.000Z', 1);
      await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'later', '2026-01-02T00:00:00.000Z', 2);
      expect(
        await db.all<{ id: string }>('SELECT id FROM items WHERE value > ? ORDER BY value', '2026-01-01T12:00:00.000Z'),
      ).toEqual([{ id: 'later' }]);
      expect(await db.get('SELECT 1 AS present')).toEqual({ present: 1 });
    });

    it('rejects continuations that escape their transaction callback', async () => {
      const resume = deferred();
      let escaped!: Promise<unknown>;
      await db.transaction(async () => {
        escaped = resume.promise.then(() => db.get('SELECT 1 AS present'));
      });
      resume.resolve();
      await expect(escaped).rejects.toThrow('transaction scope is closed');
    });

    it('watchdog rolls back and releases an outside waiter', async () => {
      await db.close();
      db = await factory.create({ watchdogMs: 25 });
      await db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT, n INTEGER NOT NULL)');
      const release = deferred();
      const timedOut = db.transaction(async () => {
        await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'timed-out', null, 1);
        await release.promise;
      });
      const waiting = db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'after', null, 2);

      await expect(timedOut).rejects.toThrow('watchdog');
      await waiting;
      release.resolve();
      expect(await db.all<{ id: string }>('SELECT id FROM items')).toEqual([{ id: 'after' }]);
    });

    it('cannot let a timed-out nested continuation roll back the next transaction', async () => {
      await db.close();
      db = await factory.create({ watchdogMs: 25 });
      await db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, value TEXT, n INTEGER NOT NULL)');
      const releaseStale = deferred();
      const staleFinished = deferred();
      const currentSavepointReady = deferred();
      const finishCurrent = deferred();

      const timedOut = db.transaction(async () => {
        try {
          await db.transaction(async () => {
            await releaseStale.promise;
          });
        } finally {
          staleFinished.resolve();
        }
      });
      await expect(timedOut).rejects.toThrow('watchdog');

      const current = db.transaction(async () => {
        await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'current-outer', null, 1);
        await db.transaction(async () => {
          await db.run('INSERT INTO items (id, value, n) VALUES (?, ?, ?)', 'current-inner', null, 2);
          currentSavepointReady.resolve();
          await finishCurrent.promise;
        });
      });
      await currentSavepointReady.promise;
      releaseStale.resolve();
      await staleFinished.promise;
      finishCurrent.resolve();

      await expect(current).resolves.toBeUndefined();
      expect(await db.all<{ id: string }>('SELECT id FROM items ORDER BY n')).toEqual([
        { id: 'current-outer' },
        { id: 'current-inner' },
      ]);
    });
  });
}
