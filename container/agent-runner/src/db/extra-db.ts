/**
 * Generic "extra DB" registry (core extension contract 6 — ADR 0006).
 *
 * The session two-DB layer (inbound.db / outbound.db) is upstream and fixed.
 * Install-overlays that need a THIRD SQLite file mounted into
 * the container register a descriptor here instead of hard-coding a new
 * singleton into connection.ts. Core ships this registry INERT: with no
 * registrations it does nothing and the default two-DB layer is unchanged.
 *
 * Mirrors the host-side name-keyed registry pattern (registerMigration,
 * registerDeliveryAction). A descriptor owns its default mount path and its
 * own pragma application so each overlay can preserve its load-bearing
 * cross-mount invariants (e.g. journal_mode=DELETE) without leaking them into
 * core.
 *
 * Singleton lifecycle (lazy open, init-with-path override, close) is provided
 * generically so overlays don't re-implement it per DB.
 */
import { Database } from 'bun:sqlite';

export interface ExtraDbDescriptor {
  /** Stable key, e.g. 'extra'. Used by getExtraDb/initExtraDb/closeExtraDb. */
  name: string;
  /** Fixed container mount path used by getExtraDb() when no init path was given. */
  defaultPath: string;
  /** Apply connection pragmas. Called on every open (default mount, init path,
   *  and :memory: test DB). The descriptor is the sole owner of its pragmas so
   *  cross-mount invariants stay with the overlay, not core. */
  applyPragmas(db: Database): void;
}

const _descriptors = new Map<string, ExtraDbDescriptor>();
const _open = new Map<string, Database>();

/** Register an extra-DB descriptor. Idempotent per name (last write wins is
 *  rejected — a duplicate name throws, matching the migration registry). */
export function registerExtraDb(desc: ExtraDbDescriptor): void {
  if (_descriptors.has(desc.name)) {
    throw new Error(`extra-db: descriptor '${desc.name}' already registered`);
  }
  _descriptors.set(desc.name, desc);
}

function descriptor(name: string): ExtraDbDescriptor {
  const d = _descriptors.get(name);
  if (!d) throw new Error(`extra-db: no descriptor registered for '${name}'`);
  return d;
}

/** Lazily open (or return) the singleton for `name` at its default mount path. */
export function getExtraDb(name: string): Database {
  let db = _open.get(name);
  if (!db) {
    const d = descriptor(name);
    db = new Database(d.defaultPath);
    d.applyPragmas(db);
    _open.set(name, db);
  }
  return db;
}

/** Open the extra DB at a caller-supplied path, replacing any current
 *  singleton. Mirrors initOutboundDb — used by subprocess
 *  entrypoints that receive an explicit --db path. */
export function initExtraDb(name: string, path: string): Database {
  _open.get(name)?.close();
  const d = descriptor(name);
  const db = new Database(path);
  d.applyPragmas(db);
  _open.set(name, db);
  return db;
}

/** Open an in-memory extra DB for tests. Pragmas are applied; schema is the
 *  caller's responsibility. */
export function initTestExtraDb(name: string): Database {
  _open.get(name)?.close();
  const d = descriptor(name);
  const db = new Database(':memory:');
  d.applyPragmas(db);
  _open.set(name, db);
  return db;
}

/** Close + drop the singleton for `name`. */
export function closeExtraDb(name: string): void {
  _open.get(name)?.close();
  _open.delete(name);
}
