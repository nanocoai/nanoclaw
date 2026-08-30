/** Oldest-first contiguous batching over the PostgreSQL Host audit outbox. */
import {
  encodeHostAuditBatchV1,
  HOST_AUDIT_MAX_BATCH_ITEMS,
} from './contract.js';
import { getAuditStore, type AuditStore } from './store.js';
import type { AuditEvent, HostAuditBatchV1 } from './types.js';

export interface EncodedHostAuditBatch {
  batch: HostAuditBatchV1;
  body: Buffer;
  firstSeq: number;
  lastSeq: number;
}

function encode(events: AuditEvent[]): { batch: HostAuditBatchV1; body: Buffer } {
  const body = encodeHostAuditBatchV1(events);
  return { batch: JSON.parse(body.toString('utf8')) as HostAuditBatchV1, body };
}

function encodeWithinLimit(events: AuditEvent[]): { batch: HostAuditBatchV1; body: Buffer } | null {
  try {
    return encode(events);
  } catch (error) {
    if (error instanceof Error && error.message === 'host audit batch exceeds 1 MiB') return null;
    throw error;
  }
}

function ready(events: AuditEvent[]): EncodedHostAuditBatch {
  const encoded = encode(events);
  return { ...encoded, firstSeq: events[0].seq, lastSeq: events[events.length - 1].seq };
}

export async function* streamGovernanceBatches(
  ackedThroughSeq: number,
  store: AuditStore = getAuditStore(),
): AsyncGenerator<EncodedHostAuditBatch> {
  if (!Number.isSafeInteger(ackedThroughSeq) || ackedThroughSeq < 0) {
    throw new Error('invalid acknowledged sequence');
  }
  let readThrough = ackedThroughSeq;
  let expectedSeq = ackedThroughSeq + 1;
  let pending: AuditEvent[] = [];

  for (;;) {
    const rows = await store.readAfter(readThrough, HOST_AUDIT_MAX_BATCH_ITEMS);
    if (rows.length === 0) break;
    for (const { event } of rows) {
      if (event.seq !== expectedSeq) {
        throw new Error(`local Host audit outbox is not contiguous at seq ${expectedSeq}`);
      }
      const candidate = [...pending, event];
      if (!encodeWithinLimit(candidate)) {
        if (pending.length === 0) {
          throw new Error(`Host audit event seq ${event.seq} exceeds the 1 MiB request limit`);
        }
        yield ready(pending);
        pending = [event];
        if (!encodeWithinLimit(pending)) {
          throw new Error(`Host audit event seq ${event.seq} exceeds the 1 MiB request limit`);
        }
      } else {
        pending = candidate;
      }
      readThrough = event.seq;
      expectedSeq++;
      if (pending.length === HOST_AUDIT_MAX_BATCH_ITEMS) {
        yield ready(pending);
        pending = [];
      }
    }
    if (rows.length < HOST_AUDIT_MAX_BATCH_ITEMS) break;
  }

  if (pending.length > 0) yield ready(pending);
}
