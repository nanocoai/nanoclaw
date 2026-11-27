/**
 * Regression test for #2390 — `genericCreate` must honor user-supplied
 * `--id <slug>` instead of silently overriding with `randomUUID()`.
 *
 * Help text advertises `--id (auto)` and callers pass explicit slugs as
 * the documented workaround for #2386 (OneCLI rejects raw UUIDs); before
 * this fix the user value was discarded.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = new Database(':memory:');
db.prepare(
  `CREATE TABLE widgets (
     id TEXT PRIMARY KEY,
     name TEXT NOT NULL,
     created_at TEXT NOT NULL
   )`,
).run();

vi.mock('../../db/connection.js', () => ({
  getDb: () => db,
}));

// Capture the handler registered by registerResource.
let createHandler: ((args: Record<string, unknown>) => Promise<unknown>) | undefined;
vi.mock('../registry.js', () => ({
  register: (cmd: { name: string; handler: (args: Record<string, unknown>) => Promise<unknown> }) => {
    if (cmd.name === 'widgets-create') createHandler = cmd.handler;
  },
}));

// Import AFTER mocks are in place so registerResource sees the mocked deps.
const { registerResource } = await import('../crud.js');

registerResource({
  name: 'widget',
  plural: 'widgets',
  table: 'widgets',
  description: 'Test resource for #2390.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Slug.', generated: true },
    { name: 'name', type: 'string', description: 'Display name.', required: true, updatable: true },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { create: 'open' },
});

beforeEach(() => {
  db.prepare('DELETE FROM widgets').run();
});

afterEach(() => {
  // no-op — table is reset in beforeEach
});

describe('genericCreate honors user-supplied --id (#2390)', () => {
  it('uses the supplied id when valid', async () => {
    expect(createHandler).toBeDefined();
    const result = (await createHandler!({ id: 'daily-os', name: 'Daily OS' })) as Record<string, unknown>;
    expect(result.id).toBe('daily-os');
    const row = db.prepare('SELECT id, name FROM widgets WHERE id = ?').get('daily-os') as
      | { id: string; name: string }
      | undefined;
    expect(row).toEqual({ id: 'daily-os', name: 'Daily OS' });
  });

  it('rejects invalid ids with a clear error', async () => {
    expect(createHandler).toBeDefined();
    await expect(createHandler!({ id: 'Bad ID!', name: 'x' })).rejects.toThrow(/--id must match/);
    // Numeric-leading, uppercase, and over-length must all be rejected.
    await expect(createHandler!({ id: '1abc', name: 'x' })).rejects.toThrow(/--id must match/);
    await expect(createHandler!({ id: 'A-cap', name: 'x' })).rejects.toThrow(/--id must match/);
    await expect(createHandler!({ id: 'a'.repeat(51), name: 'x' })).rejects.toThrow(/--id must match/);
    // None of the failed attempts should have written a row.
    const count = (db.prepare('SELECT COUNT(*) AS c FROM widgets').get() as { c: number }).c;
    expect(count).toBe(0);
  });

  it('auto-generates a UUID when --id is not supplied', async () => {
    expect(createHandler).toBeDefined();
    const result = (await createHandler!({ name: 'Auto' })) as Record<string, unknown>;
    // RFC-4122 UUID v4 shape — same as randomUUID() produces.
    expect(String(result.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    const row = db.prepare('SELECT id FROM widgets').get() as { id: string };
    expect(row.id).toBe(result.id);
  });

  it('treats empty --id as not supplied', async () => {
    expect(createHandler).toBeDefined();
    const result = (await createHandler!({ id: '', name: 'Empty' })) as Record<string, unknown>;
    expect(String(result.id)).toMatch(/^[0-9a-f]{8}-/);
  });
});
