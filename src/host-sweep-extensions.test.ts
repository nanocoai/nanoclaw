import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';

import {
  registerDueMessageGate,
  runDueMessageGates,
  registerRecurrenceTzResolver,
  getRecurrenceTzResolverFor,
} from './host-sweep-extensions.js';

// These registries are module-level singletons, so the order of the cases below matters:
// the inert-on-pristine assertions run FIRST, before anything registers into them.

describe('host-sweep extensions', () => {
  it('is inert by default (no registrations)', () => {
    const db = new Database(':memory:');
    // No gate registered ⇒ no-op, no throw, no DB access required.
    expect(() => runDueMessageGates(db, 'group-a')).not.toThrow();
    // No resolver factory ⇒ undefined ⇒ handleRecurrence falls back to the global TIMEZONE.
    expect(getRecurrenceTzResolverFor('group-a')).toBeUndefined();
    db.close();
  });

  it('rolls back a gate that writes rows then throws (fail-open = as if it never ran)', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE messages_in (id TEXT PRIMARY KEY, status TEXT)');
    db.prepare("INSERT INTO messages_in VALUES ('m1', 'pending')").run();

    // A gate that "suppresses" m1 then throws BEFORE finishing must not leave the write behind —
    // otherwise the partial mutation could still drop m1 out of the due count.
    registerDueMessageGate((inDb) => {
      inDb.prepare("UPDATE messages_in SET status = 'completed' WHERE id = 'm1'").run();
      throw new Error('gate boom');
    });

    expect(() => runDueMessageGates(db, 'group-a')).not.toThrow();
    const row = db.prepare("SELECT status FROM messages_in WHERE id = 'm1'").get() as { status: string };
    expect(row.status).toBe('pending'); // rolled back
    db.close();
  });

  it('isolates the resolver factory: a working factory is used, a throwing one falls back to undefined', () => {
    registerRecurrenceTzResolver(() => () => 'America/Sao_Paulo');
    const resolver = getRecurrenceTzResolverFor('group-a');
    expect(resolver?.({ kind: 'chat', content: '{}' })).toBe('America/Sao_Paulo');

    // A factory that throws must not propagate (it runs inline in the sweep's handleRecurrence call).
    registerRecurrenceTzResolver(() => {
      throw new Error('factory boom');
    });
    expect(getRecurrenceTzResolverFor('group-a')).toBeUndefined();
  });
});
