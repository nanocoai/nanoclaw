import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parse } from 'yaml';

const calls = vi.hoisted(() => ({ file: vi.fn(), shell: vi.fn(), status: vi.fn(), warn: vi.fn(), home: '' }));
vi.mock('child_process', () => ({ execFileSync: calls.file, execSync: calls.shell }));
vi.mock('os', async (original) => ({
  default: { ...(await original<typeof import('node:os')>()), homedir: () => calls.home },
}));
vi.mock('../../../../src/log.js', () => ({ log: { debug: vi.fn(), info: vi.fn(), warn: calls.warn, error: vi.fn() } }));
vi.mock('../../../../setup/status.js', () => ({ emitStatus: calls.status }));

const compose = `services:
  postgres:
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
      INTERNAL_API_URL: http://localhost:10254
`;
const bridgeUrl = 'http://172.17.0.1:10254';
let cli: boolean;
let endpoint: string;
let inspectFails: boolean;
let configSetFails: boolean;
let dir: string;
let started: ReturnType<typeof parse> | undefined;
let bindings: Record<string, string[]>;
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;

// Resolve the substitutions used by the fixture, with shell settings taking precedence.
function resolveCompose(args: string[], env: NodeJS.ProcessEnv): ReturnType<typeof parse> {
  const fileIndex = args.indexOf('--env-file');
  const envPath = fileIndex === -1 ? env.COMPOSE_ENV_FILES || path.join(dir, '.env') : args[fileIndex + 1];
  const settings = { ...parseEnv(fs.readFileSync(envPath, 'utf8')), ...env };
  let source = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
  while (/\$\{[^{}]*\}/.test(source)) {
    source = source.replace(/\$\{(\w+)(?::-([^{}]*))?\}/g, (_, name, fallback) => settings[name] || fallback || '');
  }
  return parse(source);
}

beforeEach(() => {
  // The fresh-install rewrite runs on Linux only; simulate it on any test host.
  Object.defineProperty(process, 'platform', { ...platform, value: 'linux' });
  vi.resetModules();
  calls.file.mockReset();
  calls.shell.mockReset();
  calls.status.mockReset();
  calls.warn.mockReset();
  calls.home = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-setup-run-'));
  dir = path.join(calls.home, '.onecli');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'docker-compose.yml'), compose);
  fs.writeFileSync(path.join(dir, '.env'), 'ONECLI_VERSION=1.42.0\nONECLI_BIND_HOST=172.17.0.1\n');
  vi.spyOn(process, 'cwd').mockReturnValue(calls.home);
  vi.spyOn(process, 'exit').mockImplementation(() => {
    throw new Error('exit');
  });
  vi.stubEnv('NANOCLAW_ONECLI_API_HOST', '');
  for (const name of [
    'COMPOSE_ENV_FILES',
    'ONECLI_VERSION',
    'ONECLI_BIND_HOST',
    'ONECLI_APP_PORT',
    'ONECLI_GATEWAY_PORT',
    'POSTGRES_PORT',
    'APP_URL',
  ]) {
    vi.stubEnv(name, undefined);
  }
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  vi.spyOn(fs, 'accessSync').mockImplementation(() => {
    throw new Error('use local bin');
  });
  vi.spyOn(fs, 'copyFileSync').mockImplementation(() => {
    cli = true;
  });
  vi.spyOn(fs, 'chmodSync').mockImplementation(() => {});
  cli = true;
  endpoint = bridgeUrl;
  inspectFails = false;
  configSetFails = false;
  started = undefined;
  bindings = { onecli: ['172.17.0.1:10254:10254', '172.17.0.1:10255:10255'], postgres: ['172.17.0.1:5432:5432'] };
  calls.shell.mockImplementation((command: string) => {
    if (command.startsWith('docker ps ')) return '';
    if (command.includes('https://onecli.sh/install')) return `OneCLI ready at ${bridgeUrl}`;
    if (command.startsWith('curl ') || command.startsWith('tar ')) return '';
    throw new Error(`unexpected shell command: ${command}`);
  });
  calls.file.mockImplementation((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    if (command === 'onecli') {
      if (!cli) throw new Error('CLI absent');
      if (args[0] === 'version') return '2.9.0';
      if (args[1] === 'get') return JSON.stringify({ data: endpoint });
      if (args[1] === 'set') {
        if (configSetFails) throw new Error('config is read-only');
        endpoint = args[3];
        return '';
      }
    }
    if (command === 'docker') {
      if (args.includes('ps')) return args.at(-1);
      if (args.includes('up')) {
        started = resolveCompose(args, options.env);
        for (const service of ['onecli', 'postgres']) bindings[service] = started.services[service].ports;
        return '';
      }
      if (args[0] === 'inspect') {
        if (inspectFails) throw new Error('inspect failed');
        return JSON.stringify(
          Object.fromEntries(
            bindings[args.at(-1)!].map((binding) => {
              const [HostIp, HostPort, port] = binding.split(':');
              return [`${port}/tcp`, [{ HostIp, HostPort }]];
            }),
          ),
        );
      }
    }
    throw new Error(`unexpected command: ${command} ${args.join(' ')}`);
  });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(calls.home, { recursive: true, force: true });
});

describe('existing gateway detection', () => {
  it('reports non-loopback bindings without changing the gateway or CLI', async () => {
    const before = fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8');
    const envBefore = fs.readFileSync(path.join(dir, '.env'), 'utf8');
    const { run } = await import('./setup.js');
    await run(['--reuse']);
    expect(calls.status).toHaveBeenLastCalledWith(
      'ONECLI',
      expect.objectContaining({
        ADMIN_NOT_LOOPBACK: '172.17.0.1:10254, 172.17.0.1:5432',
        ADMIN_HINT: expect.stringContaining('docs/onecli-upgrades.md'),
      }),
    );
    expect(fs.readFileSync(path.join(dir, 'docker-compose.yml'), 'utf8')).toBe(before);
    expect(fs.readFileSync(path.join(dir, '.env'), 'utf8')).toBe(envBefore);
    expect(endpoint).toBe(bridgeUrl);
    expect(started).toBeUndefined();
    expect(calls.shell).not.toHaveBeenCalled();
    expect(calls.file.mock.calls.some(([cmd, args]) => cmd === 'onecli' && args.includes('set'))).toBe(false);
  });

  it('reports nothing for a reused gateway with no local OneCLI files', async () => {
    fs.rmSync(dir, { recursive: true, force: true });
    const { run } = await import('./setup.js');
    await run(['--reuse']);
    const fields = calls.status.mock.lastCall![1];
    expect(fields).not.toHaveProperty('ADMIN_BINDINGS_UNKNOWN');
    expect(fields).not.toHaveProperty('ADMIN_NOT_LOOPBACK');
    expect(calls.file.mock.calls.some(([command]) => command === 'docker')).toBe(false);
  });

  it('reads the bindings without --env-file when ~/.onecli/.env is missing', async () => {
    fs.rmSync(path.join(dir, '.env'));
    const { run } = await import('./setup.js');
    await run(['--reuse']);
    expect(calls.status).toHaveBeenLastCalledWith(
      'ONECLI',
      expect.objectContaining({ ADMIN_NOT_LOOPBACK: '172.17.0.1:10254, 172.17.0.1:5432' }),
    );
    const docker = calls.file.mock.calls.filter(([command]) => command === 'docker');
    expect(docker.length).toBeGreaterThan(0);
    expect(docker.some(([, args]) => args.includes('--env-file'))).toBe(false);
  });

  it('reports unknown bindings when Docker inspection fails during reuse', async () => {
    inspectFails = true;
    const { run } = await import('./setup.js');
    await run(['--reuse']);
    expect(calls.status).toHaveBeenLastCalledWith('ONECLI', expect.objectContaining({ ADMIN_BINDINGS_UNKNOWN: true }));
    expect(started).toBeUndefined();
    expect(calls.shell).not.toHaveBeenCalled();
  });
});

describe('fresh gateway setup', () => {
  beforeEach(() => {
    cli = false;
  });

  it('uses the saved version and bridge bind when COMPOSE_ENV_FILES skips the default file', async () => {
    vi.stubEnv('COMPOSE_ENV_FILES', '/dev/null');
    vi.stubEnv('ONECLI_VERSION', '1.45.0');
    vi.stubEnv('ONECLI_BIND_HOST', '172.17.0.1');
    const { run } = await import('./setup.js');
    await run([]);
    expect(started.services.onecli.image).toBe('ghcr.io/onecli/onecli:1.45.0');
    expect(bindings).toEqual({
      onecli: ['127.0.0.1:10254:10254', '172.17.0.1:10255:10255'],
      postgres: ['127.0.0.1:5432:5432'],
    });
    expect(endpoint).toBe('http://127.0.0.1:10254');
  });

  it('restarts with installer defaults for explicitly empty port overrides', async () => {
    fs.appendFileSync(
      path.join(dir, '.env'),
      'ONECLI_APP_PORT=11254\nONECLI_GATEWAY_PORT=11255\nPOSTGRES_PORT=15432\n',
    );
    for (const name of ['ONECLI_APP_PORT', 'ONECLI_GATEWAY_PORT', 'POSTGRES_PORT']) vi.stubEnv(name, '');
    const { run } = await import('./setup.js');
    await run([]);
    expect(bindings).toEqual({
      onecli: ['127.0.0.1:10254:10254', '172.17.0.1:10255:10255'],
      postgres: ['127.0.0.1:5432:5432'],
    });
  });

  it.each(['compose', 'saved environment', 'shell environment'])(
    'moves a bridge APP_URL from %s to the fresh admin address',
    async (source) => {
      if (source === 'compose')
        fs.writeFileSync(
          path.join(dir, 'docker-compose.yml'),
          compose.replace(/^      APP_URL:.*$/m, `      APP_URL: ${bridgeUrl}`),
        );
      if (source === 'saved environment') fs.appendFileSync(path.join(dir, '.env'), `APP_URL=${bridgeUrl}\n`);
      if (source === 'shell environment') vi.stubEnv('APP_URL', bridgeUrl);
      const { run } = await import('./setup.js');
      await run([]);
      expect(started.services.onecli.environment.APP_URL).toBe('http://127.0.0.1:10254');
      expect(endpoint).toBe('http://127.0.0.1:10254');
    },
  );

  it.each(['saved environment', 'shell environment'])('keeps a public APP_URL from the %s', async (source) => {
    const publicUrl = 'https://onecli.example.com';
    if (source === 'saved environment') fs.appendFileSync(path.join(dir, '.env'), `APP_URL=${publicUrl}\n`);
    if (source === 'shell environment') vi.stubEnv('APP_URL', publicUrl);
    const { run } = await import('./setup.js');
    await run([]);
    expect(started.services.onecli.environment.APP_URL).toBe(publicUrl);
    // A shell-only APP_URL is saved too, so later `docker compose up -d` runs keep it.
    expect(parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8')).APP_URL).toBe(publicUrl);
    expect(endpoint).toBe('http://127.0.0.1:10254');
  });

  it('prefers a public shell APP_URL over a saved bridge one, as Compose does', async () => {
    const publicUrl = 'https://onecli.example.com';
    fs.appendFileSync(path.join(dir, '.env'), `APP_URL=${bridgeUrl}\n`);
    vi.stubEnv('APP_URL', publicUrl);
    const { run } = await import('./setup.js');
    await run([]);
    expect(started.services.onecli.environment.APP_URL).toBe(publicUrl);
    expect(parseEnv(fs.readFileSync(path.join(dir, '.env'), 'utf8')).APP_URL).toBe(publicUrl);
  });

  it('keeps a 1.42 gateway on a loopback APP_URL even when .env saves a public one', async () => {
    fs.writeFileSync(
      path.join(dir, 'docker-compose.yml'),
      compose
        .replace(
          /^      APP_URL:.*$/m,
          '      APP_URL: http://${ONECLI_BIND_HOST:-127.0.0.1}:${ONECLI_APP_PORT:-10254}',
        )
        .replace(/^      INTERNAL_API_URL:.*\n/m, ''),
    );
    fs.appendFileSync(path.join(dir, '.env'), 'APP_URL=https://onecli.example.com\n');
    const { run } = await import('./setup.js');
    await run([]);
    expect(started.services.onecli.environment.APP_URL).toBe('http://127.0.0.1:10254');
  });

  it('warns and completes fresh setup when setting the CLI api-host fails', async () => {
    configSetFails = true;
    const { run } = await import('./setup.js');
    await run([]);
    expect(calls.warn).toHaveBeenCalledWith('onecli config set api-host failed', expect.any(Object));
    expect(parseEnv(fs.readFileSync(path.join(calls.home, '.env'), 'utf8')).ONECLI_URL).toBe('http://127.0.0.1:10254');
    expect(calls.status).toHaveBeenLastCalledWith('ONECLI', expect.objectContaining({ STATUS: 'success' }));
  });
});

describe('published-port verification guide', () => {
  const docs = fs.readFileSync(new URL('../payload/docs/onecli-upgrades.md', import.meta.url), 'utf8');
  const section = docs.slice(docs.indexOf('**Verify the bind interface.**'), docs.indexOf('Finally, restart'));

  it('gives manual bind, restart, client and probe steps for existing gateways', () => {
    expect(section).toContain('gateway installed before this change');
    expect(section).toContain('`~/.onecli/docker-compose.yml`');
    expect(section).toContain('`127.0.0.1:<admin port>:10254`');
    expect(section).toContain('`127.0.0.1:<Postgres port>:5432`');
    expect(section).toContain('Leave the gateway proxy line alone');
    expect(section).toContain('docker port "${ONECLI_GATEWAY_CONTAINER:-onecli}" 10254/tcp');
    expect(section).not.toMatch(/docker port onecli /);
    expect(section).toContain('Re-running the upstream OneCLI installer');
    expect(section).toContain('`APP_URL: ${APP_URL:-http://127.0.0.1:<admin port>}`');
    expect(section).toContain('`APP_URL=http://127.0.0.1:<admin port>`');
    expect(section).toContain('`APP_URL: http://127.0.0.1:10254`');
    expect(section).not.toContain('`APP_URL: http://127.0.0.1:<admin port>`');
    expect(section).toContain('`INTERNAL_API_URL`');
    expect(section).toContain('unless it already sets a public `APP_URL`');
    expect(section).toContain('cd ~/.onecli && env -u ONECLI_VERSION docker compose up -d');
    expect(section).toContain("NanoClaw's `.env` `ONECLI_URL`");
    expect(section).toContain('Then restart NanoClaw');
    expect(section).toContain('Re-run the two probes');
    expect(section).toContain('`admin` prints `000`');
    expect(section).toContain('`gateway` prints a code other than `000`');
    expect(section).not.toContain('NANOCLAW_EGRESS_LOCKDOWN');
  });

  it('uses the same api-host command as fresh setup', async () => {
    cli = false;
    const { run } = await import('./setup.js');
    await run([]);
    const set = calls.file.mock.calls.find(([command, args]) => command === 'onecli' && args[1] === 'set')!;
    expect(set).toBeDefined();
    expect(section).toContain([set[0], ...set[1]].join(' ').replace(':10254', ':<admin port>'));
  });
});
