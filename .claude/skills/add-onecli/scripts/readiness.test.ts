import { execFile } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { detectInstalledOneCLI } from './detect.js';
import { gatewayReadinessError } from './setup.js';

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
      const server = createServer((req, res) => {
        if (req.url === '/v1/health' && v1Status === 'unreachable') {
          req.socket.destroy();
          return;
        }
        res.statusCode = req.url === '/v1/health' && v1Status === 'incompatible' ? 404 : 200;
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
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    15_000,
  );
});
