import fs from 'fs';
import https from 'https';
import { StringDecoder } from 'string_decoder';
import { inspect } from 'util';

import {
  isResyncRequired,
  parseApprovalEvent,
  parseApprovalSnapshot,
  parseDecisionAcknowledgement,
  type ApprovalEvent,
  type ApprovalSnapshot,
  type DecisionAcknowledgement,
  type DecisionCommand,
} from './approval-contract.js';

const REQUEST_TIMEOUT_MS = 10_000;
const JSON_RESPONSE_LIMIT = 1024 * 1024;
const SSE_EVENT_JSON_LIMIT = 64 * 1024;
// The Gateway limit applies to serialized JSON, not `id`/`event`/`data`
// framing. The fixed allowance also bounds comments and repeated prefixes.
const SSE_FRAME_LIMIT = SSE_EVENT_JSON_LIMIT + 1024;

export interface GatewayApprovalTransport {
  snapshot(signal: AbortSignal): Promise<ApprovalSnapshot>;
  events(
    gatewayEpoch: string,
    cursor: number,
    onEvent: (event: ApprovalEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<'closed' | 'resync_required'>;
  submit(command: DecisionCommand, signal: AbortSignal): Promise<DecisionSubmission>;
}

export type DecisionSubmission =
  | { status: 'acknowledged'; acknowledgement: DecisionAcknowledgement }
  | { status: 'gone' | 'resync_required' | 'retry' | 'rejected' };

export type ApprovalTransportFailureCode =
  | 'snapshot_response'
  | 'events_response'
  | 'events_stream'
  | 'request_timeout'
  | 'request_failed'
  | 'response_timeout'
  | 'response_too_large'
  | 'response_json'
  | 'sse_payload'
  | 'sse_parser';

export interface HttpsApprovalTransportOptions {
  deploymentId: string;
  controlUrl: string;
  controlServerName: string;
  gatewayCaPath: string;
  deploymentCertificatePath: string;
  deploymentPrivateKeyPath: string;
  requestTimeoutMs?: number;
}

/** Deployment-mTLS implementation of the frozen approval protocol. */
export class HttpsGatewayApprovalTransport implements GatewayApprovalTransport {
  readonly #deploymentId: string;
  readonly #origin: URL;
  readonly #serverName: string;
  readonly #ca: Buffer;
  readonly #certificate: Buffer;
  readonly #privateKey: Buffer;
  readonly #requestTimeoutMs: number;

  constructor(options: HttpsApprovalTransportOptions) {
    let origin: URL;
    try {
      origin = new URL(options.controlUrl);
    } catch (_error) {
      // eslint-disable-next-line preserve-caught-error -- a URL parse error may echo credentials or query values
      throw new Error('NanoCo Gateway control URL must be an HTTPS origin');
    }
    if (
      origin.protocol !== 'https:' ||
      origin.username ||
      origin.password ||
      origin.pathname !== '/' ||
      origin.search ||
      origin.hash
    ) {
      throw new Error('NanoCo Gateway control URL must be an HTTPS origin');
    }
    this.#deploymentId = requireToken(options.deploymentId, 'deployment ID');
    this.#origin = origin;
    this.#serverName = requireToken(options.controlServerName, 'control server name');
    this.#ca = fs.readFileSync(options.gatewayCaPath);
    this.#certificate = fs.readFileSync(options.deploymentCertificatePath);
    this.#privateKey = fs.readFileSync(options.deploymentPrivateKeyPath);
    this.#requestTimeoutMs = options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.#requestTimeoutMs) || this.#requestTimeoutMs <= 0) {
      throw new Error('NanoCo approval request timeout is invalid');
    }
  }

  async snapshot(signal: AbortSignal): Promise<ApprovalSnapshot> {
    const response = await this.#request('GET', '/v1/approvals/snapshot', undefined, signal);
    const body = await readBoundedJsonResponse(response, JSON_RESPONSE_LIMIT, this.#requestTimeoutMs);
    if (response.statusCode !== 200) throw new ApprovalTransportUnavailable('snapshot_response');
    return parseApprovalSnapshot(body, this.#deploymentId);
  }

  async events(
    gatewayEpoch: string,
    cursor: number,
    onEvent: (event: ApprovalEvent) => Promise<void>,
    signal: AbortSignal,
  ): Promise<'closed' | 'resync_required'> {
    const path = new URL('/v1/approvals/events', this.#origin);
    path.searchParams.set('gatewayEpoch', gatewayEpoch);
    path.searchParams.set('cursor', String(cursor));
    const response = await this.#request('GET', `${path.pathname}${path.search}`, undefined, signal);
    if (response.statusCode === 409) {
      const body = await readBoundedJsonResponse(response, JSON_RESPONSE_LIMIT, this.#requestTimeoutMs);
      if (isResyncRequired(body)) return 'resync_required';
      throw new ApprovalTransportUnavailable('events_response');
    }
    if (response.statusCode !== 200 || !response.headers['content-type']?.startsWith('text/event-stream')) {
      response.destroy();
      throw new ApprovalTransportUnavailable('events_response');
    }

    const parser = new SseApprovalParser(this.#deploymentId);
    try {
      for await (const chunk of response) {
        if (signal.aborted) return 'closed';
        for (const event of parser.push(Buffer.from(chunk))) {
          await onEvent(event);
        }
      }
      for (const event of parser.finish()) await onEvent(event);
    } catch (error) {
      if (error instanceof ApprovalTransportUnavailable || isAbortError(error)) throw error;
      throw new ApprovalTransportUnavailable('events_stream');
    }
    return 'closed';
  }

  async submit(command: DecisionCommand, signal: AbortSignal): Promise<DecisionSubmission> {
    const body = Buffer.from(JSON.stringify(command));
    const response = await this.#request(
      'PUT',
      `/v1/approvals/${encodeURIComponent(command.approvalId)}/decision`,
      body,
      signal,
    );
    const value = await readBoundedJsonResponse(response, JSON_RESPONSE_LIMIT, this.#requestTimeoutMs);
    if (response.statusCode === 200) {
      return { status: 'acknowledged', acknowledgement: parseDecisionAcknowledgement(value) };
    }
    if (response.statusCode === 409 && isResyncRequired(value)) return { status: 'resync_required' };
    if (response.statusCode === 404 || response.statusCode === 410 || response.statusCode === 409) {
      return { status: 'gone' };
    }
    if (response.statusCode === 503 || response.statusCode === 429 || (response.statusCode ?? 0) >= 500) {
      return { status: 'retry' };
    }
    return { status: 'rejected' };
  }

  toJSON(): string {
    return 'HttpsGatewayApprovalTransport([redacted])';
  }

  [inspect.custom](): string {
    return 'HttpsGatewayApprovalTransport([redacted])';
  }

  #request(
    method: string,
    pathname: string,
    body: Buffer | undefined,
    signal: AbortSignal,
  ): Promise<import('http').IncomingMessage> {
    if (signal.aborted) return Promise.reject(abortError());
    return new Promise((resolve, reject) => {
      const request = https.request(
        new URL(pathname, this.#origin),
        {
          method,
          ca: this.#ca,
          cert: this.#certificate,
          key: this.#privateKey,
          servername: this.#serverName,
          headers: body
            ? {
                'Content-Type': 'application/json',
                'Content-Length': body.length,
              }
            : undefined,
        },
        (response) => {
          clearTimeout(timeout);
          response.once('close', () => signal.removeEventListener('abort', abort));
          resolve(response);
        },
      );
      const timeout = setTimeout(
        () => request.destroy(new ApprovalTransportUnavailable('request_timeout')),
        this.#requestTimeoutMs,
      );
      const abort = (): void => {
        request.destroy(abortError());
      };
      signal.addEventListener('abort', abort, { once: true });
      request.once('error', (error) => {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abort);
        if (error instanceof ApprovalTransportUnavailable || isAbortError(error)) reject(error);
        else reject(new ApprovalTransportUnavailable('request_failed'));
      });
      request.end(body);
    });
  }
}

export class ApprovalTransportUnavailable extends Error {
  constructor(readonly code: ApprovalTransportFailureCode) {
    super(`NanoCo approval transport unavailable at ${code}`);
    this.name = 'ApprovalTransportUnavailable';
  }
}

export class SseApprovalParser {
  #buffer = '';
  readonly #decoder = new StringDecoder('utf8');

  constructor(private readonly deploymentId: string) {}

  push(chunk: Buffer): ApprovalEvent[] {
    return this.#append(this.#decoder.write(chunk));
  }

  finish(): ApprovalEvent[] {
    const events = this.#append(this.#decoder.end());
    if (this.#buffer.trim() !== '') throw new ApprovalTransportUnavailable('sse_parser');
    return events;
  }

  #append(text: string): ApprovalEvent[] {
    this.#buffer = `${this.#buffer}${text}`.replace(/\r\n/g, '\n');
    const events: ApprovalEvent[] = [];
    let boundary = this.#buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const frame = this.#buffer.slice(0, boundary);
      this.#buffer = this.#buffer.slice(boundary + 2);
      if (Buffer.byteLength(frame) > SSE_FRAME_LIMIT) {
        throw new ApprovalTransportUnavailable('sse_parser');
      }
      const event = this.#parseFrame(frame);
      if (event) events.push(event);
      boundary = this.#buffer.indexOf('\n\n');
    }
    if (Buffer.byteLength(this.#buffer) > SSE_FRAME_LIMIT) {
      throw new ApprovalTransportUnavailable('sse_parser');
    }
    return events;
  }

  #parseFrame(frame: string): ApprovalEvent | null {
    if (frame === '' || frame.split('\n').every((line) => line.startsWith(':'))) return null;
    let eventName = '';
    let id = '';
    const data: string[] = [];
    for (const line of frame.split('\n')) {
      if (line === '' || line.startsWith(':')) continue;
      const separator = line.indexOf(':');
      const field = separator < 0 ? line : line.slice(0, separator);
      let value = separator < 0 ? '' : line.slice(separator + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'event') eventName = value;
      else if (field === 'id') id = value;
      else if (field === 'data') data.push(value);
    }
    if (eventName !== 'approval' || !/^(0|[1-9][0-9]*)$/.test(id) || data.length === 0) {
      throw new ApprovalTransportUnavailable('sse_parser');
    }
    let value: unknown;
    const payload = data.join('\n');
    if (Buffer.byteLength(payload) > SSE_EVENT_JSON_LIMIT) {
      throw new ApprovalTransportUnavailable('sse_payload');
    }
    try {
      value = JSON.parse(payload);
    } catch {
      throw new ApprovalTransportUnavailable('sse_parser');
    }
    const event = parseApprovalEvent(value, this.deploymentId);
    if (event.eventId !== Number(id)) throw new ApprovalTransportUnavailable('sse_parser');
    return event;
  }
}

export async function readBoundedJsonResponse(
  response: import('http').IncomingMessage,
  limit: number,
  timeoutMs: number,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  const timeout = setTimeout(() => response.destroy(new ApprovalTransportUnavailable('response_timeout')), timeoutMs);
  try {
    for await (const chunk of response) {
      const bytes = Buffer.from(chunk);
      size += bytes.length;
      if (size > limit) throw new ApprovalTransportUnavailable('response_too_large');
      chunks.push(bytes);
    }
  } catch (error) {
    if (error instanceof ApprovalTransportUnavailable || isAbortError(error)) throw error;
    throw new ApprovalTransportUnavailable('request_failed');
  } finally {
    clearTimeout(timeout);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApprovalTransportUnavailable('response_json');
  }
}

function requireToken(value: string, name: string): string {
  const trimmed = value.trim();
  if (!trimmed || /\s/.test(trimmed)) throw new Error(`NanoCo ${name} is invalid`);
  return trimmed;
}

function abortError(): Error {
  const error = new Error('NanoCo approval transport stopped');
  error.name = 'AbortError';
  return error;
}

function isAbortError(error: unknown): error is Error {
  return error instanceof Error && error.name === 'AbortError';
}
