import { describe, expect, test, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

vi.mock('undici', () => {
  class Headers extends globalThis.Headers {}
  return {
    Headers,
    ProxyAgent: class ProxyAgent { constructor(readonly options: unknown) {} },
    fetch: vi.fn(async (_target: URL, init: { headers: Headers }) =>
      new Response(JSON.stringify(Object.fromEntries(init.headers.entries())))),
  };
});

import { gatewaySignedHostFetch } from './gateway-host-fetch.js';

describe('Gateway-signed Host mailbox transport', () => {
  test('adds only the bound capability and carries no AWS credential', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-host-fetch-'));
    const ca = path.join(root, 'proxy-ca.pem');
    fs.writeFileSync(ca, 'PUBLIC-CA');
    try {
      const transport = gatewaySignedHostFetch({
        proxy: 'http://10.43.91.7:15001', proxyCaPath: ca, capability: 'a'.repeat(64),
      });
      const response = await transport.fetch('https://s3.us-east-1.amazonaws.com/bucket/key', {
        method: 'PUT', headers: { 'if-none-match': '*' }, body: 'value',
      });
      expect(await response.json()).toEqual({
        'if-none-match': '*', 'x-nanoco-scope-storage-capability': 'a'.repeat(64),
      });
      await expect(transport.fetch('https://s3.us-east-1.amazonaws.com/bucket/key', {
        headers: { authorization: 'forbidden' },
      })).rejects.toThrow('must not supply AWS authentication header');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('refuses credentials, non-HTTPS S3, and caller-supplied capability', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gateway-host-fetch-'));
    const ca = path.join(root, 'proxy-ca.pem');
    fs.writeFileSync(ca, 'PUBLIC-CA');
    try {
      const transport = gatewaySignedHostFetch({
        proxy: 'http://10.43.91.7:15001', proxyCaPath: ca, capability: 'b'.repeat(64),
      });
      await expect(transport.fetch('http://s3.local/bucket')).rejects.toThrow('credential-free HTTPS');
      await expect(transport.fetch('https://s3.us-east-1.amazonaws.com/bucket', {
        headers: { 'x-nanoco-scope-storage-capability': 'c'.repeat(64) },
      })).rejects.toThrow('must not override');
      expect(() => gatewaySignedHostFetch({
        proxy: 'http://user:pass@10.43.91.7:15001', proxyCaPath: ca, capability: 'b'.repeat(64),
      })).toThrow('credential-free HTTP origin');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

});
