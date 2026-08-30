/**
 * End-to-end: the REAL restic binary against the loopback proxy, with an
 * upstream that refuses what Gateway and S3 actually refuse.
 *
 * The unit suite mocks the upstream with a fake that answers 200 to anything.
 * That fake accepted a trailing-slash bucket root (Gateway returns 400,
 * `path_not_canonical`), a bucket-root HEAD (no operation in the catalog
 * matches a keyless path), and an aws-chunked body (Gateway signs
 * UNSIGNED-PAYLOAD, so S3 rejects the framing). All three shipped green and
 * failed in the cluster, one deploy at a time.
 *
 * So this upstream encodes the contract instead of waving requests through,
 * and the client is restic itself rather than a hand-written request — the
 * bugs were in what restic really sends, which is precisely what a hand-written
 * request cannot capture.
 */
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { afterEach, describe, expect, test, vi } from 'vitest';

const run = promisify(execFile);

/** Objects, keyed by the S3 key. Shared by the upstream below. */
const store = new Map<string, Buffer>();
/** Every rejection the strict upstream made, for assertions. */
const refusals: string[] = [];

const BUCKET = 'workspace-bucket';
const DEPLOYMENT = 'omri-test';
const GROUP = 'd9cf1e39-bce5-4d1b-801b-a60c82bdcb8c';
const SCOPE = `${DEPLOYMENT}/restic/${GROUP}`;

/**
 * Gateway's request classifier: a path is canonical only when no segment is
 * empty. This is the rule that rejected `/bucket/`.
 */
function canonicalPath(pathname: string): boolean {
  if (pathname === '/') return true;
  return pathname.slice(1).split('/').every((segment) => segment.length > 0);
}

/**
 * The operation catalog, reduced to the shapes it really carries: a bucket-root
 * GET (list), and keyed reads/writes under `<deployment>/restic/<group>/`.
 * There is deliberately NO bucket-root HEAD — the live bundle has none, which
 * is why the BucketExists probe can never be forwarded.
 */
function operationFor(method: string, pathname: string): string | null {
  const segments = pathname.slice(1).split('/');
  if (segments[0] !== BUCKET) return null;
  const key = segments.slice(1).join('/');
  if (key === '') return method === 'GET' ? 'aws-s3:list-mailbox-objects' : null;
  if (!key.startsWith(`${SCOPE}/`)) return null;
  return method === 'GET' || method === 'HEAD' || method === 'PUT' || method === 'DELETE'
    ? `aws-s3:${method.toLowerCase()}-parent-workspace-object`
    : null;
}

function headerOf(init: RequestInit, name: string): string | null {
  return new Headers(init.headers as never).get(name);
}

const upstream = vi.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  const method = (init.method ?? 'GET').toUpperCase();

  if (!canonicalPath(url.pathname)) {
    refusals.push(`path_not_canonical ${method} ${url.pathname}`);
    return new Response('', { status: 400 });
  }
  if (!operationFor(method, url.pathname)) {
    refusals.push(`no_matching_operation ${method} ${url.pathname}`);
    return new Response('', { status: 400 });
  }

  const body = init.body ? Buffer.from(await new Response(init.body as never).arrayBuffer()) : Buffer.alloc(0);
  // Gateway signs UNSIGNED-PAYLOAD and does not implement aws-chunked, so a
  // framed body is bytes S3 was never told about. Left intact, S3 stores the
  // chunk headers AS the object — verified against the real bucket, which
  // accepted 192 bytes of framing for a 19-byte payload.
  if (body.includes('chunk-signature')) {
    refusals.push(`aws_chunked_forwarded ${method} ${url.pathname}`);
    return new Response('', { status: 400 });
  }
  // S3 verifies Content-MD5 when the client sends one, and restic always does.
  // It is computed over the DECODED payload, so forwarding it beside a framed
  // body is what actually produced the live failure:
  //   <Error><Code>BadDigest</Code>The Content-MD5 you specified did not match
  //   what we received.</Error>
  // A fake that ignores the header cannot catch that, which is why it is here.
  const md5 = headerOf(init, 'content-md5');
  if (md5 && createHash('md5').update(body).digest('base64') !== md5) {
    refusals.push(`bad_digest ${method} ${url.pathname}`);
    return new Response(
      '<Error><Code>BadDigest</Code><Message>The Content-MD5 you specified did not match what we received.</Message></Error>',
      { status: 400, headers: { 'content-type': 'application/xml' } },
    );
  }

  const key = url.pathname.slice(BUCKET.length + 2);
  if (method === 'PUT') {
    store.set(key, body);
    return new Response('', { status: 200, headers: { etag: '"v1"' } });
  }
  if (method === 'DELETE') {
    store.delete(key);
    // 204 carries no body; constructing one with a body throws in undici.
    return new Response(null, { status: 204 });
  }
  if (key === '') {
    const prefix = url.searchParams.get('prefix') ?? '';
    const contents = [...store.entries()]
      .filter(([k]) => k.startsWith(prefix))
      .map(([k, v]) => `<Contents><Key>${k}</Key><Size>${v.length}</Size><ETag>&quot;v1&quot;</ETag></Contents>`)
      .join('');
    return new Response(
      `<ListBucketResult><Name>${BUCKET}</Name><KeyCount>0</KeyCount><IsTruncated>false</IsTruncated>${contents}</ListBucketResult>`,
      { status: 200, headers: { 'content-type': 'application/xml' } },
    );
  }
  const object = store.get(key);
  if (!object) return new Response('missing', { status: 404 });
  // S3 always dates an object, and restic's Stat refuses a response without it
  // ("Last-Modified time format is invalid"). A fake that omits it is not
  // modelling the upstream, it is inventing a laxer one.
  const dated = { etag: '"v1"', 'last-modified': new Date(0).toUTCString() };
  if (method === 'HEAD') {
    return new Response('', { status: 200, headers: { ...dated, 'content-length': String(object.length) } });
  }
  // restic reads individual blobs out of a pack with a ranged GET. Serving the
  // whole object for a ranged request hands it the wrong bytes, which surfaces
  // only much later as "ciphertext verification failed" on restore — so an
  // upstream that ignores Range is not modelling S3, it is corrupting data.
  const range = /^bytes=(\d+)-(\d*)$/.exec(String(headerOf(init, 'range') ?? ''));
  if (range) {
    const start = Number(range[1]);
    const end = range[2] === '' ? object.length - 1 : Number(range[2]);
    if (start >= object.length || end < start) {
      return new Response('', { status: 416, headers: { 'content-range': `bytes */${object.length}` } });
    }
    const slice = object.subarray(start, end + 1);
    return new Response(new Uint8Array(slice), {
      status: 206,
      headers: { ...dated, 'content-range': `bytes ${start}-${end}/${object.length}`, 'content-length': String(slice.length) },
    });
  }
  return new Response(new Uint8Array(object), { status: 200, headers: dated });
});

vi.mock('../modules/s3-mailbox/gateway-host-fetch.js', () => ({
  gatewaySignedHostFetch: () => ({ fetch: upstream }),
}));

import { startGatewayWorkspaceProxy, type GatewayWorkspaceProxy } from './gateway-workspace-proxy.js';

let proxy: GatewayWorkspaceProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  store.clear();
  refusals.length = 0;
  upstream.mockClear();
});

/**
 * Fail rather than skip when the binary is absent. A skipped end-to-end test is
 * indistinguishable from a passing one in a build log, which is exactly how a
 * permissive mock shipped three broken deploys.
 */
async function requireRestic(): Promise<void> {
  try {
    await run('restic', ['version']);
  } catch {
    throw new Error(
      'restic is not on PATH. The workspace end-to-end suite drives the real client, ' +
        'pinned to the version ci/images/host-runtime/Dockerfile installs (RESTIC_VERSION).',
    );
  }
}

async function restic(args: string[], endpoint: string): Promise<string> {
  const { stdout } = await run('restic', ['--no-cache', '-r', `s3:${endpoint}/${BUCKET}/${SCOPE}`, ...args], {
    env: {
      ...process.env,
      AWS_ACCESS_KEY_ID: 'NANOCOGATEWAYONLY',
      AWS_SECRET_ACCESS_KEY: 'not-a-cloud-credential',
      AWS_REGION: 'us-east-1',
      RESTIC_PASSWORD: 'workspace-test-password',
    },
    timeout: 120_000,
  });
  return stdout;
}

describe('restic drives the workspace proxy end to end', () => {
  test('init creates the repository through a strictly enforced upstream', async () => {
    await requireRestic();
    proxy = await startGatewayWorkspaceProxy({
      proxy: 'http://10.43.91.7:15001',
      proxyCaPath: '/public/proxy-ca.pem',
      capability: 'a'.repeat(64),
      region: 'us-east-1',
      bucket: BUCKET,
      scopePrefix: SCOPE,
    });

    await restic(['init'], proxy.s3Endpoint);

    // The repository exists as objects, not just as an exit code.
    expect(store.has(`${SCOPE}/config`)).toBe(true);
    expect([...store.keys()].some((k) => k.startsWith(`${SCOPE}/keys/`))).toBe(true);
    // Nothing was refused: no non-canonical path, no keyless operation, no
    // aws-chunked body reached the wire.
    expect(refusals).toEqual([]);
  }, 180_000);

  test('a written snapshot reads back byte for byte', async () => {
    proxy = await startGatewayWorkspaceProxy({
      proxy: 'http://10.43.91.7:15001',
      proxyCaPath: '/public/proxy-ca.pem',
      capability: 'a'.repeat(64),
      region: 'us-east-1',
      bucket: BUCKET,
      scopePrefix: SCOPE,
    });
    await restic(['init'], proxy.s3Endpoint);

    const fs = await import('node:fs');
    const os = await import('node:os');
    const path = await import('node:path');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-e2e-'));
    // Larger than one aws-chunked frame, so the decoder is driven across
    // chunk boundaries rather than on a single small body.
    const payload = Buffer.from('nanoco-workspace-'.repeat(20_000));
    fs.writeFileSync(path.join(dir, 'payload.bin'), payload);

    await restic(['backup', dir], proxy.s3Endpoint);
    const restored = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-e2e-out-'));
    await restic(['restore', 'latest', '--target', restored], proxy.s3Endpoint);

    const found = path.join(restored, dir.replace(/^\//, ''), 'payload.bin');
    expect(fs.readFileSync(found).equals(payload)).toBe(true);
    expect(refusals).toEqual([]);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(restored, { recursive: true, force: true });
  }, 180_000);
});
