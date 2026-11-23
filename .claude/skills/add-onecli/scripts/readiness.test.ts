import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { detectInstalledOneCLI } from './detect.js';
import { gatewayReadinessError, pollGatewayReadiness } from './setup.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe('OneCLI readiness', () => {
  it('detects configuration independently of runtime readiness', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-detect-'));
    roots.push(root);

    expect(await detectInstalledOneCLI(root)).toBe(false);
    fs.writeFileSync(path.join(root, '.env'), 'ONECLI_URL=http://127.0.0.1:10254\n');
    expect(await detectInstalledOneCLI(root)).toBe(true);
  });

  it('refuses unreachable and pre-v1 gateways', () => {
    expect(gatewayReadinessError('ok')).toBeNull();
    expect(gatewayReadinessError('unreachable')).toMatch(/unreachable/);
    expect(gatewayReadinessError('incompatible')).toMatch(/lacks the \/v1 API/);
  });

  it.each([
    ['incompatible', 1, 'failed'],
    ['unreachable', 1, 'failed'],
    ['timeout', 1, 'failed'],
    ['delayed', 0, 'success'],
    ['ok', 0, 'success'],
  ] as const)(
    'gateway /v1 API %s: exits %i (%s)',
    async (v1Status, exitCode, status) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-readiness-'));
      roots.push(root);
      const bin = path.join(root, '.local', 'bin');
      fs.mkdirSync(bin, { recursive: true });
      // Reuse a fake CLI in a disposable HOME: never install a gateway or touch
      // the caller's CLI config, shell profiles or .env.
      fs.writeFileSync(
        path.join(bin, 'onecli'),
        '#!/bin/sh\ncase "$*" in\n  version) echo 2.11.0 ;;\n  "config get api-host") echo "$TEST_GATEWAY_URL" ;;\n  *) exit 1 ;;\nesac\n',
        { mode: 0o755 },
      );
      let v1Calls = 0;
      const server = createServer((req, res) => {
        if (req.url === '/v1/health') v1Calls++;
        if (req.url === '/v1/health' && v1Status === 'unreachable') {
          req.socket.destroy();
          return;
        }
        if (req.url === '/v1/health' && v1Status === 'timeout') return;
        if (req.url === '/v1/health' && v1Status === 'incompatible') res.statusCode = 404;
        if (req.url === '/v1/health' && v1Status === 'delayed' && v1Calls <= 2) res.statusCode = 503;
        res.end('{}');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      try {
        const repo = fileURLToPath(new URL('../../../../', import.meta.url));
        // Drive the real CLI entry point and logger. Calling run() directly or
        // mocking process.exit would miss a rejection swallowed by src/log.ts.
        const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
          execFile(
            process.execPath,
            [
              '--import',
              path.join(repo, 'node_modules/tsx/dist/loader.mjs'),
              path.join(repo, '.claude/skills/add-onecli/scripts/setup.ts'),
              '--reuse',
            ],
            {
              cwd: root,
              env: {
                ...process.env,
                HOME: root,
                PATH: bin,
                NODE_OPTIONS: '',
                NANOCLAW_ONECLI_API_HOST: '',
                NANOCLAW_ONECLI_API_TOKEN: '',
                TEST_GATEWAY_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
              },
              encoding: 'utf8',
              timeout: 10_000,
            },
            (error, stdout, stderr) => {
              const code = error ? error.code : 0;
              if (typeof code !== 'number') reject(error);
              else resolve({ code, stdout, stderr });
            },
          );
        });
        expect(result.stdout).toContain('REUSED: true');
        expect(result.stdout).toContain(`STATUS: ${status}`);
        if (exitCode !== 0) expect(result.stdout).toContain('ERROR: gateway_not_ready');
        expect(result.code, result.stderr).toBe(exitCode);
        if (v1Status === 'delayed') expect(v1Calls).toBe(3);
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    15_000,
  );
});

describe('OneCLI readiness deadline', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('allows /v1 to become ready while an auth-gated /api waits on the same deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let v1Calls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).endsWith('/api/health')) return new Response(null, { status: 401 });
      return new Response(null, { status: ++v1Calls <= 2 ? 503 : 200 });
    });

    const readiness = pollGatewayReadiness('http://gateway.test', 2500, fetchImpl);
    await vi.advanceTimersByTimeAsync(2500);

    // Waiting for /api first would use up /v1's budget; granting /v1 a new
    // budget would leave timers running beyond the shared deadline instead.
    expect(vi.getTimerCount()).toBe(0);
    await expect(readiness).resolves.toEqual({ healthy: false, v1Status: 'ok' });
    expect(v1Calls).toBe(3);
  });

  it('keeps an earlier /v1 404 when the last probe is cut off by the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    // Drive cancellation on the same fake clock as responses and retries.
    vi.spyOn(AbortSignal, 'timeout').mockImplementation((ms) => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), ms);
      return controller.signal;
    });
    const aborted = vi.fn();
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith('/api/health')) return new Response(null, { status: 200 });
      const signal = init!.signal!;
      return new Promise<Response>((resolve, reject) => {
        const onAbort = () => {
          clearTimeout(timer);
          aborted();
          reject(signal.reason);
        };
        const timer = setTimeout(() => {
          signal.removeEventListener('abort', onAbort);
          resolve(new Response(null, { status: 404 }));
        }, 30);
        signal.addEventListener('abort', onAbort, { once: true });
      });
    });

    // The first /v1 probe takes 30 ms and the retry waits 1 s, leaving 15 ms.
    const readiness = pollGatewayReadiness('http://gateway.test', 1045, fetchImpl);
    await vi.advanceTimersByTimeAsync(1045);

    expect(aborted).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
    await expect(readiness).resolves.toEqual({ healthy: true, v1Status: 'incompatible' });
  });

  it('bounds requests and retry sleeps by the remaining budget without extending it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetchImpl = vi.fn(async () => new Response(null, { status: 404 }));

    const readiness = pollGatewayReadiness('http://gateway.test', 2500, fetchImpl);
    await vi.advanceTimersByTimeAsync(2500);

    expect(vi.getTimerCount()).toBe(0);
    await expect(readiness).resolves.toEqual({ healthy: false, v1Status: 'incompatible' });
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([2500, 2500, 1500, 1500, 500, 500]);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(5000);
    expect(fetchImpl).toHaveBeenCalledTimes(6);
  });
});
