import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Readable, Transform } from 'node:stream';

import { gatewaySignedHostFetch } from '../modules/s3-mailbox/gateway-host-fetch.js';

/**
 * minio-go frames a PUT body as `aws-chunked` whenever it signs for a PLAINTEXT
 * endpoint, which this loopback proxy necessarily is. It announces that with
 * this sha256 marker, sends the framed length as `content-length`, and the real
 * one as `x-amz-decoded-content-length`.
 */
const AWS_CHUNKED_SHA256 = 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD';
/** A chunk header is `<hex-size>;chunk-signature=<64 hex>`; this is generous. */
const MAX_CHUNK_HEADER_BYTES = 1024;

const SYNTHETIC_AWS_HEADERS = new Set([
  'authorization',
  'host',
  'x-amz-content-sha256',
  'x-amz-date',
  'x-amz-security-token',
  'x-nanoco-scope-storage-capability',
]);
const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  // AWS SDK S3 adds this on PutObject. Node's server has already completed
  // the 100-continue exchange with the SDK; Undici refuses to forward the
  // header at all, so retaining it turns the first workspace write into a
  // local `fetch failed` before Gateway ever sees the request.
  'expect',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const KMS_TARGETS = new Set([
  'TrentService.DescribeKey',
  'TrentService.CreateKey',
  'TrentService.CreateAlias',
  'TrentService.Encrypt',
  'TrentService.Decrypt',
]);
// This must match the Governance catalog and Gateway staging ceiling. Keeping
// the local adapter looser would only move an oversized refusal downstream.
const KMS_BODY_LIMIT = 4096;

export interface GatewayWorkspaceProxyOptions {
  proxy: string;
  proxyCaPath: string;
  capability: string;
  region: string;
  bucket: string;
  scopePrefix: string;
}

export interface GatewayWorkspaceProxy {
  s3Endpoint: string;
  kmsEndpoint: string;
  syntheticCredentials: { accessKeyId: string; secretAccessKey: string };
  resticEnvironment: Record<string, string>;
  close(): Promise<void>;
}

/**
 * Start two loopback-only AWS protocol adapters. They hold no cloud credential:
 * the static strings returned here merely satisfy clients that insist on
 * producing a signature, which the adapter removes before Gateway signs.
 */
export async function startGatewayWorkspaceProxy(
  options: GatewayWorkspaceProxyOptions,
): Promise<GatewayWorkspaceProxy> {
  validateOptions(options);
  const upstream = gatewaySignedHostFetch({
    proxy: options.proxy,
    proxyCaPath: options.proxyCaPath,
    capability: options.capability,
  });
  const s3 = createServer((req, res) => void handleS3(req, res, options, upstream.fetch));
  const kms = createServer((req, res) => void handleKms(req, res, options, upstream.fetch));
  const [s3Endpoint, kmsEndpoint] = await Promise.all([listen(s3), listen(kms)]);
  const syntheticCredentials = {
    accessKeyId: 'NANOCOGATEWAYONLY',
    secretAccessKey: 'not-a-cloud-credential',
  };
  return {
    s3Endpoint,
    kmsEndpoint,
    syntheticCredentials,
    resticEnvironment: {
      AWS_ACCESS_KEY_ID: syntheticCredentials.accessKeyId,
      AWS_SECRET_ACCESS_KEY: syntheticCredentials.secretAccessKey,
      AWS_REGION: options.region,
    },
    close: async () => {
      await Promise.all([close(s3), close(kms)]);
    },
  };
}

type ScopedFetch = (input: string, init?: RequestInit) => Promise<Response>;

async function handleS3(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayWorkspaceProxyOptions,
  fetchUpstream: ScopedFetch,
): Promise<void> {
  try {
    const local = requestUrl(req);
    const bucketPath = `/${encodeURIComponent(options.bucket)}`;
    const bucketRoot = local.pathname === bucketPath || local.pathname === `${bucketPath}/`;
    const objectRoot = `${bucketPath}/${encodeKey(options.scopePrefix)}`;
    if (!bucketRoot && !local.pathname.startsWith(`${objectRoot}/`)) {
      return refuse(res, 403, 'workspace S3 path is outside the assigned environment prefix');
    }
    const query = new URLSearchParams(local.searchParams);
    if (req.method === 'GET' && bucketRoot && query.has('location')) {
      process.stdout.write(`workspace S3 location answered locally region=${options.region}\n`);
      return writeBuffered(
        res,
        200,
        new Headers({ 'content-type': 'application/xml' }),
        `<LocationConstraint xmlns="http://s3.amazonaws.com/doc/2006-03-01/">${options.region}</LocationConstraint>`,
      );
    }
    // `restic init` probes the bucket with minio-go's BucketExists before it
    // writes anything. Answer it here, for the same reason GetBucketLocation is
    // answered here: the bucket is fixed by this proxy's own configuration, so
    // the reply is already known and reveals nothing the caller did not supply.
    //
    // It cannot be forwarded. A bucket-root probe carries no object key, and
    // the workspace capability grants only key-bearing operations
    // (`aws-s3:{get,put,delete}-workspace-object` and their parent variants),
    // so upstream it has no operation to match and Gateway blocks it — leaving
    // the Custodian unable to create a repository at all.
    //
    // This does not weaken the boundary: the prefix check above still runs, and
    // every byte restic goes on to read or write is a keyed request that
    // Gateway authorises normally. A bucket that genuinely did not exist would
    // fail loudly on the very next call, the `config` PUT.
    if (req.method === 'HEAD' && bucketRoot && [...query.keys()].length === 0) {
      process.stdout.write(`workspace S3 bucket probe answered locally bucket=${options.bucket}\n`);
      return writeBuffered(res, 200, new Headers(), '');
    }
    const requestedPrefix = query.get('prefix');
    const requestedDelimiter = query.get('delimiter');
    const isList = req.method === 'GET' && bucketRoot && requestedPrefix !== null;
    if (isList) {
      const root = `${options.scopePrefix.replace(/\/+$/, '')}/`;
      if (!requestedPrefix || !requestedPrefix.startsWith(root)) {
        return refuse(res, 403, 'workspace S3 list prefix is outside the assigned environment prefix');
      }
      query.set('prefix', root);
      // The delimiter must NOT ride upstream with the widened prefix: Gateway
      // admits only the scope-root prefix, and grouping at the root folds the
      // client's requested subtree into a CommonPrefix the Contents filter
      // below can never match. Measured on nancy-v3 (custodian g12 tap):
      // restic lists `keys/` with a delimiter, received an empty filtered
      // listing, and truthfully reported "no key found" while the key existed
      // byte-perfect. Forward recursive; regroup client-side.
      if (requestedDelimiter !== null) query.delete('delimiter');
    }
    // Always address the bucket root by its canonical, slash-less form. S3
    // accepts `/bucket/` — restic's `BucketExists`, the first call `restic
    // init` makes, sends exactly that — but the Gateway classifies the empty
    // trailing segment as `path_not_canonical` and blocks with 400 before any
    // upstream I/O, so the repository can never be created:
    //
    //   client.BucketExists: 400 Bad Request
    //
    // The list branch already normalised this way; every other bucket-root
    // call forwarded `local.pathname` verbatim and hit the wall. Normalising
    // here rather than loosening the Gateway keeps the canonical path a strict
    // property of the boundary, where a parser difference between what policy
    // matches and what S3 acts on would otherwise live.
    const target = new URL(`https://s3.${options.region}.amazonaws.com${bucketRoot ? bucketPath : local.pathname}`);
    target.search = query.toString();
    // Unwrap `aws-chunked` before it leaves. Gateway signs this request
    // UNSIGNED-PAYLOAD and treats aws-chunked as a separate primitive it does
    // not implement, so forwarding the framing intact makes S3 answer 400 to
    // every write: the bytes on the wire carry chunk headers and per-chunk
    // signatures that the signature says are not there. restic then retries
    // forever and the repository is never created.
    const headers = forwardedHeaders(req);
    const chunked = singleHeader(req, 'x-amz-content-sha256') === AWS_CHUNKED_SHA256;
    let body: unknown = requestHasBody(req) ? req : undefined;
    if (chunked && body) {
      // The decoded length is the only one upstream may see; the framed
      // `content-length` describes bytes that no longer exist after decoding.
      const decoded = singleHeader(req, 'x-amz-decoded-content-length');
      if (decoded) headers.set('content-length', decoded);
      else headers.delete('content-length');
      body = (req as NodeJS.ReadableStream).pipe(decodeAwsChunked());
    }
    headers.delete('x-amz-decoded-content-length');
    const response = await fetchUpstream(target.toString(), {
      method: req.method,
      headers,
      ...(body ? { body: body as never, duplex: 'half' } : {}),
    } as RequestInit);
    if (isList && response.ok) {
      const body = filterListObjects(await response.text(), requestedPrefix!, requestedDelimiter);
      return writeBuffered(res, response.status, response.headers, body);
    }
    // Gateway deliberately returns a small safe error body rather than
    // forwarding provider error bytes. AWS SDK S3 still needs the protocol's
    // XML error envelope to preserve the HTTP 404 metadata that the snapshot
    // store interprets as "not created yet" on first workspace boot.
    if (req.method === 'GET' && !isList && response.status === 404) {
      return writeBuffered(
        res,
        404,
        new Headers({ 'content-type': 'application/xml' }),
        '<Error><Code>NoSuchKey</Code><Message>The specified key does not exist.</Message></Error>',
      );
    }
    await pipeResponse(res, response);
  } catch (error) {
    refuse(res, 502, safeError(error));
  }
}

async function handleKms(
  req: IncomingMessage,
  res: ServerResponse,
  options: GatewayWorkspaceProxyOptions,
  fetchUpstream: ScopedFetch,
): Promise<void> {
  try {
    if (req.method !== 'POST' || requestUrl(req).pathname !== '/') {
      return refuse(res, 405, 'workspace KMS accepts POST / only');
    }
    const targetName = singleHeader(req, 'x-amz-target');
    if (!targetName || !KMS_TARGETS.has(targetName)) {
      return refuse(res, 403, 'workspace KMS target is not allowed');
    }
    const body = await readBody(req, KMS_BODY_LIMIT);
    validateKmsRequest(targetName, body);
    const response = await fetchUpstream(`https://kms.${options.region}.amazonaws.com/`, {
      method: 'POST',
      headers: forwardedHeaders(req),
      body,
    });
    await pipeResponse(res, response);
  } catch (error) {
    refuse(res, 502, safeError(error));
  }
}

function validateKmsRequest(target: string, bytes: Uint8Array): void {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('workspace KMS body must be JSON');
  }
  const alias = (body.KeyId ?? body.AliasName) as unknown;
  if (target !== 'TrentService.CreateKey') {
    if (typeof alias !== 'string' || !/^alias\/nanoco-k8s\/agent-group\/[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(alias)) {
      throw new Error('workspace KMS key must be an Agent Group alias');
    }
  }
  if (target === 'TrentService.CreateKey') {
    const tags = Array.isArray(body.Tags) ? body.Tags as Array<Record<string, unknown>> : [];
    const tagged = tags.some((tag) => tag.TagKey === 'NanoCoAgentGroup' && tag.TagValue === 'true');
    const group = tags.find((tag) => tag.TagKey === 'NanoCoAgentGroupId')?.TagValue;
    if (!tagged || typeof group !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(group)) {
      throw new Error('workspace KMS CreateKey requires the Agent Group tags');
    }
  }
  if (target === 'TrentService.Encrypt' || target === 'TrentService.Decrypt') {
    const context = body.EncryptionContext as Record<string, unknown> | undefined;
    if (!context || typeof context['nanoco-agent-group'] !== 'string' || !['gocryptfs', 'restic'].includes(String(context['nanoco-purpose']))) {
      throw new Error('workspace KMS request requires the group and purpose encryption context');
    }
  }
}

function validateOptions(options: GatewayWorkspaceProxyOptions): void {
  if (!/^[a-z]{2}(?:-gov)?-[a-z]+-\d$/.test(options.region)) throw new Error('invalid workspace AWS region');
  if (!options.bucket || /[\\/]/.test(options.bucket)) throw new Error('invalid workspace S3 bucket');
  const prefix = options.scopePrefix.replace(/^\/+|\/+$/g, '');
  if (!prefix || prefix.includes('..') || !/^[A-Za-z0-9._/-]+$/.test(prefix)) {
    throw new Error('invalid workspace S3 scope prefix');
  }
}

function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? '/', 'http://127.0.0.1');
}

/**
 * Strip `aws-chunked` framing, emitting only the bytes it wraps.
 *
 * The framing is `<hex-size>;chunk-signature=<sig>\r\n<size bytes>\r\n`,
 * repeated, ending at a zero-length chunk. Per-chunk signatures are discarded
 * rather than checked: they authenticate the caller to THIS proxy over
 * loopback, and Gateway re-signs what it forwards with its own credential.
 *
 * Decoding streams rather than buffering, because a restic pack is far larger
 * than anything worth holding in memory.
 */
function decodeAwsChunked(): Transform {
  let pending = Buffer.alloc(0);
  let state: 'header' | 'data' | 'epilogue' | 'done' = 'header';
  let remaining = 0;
  return new Transform({
    transform(part: Buffer, _encoding, done) {
      pending = pending.length === 0 ? Buffer.from(part) : Buffer.concat([pending, part]);
      try {
        for (;;) {
          if (state === 'done') {
            pending = Buffer.alloc(0);
            break;
          }
          if (state === 'data') {
            const take = Math.min(remaining, pending.length);
            if (take > 0) {
              this.push(pending.subarray(0, take));
              pending = pending.subarray(take);
              remaining -= take;
            }
            if (remaining > 0) break;
            state = 'epilogue';
            continue;
          }
          if (state === 'epilogue') {
            // The CRLF that closes a chunk's data, consumed as its own state so
            // a split between the data and that CRLF cannot be read as a header.
            if (pending.length < 2) break;
            pending = pending.subarray(2);
            state = 'header';
            continue;
          }
          const end = pending.indexOf('\r\n');
          if (end < 0) {
            if (pending.length > MAX_CHUNK_HEADER_BYTES) throw new Error('aws-chunked header is too long');
            break;
          }
          const size = Number.parseInt(pending.subarray(0, end).toString('latin1').split(';', 1)[0]!, 16);
          if (!Number.isSafeInteger(size) || size < 0) throw new Error('aws-chunked chunk size is not a hex length');
          pending = pending.subarray(end + 2);
          if (size === 0) {
            // A zero-length chunk ends the body; any trailer after it is not
            // part of the object and is deliberately dropped.
            state = 'done';
            continue;
          }
          remaining = size;
          state = 'data';
        }
        done();
      } catch (error) {
        done(error as Error);
      }
    },
  });
}

function requestHasBody(req: IncomingMessage): boolean {
  return req.method !== 'GET' && req.method !== 'HEAD';
}

function forwardedHeaders(req: IncomingMessage): Headers {
  const headers = new Headers();
  for (const [name, raw] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (SYNTHETIC_AWS_HEADERS.has(lower) || HOP_BY_HOP_HEADERS.has(lower) || raw === undefined) continue;
    for (const value of Array.isArray(raw) ? raw : [raw]) headers.append(name, value);
  }
  return headers;
}

function singleHeader(req: IncomingMessage, name: string): string | null {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw.length === 1 ? raw[0] ?? null : null;
  return raw ?? null;
}

async function readBody(req: IncomingMessage, limit: number): Promise<Uint8Array> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) throw new Error('workspace KMS request body is too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

function filterListObjects(xml: string, prefix: string, delimiter: string | null = null): string {
  const escapeXml = (value: string): string =>
    value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const within = [...xml.matchAll(/<Contents>[\s\S]*?<\/Contents>/g)]
    .map((match) => match[0])
    .filter((entry) => xmlValue(entry, 'Key').startsWith(prefix));
  // The upstream list ran RECURSIVE at the scope root (see the delimiter note
  // at the call site), so the client's grouping is reconstructed here: an
  // entry with the delimiter after the requested prefix becomes a
  // CommonPrefix, everything else stays a Contents entry.
  const kept: string[] = [];
  const grouped = new Set<string>();
  for (const entry of within) {
    const key = xmlValue(entry, 'Key');
    const rest = key.slice(prefix.length);
    const at = delimiter ? rest.indexOf(delimiter) : -1;
    if (delimiter && at >= 0) grouped.add(`${prefix}${rest.slice(0, at + delimiter.length)}`);
    else kept.push(entry);
  }
  const prefixes = [...grouped]
    .sort()
    .map((value) => `<CommonPrefixes><Prefix>${escapeXml(value)}</Prefix></CommonPrefixes>`)
    .join('');
  let body = xml
    .replace(/<Contents>[\s\S]*?<\/Contents>/g, '')
    .replace(/<CommonPrefixes>[\s\S]*?<\/CommonPrefixes>/g, '');
  // Echo the REQUEST the client actually made: minio validates the response
  // Prefix/Delimiter against what it asked for, and the widened root would
  // read as another bucket's answer.
  body = body.replace(/<Prefix>[\s\S]*?<\/Prefix>/, `<Prefix>${escapeXml(prefix)}</Prefix>`);
  if (delimiter && !/<Delimiter>/.test(body)) {
    body = body.replace('</ListBucketResult>', `<Delimiter>${escapeXml(delimiter)}</Delimiter></ListBucketResult>`);
  }
  const inserted = body.replace('</ListBucketResult>', `${kept.join('')}${prefixes}</ListBucketResult>`);
  return inserted.replace(/<KeyCount>\d+<\/KeyCount>/, `<KeyCount>${kept.length + grouped.size}</KeyCount>`);
}

function xmlValue(xml: string, tag: string): string {
  const value = new RegExp(`<${tag}>([\\s\\S]*?)<\\/${tag}>`).exec(xml)?.[1] ?? '';
  return value.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
}

function encodeKey(value: string): string {
  return value.replace(/^\/+|\/+$/g, '').split('/').map(encodeURIComponent).join('/');
}

async function pipeResponse(res: ServerResponse, response: Response): Promise<void> {
  res.statusCode = response.status;
  copyResponseHeaders(res, response.headers);
  if (!response.body) return void res.end();
  Readable.fromWeb(response.body as never).pipe(res);
}

function writeBuffered(res: ServerResponse, status: number, headers: Headers, body: string): void {
  res.statusCode = status;
  copyResponseHeaders(res, headers);
  res.setHeader('content-length', Buffer.byteLength(body));
  res.end(body);
}

function copyResponseHeaders(res: ServerResponse, headers: Headers): void {
  for (const [name, value] of headers) {
    if (HOP_BY_HOP_HEADERS.has(name.toLowerCase())) continue;
    res.setHeader(name, value);
  }
}

function refuse(res: ServerResponse, status: number, message: string): void {
  if (res.headersSent) return void res.destroy();
  res.statusCode = status;
  res.setHeader('content-type', 'text/plain; charset=utf-8');
  res.end(`${message}\n`);
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : 'workspace proxy failed';
}

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('workspace proxy did not bind TCP');
  return `http://127.0.0.1:${address.port}`;
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}
