/**
 * Host-side task-script sanitizer registry (ADR 0006 contract #5).
 *
 * `schedule_task` / `update_task` can persist a shell `script` that the
 * scheduled-runner later executes. A downstream install-overlay may
 * need to strip that script for certain sessions as a host-side
 * defense-in-depth layer (e.g. a confined session must never persist a script —
 * the container MCP gate + execution gate are the primary controls, this is the
 * host leg of the same confinement). Instead of editing `scheduling/actions.ts`
 * inline, the overlay registers a sanitizer here.
 *
 * Core ships with NO sanitizer registered: `sanitizeTaskScript` is the identity
 * (returns the script verbatim), so with no registrant scripts persist unchanged.
 *
 * FAIL-CLOSED (security invariant, enforced by core — NOT by the sanitizer): if
 * a registered sanitizer THROWS, `sanitizeTaskScript` strips the script to
 * `null` rather than persisting the original. A sanitizer is downstream code treated
 * as untrusted by the core merge — a buggy/hostile sanitizer that throws must
 * never let an unsanitized script through. (A sanitizer that deliberately
 * returns a value is trusted to return the correct value.)
 */
import { log } from './log.js';
import type { Session } from './types.js';

export type TaskScriptSanitizer = (session: Session, script: string | null) => string | null;

let sanitizer: TaskScriptSanitizer | null = null;

export function registerTaskScriptSanitizer(fn: TaskScriptSanitizer): void {
  if (sanitizer) {
    throw new Error('Task-script sanitizer already registered');
  }
  sanitizer = fn;
}

/**
 * Apply the registered sanitizer to a task script. Returns the script unchanged
 * when no sanitizer is registered. On a sanitizer throw, FAILS
 * CLOSED: strips the script to `null`.
 */
export function sanitizeTaskScript(session: Session, script: string | null): string | null {
  if (!sanitizer) return script;
  try {
    return sanitizer(session, script);
  } catch (err) {
    log.warn('Task-script sanitizer threw — stripping script (fail-closed)', {
      agentGroupId: session.agent_group_id,
      err,
    });
    return null;
  }
}
