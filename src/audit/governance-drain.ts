/** Fail-open at-least-once drain from the PostgreSQL outbox into Governance. */
import fs from 'fs';
import http from 'http';
import https from 'https';

import { log } from '../log.js';
import {
  HOST_AUDIT_BEARER_TOKEN_FILE,
  HOST_AUDIT_GOVERNANCE_URL,
  HOST_AUDIT_TLS_CA,
  HOST_AUDIT_TLS_CERT,
  HOST_AUDIT_TLS_KEY,
} from './config.js';
import { registerAuditHook } from './hooks.js';
import {
  streamGovernanceBatches,
  type EncodedHostAuditBatch,
} from './governance-queue.js';
import { HOST_AUDIT_MAX_BATCH_BYTES, HOST_AUDIT_MAX_BATCH_ITEMS } from './contract.js';
import { getAuditStore, type AuditStore } from './store.js';
import { HOST_AUDIT_SCHEMA_VERSION, type HostAuditAcceptedV1 } from './types.js';

const REQUEST_TIMEOUT_MS = 10_000;
const SHUTDOWN_FLUSH_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const REFUSAL_CODES = new Set([
  'unsupported_schema_version',
  'unsupported_envelope',
  'host_mismatch',
  'sequence_gap',
  'sequence_reuse',
  'batch_unordered',
]);
const RETRY_CODES = new Set(['batch_too_large', 'too_many_items', 'storage_unavailable']);
const REFUSAL_KEYS = new Set([
  'schema_version', 'status', 'host_id', 'code', 'durable_through_seq', 'seq', 'field',
]);
const RETRY_KEYS = new Set(['schema_version', 'status', 'code']);

export type GovernanceDrainOutcome =
  | { kind: 'acknowledged'; ack: HostAuditAcceptedV1 }
  | { kind: 'refused'; code: string; seq?: number }
  | { kind: 'retry'; code?: string };

export type GovernanceBatchSender = (
  batch: EncodedHostAuditBatch,
) => Promise<GovernanceDrainOutcome>;

export class GovernanceDrainRefusedError extends Error {
  constructor(
    readonly code: string,
    readonly seq?: number,
  ) {
    super(`Governance host audit drain refused (code=${code}${seq === undefined ? '' : ` seq=${seq}`})`);
    this.name = 'GovernanceDrainRefusedError';
  }
}

export class GovernanceDrainRetryError extends Error {
  constructor(readonly code?: string) {
    super(`Governance host audit retry requested${code ? ` (code=${code})` : ''}`);
    this.name = 'GovernanceDrainRetryError';
  }
}

function readCredential(file: string, label: string): Buffer {
  try {
    return fs.readFileSync(file);
  } catch (err) {
    throw new Error(`unable to read ${label} file`, { cause: err });
  }
}

function bearerHeader(): string | undefined {
  if (!HOST_AUDIT_BEARER_TOKEN_FILE) return undefined;
  const token = readCredential(HOST_AUDIT_BEARER_TOKEN_FILE, 'host audit bearer token').toString('utf8').trim();
  if (!token || /[\u0000-\u001f\u007f]/.test(token)) throw new Error('host audit bearer token file is empty or invalid');
  return `Bearer ${token}`;
}

interface HttpResult {
  status: number;
  body: Buffer;
}

function isLoopbackHostname(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === '[::1]' || hostname === 'localhost';
}

function validateTransport(url: URL): void {
  const loopback = isLoopbackHostname(url.hostname);
  if (!loopback && HOST_AUDIT_BEARER_TOKEN_FILE) {
    throw new Error('Governance host audit Bearer transport requires a loopback hostname');
  }
  if (!loopback && url.protocol === 'http:') {
    throw new Error('Governance host audit plaintext HTTP requires a loopback hostname');
  }
  if (
    !loopback &&
    url.protocol === 'https:' &&
    (!HOST_AUDIT_TLS_CERT || !HOST_AUDIT_TLS_KEY || !HOST_AUDIT_TLS_CA)
  ) {
    throw new Error('Governance host audit remote HTTPS requires certificate, key, and CA files');
  }
}

function requestBatch(batch: EncodedHostAuditBatch): Promise<HttpResult> {
  const url = new URL(HOST_AUDIT_GOVERNANCE_URL);
  if (url.pathname !== '/api/host-audit/v1/events' || url.search || url.hash) {
    throw new Error('NANOCO_HOST_AUDIT_URL must target /api/host-audit/v1/events exactly');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('NANOCO_HOST_AUDIT_URL must use http or https');
  }
  // Validate placement before reading credentials so a typo can never send or
  // even expose a loopback Bearer secret to a non-loopback destination.
  validateTransport(url);

  const authorization = bearerHeader();
  const tls =
    url.protocol === 'https:'
      ? {
          ...(HOST_AUDIT_TLS_CERT ? { cert: readCredential(HOST_AUDIT_TLS_CERT, 'host audit TLS certificate') } : {}),
          ...(HOST_AUDIT_TLS_KEY ? { key: readCredential(HOST_AUDIT_TLS_KEY, 'host audit TLS private key') } : {}),
          ...(HOST_AUDIT_TLS_CA ? { ca: readCredential(HOST_AUDIT_TLS_CA, 'host audit TLS CA') } : {}),
        }
      : {};

  return new Promise<HttpResult>((resolve, reject) => {
    const request = (url.protocol === 'https:' ? https.request : http.request)(
      url,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': String(batch.body.length),
          ...(authorization ? { authorization } : {}),
        },
        ...tls,
      },
      (response) => {
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error('Governance host audit response exceeds 64 KiB'));
            return;
          }
          chunks.push(chunk);
        });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks) }));
        response.on('error', reject);
      },
    );
    request.setTimeout(REQUEST_TIMEOUT_MS, () => request.destroy(new Error('Governance host audit request timed out')));
    request.on('error', reject);
    request.end(batch.body);
  });
}

function responseSequence(value: unknown): number | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const seq = (value as Record<string, unknown>).seq;
  return Number.isSafeInteger(seq) && (seq as number) >= 1 ? seq as number : undefined;
}

function isClosedRetry(response: Record<string, unknown>): response is Record<string, unknown> & { code: string } {
  return (
    Object.keys(response).every((key) => RETRY_KEYS.has(key)) &&
    Object.keys(response).length === RETRY_KEYS.size &&
    response.schema_version === HOST_AUDIT_SCHEMA_VERSION &&
    response.status === 'retry' &&
    typeof response.code === 'string' &&
    RETRY_CODES.has(response.code)
  );
}

function isClosedRefusal(response: Record<string, unknown>, batch: EncodedHostAuditBatch): boolean {
  const seq = responseSequence(response);
  const field = response.field;
  return (
    Object.keys(response).every((key) => REFUSAL_KEYS.has(key)) &&
    response.schema_version === HOST_AUDIT_SCHEMA_VERSION &&
    response.status === 'refused' &&
    response.host_id === batch.batch.host_id &&
    typeof response.code === 'string' &&
    REFUSAL_CODES.has(response.code) &&
    Number.isSafeInteger(response.durable_through_seq) &&
    (response.durable_through_seq as number) >= 0 &&
    (response.seq === undefined || seq !== undefined) &&
    (field === undefined || (
      typeof field === 'string' && field.length >= 1 && field.length <= 128 &&
      !/[\u0000-\u001f\u007f]/.test(field)
    ))
  );
}

export function validateAcceptedAck(value: unknown, batch: EncodedHostAuditBatch): HostAuditAcceptedV1 {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('invalid Governance ack');
  const ack = value as Partial<HostAuditAcceptedV1>;
  if (
    Object.keys(ack).sort().join(',') !==
      'accepted,acked_through_seq,duplicates,host_id,schema_version,status' ||
    ack.schema_version !== HOST_AUDIT_SCHEMA_VERSION ||
    ack.status !== 'accepted' ||
    ack.host_id !== batch.batch.host_id ||
    ack.acked_through_seq !== batch.lastSeq ||
    !Number.isSafeInteger(ack.accepted) ||
    (ack.accepted as number) < 0 ||
    !Number.isSafeInteger(ack.duplicates) ||
    (ack.duplicates as number) < 0 ||
    (ack.accepted as number) + (ack.duplicates as number) !== batch.batch.items.length
  ) {
    throw new Error('invalid Governance ack');
  }
  return ack as HostAuditAcceptedV1;
}

/** Total Gateway-style classifier: only a fully valid ACK advances; explicit 4xx refusal parks. */
export function classifyGovernanceResponse(
  status: number,
  body: Buffer,
  batch: EncodedHostAuditBatch,
): GovernanceDrainOutcome {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    parsed = null;
  }
  if (status >= 200 && status < 300) {
    try {
      return { kind: 'acknowledged', ack: validateAcceptedAck(parsed, batch) };
    } catch {
      return { kind: 'retry' };
    }
  }
  if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
    const response = parsed as Record<string, unknown>;
    if (status >= 400 && status < 500 && isClosedRefusal(response, batch)) {
      const rawSeq = response.seq;
      return {
        kind: 'refused',
        code: response.code as string,
        ...(rawSeq === undefined ? {} : { seq: rawSeq as number }),
      };
    }
    if (isClosedRetry(response)) return { kind: 'retry', code: response.code };
  }
  return { kind: 'retry' };
}

export async function sendGovernanceBatch(batch: EncodedHostAuditBatch): Promise<GovernanceDrainOutcome> {
  if (batch.batch.items.length < 1 || batch.batch.items.length > HOST_AUDIT_MAX_BATCH_ITEMS) {
    throw new Error('Governance host audit batch item count is outside the contract');
  }
  if (batch.body.length > HOST_AUDIT_MAX_BATCH_BYTES) {
    throw new Error('Governance host audit batch exceeds the 1 MiB contract');
  }
  const response = await requestBatch(batch);
  return classifyGovernanceResponse(response.status, response.body, batch);
}

/** Drain all currently durable prefixes. DB progress advances only after a valid full acknowledgement. */
export async function drainGovernanceQueue(
  send: GovernanceBatchSender = sendGovernanceBatch,
  store: AuditStore = getAuditStore(),
): Promise<number> {
  let cursor = await store.acknowledgedThrough();
  for await (const batch of streamGovernanceBatches(cursor, store)) {
    const outcome = await send(batch);
    if (outcome.kind === 'refused') {
      throw new GovernanceDrainRefusedError(outcome.code, outcome.seq);
    }
    if (outcome.kind === 'retry') throw new GovernanceDrainRetryError(outcome.code);
    const ack = validateAcceptedAck(outcome.ack, batch);
    // At-least-once boundary: a crash before this transaction replays the
    // accepted batch; a crash after it resumes at the next sequence.
    await store.advanceAcknowledgement(ack.acked_through_seq);
    cursor = ack.acked_through_seq;
  }
  return cursor;
}

export function backoffDelayMs(failures: number, random: () => number = Math.random): number {
  const base = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(Math.max(failures - 1, 0), 9));
  return Math.min(MAX_BACKOFF_MS, Math.floor(base * (0.5 + random())));
}

function configured(): boolean {
  return HOST_AUDIT_GOVERNANCE_URL.length > 0;
}

export class DrainCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private inFlight: Promise<unknown> | null = null;
  private pending = false;
  private failures = 0;
  private stopping = false;
  private parked = false;

  constructor(
    private readonly run: () => Promise<unknown>,
    private readonly onFailure: (err: unknown, failures: number, retryMs: number) => void,
  ) {}

  /** Coalesce wakeups without losing one that joins a terminal in-flight scan. */
  request(delayMs: number = 0): void {
    if (this.stopping || this.parked) return;
    if (this.inFlight) {
      this.pending = true;
      return;
    }
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.execute();
    }, delayMs);
    this.timer.unref();
  }

  private async execute(): Promise<void> {
    if (this.inFlight) return; // request() records the pending generation.
    const work = this.run();
    this.inFlight = work;
    let retryMs: number | null = null;
    try {
      await work;
      this.failures = 0;
    } catch (err) {
      if (err instanceof GovernanceDrainRefusedError) {
        this.parked = true;
        this.onFailure(err, 0, 0);
      } else {
        this.failures++;
        retryMs = backoffDelayMs(this.failures);
        this.onFailure(err, this.failures, retryMs);
      }
    } finally {
      if (this.inFlight === work) this.inFlight = null;
      const pending = this.pending;
      this.pending = false;
      // A failed owner always retains its bounded backoff, even when an append
      // arrived during the request. A successful terminal scan immediately
      // services that dirty generation so evidence cannot wait for maintenance.
      if (!this.stopping && retryMs !== null) this.request(retryMs);
      else if (!this.stopping && pending) this.request(0);
    }
  }

  async stopAndFlush(timeoutMs: number = SHUTDOWN_FLUSH_MS): Promise<void> {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await boundedGracefulFlush(
      () => this.inFlight ?? (this.parked ? Promise.resolve() : this.run()),
      timeoutMs,
    );
  }
}

const coordinator = new DrainCoordinator(
  () => drainGovernanceQueue(),
  (err, failures, retryMs) => {
    if (err instanceof GovernanceDrainRefusedError) {
      log.error('Governance refused Host audit evidence; drain parked and PostgreSQL rows retained', {
        code: err.code,
        seq: err.seq,
      });
    } else {
      log.warn('Governance host audit drain failed; local queue retained', { failures, retryMs, err });
    }
  },
);

export async function boundedGracefulFlush(
  run: () => Promise<unknown>,
  timeoutMs: number = SHUTDOWN_FLUSH_MS,
): Promise<void> {
  let timeout: NodeJS.Timeout | null = null;
  try {
    await Promise.race([
      run(),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Governance host audit graceful flush timed out')), timeoutMs);
        timeout.unref();
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function flushOnShutdown(): Promise<void> {
  if (!configured()) return;
  await coordinator.stopAndFlush();
}

registerAuditHook({
  name: 'governance-host-audit-drain',
  onEvent: () => {
    if (configured()) coordinator.request(0);
  },
  init: () => {
    if (configured()) {
      coordinator.request(0); // restart catch-up from the durable cursor
      log.info('Governance host audit drain enabled');
    } else {
      log.info('Governance host audit drain disabled (NANOCO_HOST_AUDIT_URL is unset)');
    }
  },
  maintain: () => {
    if (configured()) coordinator.request(0);
  },
  shutdown: flushOnShutdown,
});
