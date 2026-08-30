/**
 * Post-write audit hooks — the in-process extension seam.
 *
 * A hook observes the audit LOG, not the event stream: `onEvent` fires only
 * after an event has been committed to the PostgreSQL outbox, so anything
 * a hook exports is guaranteed to exist in the source of truth
 * (exported ⊆ written). If the local append fails, hooks are not called —
 * and a hook that misses events (crash, restart) catches up from the durable
 * PostgreSQL acknowledgement cursor.
 *
 * Registration follows the tree's observer idiom (registerApprovalResolvedHandler,
 * registerResponseHandler, …): an in-tree or skill-installed module calls
 * `registerAuditHook(...)` at import time — no core edits, and credentials or
 * transport for an external system live in that module, never here.
 */
import { log } from '../log.js';
import type { AuditEvent } from './types.js';

export interface AuditHook {
  /** Short identifier used in logs and lifecycle errors. */
  name: string;
  /**
   * Called after a successful local append. `line` is the exact stored bytes
   * (canonical JSON, no trailing newline); `event` is the parsed record.
   * MUST be fast and non-blocking — this runs on the audited action's call
   * path. A real exporter buffers here and does its IO from `maintain`/its own
   * timers. Throwing is tolerated: isolated and logged, never propagated.
   */
  onEvent(event: AuditEvent, line: string): void;
  /**
   * One-time setup, called once when audit is enabled — at boot if the hook is
   * already registered, else immediately on registration (so it fires exactly
   * once regardless of import order). Failures are logged and isolated.
   */
  init?(): void;
  /** Periodic maintenance — called from the audit maintenance timer (enabled boxes only). */
  maintain?(): void;
  /** Graceful-shutdown hook (flush buffers, close handles). */
  shutdown?(): void | Promise<void>;
}

const hooks: AuditHook[] = [];
let hooksInitialized = false;

export function registerAuditHook(hook: AuditHook): void {
  hooks.push(hook);
  // onEvent/maintain/shutdown all read the live array, so they pick a hook up
  // whenever it registers. init() is the exception — it runs once at boot. If
  // boot already ran (a hook whose module loaded after the CLI audit adapter),
  // run its init() now; otherwise it would receive events but never its boot
  // hook. Initialization remains fail-open just like later lifecycle calls.
  if (hooksInitialized) initOneHook(hook);
}

/** Fan out one written event to every hook, isolating failures per hook. */
export function notifyAuditHooks(event: AuditEvent, line: string): void {
  for (const hook of hooks) {
    try {
      hook.onEvent(event, line);
      // eslint-disable-next-line no-catch-all/no-catch-all -- isolation is the contract: one bad hook must not affect the log, other hooks, or the audited action
    } catch (err) {
      log.error('Audit hook threw — event is safely in the log', {
        hook: hook.name,
        eventType: event.event_type,
        action: event.dimensions.action,
        err,
      });
    }
  }
}

/** Boot lifecycle. Hook setup failures never block the host. */
export function initAuditHooks(): void {
  for (const hook of hooks) initOneHook(hook);
  hooksInitialized = true;
}

/**
 * Run one hook's boot init inside the reporting fail-open boundary. Shared by the boot
 * sweep and by a post-boot registration, so every hook gets exactly one init()
 * regardless of the import order its module loaded in.
 */
function initOneHook(hook: AuditHook): void {
  try {
    hook.init?.();
  } catch (err) {
    log.error('Audit hook initialization failed; local append and host requests remain active', {
      hook: hook.name,
      err,
    });
  }
}

/** Periodic lifecycle — maintenance, isolated per hook. */
export function maintainAuditHooks(): void {
  for (const hook of hooks) {
    try {
      hook.maintain?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- one hook's maintenance failure must not stop the others (or the timer)
    } catch (err) {
      log.error('Audit hook maintenance failed', { hook: hook.name, err });
    }
  }
}

/** Shutdown lifecycle — awaited by the host's graceful shutdown. */
export async function shutdownAuditHooks(): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook.shutdown?.();
      // eslint-disable-next-line no-catch-all/no-catch-all -- shutdown must drain every hook even when one throws
    } catch (err) {
      log.error('Audit hook shutdown failed', { hook: hook.name, err });
    }
  }
}
