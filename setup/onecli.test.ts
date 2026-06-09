import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

/**
 * Tests for the OneCLI compose hardening step. Verifies that the rewrite
 * pins the admin API (:10254) and Postgres (:5432) to 127.0.0.1, leaves the
 * gateway (:10255) alone, fixes up the installer's config.json and .env
 * admin URLs, and is idempotent / fails safe on unknown layouts.
 *
 * Tests operate on a tempdir copy of the upstream compose shape, with an
 * injected docker-inspect stub for the detection helper — no real docker,
 * no real OneCLI install.
 */

const UPSTREAM_COMPOSE = `services:
  postgres:
    image: postgres:16
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"
  onecli:
    image: onecli/onecli:latest
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_APP_PORT:-10254}:10254"
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_GATEWAY_PORT:-10255}:10255"
`;

describe('hardenOneCliBinds', () => {
  let tempDir: string;
  let composePath: string;
  let envPath: string;
  let configPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-harden-test-'));
    composePath = path.join(tempDir, 'docker-compose.yml');
    envPath = path.join(tempDir, '.env');
    configPath = path.join(tempDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('pins admin API and Postgres to 127.0.0.1 and leaves the gateway alone', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);

    const patched = fs.readFileSync(composePath, 'utf-8');
    expect(patched).toContain('"127.0.0.1:${POSTGRES_PORT:-5432}:5432"');
    expect(patched).toContain('"127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
    // Gateway must keep the env-driven bind so containers can still reach it.
    expect(patched).toContain('"${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}:10255"');
    expect(patched).toMatch(/^# nanoclaw: admin\+postgres pinned to loopback/);
  });

  it('is a no-op when the marker is already present', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    hardenOneCliBinds({ composePath, envPath, configPath });
    const firstPass = fs.readFileSync(composePath, 'utf-8');

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('already_patched');
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(firstPass);
  });

  it('no-ops and warns when the compose layout is unrecognized', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    const mystery = `services:\n  onecli:\n    image: something-else\n    ports:\n      - "10254:10254"\n`;
    fs.writeFileSync(composePath, mystery);

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('layout_unrecognized');
    expect(fs.readFileSync(composePath, 'utf-8')).toBe(mystery);
  });

  it('no-ops when the compose file does not exist', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    const missing = path.join(tempDir, 'nope.yml');

    const result = hardenOneCliBinds({ composePath: missing, envPath, configPath });
    expect(result.changed).toBe(false);
    expect(result.reason).toBe('compose_missing');
    expect(fs.existsSync(missing)).toBe(false);
  });

  it('rewrites config.json api-host from bridge IP to 127.0.0.1', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    fs.writeFileSync(configPath, JSON.stringify({ 'api-host': 'http://172.17.0.1:10254' }, null, 2));

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);
    expect(result.adminUrlRewritten).toBe(true);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg['api-host']).toBe('http://127.0.0.1:10254');
  });

  it('preserves a gateway-port URL in config.json (only :10254 gets swapped)', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    fs.writeFileSync(configPath, JSON.stringify({ 'api-host': 'http://172.17.0.1:10255' }, null, 2));

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);
    // No admin URL to rewrite (this api-host is the gateway port).
    expect(result.adminUrlRewritten).toBe(false);

    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    expect(cfg['api-host']).toBe('http://172.17.0.1:10255');
  });

  it('leaves config.json alone if api-host already points to loopback', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    const original = JSON.stringify({ 'api-host': 'http://127.0.0.1:10254', other: 'kept' }, null, 2);
    fs.writeFileSync(configPath, original);

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);
    expect(result.adminUrlRewritten).toBe(false);
    expect(fs.readFileSync(configPath, 'utf-8')).toBe(original);
  });

  it('rewrites ~/.onecli/.env ONECLI_URL when it has a bridge-IP admin URL', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    fs.writeFileSync(
      envPath,
      'ONECLI_BIND_HOST=172.17.0.1\nONECLI_URL=http://172.17.0.1:10254\nOTHER=keep\n',
    );

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);
    expect(result.adminUrlRewritten).toBe(true);

    const env = fs.readFileSync(envPath, 'utf-8');
    expect(env).toContain('ONECLI_URL=http://127.0.0.1:10254');
    expect(env).toContain('ONECLI_BIND_HOST=172.17.0.1');
    expect(env).toContain('OTHER=keep');
  });

  it('leaves ~/.onecli/.env alone when ONECLI_URL is the gateway port (:10255)', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    const original = 'ONECLI_URL=http://172.17.0.1:10255\n';
    fs.writeFileSync(envPath, original);

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);
    expect(result.adminUrlRewritten).toBe(false);
    expect(fs.readFileSync(envPath, 'utf-8')).toBe(original);
  });

  it('treats missing config.json and .env as no-ops (security fix still lands)', async () => {
    const { hardenOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(composePath, UPSTREAM_COMPOSE);
    // No config.json, no .env (matches the affected-box layout).

    const result = hardenOneCliBinds({ composePath, envPath, configPath });
    expect(result.changed).toBe(true);
    expect(result.adminUrlRewritten).toBe(false);
    expect(fs.existsSync(configPath)).toBe(false);
    expect(fs.existsSync(envPath)).toBe(false);
  });
});

describe('swapHostInAdminUrl', () => {
  it('swaps a non-loopback host on the admin port to 127.0.0.1', async () => {
    const { swapHostInAdminUrl } = await import('./onecli.js');
    expect(swapHostInAdminUrl('http://172.17.0.1:10254')).toBe('http://127.0.0.1:10254');
    expect(swapHostInAdminUrl('http://172.17.0.1:10254/api/health')).toBe('http://127.0.0.1:10254/api/health');
    expect(swapHostInAdminUrl('https://10.0.0.5:10254')).toBe('https://127.0.0.1:10254');
  });

  it('leaves already-loopback admin URLs unchanged', async () => {
    const { swapHostInAdminUrl } = await import('./onecli.js');
    expect(swapHostInAdminUrl('http://127.0.0.1:10254')).toBe('http://127.0.0.1:10254');
    expect(swapHostInAdminUrl('http://localhost:10254')).toBe('http://localhost:10254');
  });

  it('leaves gateway-port URLs unchanged', async () => {
    const { swapHostInAdminUrl } = await import('./onecli.js');
    expect(swapHostInAdminUrl('http://172.17.0.1:10255')).toBe('http://172.17.0.1:10255');
  });

  it('leaves non-matching URLs unchanged', async () => {
    const { swapHostInAdminUrl } = await import('./onecli.js');
    expect(swapHostInAdminUrl('not-a-url')).toBe('not-a-url');
    expect(swapHostInAdminUrl('')).toBe('');
  });
});

describe('detectUnsafeOneCliBinds', () => {
  let tempDir: string;
  let envPath: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-detect-test-'));
    envPath = path.join(tempDir, '.env');
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('flags a non-loopback :10254 bind reported by docker inspect', async () => {
    const { detectUnsafeOneCliBinds } = await import('./onecli.js');
    const inspectFn = (_c: string, port: string) => (port === '10254/tcp' ? '172.17.0.1' : null);

    expect(detectUnsafeOneCliBinds({ inspectFn, envPath })).toBe('172.17.0.1');
  });

  it('returns null when docker inspect reports loopback', async () => {
    const { detectUnsafeOneCliBinds } = await import('./onecli.js');
    const inspectFn = (_c: string, port: string) => (port === '10254/tcp' ? '127.0.0.1' : null);

    expect(detectUnsafeOneCliBinds({ inspectFn, envPath })).toBeNull();
  });

  it('falls back to ~/.onecli/.env when docker inspect fails', async () => {
    const { detectUnsafeOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(envPath, 'ONECLI_BIND_HOST=172.17.0.1\n');
    const inspectFn = () => null;

    expect(detectUnsafeOneCliBinds({ inspectFn, envPath })).toBe('172.17.0.1');
  });

  it('returns null when inspect fails and .env shows loopback', async () => {
    const { detectUnsafeOneCliBinds } = await import('./onecli.js');
    fs.writeFileSync(envPath, 'ONECLI_BIND_HOST=127.0.0.1\n');
    const inspectFn = () => null;

    expect(detectUnsafeOneCliBinds({ inspectFn, envPath })).toBeNull();
  });

  it('returns null when inspect fails and .env is missing', async () => {
    const { detectUnsafeOneCliBinds } = await import('./onecli.js');
    const inspectFn = () => null;

    expect(detectUnsafeOneCliBinds({ inspectFn, envPath })).toBeNull();
  });
});
