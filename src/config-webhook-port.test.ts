import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Use real .env files, as in #2977, and exercise the shared listener as well
// as #3148's configuration lookup. Each test owns its cwd and environment.
describe('WEBHOOK_PORT configuration (#2901)', () => {
  const originalCwd = process.cwd();
  let directory: string;
  let stopWebhookServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    directory = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-webhook-port-'));
    process.chdir(directory);
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

  it('reads the port from .env without populating process.env', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_PORT=3097\n');
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(3097);
    expect(process.env.WEBHOOK_PORT).toBeUndefined();
  });

  it('defaults to 3000 when neither source sets a port', async () => {
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(3000);
  });

  it('lets the process environment override .env', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_PORT=3097\n');
    vi.stubEnv('WEBHOOK_PORT', '4111');
    const { getWebhookPort } = await import('./config.js');

    expect(getWebhookPort()).toBe(4111);
  });

  it('honors a process override set after config was imported', async () => {
    fs.writeFileSync(path.join(directory, '.env'), 'WEBHOOK_PORT=3097\n');
    const { getWebhookPort } = await import('./config.js');
    expect(getWebhookPort()).toBe(3097);

    vi.stubEnv('WEBHOOK_PORT', '4111');
    expect(getWebhookPort()).toBe(4111);
  });

  it.each(['abc', '3000junk', '0', '-1', '65536'])(
    'rejects invalid port %s without wedging a later registration',
    async (invalid) => {
      vi.stubEnv('WEBHOOK_PORT', invalid);
      const webhook = await import('./webhook-server.js');
      stopWebhookServer = webhook.stopWebhookServer;
      expect(() =>
        webhook.registerWebhookHandler('invalid-port', (_req, res) => {
          res.end();
        }),
      ).toThrow(/Invalid WEBHOOK_PORT/);

      const port = 21000 + Math.floor(Math.random() * 20000);
      vi.stubEnv('WEBHOOK_PORT', String(port));
      webhook.registerWebhookHandler('recovered-port', (_req, res) => {
        res.end('ready');
      });
      await vi.waitFor(
        async () => {
          const response = await fetch(`http://127.0.0.1:${port}/webhook/recovered-port`, {
            signal: AbortSignal.timeout(500),
          });
          expect(await response.text()).toBe('ready');
        },
        { timeout: 2000, interval: 25 },
      );
    },
  );

  it('recovers after the configured port is already in use', async () => {
    const occupied = http.createServer();
    await new Promise<void>((resolve) => occupied.listen(0, '0.0.0.0', resolve));
    const address = occupied.address();
    if (!address || typeof address === 'string') throw new Error('Expected an allocated TCP port');

    vi.stubEnv('WEBHOOK_PORT', String(address.port));
    const webhook = await import('./webhook-server.js');
    stopWebhookServer = webhook.stopWebhookServer;
    const { log } = await import('./log.js');
    const failed = vi.spyOn(log, 'error');
    const started = vi.spyOn(log, 'info');
    webhook.registerWebhookHandler('busy-port', (_req, res) => {
      res.end('busy');
    });

    try {
      await vi.waitFor(() =>
        expect(failed).toHaveBeenCalledWith(
          'Webhook server error',
          expect.objectContaining({
            port: address.port,
            err: expect.objectContaining({ code: 'EADDRINUSE' }),
          }),
        ),
      );
      // Release the port this test owns, then retry that same port. A random
      // second port can belong to another test (or an ephemeral HTTP client),
      // which turns a recovery test into a permanent EADDRINUSE failure.
      await new Promise<void>((resolve, reject) => occupied.close((err) => (err ? reject(err) : resolve())));
      await vi.waitFor(
        () => {
          webhook.registerWebhookHandler('recovered-port', (_req, res) => {
            res.end('ready');
          });
          // Wait for listen before opening an HTTP client; the connection's
          // ephemeral source port must not steal the port we are about to bind.
          expect(started).toHaveBeenCalledWith(
            'Webhook server started',
            expect.objectContaining({ port: address.port }),
          );
        },
        { timeout: 2000, interval: 25 },
      );
      const response = await fetch(`http://127.0.0.1:${address.port}/webhook/recovered-port`, {
        signal: AbortSignal.timeout(500),
      });
      expect(await response.text()).toBe('ready');
    } finally {
      started.mockRestore();
      failed.mockRestore();
      if (occupied.listening) await new Promise<void>((resolve) => occupied.close(() => resolve()));
    }
  });

  it.each(['.env', 'late process override'])('serves HTTP on the port selected by %s', async (source) => {
    const port = 21000 + Math.floor(Math.random() * 20000);
    fs.writeFileSync(path.join(directory, '.env'), `WEBHOOK_PORT=${source === '.env' ? port : 3097}\n`);
    const { getWebhookPort } = await import('./config.js');
    if (source === 'late process override') vi.stubEnv('WEBHOOK_PORT', String(port));
    expect(getWebhookPort()).toBe(port);

    const webhook = await import('./webhook-server.js');
    stopWebhookServer = webhook.stopWebhookServer;
    webhook.registerWebhookHandler('port-check', (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(String(req.socket.localPort));
    });

    await vi.waitFor(
      async () => {
        const response = await fetch(`http://127.0.0.1:${port}/webhook/port-check`, {
          signal: AbortSignal.timeout(500),
        });
        expect(response.status).toBe(200);
        expect(await response.text()).toBe(String(port));
      },
      { timeout: 2000, interval: 25 },
    );
  });
});
