import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ensureLocalGatewayHostAccess, nonLoopbackBindings, withLinuxHostGateway, withLoopbackAdmin } from './setup.js';

// `ip` reports docker0 at 172.17.0.1; every other call (docker) is recorded.
vi.mock('child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn((cmd: string, args: string[]) =>
    cmd === 'ip' && args.join(' ') === '-4 addr show docker0' ? '    inet 172.17.0.1/16 scope global docker0\n' : '',
  ),
}));

// The port and URL lines of the 1.45 compose file, as the installer writes it.
const stock = `services:
  postgres:
    image: postgres:18-alpine
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${POSTGRES_PORT:-5432}:5432"
  onecli:
    image: ghcr.io/onecli/onecli:\${ONECLI_VERSION:-latest}
    container_name: onecli
    ports:
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_APP_PORT:-10254}:10254"
      - "\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_GATEWAY_PORT:-10255}:10255"
    environment:
      APP_URL: \${APP_URL:-http://\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_APP_PORT:-10254}}
      GATEWAY_API_URL: http://\${ONECLI_BIND_HOST:-127.0.0.1}:\${ONECLI_GATEWAY_PORT:-10255}
      INTERNAL_API_URL: http://localhost:10254
`;

describe('withLoopbackAdmin', () => {
  it('moves the admin API, Postgres and the APP_URL default to loopback', () => {
    const next = withLoopbackAdmin(stock)!;
    expect(next).toContain('- "127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
    expect(next).toContain('- "127.0.0.1:${POSTGRES_PORT:-5432}:5432"');
    expect(next).toContain('APP_URL: ${APP_URL:-http://127.0.0.1:${ONECLI_APP_PORT:-10254}}');
  });

  it('leaves the gateway port and its URL on the bind host', () => {
    const next = withLoopbackAdmin(stock)!;
    expect(next).toContain('- "${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}:10255"');
    expect(next).toContain('GATEWAY_API_URL: http://${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}');
    expect(next.split('\n')).toHaveLength(stock.split('\n').length);
  });

  it('keeps the host mapping setup adds and is a no-op on a second run', () => {
    const next = withLoopbackAdmin(withLinuxHostGateway(stock, 'linux'))!;
    expect(next).toContain('- "host.docker.internal:host-gateway"');
    expect(withLoopbackAdmin(next)).toBe(next);
  });

  it('returns null when a stock line is missing', () => {
    expect(withLoopbackAdmin(stock.replace('${ONECLI_APP_PORT:-10254}:10254"', '9000:10254"'))).toBeNull();
    expect(withLoopbackAdmin(stock.replace(/ {6}APP_URL: .*\n/, ''))).toBeNull();
  });
});

describe('nonLoopbackBindings', () => {
  it('lists bindings off loopback from docker port output', () => {
    expect(nonLoopbackBindings('172.17.0.1:10254\n[::]:10254\n')).toEqual(['172.17.0.1:10254', '[::]:10254']);
  });

  it('returns nothing for loopback-only bindings', () => {
    expect(nonLoopbackBindings('127.0.0.1:10254\n[::1]:10254\n')).toEqual([]);
    expect(nonLoopbackBindings('')).toEqual([]);
  });
});

describe('ensureLocalGatewayHostAccess', () => {
  const platform = process.platform;
  const homes: string[] = [];
  const adminLoopback = '- "127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"';
  const gatewayLine = '- "${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}:10255"';

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true });
  });

  function run(installerUrl: string, opts: { platform?: string; bind?: string; compose?: string } = {}) {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-home-'));
    homes.push(home);
    const file = path.join(home, '.onecli', 'docker-compose.yml');
    fs.mkdirSync(path.dirname(file));
    fs.writeFileSync(file, opts.compose ?? stock);
    vi.spyOn(os, 'homedir').mockReturnValue(home);
    Object.defineProperty(process, 'platform', { value: opts.platform ?? 'linux' });
    vi.stubEnv('ONECLI_BIND_HOST', opts.bind);
    vi.mocked(execFileSync).mockClear();
    const url = ensureLocalGatewayHostAccess(installerUrl);
    const docker = vi
      .mocked(execFileSync)
      .mock.calls.filter(([cmd]) => cmd === 'docker')
      .map(([, args]) => args);
    return { url, compose: fs.readFileSync(file, 'utf8'), docker, up: [['compose', '-f', file, 'up', '-d']] };
  }

  it('moves the docker0 bind the installer picked to loopback and recreates the stack', () => {
    const { url, compose, docker, up } = run('http://172.17.0.1:10254');
    expect(url).toBe('http://127.0.0.1:10254');
    expect(compose).toContain(adminLoopback);
    expect(compose).toContain(gatewayLine);
    expect(docker).toEqual(up);
  });

  it.each<[string, string, { bind?: string; compose?: string }]>([
    ['an exported ONECLI_BIND_HOST', 'http://172.17.0.1:10254', { bind: '172.17.0.1' }],
    ['another bind address', 'http://192.168.1.50:10254', {}],
    [
      'an unrecognized compose layout',
      'http://172.17.0.1:10254',
      { compose: stock.replace('${ONECLI_APP_PORT:-10254}:10254"', '9000:10254"') },
    ],
  ])('keeps the installer bind for %s', (_name, installerUrl, opts) => {
    const { url, compose, docker, up } = run(installerUrl, opts);
    expect(url).toBe(installerUrl);
    // Only the host mapping is added.
    expect(compose).toBe(withLinuxHostGateway(opts.compose ?? stock, 'linux'));
    expect(docker).toEqual(up);
  });

  it('leaves a non-Linux install as installed, even on a docker0-like address', () => {
    const { url, compose, docker } = run('http://172.17.0.1:10254', { platform: 'darwin' });
    expect(url).toBe('http://172.17.0.1:10254');
    expect(compose).toBe(stock);
    expect(docker).toEqual([]);
  });
});
