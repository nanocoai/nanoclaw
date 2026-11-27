/**
 * Synchronous RPC to the host mailbox service.
 *
 * `MailboxOperations` is synchronous, but HTTP is not. A worker thread owns
 * the network; the calling thread publishes a request into a
 * SharedArrayBuffer and blocks on Atomics.wait until the worker answers
 * (~0.2 ms/call on loopback, proven in the M0 spike).
 *
 * Hardening over the spike:
 * - every request carries a monotonically increasing id and a response with a
 *   different id is discarded as an error, never returned;
 * - a call that times out terminates the worker and the next call starts a
 *   fresh one on a fresh buffer, so a late reply can never land in a later
 *   call's slot;
 * - connection refused/reset is retried with backoff inside the worker.
 */
import { Worker } from 'node:worker_threads';

export class MailboxRpcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'MailboxRpcError';
  }
}

export class MailboxAuthError extends MailboxRpcError {
  constructor(message: string) {
    super('unauthorized', message, 401);
    this.name = 'MailboxAuthError';
  }
}

export interface SyncRpcOptions {
  url: string;
  token: string;
  /** Per-call timeout for a single HTTP attempt. */
  timeoutMs?: number;
  /** Total time spent retrying connection refused/reset before giving up. */
  retryBudgetMs?: number;
  /** Shared buffer size; bounds the largest request and response. */
  bufferBytes?: number;
}

export interface CallOptions {
  timeoutMs?: number;
  retryBudgetMs?: number;
}

const HEADER_BYTES = 16;
// Mailbox ops are quick local DB calls; a long timeout only delays recovery
// from a dead connection. Host restarts are covered by the retry budget.
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BUDGET_MS = 60_000;
const DEFAULT_BUFFER_BYTES = 16 * 1024 * 1024;

const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;
const STATUS_NETWORK = -1;
const STATUS_TIMEOUT = -2;
const STATUS_TOO_LARGE = -3;

const enc = new TextEncoder();
const dec = new TextDecoder();

export class SyncRpcClient {
  private worker: Worker | undefined;
  private ctl!: Int32Array;
  private bytes!: Uint8Array;
  private nextId = 0;
  /** `<agentGroupId>/<sessionId>`, sent as x-nanoclaw-session. */
  session: string | undefined;

  constructor(private readonly options: SyncRpcOptions) {}

  private ensureWorker(): void {
    if (this.worker) return;
    const sab = new SharedArrayBuffer(HEADER_BYTES + (this.options.bufferBytes ?? DEFAULT_BUFFER_BYTES));
    this.ctl = new Int32Array(sab, 0, 4);
    this.bytes = new Uint8Array(sab, HEADER_BYTES);
    const worker = new Worker(new URL('./rpc-worker.ts', import.meta.url), {
      workerData: { sab, url: this.options.url, token: this.options.token },
    });
    worker.unref();
    this.worker = worker;
  }

  private dropWorker(): void {
    const worker = this.worker;
    this.worker = undefined;
    if (worker) void worker.terminate();
  }

  close(): void {
    this.dropWorker();
  }

  /** Blocking call. Throws MailboxRpcError / MailboxAuthError on failure. */
  call<T = unknown>(op: string, args: unknown[] = [], options: CallOptions = {}): T {
    if (!this.session) throw new MailboxRpcError('no_session', 'mailbox session identity is not known');
    const timeoutMs = options.timeoutMs ?? this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const retryBudgetMs = options.retryBudgetMs ?? this.options.retryBudgetMs ?? DEFAULT_RETRY_BUDGET_MS;
    const id = ++this.nextId;
    const envelope = enc.encode(
      JSON.stringify({ body: JSON.stringify({ id, op, args }), session: this.session, timeoutMs, retryBudgetMs }),
    );
    this.ensureWorker();
    if (envelope.length > this.bytes.length) {
      throw new MailboxRpcError('request_too_large', `mailbox request ${op} is ${envelope.length} bytes`);
    }

    this.bytes.set(envelope);
    this.ctl[1] = envelope.length;
    Atomics.store(this.ctl, 0, STATE_REQUEST);
    Atomics.notify(this.ctl, 0);

    // The worker enforces the timeout/retry policy; this deadline is only a
    // backstop against a wedged worker.
    const deadline = Date.now() + timeoutMs + retryBudgetMs + 5_000;
    while (Atomics.load(this.ctl, 0) !== STATE_RESPONSE) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        this.dropWorker();
        throw new MailboxRpcError('timeout', `mailbox call ${op} timed out (worker unresponsive)`);
      }
      Atomics.wait(this.ctl, 0, STATE_REQUEST, remaining);
    }
    const status = this.ctl[2];
    const text = dec.decode(this.bytes.slice(0, this.ctl[1]));
    Atomics.store(this.ctl, 0, STATE_IDLE);

    if (status === STATUS_TIMEOUT) {
      // The abandoned request may still be answered; a fresh worker/buffer
      // guarantees that reply can never be read as a later call's result.
      this.dropWorker();
      throw new MailboxRpcError('timeout', `mailbox call ${op} timed out after ${timeoutMs}ms`);
    }
    if (status === STATUS_NETWORK) {
      throw new MailboxRpcError('unreachable', `mailbox host unreachable for ${op}: ${text}`);
    }
    if (status === STATUS_TOO_LARGE) throw new MailboxRpcError('response_too_large', text);
    if (status === 401) throw new MailboxAuthError(`mailbox rejected credentials for ${op}`);

    let parsed: { id?: unknown; ok?: unknown; result?: unknown; error?: { code?: string; message?: string } };
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new MailboxRpcError('bad_response', `mailbox ${op}: HTTP ${status} with non-JSON body`, status);
    }
    if (status !== 200) {
      throw new MailboxRpcError(
        parsed.error?.code ?? 'http_error',
        `mailbox ${op}: HTTP ${status} ${parsed.error?.message ?? ''}`.trim(),
        status,
      );
    }
    if (parsed.id !== id) {
      throw new MailboxRpcError(
        'id_mismatch',
        `mailbox ${op}: discarded reply for id ${String(parsed.id)} (expected ${id})`,
      );
    }
    if (parsed.ok !== true) {
      throw new MailboxRpcError(parsed.error?.code ?? 'error', `mailbox ${op}: ${parsed.error?.message ?? 'failed'}`);
    }
    return (parsed.result ?? null) as T;
  }
}
