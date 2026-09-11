/**
 * The door socket (`data/door/host.sock`, mode 0600): HTTP/1.1 + JSON, the
 * one channel between the forced commands (children of the OpenSSH server)
 * and the host process. The routes:
 *
 *   GET  /target?port=N                → the relayed stream behind that source port · 404 no_target
 *   GET  /authorize?fingerprint=F      → { status: approved | unknown | disabled }
 *   POST /pending { fingerprint, keyType, publicKey, port }
 *                                      → { code?, url, expiresAt } · 429 pending_limit
 *   GET  /approval?fingerprint=F&wait=S → long-poll ≤ 25 s → { approved }
 *   POST /session { port, pid, fingerprint } → { ok } (registers a landing for kill-on-revoke)
 */
import fs from 'node:fs';
import http from 'node:http';

import type { PendingKeyResult } from './report.js';
import { validPort, type DoorStream } from './target-map.js';

export type AuthorizeStatus = 'approved' | 'unknown' | 'disabled';

export interface PendingRequest {
  fingerprint: string;
  keyType: string;
  publicKey: string;
  port?: number;
}

export interface SessionRequest {
  port?: number;
  pid: number;
  fingerprint: string;
}

export interface HostSocketDeps {
  lookupTarget: (port: number) => DoorStream | undefined;
  authorize: (fingerprint: string) => AuthorizeStatus;
  pending: (request: PendingRequest) => Promise<PendingKeyResult | 'limit'>;
  waitApproval: (fingerprint: string, waitMs: number) => Promise<boolean>;
  registerSession: (request: SessionRequest) => void;
}

export const MAX_APPROVAL_WAIT_MS = 25_000;
const MAX_BODY_BYTES = 16 * 1024;

let server: http.Server | undefined;
let serverPath: string | undefined;

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        chunks.length = 0;
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        reject(new Error('body is not JSON', { cause: error }));
      }
    });
    req.on('error', reject);
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

async function handle(deps: HostSocketDeps, req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://door');
  const reply = (status: number, body: unknown): void => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const route = `${req.method} ${url.pathname}`;
  switch (route) {
    case 'GET /target': {
      const port = Number(url.searchParams.get('port'));
      if (!validPort(port)) return reply(400, { error: 'invalid_port' });
      const stream = deps.lookupTarget(port);
      return stream ? reply(200, stream) : reply(404, { error: 'no_target' });
    }
    case 'GET /authorize': {
      const fingerprint = url.searchParams.get('fingerprint');
      if (!fingerprint) return reply(400, { error: 'invalid_fingerprint' });
      return reply(200, { status: deps.authorize(fingerprint) });
    }
    case 'GET /approval': {
      const fingerprint = url.searchParams.get('fingerprint');
      if (!fingerprint) return reply(400, { error: 'invalid_fingerprint' });
      const waitS = Number(url.searchParams.get('wait') ?? '0');
      const waitMs = Math.min(MAX_APPROVAL_WAIT_MS, Math.max(0, Number.isFinite(waitS) ? waitS * 1000 : 0));
      return reply(200, { approved: await deps.waitApproval(fingerprint, waitMs) });
    }
    case 'POST /pending': {
      const body = await readBody(req);
      if (
        !isRecord(body) ||
        typeof body.fingerprint !== 'string' ||
        typeof body.keyType !== 'string' ||
        typeof body.publicKey !== 'string'
      ) {
        return reply(400, { error: 'invalid_body' });
      }
      const port = typeof body.port === 'number' && validPort(body.port) ? body.port : undefined;
      const result = await deps.pending({
        fingerprint: body.fingerprint,
        keyType: body.keyType,
        publicKey: body.publicKey,
        ...(port !== undefined ? { port } : {}),
      });
      return result === 'limit' ? reply(429, { error: 'pending_limit' }) : reply(200, result);
    }
    case 'POST /session': {
      const body = await readBody(req);
      if (!isRecord(body) || typeof body.fingerprint !== 'string' || !Number.isInteger(body.pid)) {
        return reply(400, { error: 'invalid_body' });
      }
      const port = typeof body.port === 'number' && validPort(body.port) ? body.port : undefined;
      deps.registerSession({
        pid: body.pid as number,
        fingerprint: body.fingerprint,
        ...(port !== undefined ? { port } : {}),
      });
      return reply(200, { ok: true });
    }
    default:
      return reply(404, { error: 'not_found' });
  }
}

/** Serve the door socket (mode 0600). Idempotent while running. */
export async function startHostSocket(socketPath: string, deps: HostSocketDeps): Promise<void> {
  if (server) return;
  await fs.promises.rm(socketPath, { force: true });
  const s = http.createServer((req, res) => {
    handle(deps, req, res).catch((error: unknown) => {
      if (!res.headersSent) {
        const status = (error as { status?: number }).status ?? 400;
        res.writeHead(status, { 'content-type': 'application/json', connection: 'close' });
        res.end(JSON.stringify({ error: error instanceof Error ? error.message : 'bad_request' }));
      } else {
        res.destroy();
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    s.once('error', reject);
    s.listen(socketPath, () => {
      s.off('error', reject);
      fs.chmodSync(socketPath, 0o600);
      resolve();
    });
  });
  server = s;
  serverPath = socketPath;
}

export async function stopHostSocket(): Promise<void> {
  const s = server;
  const p = serverPath;
  server = undefined;
  serverPath = undefined;
  if (!s) return;
  s.closeAllConnections();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  if (p) await fs.promises.rm(p, { force: true });
}
