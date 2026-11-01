import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { allocateFreePort } from './test-utils/free-port.js';

async function reachable(host: string, port: number): Promise<boolean> {
  try {
    await fetch(`http://${host}:${port}/webhook/bind-check`, { signal: AbortSignal.timeout(500) });
    return true;
  } catch (err) {
    // A refused connection rejects with TypeError; a dropped one times out.
    if (err instanceof TypeError || (err instanceof DOMException && err.name === 'TimeoutError')) return false;
    throw err;
  }
}

// A non-loopback address this machine reaches itself on, standing in for a LAN
// peer. Proven against a throwaway 0.0.0.0 listener first, so a firewalled or
// VPN interface cannot turn the "not reachable" checks into a vacuous pass.
async function findLanAddress(): Promise<string | undefined> {
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((iface) => iface?.family === 'IPv4' && !iface.internal)
    .map((iface) => iface!.address);
  const control = http.createServer((_req, res) => res.end());
  await new Promise<void>((resolve) => control.listen(0, '0.0.0.0', resolve));
  const { port } = control.address() as AddressInfo;
  try {
    for (const address of candidates) if (await reachable(address, port)) return address;
    return undefined;
  } finally {
    control.closeAllConnections();
    await new Promise<void>((resolve) => control.close(() => resolve()));
  }
}

const lanAddress = await findLanAddress();

describe('WEBHOOK_HOST configuration', () => {
  const originalCwd = process.cwd();
  let directory: string;
  let stopWebhookServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-webhook-host-'));
    process.chdir(directory);
    vi.stubEnv('WEBHOOK_HOST', undefined);
    vi.stubEnv('WEBHOOK_PORT', undefined);
    vi.resetModules();
    stopWebhookServer = undefined;
  });

  afterEach(async () => {
    try {
      await stopWebhookServer?.();
    } finally {
      process.chdir(originalCwd);
      vi.unstubAllEnvs();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('defaults to loopback when neither source sets a host', async () => {
    const { getWebhookHost } = await import('./config.js');

    expect(getWebhookHost()).toBe('127.0.0.1');
  });

  it('treats an empty value as unset', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_HOST=\n');
    vi.stubEnv('WEBHOOK_HOST', '');
    const { getWebhookHost } = await import('./config.js');

    expect(getWebhookHost()).toBe('127.0.0.1');
  });

  it('reads the host from .env and lets the process environment override it', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_HOST=0.0.0.0\n');
    const { getWebhookHost } = await import('./config.js');
    expect(getWebhookHost()).toBe('0.0.0.0');
    expect(process.env.WEBHOOK_HOST).toBeUndefined();

    vi.stubEnv('WEBHOOK_HOST', '192.168.1.10');
    expect(getWebhookHost()).toBe('192.168.1.10');
  });

  it.each(['0.0.0.0', '::', '::1', '10.0.0.5'])('accepts the IP address %s', async (host) => {
    vi.stubEnv('WEBHOOK_HOST', host);
    const { getWebhookHost } = await import('./config.js');

    expect(getWebhookHost()).toBe(host);
  });

  it.each(['localhost', 'example.com', '0.0.0.0:3000', '127.0.0.1 ', 'http://127.0.0.1', 'fe80::1%lo0'])(
    'rejects %j, which is not an IP address',
    async (invalid) => {
      vi.stubEnv('WEBHOOK_HOST', invalid);
      const webhook = await import('./webhook-server.js');
      stopWebhookServer = webhook.stopWebhookServer;

      expect(() =>
        webhook.registerWebhookHandler('invalid-host', (_req, res) => {
          res.end();
        }),
      ).toThrow(/Invalid WEBHOOK_HOST/);
    },
  );

  async function serveBindCheck(host?: string): Promise<{ port: number; status: unknown }> {
    const port = await allocateFreePort();
    vi.stubEnv('WEBHOOK_PORT', String(port));
    if (host) vi.stubEnv('WEBHOOK_HOST', host);
    const webhook = await import('./webhook-server.js');
    stopWebhookServer = webhook.stopWebhookServer;
    webhook.registerWebhookHandler('bind-check', (_req, res) => {
      res.end('ok');
    });
    await vi.waitFor(() => expect(webhook.getWebhookStatus()).not.toBeNull());
    return { port, status: webhook.getWebhookStatus() };
  }

  it.each([
    ['by default', undefined, '127.0.0.1'],
    ['with WEBHOOK_HOST=0.0.0.0', '0.0.0.0', '0.0.0.0'],
  ])('serves loopback and reports the bound host %s', async (_label, host, bound) => {
    const { port, status } = await serveBindCheck(host);
    expect(status).toMatchObject({ host: bound, port });
    expect(await reachable('127.0.0.1', port)).toBe(true);
  });

  it.skipIf(!lanAddress)('refuses a LAN peer by default', async () => {
    const { port } = await serveBindCheck();
    expect(await reachable(lanAddress!, port)).toBe(false);
  });

  it.skipIf(!lanAddress)('serves a LAN peer with WEBHOOK_HOST=0.0.0.0', async () => {
    const { port } = await serveBindCheck('0.0.0.0');
    expect(await reachable(lanAddress!, port)).toBe(true);
  });
});
