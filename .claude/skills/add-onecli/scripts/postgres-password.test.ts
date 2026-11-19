import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  COMPOSE_DEFAULT_PASSWORD,
  type Exec,
  type Paths,
  envValue,
  passwordCheck,
  rotateDefaultPassword,
  scramVerifier,
  seedPassword,
  verifierMatches,
  withEnvLine,
} from './postgres-password.js';

// What postgres:18-alpine stored for the compose default `onecli`.
const PG_DEFAULT_VERIFIER =
  'SCRAM-SHA-256$4096:iIyI5+AT/OENlOTVXjBWeA==$chtS95aPbxR5WfPV1Tg02l+9WhqxzmzBDBtFIVFXMVM=:ck5DrzORTXrnyAl1Cf1wBlNHuEOTovNM716dgRE0Tvc=';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function tempPaths(env?: string): Paths {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-pg-'));
  roots.push(dir);
  const paths = { envFile: path.join(dir, '.env'), composeFile: path.join(dir, 'docker-compose.yml') };
  fs.writeFileSync(paths.composeFile, 'name: onecli\n');
  if (env !== undefined) fs.writeFileSync(paths.envFile, env, { mode: 0o600 });
  return paths;
}

const mode = (file: string) => fs.statSync(file).mode & 0o777;

/**
 * A Docker host running one OneCLI stack. State: the role's stored verifier, and
 * the password the running containers were created with (compose reads it from
 * .env on every `up`).
 */
function fakeDocker(
  paths: Paths,
  opts: {
    running?: boolean;
    verifier?: string;
    containerPassword?: string;
    volumes?: string[];
    configImage?: string;
    configPullPolicy?: string;
    configPlatform?: string;
    // `platform:` on every service.
    configPlatformAll?: string;
    imageArch?: { Architecture: string; Variant?: string };
    // The tag the running app was made from, and the image it runs.
    containerImage?: string;
    containerImageId?: string;
    // Tags pulled on this machine, beyond the two the stack uses.
    images?: Record<string, string>;
    configHostIp?: string;
    configVolume?: string;
    configService?: string;
    configPgdata?: string;
    configLiteralUrl?: boolean;
    // The app's `env_file: .env`, which compose folds into its environment.
    envFile?: boolean;
    containerExtra?: string;
    stopped?: boolean;
    readFails?: boolean;
    alterFails?: 'before-commit' | 'after-commit';
    rereadFails?: boolean;
    upFails?: boolean;
  } = {},
) {
  const state = {
    verifier: opts.verifier ?? PG_DEFAULT_VERIFIER,
    containerPassword: opts.containerPassword ?? COMPOSE_DEFAULT_PASSWORD,
    ups: 0,
    alters: 0,
    reads: 0,
  };
  const calls: Array<{ args: string[]; input?: string }> = [];
  const containers = [
    { service: 'postgres', image: 'postgres:18-alpine', port: 5432, volume: 'pgdata', target: '/var/lib/postgresql' },
    { service: 'onecli', image: 'ghcr.io/onecli/onecli:1.45.0', port: 10254, volume: 'app-data', target: '/app/data' },
  ];
  const env = (service: string) =>
    service === 'postgres'
      ? [
          'PATH=/usr/bin',
          `POSTGRES_PASSWORD=${state.containerPassword}`,
          'PGDATA=/var/lib/postgresql/18/docker',
          ...(opts.containerExtra ? [opts.containerExtra] : []),
        ]
      : [
          'PATH=/usr/bin',
          `DATABASE_URL=postgresql://onecli:${state.containerPassword}@postgres:5432/onecli`,
          'NODE_ENV=production',
        ];
  const imageEnv = (service: string) =>
    service === 'postgres' ? ['PATH=/usr/bin', 'PGDATA=/var/lib/postgresql/18/docker'] : ['PATH=/usr/bin'];
  const images: Record<string, string> = {
    'postgres:18-alpine': 'sha256:postgres',
    'ghcr.io/onecli/onecli:1.45.0': 'sha256:onecli',
    ...opts.images,
  };
  // What compose would set now: the password from .env, everything else as the file says.
  const configEnv = (service: string) => {
    const pw = envValue(fs.readFileSync(paths.envFile, 'utf8'), 'POSTGRES_PASSWORD') || COMPOSE_DEFAULT_PASSWORD;
    return service === 'postgres'
      ? { POSTGRES_PASSWORD: pw, PGDATA: opts.configPgdata ?? '/var/lib/postgresql/18/docker', POSTGRES_DB: null }
      : {
          ...(opts.envFile
            ? Object.fromEntries(
                fs
                  .readFileSync(paths.envFile, 'utf8')
                  .split('\n')
                  .filter((line) => line.includes('='))
                  .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
              )
            : {}),
          DATABASE_URL: `postgresql://onecli:${opts.configLiteralUrl ? COMPOSE_DEFAULT_PASSWORD : pw}@postgres:5432/onecli`,
          NODE_ENV: 'production',
        };
  };
  const exec: Exec = (cmd, args, input) => {
    calls.push({ args: [cmd, ...args], input });
    const line = args.join(' ');
    if (line.startsWith('ps -q')) return opts.running === false ? '' : 'pg1\n';
    if (line.startsWith('ps -aq') && line.includes('service=postgres')) {
      return opts.running !== false || opts.stopped ? 'pg1\n' : '';
    }
    if (line.startsWith('ps -aq')) return 'pg1\napp1\n';
    if (line.startsWith('image inspect')) {
      const id = args[2].startsWith('sha256:') ? args[2] : images[args[2]];
      if (!id) throw new Error(`Error: No such image: ${args[2]}`);
      const arch = opts.imageArch ?? { Architecture: 'amd64' };
      return JSON.stringify([{ Id: id, Os: 'linux', ...arch, Config: { Env: imageEnv(id.slice(7)) } }]);
    }
    if (line.startsWith('volume ls')) return (opts.volumes ?? []).join('\n');
    if (args[0] === 'exec' && input?.startsWith('SELECT')) {
      state.reads++;
      if (opts.readFails || (opts.rereadFails && state.alters > 0)) {
        throw new Error('Error response from daemon: container is restarting');
      }
      return `onecli|${state.verifier}\n`;
    }
    if (args[0] === 'exec' && input?.startsWith('ALTER')) {
      state.alters++;
      if (opts.alterFails === 'before-commit') throw new Error('psql: server closed the connection');
      state.verifier = /PASSWORD '([^']+)'/.exec(input)![1];
      if (opts.alterFails === 'after-commit') throw new Error('psql: server closed the connection');
      return '';
    }
    if (args[0] === 'compose' && args.includes('config')) {
      const services = Object.fromEntries(
        containers.map((c) => [
          c.service === 'onecli' ? (opts.configService ?? c.service) : c.service,
          {
            environment: configEnv(c.service),
            image: c.service === 'onecli' ? (opts.configImage ?? c.image) : c.image,
            ...(c.service === 'onecli' && opts.configPullPolicy ? { pull_policy: opts.configPullPolicy } : {}),
            ...(c.service === 'onecli' && opts.configPlatform ? { platform: opts.configPlatform } : {}),
            ...(opts.configPlatformAll ? { platform: opts.configPlatformAll } : {}),
            ports: [{ host_ip: opts.configHostIp ?? '127.0.0.1', published: String(c.port), target: c.port }],
            volumes: [
              {
                type: 'volume',
                source: c.service === 'postgres' ? (opts.configVolume ?? c.volume) : c.volume,
                target: c.target,
              },
            ],
          },
        ]),
      );
      const volumes = { pgdata: { name: 'onecli_pgdata' }, 'app-data': { name: 'onecli_app-data' } };
      return JSON.stringify({ name: 'onecli', services, volumes });
    }
    if (args[0] === 'inspect') {
      return JSON.stringify(
        containers.map((c) => ({
          Image: (c.service === 'onecli' && opts.containerImageId) || `sha256:${c.service}`,
          Config: {
            Image: (c.service === 'onecli' && opts.containerImage) || c.image,
            Labels: { 'com.docker.compose.service': c.service },
            Env: env(c.service),
          },
          HostConfig: { PortBindings: { [`${c.port}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: String(c.port) }] } },
          Mounts: [
            { Type: 'volume', Name: `onecli_${c.volume}`, Source: `/v/onecli_${c.volume}`, Destination: c.target },
            { Type: 'volume', Name: 'a'.repeat(64), Source: '/v/anon', Destination: '/tmp/anon' },
          ],
        })),
      );
    }
    if (args[0] === 'compose' && args.includes('up')) {
      if (opts.upFails) throw new Error('container onecli exited (1)');
      state.ups++;
      state.containerPassword =
        envValue(fs.readFileSync(paths.envFile, 'utf8'), 'POSTGRES_PASSWORD') || COMPOSE_DEFAULT_PASSWORD;
      return '';
    }
    throw new Error(`unexpected command: ${cmd} ${line}`);
  };
  return { exec, calls, state };
}

describe('SCRAM verifier', () => {
  it('reproduces what Postgres stores, so the default password is recognised', () => {
    expect(verifierMatches(PG_DEFAULT_VERIFIER, COMPOSE_DEFAULT_PASSWORD, 'onecli')).toBe(true);
    expect(verifierMatches(PG_DEFAULT_VERIFIER, 'something-else', 'onecli')).toBe(false);
  });

  it('recognises md5 hashes and rejects unknown formats', () => {
    const md5 =
      'md5' +
      crypto
        .createHash('md5')
        .update('onecli' + 'onecli')
        .digest('hex');
    expect(verifierMatches(md5, COMPOSE_DEFAULT_PASSWORD, 'onecli')).toBe(true);
    expect(verifierMatches(md5, COMPOSE_DEFAULT_PASSWORD, 'other-role')).toBe(false);
    expect(verifierMatches('', COMPOSE_DEFAULT_PASSWORD, 'onecli')).toBe(false);
    expect(verifierMatches('onecli', COMPOSE_DEFAULT_PASSWORD, 'onecli')).toBe(false);
  });

  it('salts every verifier', () => {
    const a = scramVerifier('pw');
    expect(a).not.toBe(scramVerifier('pw'));
    expect(verifierMatches(a, 'pw', 'onecli')).toBe(true);
  });
});

describe('.env helpers', () => {
  it('reads the last value without quotes', () => {
    expect(envValue('A=1\nPOSTGRES_PASSWORD="x"\nPOSTGRES_PASSWORD=y\n', 'POSTGRES_PASSWORD')).toBe('y');
    expect(envValue("POSTGRES_PASSWORD='q'\n", 'POSTGRES_PASSWORD')).toBe('q');
    expect(envValue('POSTGRES_PASSWORD=\n', 'POSTGRES_PASSWORD')).toBe('');
    expect(envValue('A=1\n', 'POSTGRES_PASSWORD')).toBeUndefined();
  });

  it('replaces every line for the name and keeps the rest', () => {
    expect(withEnvLine('A=1\nPOSTGRES_PASSWORD=\nB=2', 'POSTGRES_PASSWORD', 'p')).toBe(
      'A=1\nB=2\nPOSTGRES_PASSWORD=p\n',
    );
    expect(withEnvLine('', 'POSTGRES_PASSWORD', 'p')).toBe('POSTGRES_PASSWORD=p\n');
  });
});

describe('seedPassword (before the first start)', () => {
  it('writes a random URL-safe password, readable only by the owner', () => {
    const paths = tempPaths();
    expect(seedPassword(paths, fakeDocker(paths).exec)).toBe(true);
    const value = envValue(fs.readFileSync(paths.envFile, 'utf8'), 'POSTGRES_PASSWORD');
    expect(value).toMatch(/^[0-9a-f]{64}$/);
    expect(mode(paths.envFile)).toBe(0o600);
  });

  it('keeps an existing password and the other settings', () => {
    const paths = tempPaths('ONECLI_BIND_HOST=172.17.0.1\nPOSTGRES_PASSWORD=mine\n');
    expect(seedPassword(paths, fakeDocker(paths).exec)).toBe(false);
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe('ONECLI_BIND_HOST=172.17.0.1\nPOSTGRES_PASSWORD=mine\n');
  });

  it('replaces the compose default written out by hand', () => {
    const paths = tempPaths('POSTGRES_PASSWORD=onecli\n');
    expect(seedPassword(paths, fakeDocker(paths).exec)).toBe(true);
    expect(envValue(fs.readFileSync(paths.envFile, 'utf8'), 'POSTGRES_PASSWORD')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('leaves an existing database volume to the rotation', () => {
    const paths = tempPaths('ONECLI_BIND_HOST=172.17.0.1\n');
    expect(seedPassword(paths, fakeDocker(paths, { volumes: ['onecli_app-data', 'onecli_pgdata'] }).exec)).toBe(false);
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe('ONECLI_BIND_HOST=172.17.0.1\n');
  });
});

describe('rotateDefaultPassword (existing installs)', () => {
  const env = 'ONECLI_VERSION=1.45.0\nONECLI_BIND_HOST=127.0.0.1\n';
  const saved = (paths: Paths) => envValue(fs.readFileSync(paths.envFile, 'utf8'), 'POSTGRES_PASSWORD');

  it('moves a default database to a new password, saves it, and recreates the stack', () => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths);
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });

    const password = saved(paths)!;
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(fs.readFileSync(paths.envFile, 'utf8').startsWith(env)).toBe(true);
    expect(mode(paths.envFile)).toBe(0o600);
    expect(verifierMatches(docker.state.verifier, password, 'onecli')).toBe(true);
    expect(verifierMatches(docker.state.verifier, COMPOSE_DEFAULT_PASSWORD, 'onecli')).toBe(false);
    expect(docker.state).toMatchObject({ ups: 1, containerPassword: password });
    // compose must read ~/.onecli/.env, not one in the caller's working directory.
    const dir = path.dirname(paths.composeFile);
    for (const sub of ['config', 'up']) {
      const call = docker.calls.find((c) => c.args[1] === 'compose' && c.args.includes(sub))!;
      expect(call.args.slice(0, 8)).toEqual([
        'docker',
        'compose',
        '-p',
        'onecli',
        '--project-directory',
        dir,
        '-f',
        paths.composeFile,
      ]);
    }
    expect(docker.calls.find((c) => c.args.includes('up'))!.args.slice(8)).toEqual(['up', '-d', '--wait']);
    // The plain password never leaves the .env file.
    for (const call of docker.calls) expect(JSON.stringify(call)).not.toContain(password);
  });

  it('moves a macOS install, whose app started before setup saved ONECLI_VERSION in .env', () => {
    // compose config now has .env's ONECLI_VERSION and ONECLI_BIND_HOST, plus a port saved as
    // docs/onecli-upgrades.md says; the running app has none of them.
    const paths = tempPaths(`${env}ONECLI_APP_PORT=10254\n`);
    const docker = fakeDocker(paths, { envFile: true });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
    expect(docker.state.ups).toBe(1);
  });

  it('moves an install whose app was made from another tag of the same image', () => {
    // Made from `latest` before setup pinned ONECLI_VERSION; both tags name the same local image.
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, {
      envFile: true,
      containerImage: 'ghcr.io/onecli/onecli:latest',
      images: { 'ghcr.io/onecli/onecli:latest': 'sha256:onecli' },
    });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
    expect(docker.state.ups).toBe(1);
  });

  it.each([
    ['pull_policy missing', { configPullPolicy: 'missing' }],
    ['pull_policy never', { configPullPolicy: 'never' }],
    ['the platform of its image', { configPlatform: 'linux/amd64' }],
    ['linux/arm64 for an arm64 image', { configPlatform: 'linux/arm64', imageArch: { Architecture: 'arm64' } }],
    ['linux/arm64/v8 for an arm64 image', { configPlatform: 'linux/arm64/v8', imageArch: { Architecture: 'arm64' } }],
    [
      'linux/arm64 for an arm64/v8 image',
      { configPlatform: 'linux/arm64', imageArch: { Architecture: 'arm64', Variant: 'v8' } },
    ],
    [
      'linux/amd64 for an amd64/v1 image',
      { configPlatform: 'linux/amd64', imageArch: { Architecture: 'amd64', Variant: 'v1' } },
    ],
  ])('moves an install whose compose file sets %s', (_label, opts) => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, opts);
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
  });

  it.each([
    ['matches its images', 'linux/amd64', {}],
    ['matches its images, written as compose also reads it', "'linux/amd64' # x86", {}],
    ['is overridden by each service', 'linux/arm64', { configPlatformAll: 'linux/amd64' }],
  ])('moves an install whose .env DOCKER_DEFAULT_PLATFORM %s', (_label, platform, opts) => {
    const paths = tempPaths(`${env}export DOCKER_DEFAULT_PLATFORM=${platform}\n`);
    const docker = fakeDocker(paths, opts);
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
  });

  it.each([
    'DOCKER_DEFAULT_PLATFORM=linux/arm64',
    'export DOCKER_DEFAULT_PLATFORM=linux/arm64',
    'DOCKER_DEFAULT_PLATFORM = "linux/arm64" # Apple Silicon',
  ])("refuses, changing nothing, when .env's %s is not its images' platform", (line) => {
    const content = `${env}${line}\n`;
    const paths = tempPaths(content);
    const docker = fakeDocker(paths);
    expect(rotateDefaultPassword(paths, docker.exec)).toMatchObject({
      status: 'refused',
      detail: 'postgres would need postgres:18-alpine for linux/arm64, which is not on this machine',
    });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(content);
    expect(docker.state).toMatchObject({ alters: 0, ups: 0 });
  });

  it('moves an install whose tag now names a newer image, as any restart would', () => {
    // e.g. another project pulled a newer postgres:18-alpine; refusing would leave the default in place.
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, { containerImageId: 'sha256:onecli-older' });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
    expect(docker.state.ups).toBe(1);
  });

  it.each([
    ['an app setting', 'SECRET_ENCRYPTION_KEY'],
    ['a database setting the compose file also interpolates', 'POSTGRES_USER'],
  ])('refuses, changing nothing, when .env adds %s', (_label, key) => {
    const content = `${env}${key}=x\n`;
    const paths = tempPaths(content);
    const docker = fakeDocker(paths, { envFile: true });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'refused', detail: `onecli would add ${key}` });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(content);
    expect(docker.state).toMatchObject({ alters: 0, ups: 0 });
  });

  it('does nothing on a second run', () => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths);
    rotateDefaultPassword(paths, docker.exec);
    const before = fs.readFileSync(paths.envFile, 'utf8');
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'own-password' });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(before);
    expect(docker.state).toMatchObject({ alters: 1, ups: 1 });
  });

  it('reuses a password already saved in .env (a retry, or one set by hand)', () => {
    const paths = tempPaths(`${env}POSTGRES_PASSWORD="chosen-Pw_1.x~"\n`);
    const docker = fakeDocker(paths);
    expect(rotateDefaultPassword(paths, docker.exec).status).toBe('rotated');
    expect(verifierMatches(docker.state.verifier, 'chosen-Pw_1.x~', 'onecli')).toBe(true);
    expect(saved(paths)).toBe('chosen-Pw_1.x~');
  });

  it.each([
    ['the compose default', 'onecli'],
    ['a value compose would rewrite', "'pass$word'"],
    ['a value that breaks the database URL', 'p@ss/word'],
    ['a non-ASCII value', 'I\u00ADX'],
  ])('replaces %s saved in .env instead of reusing it', (_label, value) => {
    const paths = tempPaths(`${env}POSTGRES_PASSWORD=${value}\n`);
    const docker = fakeDocker(paths);
    expect(rotateDefaultPassword(paths, docker.exec).status).toBe('rotated');
    const password = saved(paths)!;
    expect(password).toMatch(/^[0-9a-f]{64}$/);
    expect(verifierMatches(docker.state.verifier, password, 'onecli')).toBe(true);
  });

  it('leaves a database with its own password alone', () => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, { verifier: scramVerifier('already-custom') });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'own-password' });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(env);
    expect(docker.state).toMatchObject({ alters: 0, ups: 0 });
  });

  it.each([
    ['no OneCLI database', {}, 'no-database'],
    ['a stopped one', { stopped: true }, 'stopped'],
  ])('does nothing with %s', (_label, opts, status) => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, { running: false, ...opts });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status });
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(env);
  });

  it.each([
    [
      'an image change (no ONECLI_VERSION saved)',
      {
        configImage: 'ghcr.io/onecli/onecli:latest',
        images: { 'ghcr.io/onecli/onecli:latest': 'sha256:onecli-newer' },
      },
      /onecli would switch from ghcr\.io\/onecli\/onecli:1\.45\.0 to ghcr\.io\/onecli\/onecli:latest/,
    ],
    [
      'another image under another tag, even one both tags name now',
      {
        containerImage: 'ghcr.io/onecli/onecli:latest',
        containerImageId: 'sha256:onecli-older',
        images: { 'ghcr.io/onecli/onecli:latest': 'sha256:onecli' },
      },
      /onecli would switch from ghcr\.io\/onecli\/onecli:latest to ghcr\.io\/onecli\/onecli:1\.45\.0/,
    ],
    [
      'a tag that is not on this machine',
      { configImage: 'ghcr.io/onecli/onecli:1.46.0' },
      /onecli would need ghcr\.io\/onecli\/onecli:1\.46\.0, which is not on this machine/,
    ],
    [
      'its own tag, removed from this machine',
      { images: { 'ghcr.io/onecli/onecli:1.45.0': '' } },
      /onecli would need ghcr\.io\/onecli\/onecli:1\.45\.0, which is not on this machine/,
    ],
    [
      'a pull_policy that fetches an image already here',
      { configPullPolicy: 'always' },
      /onecli has pull_policy always, so a restart could change its image/,
    ],
    ['a pull_policy that rebuilds the image', { configPullPolicy: 'build' }, /onecli has pull_policy build/],
    [
      'another platform than its image',
      { configPlatform: 'linux/arm64' },
      /onecli would need ghcr\.io\/onecli\/onecli:1\.45\.0 for linux\/arm64, which is not on this machine/,
    ],
    [
      'linux/arm, which means v7, for an arm/v6 image',
      { configPlatform: 'linux/arm', imageArch: { Architecture: 'arm', Variant: 'v6' } },
      /for linux\/arm, which is not on this machine/,
    ],
    ['a platform with an extra part', { configPlatform: 'linux/amd64/v1/extra' }, /for linux\/amd64\/v1\/extra, which/],
    ['a platform with an empty part', { configPlatform: 'linux//amd64' }, /for linux\/\/amd64, which/],
    [
      'linux/amd64 for an amd64/v3 image',
      { configPlatform: 'linux/amd64', imageArch: { Architecture: 'amd64', Variant: 'v3' } },
      /for linux\/amd64, which is not on this machine/,
    ],
    ['a bind change', { configHostIp: '172.17.0.1' }, /would move from 127\.0\.0\.1/],
    ['a different data volume', { configVolume: 'other' }, /postgres would mount onecli_other/],
    ['a different data directory', { configPgdata: '/var/lib/postgresql/data' }, /postgres would change PGDATA/],
    ['a renamed service', { configService: 'app' }, /onecli is not in .*docker-compose\.yml/],
    ['a dropped setting', { containerExtra: 'LEGACY=1' }, /postgres would drop LEGACY/],
    ['a DATABASE_URL that ignores the saved password', { configLiteralUrl: true }, /onecli sets its DATABASE_URL/],
    ['an unreadable database', { readFails: true }, /could not inspect OneCLI/],
  ])('refuses, changing nothing, when a recreate would bring %s', (_label, opts, detail) => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, opts);
    const result = rotateDefaultPassword(paths, docker.exec);
    expect(result.status).toBe('refused');
    expect(result.status === 'refused' && result.detail).toMatch(detail);
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(env);
    expect(docker.state).toMatchObject({ alters: 0, ups: 0 });
  });

  it('restores .env when the password was not set', () => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, { alterFails: 'before-commit' });
    expect(() => rotateDefaultPassword(paths, docker.exec)).toThrow(/nothing changed/);
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe(env);
    expect(verifierMatches(docker.state.verifier, COMPOSE_DEFAULT_PASSWORD, 'onecli')).toBe(true);
    expect(docker.state.ups).toBe(0);
  });

  it('carries on when the password was set but psql reported an error', () => {
    const paths = tempPaths(env);
    const docker = fakeDocker(paths, { alterFails: 'after-commit' });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
    const password = saved(paths)!;
    expect(verifierMatches(docker.state.verifier, password, 'onecli')).toBe(true);
    expect(docker.state).toMatchObject({ ups: 1, containerPassword: password });
  });

  it('keeps the new password when it cannot tell whether it was set, and the next run finishes', () => {
    const paths = tempPaths(env);
    const failing = fakeDocker(paths, { alterFails: 'after-commit', rereadFails: true });
    expect(() => rotateDefaultPassword(paths, failing.exec)).toThrow(/run this again/);
    const password = saved(paths)!;
    expect(verifierMatches(failing.state.verifier, password, 'onecli')).toBe(true);

    const docker = fakeDocker(paths, { verifier: failing.state.verifier });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
    expect(docker.state).toMatchObject({ alters: 0, ups: 1, containerPassword: password });
  });

  it('finishes a run that stopped after the password changed but before the restart', () => {
    const paths = tempPaths(env);
    const first = fakeDocker(paths, { upFails: true });
    expect(() => rotateDefaultPassword(paths, first.exec)).toThrow(/docker compose up -d/);
    const password = saved(paths)!;
    expect(first.state.containerPassword).toBe(COMPOSE_DEFAULT_PASSWORD);

    const docker = fakeDocker(paths, { verifier: first.state.verifier });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'rotated' });
    expect(docker.state).toMatchObject({ alters: 0, ups: 1, containerPassword: password });
    expect(rotateDefaultPassword(paths, docker.exec)).toEqual({ status: 'own-password' });
    expect(docker.state.ups).toBe(1);
  });
});

describe('passwordCheck (after setup)', () => {
  it('warns while the database still accepts the compose default, and changes nothing', () => {
    const paths = tempPaths('ONECLI_VERSION=1.45.0\n');
    const docker = fakeDocker(paths);
    const result = passwordCheck(docker.exec);
    expect(result.warn).toBe('yes');
    expect(result.hint).toMatch(/still accepts the default password.*postgres-password\.ts/);
    expect(fs.readFileSync(paths.envFile, 'utf8')).toBe('ONECLI_VERSION=1.45.0\n');
    expect(docker.state).toMatchObject({ alters: 0, ups: 0 });
  });

  it('is quiet once the database has its own password', () => {
    const docker = fakeDocker(tempPaths(), { verifier: scramVerifier('already-custom') });
    expect(passwordCheck(docker.exec)).toEqual({ warn: 'no', hint: 'none' });
  });

  it.each([
    ['no OneCLI database', {}],
    ['a stopped one', { stopped: true }],
  ])('is quiet with %s', (_label, opts) => {
    const docker = fakeDocker(tempPaths(), { running: false, ...opts });
    expect(passwordCheck(docker.exec)).toEqual({ warn: 'no', hint: 'none' });
  });

  it('says so when a running database cannot be read', () => {
    const docker = fakeDocker(tempPaths(), { readFails: true });
    const result = passwordCheck(docker.exec);
    expect(result.warn).toBe('yes');
    expect(result.hint).toMatch(/Could not check/);
  });
});

describe('running the script directly', () => {
  // From a checkout path with a space, against a Docker with no OneCLI containers that logs what it gets.
  function runFromSpacedPath(extraEnv: Record<string, string> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli pg '));
    roots.push(dir);
    fs.copyFileSync(new URL('./postgres-password.ts', import.meta.url), path.join(dir, 'postgres-password.ts'));
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}\n');
    fs.mkdirSync(path.join(dir, 'bin'));
    const log = path.join(dir, 'docker-env');
    const vars = ['POSTGRES_PASSWORD', 'ONECLI_VERSION', 'DOCKER_DEFAULT_PLATFORM', 'COMPOSE_ENV_FILES'];
    const record = vars.map((v) => `${v}=\${${v}-unset}`).join(' ');
    fs.writeFileSync(path.join(dir, 'bin', 'docker'), `#!/bin/sh\necho "${record}" >> '${log}'\nexit 0\n`, {
      mode: 0o755,
    });
    const result = spawnSync(process.execPath, ['--import', 'tsx', path.join(dir, 'postgres-password.ts')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        ...extraEnv,
        HOME: dir,
        PATH: `${path.join(dir, 'bin')}${path.delimiter}${process.env.PATH}`,
      },
    });
    return { result, dockerEnv: fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
  }

  it('runs from a checkout path with a space', () => {
    const { result } = runFromSpacedPath();
    expect(result.stdout).toContain('No OneCLI database on this machine');
    expect(result.status).toBe(0);
  });

  it("keeps the caller's settings that change what compose runs away from Docker", () => {
    const { result, dockerEnv } = runFromSpacedPath({
      POSTGRES_PASSWORD: 'x',
      ONECLI_VERSION: '9.9.9',
      DOCKER_DEFAULT_PLATFORM: 'linux/arm64',
      COMPOSE_ENV_FILES: '/elsewhere/platform.env',
    });
    expect(result.status).toBe(0);
    expect(dockerEnv).toMatch(
      /^(POSTGRES_PASSWORD=unset ONECLI_VERSION=unset DOCKER_DEFAULT_PLATFORM=unset COMPOSE_ENV_FILES=unset\n)+$/,
    );
  });

  it('does nothing when imported, even when argv[1] is not a file', () => {
    const script = new URL('./postgres-password.ts', import.meta.url).href;
    const result = spawnSync(
      process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', `import ${JSON.stringify(script)}`, '--', 'not-a-file'],
      { encoding: 'utf8' },
    );
    expect(result.stderr).toBe('');
    expect(result.stdout).toBe('');
    expect(result.status).toBe(0);
  });
});
