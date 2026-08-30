import fs from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import https from 'node:https';
import { X509Certificate } from 'node:crypto';
import type { TLSSocket } from 'node:tls';

import { dispatch } from '../../cli/dispatch.js';
import type { RequestFrame, ResponseFrame } from '../../cli/frame.js';
import { log } from '../../log.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_BIND = '0.0.0.0';

let server: https.Server | null = null;

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required for the NCL control listener`);
  return value;
}

function port(name: string): number {
  const value = Number(required(name));
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error(`${name} must be a TCP port`);
  }
  return value;
}

function fingerprints(paths: string): Set<string> {
  const values = paths.split(',').filter(Boolean).map((path) => new X509Certificate(fs.readFileSync(path)).fingerprint256);
  if (values.length === 0) throw new Error('NANOCLAW_NCL_CONTROL_ALLOWED_CLIENT_CERTS must name at least one certificate');
  return new Set(values);
}

export function isRequestFrame(value: unknown): value is RequestFrame {
  if (!value || typeof value !== 'object') return false;
  const frame = value as Record<string, unknown>;
  return typeof frame.id === 'string' && frame.id.length > 0 &&
    typeof frame.command === 'string' && frame.command.length > 0 &&
    !!frame.args && typeof frame.args === 'object' && !Array.isArray(frame.args);
}

function write(res: ServerResponse, status: number, frame: ResponseFrame | { error: string }): void {
  const body = JSON.stringify(frame);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function body(req: IncomingMessage): Promise<string> {
  const declared = Number(req.headers['content-length'] ?? 0);
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += value.length;
    if (size > MAX_BODY_BYTES) throw new Error('request body exceeds 1 MiB');
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function peerAllowed(socket: TLSSocket, allowed: ReadonlySet<string>): boolean {
  if (!socket.authorized) return false;
  const peer = socket.getPeerCertificate();
  return typeof peer.fingerprint256 === 'string' && allowed.has(peer.fingerprint256);
}

export async function startNclControlServer(): Promise<void> {
  if (server) throw new Error('NCL control listener already started');
  const bind = process.env.NANOCLAW_NCL_CONTROL_BIND ?? DEFAULT_BIND;
  const listenPort = port('NANOCLAW_NCL_CONTROL_PORT');
  const allowed = fingerprints(required('NANOCLAW_NCL_CONTROL_ALLOWED_CLIENT_CERTS'));
  const created = https.createServer(
    {
      cert: fs.readFileSync(required('NANOCLAW_NCL_CONTROL_TLS_CERT')),
      key: fs.readFileSync(required('NANOCLAW_NCL_CONTROL_TLS_KEY')),
      ca: fs.readFileSync(required('NANOCLAW_NCL_CONTROL_CLIENT_CA')),
      requestCert: true,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.3',
    },
    (req, res) => {
      void (async () => {
        if (!peerAllowed(req.socket as TLSSocket, allowed)) {
          write(res, 403, { error: 'client certificate is not enrolled for NCL control' });
          return;
        }
        if (req.method !== 'POST' || req.url !== '/v1/commands') {
          write(res, 404, { error: 'not found' });
          return;
        }
        let parsed: unknown;
        try {
          parsed = JSON.parse(await body(req));
        } catch (err) {
          write(res, 400, { error: err instanceof Error ? err.message : 'invalid request body' });
          return;
        }
        if (!isRequestFrame(parsed)) {
          write(res, 400, { error: 'invalid NCL request frame' });
          return;
        }
        // The exact enrolled certificate is the host-caller boundary. Caller
        // identity never comes from an HTTP header or from the request body.
        write(res, 200, await dispatch(parsed, { caller: 'host' }));
      })().catch((err) => {
        log.error('NCL control request failed', { err });
        if (!res.headersSent) write(res, 500, { error: 'NCL control request failed' });
        else res.destroy();
      });
    },
  );
  created.requestTimeout = 10_000;
  created.headersTimeout = 5_000;
  created.keepAliveTimeout = 1_000;
  created.maxRequestsPerSocket = 1;
  server = created;
  await new Promise<void>((resolve, reject) => {
    created.once('error', reject);
    created.listen(listenPort, bind, resolve);
  });
  log.info('NCL mTLS control listener ready', { bind, port: listenPort });
}

export async function stopNclControlServer(): Promise<void> {
  if (!server) return;
  const current = server;
  server = null;
  await new Promise<void>((resolve, reject) => current.close((err) => err ? reject(err) : resolve()));
}
