/**
 * Host-sweep extension contracts (ADR 0006 host-sweep contract) — INERT with no registrant.
 *
 * Two generic hooks consumed by `src/host-sweep.ts`. With no modules registered
 * (upstream default), both are no-ops: `runDueMessageGates` does nothing and
 * `getRecurrenceTzResolverFor` returns undefined (so every recurring row falls back
 * to the global TIMEZONE inside handleRecurrence). A downstream install-overlay
 * registers into these from its own host-sweep registration module.
 *
 * Keep this file dependency-light (only `log.js`). It must not import from
 * modules/* or index.ts (registry-before-registration ordering + no cycles).
 */
import type Database from 'better-sqlite3';

import { log } from './log.js';

/**
 * A pre-wake gate over a session's inbound DB. Runs in the sweep BEFORE the
 * due-message wake; may mark due rows completed so they drop out of the due
 * count (and get advanced by the recurrence fanout). Receives the session's
 * inbound DB handle and the agent group's folder.
 */
export type DueMessageGate = (inDb: Database.Database, agentGroupFolder: string) => void;

const dueMessageGates: DueMessageGate[] = [];

export function registerDueMessageGate(gate: DueMessageGate): void {
  dueMessageGates.push(gate);
}

/**
 * Run all registered due-message gates for a session. Each gate is fail-isolated:
 * a throwing gate is logged and skipped so it can never break the sweep tick
 * (preserves the existing fail-open guarantee — registered gates are also
 * expected to be internally fail-open). No-op with no registrant (no gates).
 */
export function runDueMessageGates(inDb: Database.Database, agentGroupFolder: string): void {
  for (const gate of dueMessageGates) {
    try {
      // Per-gate transaction: a gate that writes rows then throws must not leave PARTIAL
      // mutations behind — those could still drop rows out of dueCount or mis-trigger the
      // recurrence fanout. The throw rolls the gate's writes back, so fail-open means "as if the
      // gate never ran", not "ran halfway". (better-sqlite3 nests via SAVEPOINT if a gate opens
      // its own transaction.)
      inDb.transaction(() => gate(inDb, agentGroupFolder))();
    } catch (err) {
      log.warn('Due-message gate threw (rolled back, fail-open)', { agentGroupFolder, err });
    }
  }
}

/**
 * Per-row timezone resolver — structurally compatible with scheduling's
 * `RowTimezoneResolver` (it receives the full RecurringMessage, of which only
 * `kind` + `content` are read here). Returns a zone string to interpret the
 * row's cron in, or undefined to fall back to the global TIMEZONE.
 */
export type RowTimezoneResolver = (msg: { kind: string; content: string }) => string | undefined;

/**
 * Factory producing a per-session resolver. The factory is called once per
 * session per tick so the resolver can memoize an expensive per-group lookup
 * across that session's recurring rows.
 */
export type RecurrenceTzResolverFactory = (agentGroupFolder: string) => RowTimezoneResolver;

let recurrenceTzResolverFactory: RecurrenceTzResolverFactory | null = null;

export function registerRecurrenceTzResolver(factory: RecurrenceTzResolverFactory): void {
  if (recurrenceTzResolverFactory) {
    log.warn('Recurrence timezone resolver overwritten');
  }
  recurrenceTzResolverFactory = factory;
}

/**
 * Resolve the per-row timezone resolver for a session, or undefined when none is
 * registered (no registrant ⇒ handleRecurrence uses the global TIMEZONE for every
 * row). Returns a fresh resolver per call so per-session memoization stays scoped
 * to one tick.
 */
export function getRecurrenceTzResolverFor(agentGroupFolder: string): RowTimezoneResolver | undefined {
  if (!recurrenceTzResolverFactory) return undefined;
  try {
    return recurrenceTzResolverFactory(agentGroupFolder);
  } catch (err) {
    // A throwing factory must not abort the sweep's recurrence fanout (it runs inline in the
    // handleRecurrence call). Fall back to undefined ⇒ handleRecurrence uses the global TIMEZONE
    // for every row this tick.
    log.warn('Recurrence tz resolver factory threw (falling back to global TIMEZONE)', { agentGroupFolder, err });
    return undefined;
  }
}
