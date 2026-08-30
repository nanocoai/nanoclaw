import { afterEach, describe, expect, test, vi } from 'vitest';
import { request } from 'node:http';

const upstream = vi.fn(async (input: string, init: RequestInit = {}) => {
  const url = new URL(input);
  if (url.hostname.startsWith('s3.')) {
    if (url.pathname.endsWith('/missing')) {
      return new Response('forbidden', { status: 404, headers: { 'content-type': 'text/plain' } });
    }
    const prefix = url.searchParams.get('prefix');
    if (prefix) {
      return new Response(
        `<ListBucketResult><KeyCount>2</KeyCount>` +
        `<Contents><Key>${prefix}group-a/config</Key><ETag>&quot;a&quot;</ETag></Contents>` +
        `<Contents><Key>${prefix}group-b/config</Key><ETag>&quot;b&quot;</ETag></Contents>` +
        `</ListBucketResult>`,
        { status: 200, headers: { 'content-type': 'application/xml' } },
      );
    }
    return new Response('ok', { status: 200, headers: { etag: '"v1"' } });
  }
  return new Response(JSON.stringify({ KeyMetadata: { KeyId: 'key-1' } }), { status: 200 });
});

vi.mock('../modules/s3-mailbox/gateway-host-fetch.js', () => ({
  gatewaySignedHostFetch: () => ({ fetch: upstream }),
}));

import { startGatewayWorkspaceProxy, type GatewayWorkspaceProxy } from './gateway-workspace-proxy.js';

let proxy: GatewayWorkspaceProxy | undefined;
afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  upstream.mockClear();
});

const options = {
  proxy: 'http://10.43.91.7:15001',
  proxyCaPath: '/public/proxy-ca.pem',
  capability: 'a'.repeat(64),
  region: 'us-east-1',
  bucket: 'workspace-bucket',
  scopePrefix: 'install/restic/children/devenv-env-1',
};

describe('Gateway workspace loopback proxy', () => {
  test('widens one ListObjects request to the trusted environment root and filters siblings', async () => {
    proxy = await startGatewayWorkspaceProxy(options);
    const requested = `${options.scopePrefix}/group-a/`;
    const response = await fetch(
      `${proxy.s3Endpoint}/${options.bucket}?list-type=2&prefix=${encodeURIComponent(requested)}`,
      { headers: syntheticHeaders() },
    );
    expect(response.status).toBe(200);
    const xml = await response.text();
    expect(xml).toContain(`${options.scopePrefix}/group-a/config`);
    expect(xml).not.toContain(`${options.scopePrefix}/group-b/config`);
    expect(xml).toContain('<KeyCount>1</KeyCount>');
    const [target, init] = upstream.mock.calls[0]!;
    expect(new URL(String(target)).searchParams.get('prefix')).toBe(`${options.scopePrefix}/`);
    expect(new Headers(init?.headers).has('authorization')).toBe(false);
  });

  test('canonicalizes Restic ListObjects bucket roots with a trailing slash', async () => {
    const groupOptions = { ...options, scopePrefix: 'install/restic/group-a' };
    proxy = await startGatewayWorkspaceProxy(groupOptions);
    const response = await fetch(
      `${proxy.s3Endpoint}/${groupOptions.bucket}/?encoding-type=url&max-keys=1000&prefix=${encodeURIComponent(`${groupOptions.scopePrefix}/`)}`,
      { headers: syntheticHeaders() },
    );
    expect(response.status).toBe(200);
    const [target] = upstream.mock.calls[0]!;
    const forwarded = new URL(String(target));
    expect(forwarded.pathname).toBe(`/${groupOptions.bucket}`);
    expect(forwarded.searchParams.get('prefix')).toBe(`${groupOptions.scopePrefix}/`);
    expect(forwarded.searchParams.get('encoding-type')).toBe('url');
    expect(forwarded.searchParams.get('max-keys')).toBe('1000');
  });

  test('answers the Restic BucketExists probe locally instead of forwarding it', async () => {
    // `restic init` opens with minio-go's BucketExists, a HEAD on the bucket
    // root. It cannot go upstream: a bucket-root path carries no object key, so
    // it matches none of the capability's keyed operations and Gateway blocks
    // it — observed as 6/6 blocked with reason="path_not_canonical" while every
    // keyed request in the same window was allowed. That surfaced far from its
    // cause as `client.BucketExists: 400 Bad Request`, and no workspace could
    // ever get a repository.
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await fetch(`${proxy.s3Endpoint}/${options.bucket}/`, {
      method: 'HEAD',
      headers: syntheticHeaders(),
    });
    expect(response.status).toBe(200);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('still canonicalizes a forwarded bucket-root call to the slash-less form', async () => {
    // A bucket-root GET carrying no prefix is not the widened-list case and is
    // not answered locally, so it reaches the wire — and it must arrive in the
    // shape Gateway accepts. In one production window 962 slash-less
    // bucket-root requests were allowed while all 6 trailing-slash ones were
    // blocked, so forwarding the request's own pathname is what fails.
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await fetch(`${proxy.s3Endpoint}/${options.bucket}/`, {
      headers: syntheticHeaders(),
    });
    expect(response.status).toBe(200);
    const [target] = upstream.mock.calls[0]!;
    expect(new URL(String(target)).pathname).toBe(`/${options.bucket}`);
  });

  test('unwraps the aws-chunked framing Restic uses for every repository write', async () => {
    // Captured from restic 0.18.1 inside the Custodian: because this proxy is a
    // plaintext loopback endpoint, minio-go signs with
    // STREAMING-AWS4-HMAC-SHA256-PAYLOAD and frames the body — 650 wire bytes
    // around 476 real ones. Gateway signs UNSIGNED-PAYLOAD and does not
    // implement aws-chunked, so forwarding the framing made S3 answer 400 to
    // every write and restic retried the key PUT forever.
    proxy = await startGatewayWorkspaceProxy(options);
    const payload = JSON.stringify({ created: '2026-08-30T06:38:18Z', data: 'x'.repeat(64) });
    const framed = Buffer.concat([
      Buffer.from(`${payload.length.toString(16)};chunk-signature=${'b'.repeat(64)}\r\n`),
      Buffer.from(payload),
      Buffer.from(`\r\n0;chunk-signature=${'c'.repeat(64)}\r\n\r\n`),
    ]);
    const response = await fetch(
      `${proxy.s3Endpoint}/${options.bucket}/${options.scopePrefix}/keys/de90646f25`,
      {
        method: 'PUT',
        headers: {
          ...syntheticHeaders(),
          'x-amz-content-sha256': 'STREAMING-AWS4-HMAC-SHA256-PAYLOAD',
          'x-amz-decoded-content-length': String(payload.length),
        },
        body: framed,
      },
    );
    expect(response.status).toBe(200);

    const [, init] = upstream.mock.calls[0]!;
    const forwarded = await new Response(init!.body as never).text();
    // Upstream must see the object, not the envelope.
    expect(forwarded).toBe(payload);
    expect(forwarded).not.toContain('chunk-signature');
    const sent = new Headers(init?.headers);
    expect(sent.get('content-length')).toBe(String(payload.length));
    expect(sent.has('x-amz-decoded-content-length')).toBe(false);
  });

  test('leaves an unframed body alone instead of decoding every write', async () => {
    // Only a body announcing the streaming marker is framed. Running the
    // decoder over a plain body would misread the first bytes as a chunk
    // header and fail the write, so the request stream must be forwarded
    // untouched — no decoder spliced in, no length rewritten.
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await fetch(
      `${proxy.s3Endpoint}/${options.bucket}/${options.scopePrefix}/keys/plain`,
      { method: 'PUT', headers: syntheticHeaders(), body: 'plain-object-bytes' },
    );
    expect(response.status).toBe(200);
    const [, init] = upstream.mock.calls[0]!;
    expect((init!.body as object).constructor.name).toBe('IncomingMessage');
    expect(new Headers(init?.headers).has('x-amz-decoded-content-length')).toBe(false);
  });

  test('answers Restic GetBucketLocation from the already configured region', async () => {
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await fetch(`${proxy.s3Endpoint}/${options.bucket}/?location`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`>${options.region}</LocationConstraint>`);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('refuses S3 paths outside the assigned workspace prefix', async () => {
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await fetch(`${proxy.s3Endpoint}/${options.bucket}/other/config`, {
      headers: syntheticHeaders(),
    });
    expect(response.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
  });

  test('restores the S3 NoSuchKey protocol envelope for an allowed first-read 404', async () => {
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await fetch(
      `${proxy.s3Endpoint}/${options.bucket}/${options.scopePrefix}/group-a/missing`,
      { headers: syntheticHeaders() },
    );
    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toBe('application/xml');
    expect(await response.text()).toContain('<Code>NoSuchKey</Code>');
  });

  test('terminates the SDK S3 100-continue hop before forwarding PutObject', async () => {
    proxy = await startGatewayWorkspaceProxy(options);
    const response = await rawRequest(
      `${proxy.s3Endpoint}/${options.bucket}/${options.scopePrefix}/group-a/HEAD`,
      'workspace',
    );
    expect(response.status).toBe(200);
    const [, init] = upstream.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.has('expect')).toBe(false);
    expect(headers.get('content-length')).toBe(String(Buffer.byteLength('workspace')));
  });

  test('allows only the wrapping-key KMS contract and removes synthetic signatures', async () => {
    proxy = await startGatewayWorkspaceProxy(options);
    const allowed = await fetch(proxy.kmsEndpoint, {
      method: 'POST',
      headers: { ...syntheticHeaders(), 'x-amz-target': 'TrentService.DescribeKey' },
      body: JSON.stringify({ KeyId: 'alias/nanoco-k8s/agent-group/group-a' }),
    });
    expect(allowed.status).toBe(200);
    const [, init] = upstream.mock.calls[0]!;
    const headers = new Headers(init?.headers);
    expect(headers.get('x-amz-target')).toBe('TrentService.DescribeKey');
    expect(headers.has('authorization')).toBe(false);

    const denied = await fetch(proxy.kmsEndpoint, {
      method: 'POST',
      headers: { ...syntheticHeaders(), 'x-amz-target': 'TrentService.ScheduleKeyDeletion' },
      body: JSON.stringify({ KeyId: 'alias/nanoco-k8s/agent-group/group-a' }),
    });
    expect(denied.status).toBe(403);
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});

function syntheticHeaders(): Record<string, string> {
  return {
    authorization: 'AWS4-HMAC-SHA256 synthetic',
    'x-amz-date': '20260828T000000Z',
    'x-amz-content-sha256': 'synthetic',
  };
}

async function rawRequest(url: string, body: string): Promise<{ status: number; body: string }> {
  return await new Promise((resolve, reject) => {
    const target = new URL(url);
    const req = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname + target.search,
      method: 'PUT',
      headers: { expect: '100-continue', 'content-length': Buffer.byteLength(body) },
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(body);
  });
}
