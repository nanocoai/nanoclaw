/** Privacy-checked, awaited, fail-open emit seam for all host activity. */
import { randomUUID } from 'node:crypto';

import { log } from '../log.js';
import { AUDIT_ENABLED, AUDIT_HOST_ID } from './config.js';
import { buildHostAuditEventV1 } from './contract.js';
import { notifyAuditHooks } from './hooks.js';
import { pseudonymizeAuditInput } from './pseudonym.js';
import { appendAuditEvent } from './store.js';
import { auditStdout } from './stdout.js';
import type { AuditEvent, AuditEventInput } from './types.js';

let accepting = true;
let warnedAfterStop = false;
const pending = new Set<Promise<void>>();

async function writeEvent(input: AuditEventInput | (() => AuditEventInput)): Promise<void> {
  try {
    const resolved = pseudonymizeAuditInput(typeof input === 'function' ? input() : input);
    const occurredAt = new Date().toISOString();
    const eventId = randomUUID();
    const { event, line } = await appendAuditEvent((seq): AuditEvent =>
      buildHostAuditEventV1(resolved, {
        hostId: AUDIT_HOST_ID,
        seq,
        eventId,
        occurredAt,
      }),
    );
    // The database commit is complete. Operational copies may fail or drop,
    // but can never change the durable result or the audited business action.
    auditStdout.writeCanonical(line);
    notifyAuditHooks(event, line);
  } catch (error) {
    const eventType = typeof input === 'function' ? undefined : input.eventType;
    log.error('Audit append failed in PostgreSQL — action proceeding (fail-open)', { eventType, err: error });
  }
}

/** Awaiting this promise never rejects and therefore cannot change the business result. */
export function emitAuditEvent(input: AuditEventInput | (() => AuditEventInput)): Promise<void> {
  if (!AUDIT_ENABLED) return Promise.resolve();
  if (!accepting) {
    if (!warnedAfterStop) {
      warnedAfterStop = true;
      log.warn('Audit write arrived after shutdown admission closed; action proceeding');
    }
    return Promise.resolve();
  }
  const work = writeEvent(input);
  pending.add(work);
  void work.finally(() => pending.delete(work));
  return work;
}

export function openAuditWriteAdmission(): void {
  accepting = true;
  warnedAfterStop = false;
}

/** Close admission, then wait for every write accepted before this call. */
export async function closeAuditWriteAdmissionAndWait(): Promise<void> {
  accepting = false;
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

export function pendingAuditWritesForTest(): number {
  return pending.size;
}
