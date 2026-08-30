import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { HOST_AUDIT_MAX_BATCH_BYTES, HOST_AUDIT_MAX_BATCH_ITEMS } from './contract.js';
import type { AuditEvent, HostAuditAcceptedV1, HostAuditBatchV1 } from './types.js';
import type { EncodedHostAuditBatch } from './governance-queue.js';

const event: AuditEvent = {
  schema_version: 'nanoco.host-audit.v1',
  event_id: '00000000-0000-4000-8000-000000000001',
  host_id: 'Prod.EU:Host-01',
  seq: 1,
  occurred_at: '2026-08-23T10:00:00.000Z',
  event_type: 'ncl_action',
  provenance: 'host-observed',
  actor: { type: 'system', id: 'test' },
  agent_id: null,
  session_id: null,
  dimensions: {},
};
const wire: HostAuditBatchV1 = {
  schema_version: 'nanoco.host-audit.v1',
  host_id: 'Prod.EU:Host-01',
  items: [{ event }],
};
const batch = {
  batch: wire,
  body: Buffer.from(JSON.stringify(wire)),
  firstSeq: 1,
  lastSeq: 1,
};

const state = vi.hoisted(() => ({
  cursor: 0,
  availableThrough: 1,
  persistThrows: false,
  url: 'not-a-valid-url',
  bearerFile: '',
  tlsCert: '',
  tlsKey: '',
  tlsCa: '',
  hook: null as null | {
    init?: () => void;
    onEvent: () => void;
    maintain?: () => void;
  },
}));

vi.mock('./config.js', () => ({
  get HOST_AUDIT_GOVERNANCE_URL() {
    return state.url;
  },
  get HOST_AUDIT_BEARER_TOKEN_FILE() {
    return state.bearerFile;
  },
  get HOST_AUDIT_TLS_CERT() {
    return state.tlsCert;
  },
  get HOST_AUDIT_TLS_KEY() {
    return state.tlsKey;
  },
  get HOST_AUDIT_TLS_CA() {
    return state.tlsCa;
  },
}));
vi.mock('./store.js', () => ({
  getAuditStore: () => ({
    acknowledgedThrough: async () => state.cursor,
    advanceAcknowledgement: async (value: number) => {
      if (state.persistThrows) throw new Error('simulated crash before cursor commit');
      state.cursor = value;
    },
  }),
}));
vi.mock('./governance-queue.js', () => ({
  streamGovernanceBatches: async function* (cursor: number) {
    while (cursor < state.availableThrough) {
      const seq = cursor + 1;
      const nextEvent = { ...event, seq, event_id: `00000000-0000-4000-8000-${String(seq).padStart(12, '0')}` };
      const nextWire = { ...wire, items: [{ event: nextEvent }] };
      yield {
        batch: nextWire,
        body: Buffer.from(JSON.stringify(nextWire)),
        firstSeq: seq,
        lastSeq: seq,
      };
      cursor = seq;
    }
  },
}));
vi.mock('./hooks.js', () => ({
  registerAuditHook: (hook: typeof state.hook) => {
    state.hook = hook;
  },
}));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

let drain: typeof import('./governance-drain.js');

beforeEach(async () => {
  state.cursor = 0;
  state.availableThrough = 1;
  state.persistThrows = false;
  state.url = 'not-a-valid-url';
  state.bearerFile = '';
  state.tlsCert = '';
  state.tlsKey = '';
  state.tlsCa = '';
  vi.useFakeTimers();
  vi.resetModules();
  drain = await import('./governance-drain.js');
});

afterEach(() => {
  vi.clearAllTimers();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function ack(accepted = 1, duplicates = 0, seq = 1): HostAuditAcceptedV1 {
  return {
    schema_version: 'nanoco.host-audit.v1',
    status: 'accepted',
    host_id: 'Prod.EU:Host-01',
    acked_through_seq: seq,
    accepted,
    duplicates,
  };
}

describe('Governance drain', () => {
  it('classifies every Governance response as acknowledged, retry, or refused', () => {
    const acceptedBody = Buffer.from(JSON.stringify(ack()));
    expect(drain.classifyGovernanceResponse(200, acceptedBody, batch)).toEqual({
      kind: 'acknowledged',
      ack: ack(),
    });
    expect(drain.classifyGovernanceResponse(409, Buffer.from(JSON.stringify({
      schema_version: 'nanoco.host-audit.v1',
      status: 'refused',
      host_id: 'Prod.EU:Host-01',
      code: 'sequence_gap',
      durable_through_seq: 0,
      seq: 1,
      field: 'seq',
    })), batch)).toEqual({ kind: 'refused', code: 'sequence_gap', seq: 1 });
    expect(drain.classifyGovernanceResponse(413, Buffer.from(JSON.stringify({
      schema_version: 'nanoco.host-audit.v1',
      status: 'retry',
      code: 'batch_too_large',
    })), batch)).toEqual({ kind: 'retry', code: 'batch_too_large' });
    expect(drain.classifyGovernanceResponse(503, Buffer.from(JSON.stringify({
      schema_version: 'nanoco.host-audit.v1',
      status: 'retry',
      code: 'storage_unavailable',
    })), batch)).toEqual({ kind: 'retry', code: 'storage_unavailable' });
    expect(drain.classifyGovernanceResponse(409, Buffer.from(JSON.stringify({
      schema_version: 'nanoco.host-audit.v1',
      status: 'refused',
      host_id: 'Prod.EU:Host-01',
      code: 'future_refusal',
      durable_through_seq: 0,
      seq: 1,
    })), batch)).toEqual({ kind: 'retry', code: undefined });
    expect(drain.classifyGovernanceResponse(409, Buffer.from(JSON.stringify({
      schema_version: 'nanoco.host-audit.v1',
      status: 'refused',
      host_id: 'Prod.EU:Host-01',
      code: 'sequence_gap',
      durable_through_seq: 0,
      seq: 1,
      unexpected: true,
    })), batch)).toEqual({ kind: 'retry', code: undefined });
    expect(drain.classifyGovernanceResponse(200, Buffer.from('{not-json'), batch)).toEqual({
      kind: 'retry', code: undefined,
    });
    expect(drain.classifyGovernanceResponse(500, Buffer.from(JSON.stringify({
      status: 'refused', code: 'sequence_gap',
    })), batch)).toEqual({ kind: 'retry', code: undefined });
  });

  it('persists the contiguous ack only after a valid accepted response', async () => {
    const send = vi.fn(async () => ({ kind: 'acknowledged' as const, ack: ack() }));
    await expect(drain.drainGovernanceQueue(send)).resolves.toBe(1);
    expect(state.cursor).toBe(1);
    expect(send).toHaveBeenCalledWith(batch);
  });

  it('replays identical bytes when a crash happens after receive and before cursor fsync', async () => {
    const bodies: Buffer[] = [];
    const send = vi.fn(async (candidate: EncodedHostAuditBatch) => {
      bodies.push(Buffer.from(candidate.body));
      return { kind: 'acknowledged' as const, ack: ack(0, 1) };
    });
    state.persistThrows = true;
    await expect(drain.drainGovernanceQueue(send)).rejects.toThrow(/simulated crash/);
    expect(state.cursor).toBe(0);

    state.persistThrows = false;
    await expect(drain.drainGovernanceQueue(send)).resolves.toBe(1);
    expect(bodies).toHaveLength(2);
    expect(bodies[0].equals(bodies[1])).toBe(true);
  });

  it('drains an event appended during an already-running send before becoming idle', async () => {
    const seen: number[] = [];
    const send = vi.fn(async (candidate: EncodedHostAuditBatch) => {
      seen.push(candidate.lastSeq);
      if (candidate.lastSeq === 1) {
        state.availableThrough = 2;
        expect(() => state.hook?.onEvent()).not.toThrow();
      }
      return { kind: 'acknowledged' as const, ack: ack(1, 0, candidate.lastSeq) };
    });

    await expect(drain.drainGovernanceQueue(send)).resolves.toBe(2);
    expect(seen).toEqual([1, 2]);
    expect(state.cursor).toBe(2);
  });

  it('schedules a fresh scan when a post-append wake joins a terminal in-flight scan', async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const run = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const onFailure = vi.fn();
    const coordinator = new drain.DrainCoordinator(run, onFailure);

    coordinator.request();
    await vi.advanceTimersByTimeAsync(0); // first scan is now in flight
    coordinator.request();
    await vi.advanceTimersByTimeAsync(0); // post-append wake joins that scan
    expect(run).toHaveBeenCalledTimes(1);

    finishFirst(); // models the first scan having already returned "empty"
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(run).toHaveBeenCalledTimes(2);
    expect(onFailure).not.toHaveBeenCalled();
  });

  it('keeps failure backoff when a post-append wake marks the active scan dirty', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0); // first retry = 500 ms
    let failFirst!: (err: Error) => void;
    const first = new Promise<void>((_resolve, reject) => {
      failFirst = reject;
    });
    const run = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const coordinator = new drain.DrainCoordinator(run, vi.fn());

    coordinator.request();
    await vi.advanceTimersByTimeAsync(0);
    coordinator.request(); // records a pending generation while the request is active
    failFirst(new Error('offline'));
    await Promise.resolve();

    await vi.advanceTimersByTimeAsync(499);
    expect(run).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('parks a permanent refusal without advancing or retrying the durable queue', async () => {
    const send = vi.fn(async () => ({ kind: 'refused' as const, code: 'sequence_gap', seq: 1 }));
    await expect(drain.drainGovernanceQueue(send)).rejects.toBeInstanceOf(
      drain.GovernanceDrainRefusedError,
    );
    expect(state.cursor).toBe(0);

    const run = vi.fn(async () => {
      throw new drain.GovernanceDrainRefusedError('sequence_gap', 1);
    });
    const onFailure = vi.fn();
    const coordinator = new drain.DrainCoordinator(run, onFailure);
    coordinator.request();
    await vi.advanceTimersByTimeAsync(0);
    coordinator.request();
    await vi.advanceTimersByTimeAsync(300_000);
    expect(run).toHaveBeenCalledTimes(1);
    expect(onFailure).toHaveBeenCalledWith(
      expect.any(drain.GovernanceDrainRefusedError), 0, 0,
    );
  });

  it('retries a retry response without advancing the durable acknowledgement', async () => {
    const send = vi.fn(async () => ({ kind: 'retry' as const, code: 'storage_unavailable' }));
    await expect(drain.drainGovernanceQueue(send)).rejects.toThrow(/retry requested/);
    expect(state.cursor).toBe(0);
  });

  it('rejects malformed or partial acknowledgements without advancing', () => {
    expect(() => drain.validateAcceptedAck({ ...ack(), acked_through_seq: 0 }, batch)).toThrow(/invalid/);
    expect(() => drain.validateAcceptedAck({ ...ack(), accepted: 0, duplicates: 0 }, batch)).toThrow(/invalid/);
    expect(state.cursor).toBe(0);
  });

  it('refuses oversized sender inputs before attempting transport', async () => {
    const tooMany = {
      ...batch,
      batch: {
        ...batch.batch,
        items: Array.from({ length: HOST_AUDIT_MAX_BATCH_ITEMS + 1 }, () => batch.batch.items[0]),
      },
    };
    await expect(drain.sendGovernanceBatch(tooMany)).rejects.toThrow(/item count/);

    const tooLarge = { ...batch, body: Buffer.alloc(HOST_AUDIT_MAX_BATCH_BYTES + 1) };
    await expect(drain.sendGovernanceBatch(tooLarge)).rejects.toThrow(/1 MiB/);
  });

  it('refuses non-loopback Bearer and plaintext HTTP before credential or network access', async () => {
    state.url = 'http://governance.internal/api/host-audit/v1/events';
    state.bearerFile = '/missing/secret-that-must-not-be-read';
    await expect(drain.sendGovernanceBatch(batch)).rejects.toThrow(/Bearer transport requires a loopback/);

    state.bearerFile = '';
    await expect(drain.sendGovernanceBatch(batch)).rejects.toThrow(/plaintext HTTP requires a loopback/);
  });

  it('keeps remote HTTPS behind the complete client-certificate seam', async () => {
    state.url = 'https://governance.internal/api/host-audit/v1/events';
    state.tlsCert = '/cert';
    state.tlsKey = '/key';
    await expect(drain.sendGovernanceBatch(batch)).rejects.toThrow(/certificate, key, and CA/);
  });

  it('keeps a remote transport refusal fail-open through the registered hook', async () => {
    const { log } = await import('../log.js');
    state.url = 'http://governance.internal/api/host-audit/v1/events';
    state.bearerFile = '/missing/secret-that-must-not-be-read';

    expect(() => state.hook?.init?.()).not.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('drain failed'),
      expect.objectContaining({ failures: 1 }),
    );
    expect(state.cursor).toBe(0);
  });

  it('keeps configured bad endpoints asynchronous and fail-open at every hook entry', async () => {
    const { log } = await import('../log.js');
    expect(() => state.hook?.init?.()).not.toThrow();
    expect(() => state.hook?.onEvent()).not.toThrow();
    expect(() => state.hook?.maintain?.()).not.toThrow();

    await vi.advanceTimersByTimeAsync(0);
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('drain failed'),
      expect.objectContaining({ failures: 1 }),
    );
    expect(state.cursor).toBe(0);
  });

  it('uses bounded exponential backoff with jitter', () => {
    expect(drain.backoffDelayMs(1, () => 0)).toBe(500);
    expect(drain.backoffDelayMs(2, () => 0.5)).toBe(2000);
    expect(drain.backoffDelayMs(99, () => 1)).toBe(300_000);
  });

  it('attempts graceful flush and enforces its timeout', async () => {
    const completed = vi.fn(async () => {});
    await expect(drain.boundedGracefulFlush(completed, 50)).resolves.toBeUndefined();
    expect(completed).toHaveBeenCalledTimes(1);

    const pending = drain.boundedGracefulFlush(() => new Promise(() => {}), 50);
    const rejection = expect(pending).rejects.toThrow(/graceful flush timed out/);
    await vi.advanceTimersByTimeAsync(50);
    await rejection;
  });
});
