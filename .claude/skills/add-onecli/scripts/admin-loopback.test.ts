import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseEnv } from 'node:util';
import { parse } from 'yaml';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADMIN_LOOPBACK_MARKER,
  bindingHost,
  isLoopbackHost,
  parsePublishedPorts,
  pinAdminToLoopback,
} from './admin-loopback.js';
import {
  composeEnv,
  configureLocalGateway,
  nonLoopbackAdminPorts,
  withInstallerPorts,
  type LocalGatewayDocker,
} from './setup.js';

// The port and APP_URL lines of the upstream compose files, as the installer
// writes them, plus the extra_hosts entry setup adds on Linux.
const compose145 = `services:
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

// 1.42 builds APP_URL from the bind and has no INTERNAL_API_URL.
const compose142 = compose145
  .replace(
    'APP_URL: ${APP_URL:-http://${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_APP_PORT:-10254}}',
    'APP_URL: http://${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_APP_PORT:-10254}',
  )
  .replace('      INTERNAL_API_URL: http://localhost:10254\n', '');

const BRIDGE_URL = 'http://172.17.0.1:10254';
const GATEWAY_LINE = '- "${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}:10255"';

describe('pinAdminToLoopback', () => {
  it('pins the admin API and Postgres to 127.0.0.1 and leaves the gateway on the bind host', () => {
    const { compose, status } = pinAdminToLoopback(compose145);
    expect(status).toBe('pinned');
    expect(compose).toContain('- "127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
    expect(compose).toContain('- "127.0.0.1:${POSTGRES_PORT:-5432}:5432"');
    expect(compose).toContain(GATEWAY_LINE);
    expect(compose).toContain('GATEWAY_API_URL: http://${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_GATEWAY_PORT:-10255}');
    expect(compose.startsWith(`${ADMIN_LOOPBACK_MARKER}\n`)).toBe(true);
  });

  it('points the dashboard URL at loopback and keeps an APP_URL override working', () => {
    expect(pinAdminToLoopback(compose145).compose).toContain(
      'APP_URL: "${APP_URL:-http://127.0.0.1:${ONECLI_APP_PORT:-10254}}"',
    );
  });

  it('keeps APP_URL fixed on loopback when the gateway has no INTERNAL_API_URL', () => {
    const { compose } = pinAdminToLoopback(compose142);
    // The container's own port: 1.42 calls this URL from inside the container.
    expect(compose).toContain('APP_URL: "http://127.0.0.1:10254"');
    expect(compose).not.toContain('${APP_URL:-');
  });

  it('rewrites service ports while leaving unused YAML entries unchanged', () => {
    const example = `x-example:
  ports:
    - "${'${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_APP_PORT:-10254}:10254'}"
    - "${'${ONECLI_BIND_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432'}"
  APP_URL: http://${'${ONECLI_BIND_HOST:-127.0.0.1}'}:10254
`;
    const result = pinAdminToLoopback(example + compose145);
    expect(result.status).toBe('pinned');
    const parsed = parse(result.compose);
    expect(parsed.services.onecli.ports[0]).toBe('127.0.0.1:${ONECLI_APP_PORT:-10254}:10254');
    expect(parsed.services.postgres.ports[0]).toBe('127.0.0.1:${POSTGRES_PORT:-5432}:5432');
    expect(parsed.services.onecli.environment.APP_URL).toContain('http://127.0.0.1:');
    expect(parsed['x-example']).toEqual(parse(example)['x-example']);
  });

  it('is a no-op on an already pinned file', () => {
    const once = pinAdminToLoopback(compose145).compose;
    expect(pinAdminToLoopback(once)).toEqual({ compose: once, status: 'already-pinned' });
  });

  it('pins a file someone pinned by hand without adding a second marker', () => {
    const half = compose145.replace(
      '"${ONECLI_BIND_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432"',
      '"127.0.0.1:${POSTGRES_PORT:-5432}:5432"',
    );
    const { compose, status } = pinAdminToLoopback(half);
    expect(status).toBe('pinned');
    expect(compose).toContain('- "127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
    expect(compose.split(ADMIN_LOOPBACK_MARKER)).toHaveLength(2);
  });

  it('leaves an unrecognized layout untouched', () => {
    for (const changed of [
      compose145.replace('"${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_APP_PORT:-10254}:10254"', '"0.0.0.0:10254:10254"'),
      compose145.replace(
        '"${ONECLI_BIND_HOST:-127.0.0.1}:${POSTGRES_PORT:-5432}:5432"',
        '"${PG_BIND:-0.0.0.0}:5432:5432"',
      ),
      compose145.replace(/^.*:5432"\n/m, ''),
      compose145.replace(GATEWAY_LINE, `${GATEWAY_LINE}\n      - "172.17.0.1:20254:10254"`),
    ]) {
      expect(pinAdminToLoopback(changed)).toEqual({ compose: changed, status: 'unrecognized' });
    }
  });

  it('refuses additional admin or Postgres mappings in every YAML form', () => {
    for (const extra of [
      '- "${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_APP_PORT:-10254}:10254" # duplicate',
      "- '172.17.0.1:20254:10254'",
      '- 172.17.0.1:20254:10254',
      '- "172.17.0.1:20254:10254/tcp"',
      '- {target: 10254, published: 20254, host_ip: 172.17.0.1}',
      '- target: 5432\n        published: 5433\n        host_ip: 172.17.0.1',
    ]) {
      const changed = compose145.replace(GATEWAY_LINE, `${GATEWAY_LINE}\n      ${extra}`);
      expect(pinAdminToLoopback(changed), extra).toEqual({ compose: changed, status: 'unrecognized' });
    }
  });

  it('refuses unresolved YAML aliases unchanged', () => {
    const changed = compose145 + 'x-unused: *missing\n';
    expect(pinAdminToLoopback(changed)).toEqual({ compose: changed, status: 'unrecognized' });
  });

  it('refuses a multiline dashboard value unchanged', () => {
    const changed = compose145.replace(/^      APP_URL:.*$/m, `      APP_URL: >-\n        ${BRIDGE_URL}`);
    expect(pinAdminToLoopback(changed)).toEqual({ compose: changed, status: 'unrecognized' });
  });

  it('keeps a flow-style dashboard setting valid YAML', () => {
    const changed = compose145.replace(/    environment:[\s\S]*/, `    environment: { APP_URL: "${BRIDGE_URL}" }\n`);
    const result = pinAdminToLoopback(changed);
    expect(result.status).toBe('pinned');
    expect(parse(result.compose).services.onecli.environment.APP_URL).toBe('http://127.0.0.1:10254');
  });

  it('pins CRLF Compose files and preserves their line endings', () => {
    const crlf = compose145.replaceAll('\n', '\r\n');
    const pinned = pinAdminToLoopback(crlf);
    expect(pinned.status).toBe('pinned');
    expect(pinned.compose.replaceAll('\r\n', '\n')).toBe(pinAdminToLoopback(compose145).compose);
    expect(pinned.compose).not.toMatch(/(?<!\r)\n/);
    expect(pinAdminToLoopback(pinned.compose).status).toBe('already-pinned');
  });
});

describe('isLoopbackHost and published ports', () => {
  it('recognizes loopback hosts only', () => {
    for (const host of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]']) expect(isLoopbackHost(host)).toBe(true);
    for (const host of ['172.17.0.1', '0.0.0.0', '::', '[::]', '10.0.0.5', ''])
      expect(isLoopbackHost(host)).toBe(false);
  });

  it('reads bindings from docker port output', () => {
    expect(parsePublishedPorts('172.17.0.1:10254\n')).toEqual(['172.17.0.1:10254']);
    expect(parsePublishedPorts('0.0.0.0:5432\n[::]:5432\n').map(bindingHost)).toEqual(['0.0.0.0', '::']);
    expect(parsePublishedPorts('')).toEqual([]);
    expect(parsePublishedPorts("no public port '9999/tcp' published for 75dabfb838ac\n")).toEqual([]);
  });
});

describe('local gateway', () => {
  let dir: string;
  let ups: number;
  let published: Record<string, string[]>;

  const envFile = () => (fs.existsSync(path.join(dir, '.env')) ? fs.readFileSync(path.join(dir, '.env'), 'utf8') : '');

  // Compose as the stock file uses it: image tag and bind come from .env.
  const docker: LocalGatewayDocker = {
    publishedPorts: (service, port) => published[`${service}:${port}`] ?? [],
    up: () => {
      ups++;
      const compose = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
      const env = parseEnv(envFile());
      const bind = env.ONECLI_BIND_HOST ?? '127.0.0.1';
      const gatewayPort = env.ONECLI_GATEWAY_PORT ?? '10255';
      const hostFor = (port: number) =>
        compose.includes(`"127.0.0.1:\${${port === 5432 ? 'POSTGRES_PORT' : 'ONECLI_APP_PORT'}`) ? '127.0.0.1' : bind;
      published = {
        'onecli:10254': [`${hostFor(10254)}:${env.ONECLI_APP_PORT ?? '10254'}`],
        'onecli:10255': [`${bind}:${gatewayPort}`],
        'postgres:5432': [`${hostFor(5432)}:${env.POSTGRES_PORT ?? '5432'}`],
      };
    },
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-loopback-'));
    ups = 0;
    published = {
      'onecli:10254': ['172.17.0.1:10254'],
      'onecli:10255': ['172.17.0.1:10255'],
      'postgres:5432': ['172.17.0.1:5432'],
    };
  });

  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, content: string) => fs.writeFileSync(path.join(dir, name), content);
  const read = (name: string) => fs.readFileSync(path.join(dir, name), 'utf8');

  it('reports admin ports published off loopback', () => {
    expect(nonLoopbackAdminPorts(docker)).toEqual(['172.17.0.1:10254', '172.17.0.1:5432']);
    published = { 'onecli:10254': ['127.0.0.1:10254'], 'postgres:5432': ['127.0.0.1:5432'] };
    expect(nonLoopbackAdminPorts(docker)).toEqual([]);
  });

  describe('fresh install', () => {
    it('pins admin and Postgres on a bridge bind and recreates the stack once', () => {
      write('docker-compose.yml', compose145);
      write('.env', 'ONECLI_BIND_HOST=172.17.0.1\n');
      expect(configureLocalGateway('http://172.17.0.1:10254', 'linux', docker, dir)).toBe('http://127.0.0.1:10254');
      expect(read('docker-compose.yml')).toContain('"127.0.0.1:${ONECLI_APP_PORT:-10254}:10254"');
      expect(read('docker-compose.yml')).toContain('host.docker.internal:host-gateway');
      expect(ups).toBe(1);
      expect(nonLoopbackAdminPorts(docker)).toEqual([]);
      expect(published['onecli:10255']).toEqual(['172.17.0.1:10255']);
    });

    it('configures a fresh CRLF compose file and preserves its line endings', () => {
      write('docker-compose.yml', compose145.replaceAll('\n', '\r\n'));
      write('.env', 'ONECLI_BIND_HOST=172.17.0.1\n');
      expect(configureLocalGateway(BRIDGE_URL, 'linux', docker, dir)).toBe('http://127.0.0.1:10254');
      expect(read('docker-compose.yml')).not.toMatch(/(?<!\r)\n/);
      expect(nonLoopbackAdminPorts(docker)).toEqual([]);
      expect(ups).toBe(1);
    });

    it('changes nothing but the host mapping when the installer bound to loopback', () => {
      write('docker-compose.yml', compose145);
      write('.env', 'ONECLI_BIND_HOST=127.0.0.1\n');
      expect(configureLocalGateway('http://127.0.0.1:10254', 'linux', docker, dir)).toBe('http://127.0.0.1:10254');
      expect(read('docker-compose.yml')).not.toContain(ADMIN_LOOPBACK_MARKER);
      expect(read('docker-compose.yml')).toContain('host.docker.internal:host-gateway');
      expect(ups).toBe(1);
    });

    it('does not read or write the compose file off Linux, as before', () => {
      const url = 'http://127.0.0.1:10254';
      expect(configureLocalGateway(url, 'darwin', docker, dir)).toBe(url);
      expect(configureLocalGateway('http://172.17.0.1:10254', 'darwin', docker, dir)).toBe('http://172.17.0.1:10254');
      expect(fs.existsSync(path.join(dir, 'docker-compose.yml'))).toBe(false);
      expect(ups).toBe(0);
    });

    it('leaves a macOS install alone', () => {
      write('docker-compose.yml', compose145);
      expect(configureLocalGateway('http://127.0.0.1:10254', 'darwin', docker, dir)).toBe('http://127.0.0.1:10254');
      expect(read('docker-compose.yml')).toBe(compose145);
      expect(ups).toBe(0);
    });

    it('leaves a custom admin port alone', () => {
      write('docker-compose.yml', compose145);
      write('.env', 'ONECLI_BIND_HOST=172.17.0.1\n');
      expect(configureLocalGateway('http://172.17.0.1:11254', 'linux', docker, dir)).toBe('http://172.17.0.1:11254');
      expect(read('docker-compose.yml')).not.toContain(ADMIN_LOOPBACK_MARKER);
    });

    it('keeps the installer bind when the layout is unrecognized', () => {
      const custom = compose145.replace(/^.*:5432"\n/m, '');
      write('docker-compose.yml', custom);
      write('.env', 'ONECLI_BIND_HOST=172.17.0.1\n');
      expect(configureLocalGateway('http://172.17.0.1:10254', 'linux', docker, dir)).toBe('http://172.17.0.1:10254');
      expect(read('docker-compose.yml')).not.toContain(ADMIN_LOOPBACK_MARKER);
    });
  });
});

describe('withInstallerPorts', () => {
  it('saves explicitly empty installer port overrides over stale saved ports', () => {
    const saved = 'ONECLI_APP_PORT=11254\nONECLI_GATEWAY_PORT=11255\nPOSTGRES_PORT=15432\n';
    expect(
      parseEnv(
        withInstallerPorts(saved, {
          ONECLI_APP_PORT: '',
          ONECLI_GATEWAY_PORT: '',
          POSTGRES_PORT: '',
        }),
      ),
    ).toEqual({ ONECLI_APP_PORT: '', ONECLI_GATEWAY_PORT: '', POSTGRES_PORT: '' });
  });

  it('saves the port overrides the installer ran with, since composeEnv drops them', () => {
    expect(withInstallerPorts('ONECLI_VERSION=1.45.0\n', { POSTGRES_PORT: '5433', PATH: '/bin' })).toBe(
      'ONECLI_VERSION=1.45.0\nPOSTGRES_PORT=5433\n',
    );
    expect(withInstallerPorts('', {})).toBe('');
  });
});

describe('composeEnv', () => {
  it('drops the shell values that would override the binds, ports and version saved in .env', () => {
    const shell = {
      PATH: '/bin',
      ONECLI_BIND_HOST: '127.0.0.1',
      ONECLI_VERSION: 'latest',
      APP_URL: BRIDGE_URL,
      ONECLI_APP_PORT: '1',
      ONECLI_GATEWAY_PORT: '2',
      POSTGRES_PORT: '3',
      HOME: '/h',
    };
    expect(composeEnv(shell, { APP_URL: 'http://127.0.0.1:10254' })).toEqual({ PATH: '/bin', HOME: '/h' });
  });

  it('keeps a shell APP_URL when .env does not save one', () => {
    const shell = { PATH: '/bin', APP_URL: 'https://onecli.example.com' };
    expect(composeEnv(shell)).toEqual(shell);
    expect(composeEnv(shell, {})).toEqual(shell);
  });
});
