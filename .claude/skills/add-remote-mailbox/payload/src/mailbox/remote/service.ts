/**
 * Remote mailbox HTTP service (prototype).
 *
 * A session runner without the host's session directory mounted reaches its
 * mailbox here: POST /v1/mailbox executes one `MailboxOperations` call (or one
 * of the file ops) against that session's inbound.db/outbound.db. Loopback
 * only; bearer token per session; one request per session at a time.
 * Wire format: see the remote-mailbox spec. Started by the remote-mailbox
 * session driver (driver.ts) before adoption.
 */
import http from 'http';
import type { AddressInfo } from 'net';

import { log } from '../../log.js';
import { inboxList, inboxRead, outboxWrite, PathRejectedError } from './files.js';
import type { RemoteSessionKey } from './ids.js';
import { createSessionOperations, SessionUnavailableError } from './operations.js';
import type { SessionOperations } from './operations.js';
import { DEFAULT_MAILBOX_PORT } from './config.js';
import { verifyMailboxToken } from './tokens.js';

export { DEFAULT_MAILBOX_PORT };
export const MAX_REQUEST_BODY_BYTES = 8 * 1024 * 1024;
const LOOPBACK = '127.0.0.1';

class InvalidArgsError extends Error {}

type Handler = (key: RemoteSessionKey, ops: SessionOperations, args: unknown[]) => unknown;

function str(value: unknown, name: string): string {
  if (typeof value !== 'string') throw new InvalidArgsError(`${name} must be a string`);
  return value;
}
function int(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value))
    throw new InvalidArgsError(`${name} must be an integer`);
  return value;
}
function strArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) {
    throw new InvalidArgsError(`${name} must be an array of strings`);
  }
  return value as string[];
}
function expectArgs(args: unknown[], n: number): void {
  if (args.length !== n) throw new InvalidArgsError(`expected ${n} argument(s), got ${args.length}`);
}

const STATUSES = new Set(['processing', 'completed', 'failed', 'script-skip:error']);

const HANDLERS: Record<string, Handler> = {
  getPendingMessages: (_k, o, a) => (expectArgs(a, 2), o.getPendingMessages(int(a[0], 'limit'), a[1] === true)),
  markMessages: (_k, o, a) => {
    expectArgs(a, 2);
    const status = str(a[1], 'status');
    if (!STATUSES.has(status)) throw new InvalidArgsError('invalid status');
    return o.markMessages(strArray(a[0], 'ids'), status as Parameters<SessionOperations['markMessages']>[1]);
  },
  markScriptSkipped: (_k, o, a) => {
    expectArgs(a, 1);
    if (!Array.isArray(a[0])) throw new InvalidArgsError('skips must be an array');
    return o.markScriptSkipped(
      a[0].map((s: unknown) => {
        const skip = s as { id?: unknown; reason?: unknown } | null;
        return { id: str(skip?.id, 'id'), reason: str(skip?.reason, 'reason') };
      }),
    );
  },
  getMessageIn: (_k, o, a) => (expectArgs(a, 1), o.getMessageIn(str(a[0], 'id'))),
  findQuestionResponse: (_k, o, a) => (expectArgs(a, 1), o.findQuestionResponse(str(a[0], 'questionId'))),
  findCliResponse: (_k, o, a) => (expectArgs(a, 1), o.findCliResponse(str(a[0], 'requestId'))),
  writeMessageOut: (_k, o, a) => {
    expectArgs(a, 1);
    if (typeof a[0] !== 'object' || a[0] === null) throw new InvalidArgsError('draft must be an object');
    return o.writeMessageOut(a[0] as Parameters<SessionOperations['writeMessageOut']>[0]);
  },
  getMessageIdBySeq: (_k, o, a) => (expectArgs(a, 1), o.getMessageIdBySeq(int(a[0], 'sequence'))),
  getRoutingBySeq: (_k, o, a) => (expectArgs(a, 1), o.getRoutingBySeq(int(a[0], 'sequence'))),
  getLatestInboundRoute: (_k, o, a) => (
    expectArgs(a, 2),
    o.getLatestInboundRoute(str(a[0], 'channelType'), str(a[1], 'platformId'))
  ),
  getUndeliveredMessages: (_k, o, a) => (expectArgs(a, 0), o.getUndeliveredMessages()),
  getDeliveryStatus: (_k, o, a) => (expectArgs(a, 1), o.getDeliveryStatus(str(a[0], 'messageOutId'))),
  getState: (_k, o, a) => (expectArgs(a, 1), o.getState(str(a[0], 'key'))),
  setState: (_k, o, a) => (expectArgs(a, 2), o.setState(str(a[0], 'key'), str(a[1], 'value'))),
  deleteState: (_k, o, a) => (expectArgs(a, 1), o.deleteState(str(a[0], 'key'))),
  getSessionRouting: (_k, o, a) => (expectArgs(a, 0), o.getSessionRouting()),
  getDestinations: (_k, o, a) => (expectArgs(a, 0), o.getDestinations()),
  findDestinationByName: (_k, o, a) => (expectArgs(a, 1), o.findDestinationByName(str(a[0], 'name'))),
  findDestinationByRouting: (_k, o, a) => (
    expectArgs(a, 2),
    o.findDestinationByRouting(str(a[0], 'channelType'), str(a[1], 'platformId'))
  ),
  setContainerToolInFlight: (_k, o, a) => {
    expectArgs(a, 2);
    const timeout = a[1] === null ? null : int(a[1], 'declaredTimeoutMs');
    return o.setContainerToolInFlight(str(a[0], 'tool'), timeout);
  },
  clearContainerToolInFlight: (_k, o, a) => (expectArgs(a, 0), o.clearContainerToolInFlight()),
  clearStaleProcessingAcks: (_k, o, a) => (expectArgs(a, 0), o.clearStaleProcessingAcks()),
  // Extra ops
  hello: (k, _o, a) => (expectArgs(a, 0), { agentGroupId: k.agentGroupId, sessionId: k.sessionId }),
  inboxList: (k, _o, a) => (expectArgs(a, 0), inboxList(k)),
  inboxRead: (k, _o, a) => (expectArgs(a, 3), inboxRead(k, a[0], a[1], a[2])),
  outboxWrite: (k, _o, a) => (expectArgs(a, 5), outboxWrite(k, a[0], a[1], a[2], a[3], a[4])),
};

export const REMOTE_MAILBOX_OPS: readonly string[] = Object.keys(HANDLERS);

/** Executes one op for one session. Replaceable in tests. */
export type RemoteMailboxExecutor = (key: RemoteSessionKey, op: string, args: unknown[]) => unknown | Promise<unknown>;

function defaultExecutor(key: RemoteSessionKey, op: string, args: unknown[]): unknown {
  return HANDLERS[op](key, createSessionOperations(key), args);
}

export interface RemoteMailboxServiceOptions {
  /** Defaults to NANOCLAW_MAILBOX_PORT, then 18770. 0 picks a free port. Always bound to 127.0.0.1. */
  port?: number;
  /** Tests only: replaces op execution. Per-session serialization still applies. */
  executor?: RemoteMailboxExecutor;
}

export interface RemoteMailboxService {
  port: number;
  stop(): Promise<void>;
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
    connection: 'close',
  });
  res.end(payload);
}

function failure(id: unknown, code: string, message: string) {
  return { ...(typeof id === 'number' ? { id } : {}), ok: false, error: { code, message } };
}

export function startRemoteMailboxService(options: RemoteMailboxServiceOptions = {}): Promise<RemoteMailboxService> {
  const envPort = Number.parseInt(process.env.NANOCLAW_MAILBOX_PORT ?? '', 10);
  const port = options.port ?? (Number.isInteger(envPort) && envPort >= 0 ? envPort : DEFAULT_MAILBOX_PORT);
  const execute = options.executor ?? defaultExecutor;
  const tails = new Map<string, Promise<unknown>>();

  /** Run `task` after every earlier task for the same session finished. */
  function serialize<T>(key: RemoteSessionKey, task: () => Promise<T>): Promise<T> {
    const name = `${key.agentGroupId}/${key.sessionId}`;
    const previous = tails.get(name) ?? Promise.resolve();
    const result = previous.then(task, task);
    const tail = result.catch(() => undefined);
    tails.set(name, tail);
    void tail.then(() => {
      if (tails.get(name) === tail) tails.delete(name);
    });
    return result;
  }

  const server = http.createServer((req, res) => {
    if (req.url !== '/v1/mailbox') {
      send(res, 404, failure(undefined, 'not_found', 'not found'));
      req.resume();
      return;
    }
    if (req.method !== 'POST') {
      send(res, 405, failure(undefined, 'method_not_allowed', 'POST only'));
      req.resume();
      return;
    }
    // Authenticate before reading any body: unauthenticated callers cost nothing.
    const key = verifyMailboxToken(req.headers.authorization, req.headers['x-nanoclaw-session']);
    if (!key) {
      send(res, 401, failure(undefined, 'unauthorized', 'unauthorized'));
      req.resume();
      return;
    }
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
      send(res, 413, failure(undefined, 'payload_too_large', 'request body too large'));
      req.resume();
      return;
    }
    const chunks: Buffer[] = [];
    let received = 0;
    let rejected = false;
    req.on('data', (chunk: Buffer) => {
      if (rejected) return;
      received += chunk.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
        rejected = true;
        chunks.length = 0;
        send(res, 413, failure(undefined, 'payload_too_large', 'request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', () => {
      rejected = true;
    });
    req.on('end', () => {
      if (rejected) return;
      void handle(key, Buffer.concat(chunks).toString('utf8'), res);
    });
  });

  async function handle(key: RemoteSessionKey, raw: string, res: http.ServerResponse): Promise<void> {
    let message: { id?: unknown; op?: unknown; args?: unknown };
    try {
      message = JSON.parse(raw) as typeof message;
    } catch {
      send(res, 400, failure(undefined, 'bad_request', 'malformed JSON'));
      return;
    }
    if (typeof message !== 'object' || message === null || Array.isArray(message)) {
      send(res, 400, failure(undefined, 'bad_request', 'request must be an object'));
      return;
    }
    const { id, op, args } = message;
    if (typeof id !== 'number' || !Number.isSafeInteger(id)) {
      send(res, 400, failure(undefined, 'bad_request', 'id must be an integer'));
      return;
    }
    if (typeof op !== 'string' || !Object.hasOwn(HANDLERS, op)) {
      send(res, 400, failure(id, 'unknown_op', 'unknown op'));
      return;
    }
    if (!Array.isArray(args)) {
      send(res, 400, failure(id, 'bad_request', 'args must be an array'));
      return;
    }
    try {
      const result = await serialize(key, async () => execute(key, op, args));
      send(res, 200, { id, ok: true, result: result === undefined ? null : result });
    } catch (err) {
      if (err instanceof InvalidArgsError) send(res, 200, failure(id, 'invalid_args', err.message));
      else if (err instanceof PathRejectedError) send(res, 200, failure(id, 'path_rejected', err.message));
      else if (err instanceof SessionUnavailableError) send(res, 200, failure(id, 'session_unavailable', err.message));
      else {
        log.error('Remote mailbox op failed', { op, session: `${key.agentGroupId}/${key.sessionId}`, err });
        send(res, 200, failure(id, 'op_failed', err instanceof Error ? err.message : String(err)));
      }
    }
  }

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, LOOPBACK, () => {
      server.off('error', reject);
      const bound = (server.address() as AddressInfo).port;
      log.info('Remote mailbox service listening', { host: LOOPBACK, port: bound });
      resolve({
        port: bound,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            server.closeAllConnections();
          }),
      });
    });
  });
}
