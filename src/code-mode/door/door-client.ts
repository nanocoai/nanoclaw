/**
 * The forced commands' side of the door socket: one small HTTP call per
 * question. Connection failures throw; the callers decide what a silent
 * host means for them (the authorizer prints nothing, the waiting room
 * keeps waiting, the landing refuses).
 */
import http from 'node:http';

import type { AuthorizeStatus, PendingRequest, SessionRequest } from './host-socket.js';
import type { PendingKeyResult } from './report.js';
import type { DoorStream } from './target-map.js';

interface Reply {
  status: number;
  body: unknown;
}

export function doorRequest(
  socketPath: string,
  method: 'GET' | 'POST',
  path: string,
  body?: unknown,
  timeoutMs = 3000,
): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method,
        timeout: timeoutMs,
        headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          try {
            resolve({ status: res.statusCode ?? 0, body: text ? JSON.parse(text) : undefined });
          } catch (error) {
            if (!(error instanceof SyntaxError)) throw error;
            reject(new Error(`malformed answer from the host: ${error.message}`, { cause: error }));
          }
        });
        res.on('error', reject);
      },
    );
    req.on('timeout', () => req.destroy(new Error('the host did not answer in time')));
    req.on('error', reject);
    req.end(payload);
  });
}

export async function fetchTarget(socketPath: string, port: number): Promise<DoorStream | undefined> {
  const { status, body } = await doorRequest(socketPath, 'GET', `/target?port=${port}`);
  if (status === 404) return undefined;
  const stream = body as DoorStream | undefined;
  if (status !== 200 || typeof stream?.target?.account !== 'string') {
    throw new Error(`target lookup failed (${status})`);
  }
  return stream;
}

export async function authorize(socketPath: string, fingerprint: string): Promise<AuthorizeStatus> {
  const { status, body } = await doorRequest(
    socketPath,
    'GET',
    `/authorize?fingerprint=${encodeURIComponent(fingerprint)}`,
  );
  const answer = (body as { status?: unknown } | undefined)?.status;
  if (status !== 200 || (answer !== 'approved' && answer !== 'unknown' && answer !== 'disabled')) {
    throw new Error(`authorize failed (${status})`);
  }
  return answer;
}

export async function postPending(socketPath: string, request: PendingRequest): Promise<PendingKeyResult | 'limit'> {
  const { status, body } = await doorRequest(socketPath, 'POST', '/pending', request);
  if (status === 429) return 'limit';
  const result = body as PendingKeyResult | undefined;
  if (status !== 200 || typeof result?.url !== 'string') throw new Error(`pending registration failed (${status})`);
  return result;
}

/** One long-poll round: the host answers within `waitS` seconds. */
export async function waitApproval(socketPath: string, fingerprint: string, waitS: number): Promise<boolean> {
  const path = `/approval?fingerprint=${encodeURIComponent(fingerprint)}&wait=${waitS}`;
  const { status, body } = await doorRequest(socketPath, 'GET', path, undefined, waitS * 1000 + 5000);
  if (status !== 200) throw new Error(`approval poll failed (${status})`);
  return (body as { approved?: unknown } | undefined)?.approved === true;
}

export async function postSession(socketPath: string, request: SessionRequest): Promise<void> {
  const { status } = await doorRequest(socketPath, 'POST', '/session', request);
  if (status !== 200) throw new Error(`session registration failed (${status})`);
}
