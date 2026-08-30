import fs from 'node:fs';
import path from 'node:path';
import { fetch as undiciFetch, Headers as UndiciHeaders, ProxyAgent } from 'undici';

import type { SignedFetch } from './store.js';

const AWS_AUTH_HEADERS = [
  'authorization',
  'x-amz-content-sha256',
  'x-amz-date',
  'x-amz-security-token',
] as const;
const CAPABILITY_HEADER = 'x-nanoco-scope-storage-capability';

export interface GatewayHostFetchOptions {
  proxy: string;
  proxyCaPath: string;
  capability: string;
}

/** Unsigned Host S3 transport through the parent session relay. */
export function gatewaySignedHostFetch(options: GatewayHostFetchOptions): SignedFetch {
  const proxy = proxyOrigin(options.proxy);
  if (!path.isAbsolute(options.proxyCaPath)) throw new Error('Gateway mailbox proxy CA path must be absolute');
  if (!/^[0-9a-f]{64}$/.test(options.capability)) {
    throw new Error('Gateway request capability must be a 256-bit lowercase hex value');
  }
  const dispatcher = new ProxyAgent({
    uri: proxy,
    requestTls: { ca: fs.readFileSync(options.proxyCaPath, 'utf8') },
  });
  return {
    async fetch(input, init = {}) {
      const target = new URL(input);
      if (target.protocol !== 'https:' || target.username || target.password || target.hash) {
        throw new Error('Gateway-signed Host S3 target must be credential-free HTTPS without a fragment');
      }
      const headers = new UndiciHeaders(init.headers as ConstructorParameters<typeof UndiciHeaders>[0]);
      for (const name of AWS_AUTH_HEADERS) {
        if (headers.has(name)) throw new Error(`Gateway-signed Host must not supply AWS authentication header ${name}`);
      }
      if (headers.has(CAPABILITY_HEADER)) {
        throw new Error('Gateway-signed Host must not override its private scope header');
      }
      headers.set(CAPABILITY_HEADER, options.capability);
      return await undiciFetch(target, {
        ...(init as unknown as NonNullable<Parameters<typeof undiciFetch>[1]>),
        headers,
        dispatcher,
      }) as unknown as Response;
    },
  };
}

function proxyOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== 'http:' || !url.hostname || !url.port || url.username || url.password ||
    url.pathname !== '/' || url.search || url.hash
  ) {
    throw new Error('Gateway mailbox proxy must be a credential-free HTTP origin');
  }
  return url.origin;
}
