import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import { assertCredentialIsolation } from './credential-isolation.js';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installCommand } from './install-command.js';

import * as p from '@clack/prompts';
import { stringify as yaml } from 'yaml';
import { getInstallSlug } from '../../../../src/install-slug.js';
import { upsertEnvVar } from '../../../../setup/set-env.js';

const skill = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(skill, 'versions.json'), 'utf8'));
const secret = () => randomBytes(32).toString('hex');

export function controlPaths(root = process.cwd()) {
  const slug = getInstallSlug(root);
  const directory = path.join(root, 'data', 'session-materials', 'iron-control');
  return {
    directory,
    project: `nanoclaw-iron-control-${slug}`,
    network: `nanoclaw-iron-control-${slug}`,
    compose: path.join(directory, 'compose.yaml'),
    environment: path.join(directory, 'control.env'),
    databaseEnvironment: path.join(directory, 'database.env'),
    proxyEnvironment: path.join(directory, 'proxy.env'),
    registration: path.join(directory, 'registration.json'),
    login: path.join(directory, 'login.txt'),
  };
}

function writePrivate(file: string, text: string): void {
  fs.writeFileSync(file, text, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

export function controlPort(root: string): number {
  const env = fs.existsSync(path.join(root, '.env')) ? fs.readFileSync(path.join(root, '.env'), 'utf8') : '';
  const port = Number(
    process.env.NANOCLAW_IRON_CONTROL_PORT || env.match(/^NANOCLAW_IRON_CONTROL_PORT=(.*)$/m)?.[1] || 10257,
  );
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('Iron Control port must be between 1 and 65535');
  return port;
}

export function controlCompose(root: string, port: number): string {
  const p = controlPaths(root);
  return yaml({
    name: p.project,
    services: {
      database: {
        image: pins['iron-control-postgres-image'],
        restart: 'unless-stopped',
        env_file: [p.databaseEnvironment],
        volumes: ['database:/var/lib/postgresql/data'],
        healthcheck: { test: ['CMD-SHELL', 'pg_isready -U iron_control'], interval: '2s', timeout: '3s', retries: 30 },
      },
      web: {
        image: pins['iron-control-image'],
        platform: pins['iron-control-platform'],
        restart: 'unless-stopped',
        env_file: [p.environment],
        command: ['./bin/rails', 'server'],
        ports: [`127.0.0.1:${port}:3000`],
        depends_on: { database: { condition: 'service_healthy' } },
        healthcheck: {
          test: ['CMD', 'curl', '-fsS', 'http://127.0.0.1:3000/up'],
          interval: '3s',
          timeout: '5s',
          retries: 60,
          start_period: '30s',
        },
      },
    },
    volumes: { database: {} },
    networks: { default: { name: p.network } },
  });
}

async function compose(root: string, args: string[]): Promise<void> {
  const p = controlPaths(root);
  await installCommand('docker', ['compose', '-p', p.project, '-f', p.compose, ...args], {
    label: args[0] === 'up' ? 'Pull and start Iron Control and database' : 'Stop Iron Control',
    timeoutMs: 360_000,
    failureHint:
      'Check Docker and access to the pinned console/database images. Registry permissions require authentication on this machine. Existing database and keys have been kept; retry after fixing access.',
  });
}

function readEnvironment(root: string): Record<string, string> {
  return Object.fromEntries(
    fs
      .readFileSync(controlPaths(root).environment, 'utf8')
      .trim()
      .split('\n')
      .map((line) => {
        const eq = line.indexOf('=');
        return [line.slice(0, eq), line.slice(eq + 1)];
      }),
  );
}

export class IronControlRequestError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** Calls the official local API; never returns credentials to an agent. */
export async function controlRequest(root: string, resource: string, method = 'GET', data?: unknown): Promise<any> {
  const p = controlPaths(root);
  const env = readEnvironment(root);
  const response = await fetch(`http://127.0.0.1:${controlPort(root)}/api/v1/${resource}`, {
    method,
    headers: { Authorization: `Bearer ${env.IRON_CONTROL_INITIAL_API_KEY}`, 'Content-Type': 'application/json' },
    ...(data === undefined ? {} : { body: JSON.stringify({ data }) }),
    signal: AbortSignal.timeout(15_000),
    redirect: 'error',
  });
  if (!response.ok)
    throw new IronControlRequestError(
      `Iron Control ${method} ${resource} failed (${response.status}); inspect ${p.project} logs`,
      response.status,
    );
  return response.status === 204 ? null : ((await response.json()) as { data: unknown }).data;
}

/** Runs one `docker` command and resolves its stdout; the install seam for tests. */
export type DockerRunner = (args: string[], label: string) => Promise<string>;

const dockerCapture: DockerRunner = (args, label) =>
  installCommand('docker', args, { label, timeoutMs: 15_000, capture: true });

/** One container Docker Compose created for this install's Iron Control project. */
export interface ControlContainer {
  name: string;
  /** The compose service: `web` carries the keys in its environment, `database` mounts the volume. */
  service: string;
  running: boolean;
}

export interface ControlDatabaseState {
  volume: string;
  /** The database volume exists. */
  exists: boolean;
  /** This install's Iron Control containers (compose project label), running or stopped. */
  containers: ControlContainer[];
  /** Containers outside this install's compose project that mount the volume; never touched here. */
  foreign: string[];
}

/**
 * Lists what an earlier Iron Control install of THIS checkout left in Docker:
 * the containers Compose labelled with this install's project name, and the
 * database volume. Another install has another slug, so neither its project
 * name nor its volume name can match.
 */
export async function inspectControlDatabase(
  root: string,
  docker: DockerRunner = dockerCapture,
): Promise<ControlDatabaseState> {
  const project = controlPaths(root).project;
  const volume = `${project}_database`;
  const volumes = await docker(['volume', 'ls', '--format', '{{.Name}}'], 'Check existing Iron Control data');
  const exists = volumes.trim().split('\n').includes(volume);
  const listed = await docker(
    [
      'ps',
      '-a',
      '--filter',
      `label=com.docker.compose.project=${project}`,
      '--format',
      '{{.Names}}\t{{.Label "com.docker.compose.service"}}\t{{.State}}',
    ],
    'Check existing Iron Control services',
  );
  const containers = listed
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [name, service = '', state = ''] = line.split('\t');
      return { name, service, running: state === 'running' };
    });
  if (!exists) return { volume, exists, containers, foreign: [] };
  const mounting = await docker(
    ['ps', '-a', '--filter', `volume=${volume}`, '--format', '{{.Names}}'],
    'Check services using the Iron Control database',
  );
  const own = new Set(containers.map((container) => container.name));
  const foreign = mounting
    .trim()
    .split('\n')
    .filter((name) => name && !own.has(name));
  return { volume, exists, containers, foreign };
}

export interface InstallControlOptions {
  docker?: DockerRunner;
  /**
   * Asks the operator whether this install's old Iron Control services and
   * database may be removed. Absent in a headless run, which stops with the
   * exact commands instead.
   */
  confirmRemoval?: (message: string) => Promise<boolean>;
}

async function askRemoval(message: string): Promise<boolean> {
  const answer = await p.select({
    message,
    options: [
      { value: 'remove', label: 'Remove it and start fresh' },
      { value: 'abort', label: 'Abort' },
    ],
    // Enter alone keeps everything; removal takes a deliberate move.
    initialValue: 'abort',
  });
  return !p.isCancel(answer) && answer === 'remove';
}

/** "services a, b and database volume v": what the earlier install left behind. */
function leftovers(state: ControlDatabaseState): string {
  const names = state.containers.map((container) => container.name);
  return [
    ...(names.length ? [`services ${names.join(', ')}`] : []),
    ...(state.exists ? [`database volume ${state.volume}`] : []),
  ].join(' and ');
}

/** The commands that remove what `state` lists, in the order Docker accepts them. */
function removalCommand(state: ControlDatabaseState, extraContainers: string[] = []): string {
  const names = [...state.containers.map((container) => container.name), ...extraContainers];
  return [
    ...(names.length ? [`docker rm -f ${names.join(' ')}`] : []),
    ...(state.exists ? [`docker volume rm ${state.volume}`] : []),
  ].join(' && ');
}

/**
 * `control.env` was the only file holding the encryption keys, but the `web`
 * container still carries them in its environment. Once it is removed, the
 * database rows are unreadable for good, so every path that may remove it
 * says so first.
 */
function keysWarning(state: ControlDatabaseState): string {
  const web = state.containers.find((container) => container.service === 'web');
  if (!web) return '';
  return (
    ` The ${web.running ? 'running ' : ''}web container ${web.name} holds the only remaining copy of those keys ` +
    `(its environment: docker inspect ${web.name}); removing it destroys them and every credential stored in the database.`
  );
}

/**
 * Without this install's `control.env` the database cannot be opened: its rows
 * are encrypted with keys only that file held. What the earlier install left in
 * Docker (this install's compose containers, the volume, or both) may be
 * removed together with explicit consent; a container outside this install's
 * compose project that mounts the volume is never touched here.
 */
export async function resolveOrphanedDatabase(root: string, options: InstallControlOptions = {}): Promise<void> {
  const paths = controlPaths(root);
  const state = await inspectControlDatabase(root, options.docker);
  if (!state.exists && !state.containers.length) return;
  if (state.foreign.length) {
    throw new Error(
      `Iron Control database ${state.volume} is still used by ${state.foreign.join(', ')}, which this install did not create, ` +
        `and its encryption keys are missing for this install. Restore ${paths.environment}, ` +
        `or remove those services and the database by hand: ${removalCommand(state, state.foreign)}`,
    );
  }
  const command = removalCommand(state);
  const confirm = options.confirmRemoval ?? (process.stdin.isTTY ? askRemoval : undefined);
  if (!confirm) {
    throw new Error(
      `An earlier Iron Control install of this checkout left ${leftovers(state)} in Docker, but its encryption keys are missing for this install.` +
        `${keysWarning(state)} Restore ${paths.environment}, or remove the old install with: ${command}`,
    );
  }
  console.log(
    `The old Iron Control install (${leftovers(state)}) can't be reused without its keys.${keysWarning(state)}`,
  );
  const web = state.containers.find((container) => container.service === 'web');
  const question = web
    ? `Remove it and start fresh? This destroys the keys held by ${web.name} and every credential in the old database.`
    : 'Remove it and start fresh?';
  if (!(await confirm(question))) {
    throw new Error(
      `Kept the old Iron Control install (${leftovers(state)}). Restore ${paths.environment} or run: ${command}`,
    );
  }
  const docker = options.docker ?? dockerCapture;
  const names = state.containers.map((container) => container.name);
  if (names.length) await docker(['rm', '-f', ...names], 'Remove the old Iron Control services');
  if (state.exists) await docker(['volume', 'rm', state.volume], 'Remove the orphaned Iron Control database');
}

export async function installControl(root = process.cwd(), options: InstallControlOptions = {}): Promise<void> {
  const p = controlPaths(root);
  const port = controlPort(root);
  const url = `http://127.0.0.1:${port}`;
  fs.mkdirSync(p.directory, { recursive: true, mode: 0o700 });
  fs.chmodSync(p.directory, 0o700);
  if (!fs.existsSync(p.environment)) {
    await resolveOrphanedDatabase(root, options);
    // New keys go with a new database (none existed, or the orphan was just
    // removed with consent). A registration or proxy token left from an older
    // database names a proxy that database took with it; keeping it would make
    // every retry look up that proxy and stop on its 404.
    for (const stale of [p.registration, p.proxyEnvironment]) fs.rmSync(stale, { force: true });
    const password = secret();
    const email = 'operator@nanoclaw.local';
    const databasePassword = secret();
    const env = {
      RAILS_ENV: 'production',
      SECRET_KEY_BASE: secret(),
      IRON_CONTROL_AR_ENCRYPTION_PRIMARY_KEY: secret(),
      IRON_CONTROL_AR_ENCRYPTION_DETERMINISTIC_KEY: secret(),
      IRON_CONTROL_AR_ENCRYPTION_KEY_DERIVATION_SALT: secret(),
      IRON_CONTROL_DB_HOST: 'database',
      IRON_CONTROL_DATABASE_PASSWORD: databasePassword,
      IRON_CONTROL_INITIAL_USER_EMAIL: email,
      IRON_CONTROL_INITIAL_USER_PASSWORD: password,
      IRON_CONTROL_INITIAL_API_KEY: `iak_${secret()}`,
      IRON_CONTROL_SOLID_QUEUE_IN_PUMA: 'true',
    };
    writePrivate(
      p.environment,
      Object.entries(env)
        .map(([key, value]) => `${key}=${value}`)
        .join('\n') + '\n',
    );
    writePrivate(p.login, `Email: ${email}\nPassword: ${password}\n`);
  }
  const environment = readEnvironment(root);
  writePrivate(
    p.databaseEnvironment,
    `POSTGRES_USER=iron_control\nPOSTGRES_PASSWORD=${environment.IRON_CONTROL_DATABASE_PASSWORD}\n`,
  );
  // Keep encryption and account keys unchanged on every refresh.
  writePrivate(p.compose, controlCompose(root, port));
  await compose(root, ['up', '-d', '--wait', '--wait-timeout', '240']);
  let registration: { principalId: string; proxyId: string };
  if (fs.existsSync(p.registration)) {
    registration = JSON.parse(fs.readFileSync(p.registration, 'utf8'));
    await controlRequest(root, `proxies/${registration.proxyId}`);
    if (!fs.existsSync(p.proxyEnvironment))
      throw new Error('Iron proxy token file is missing; restore it before reconnecting');
  } else {
    const principal = await controlRequest(root, 'principals/nanoclaw', 'PUT', {
      namespace: getInstallSlug(root),
      name: 'NanoClaw',
    });
    const proxy = await controlRequest(root, 'proxies', 'POST', {
      name: `NanoClaw ${getInstallSlug(root)}`,
      principal_id: principal.id,
    });
    writePrivate(p.proxyEnvironment, `IRON_PROXY_TOKEN=${proxy.token}\nIRON_CONTROL_PLANE_URL=http://web:3000\n`);
    registration = { principalId: principal.id, proxyId: proxy.id };
    writePrivate(p.registration, JSON.stringify(registration, null, 2) + '\n');
  }
  upsertEnvVar('NANOCLAW_IRON_CONTROL_PORT', String(port), root);
  upsertEnvVar('NANOCLAW_IRON_CONTROL_URL', url, root);
  console.log(`Official Iron Control: ${url}\nLocal login details: ${p.login}`);
}

export async function removeControl(root = process.cwd()): Promise<void> {
  if (fs.existsSync(controlPaths(root).compose)) await compose(root, ['down']);
}

export async function grantSecret(kind: string, id: string, root = process.cwd()): Promise<void> {
  const fields: Record<string, string> = {
    static: 'static_secret_id',
    gcp: 'gcp_auth_secret_id',
    aws: 'aws_auth_secret_id',
    oauth: 'oauth_token_secret_id',
    postgres: 'pg_dsn_secret_id',
    hmac: 'hmac_secret_id',
  };
  if (!fields[kind]) throw new Error('Secret kind must be static, gcp, aws, oauth, postgres, or hmac');
  const { principalId } = JSON.parse(fs.readFileSync(controlPaths(root).registration, 'utf8'));
  for (let page = 1; ; page++) {
    const grants = await controlRequest(root, `principals/${principalId}/grants?limit=200&page=${page}`);
    if (grants.some((grant: Record<string, string>) => grant[fields[kind]] === id)) return;
    if (grants.length < 200) break;
  }
  await controlRequest(root, 'grants', 'POST', { principal_id: principalId, [fields[kind]]: id });
  console.log('Credential granted to this NanoClaw install. Iron Proxy will sync it automatically.');
}

export async function storeModelCredential(value: string, host: string, root: string, authEnv?: string): Promise<void> {
  await assertCredentialIsolation(root, {
    host,
    headers: ['Authorization', 'x-api-key'],
    proxyValue: 'gateway-managed',
    ownedForeignIds: ['nanoclaw-model'],
  });
  const credential = await controlRequest(root, 'static_secrets/nanoclaw-model', 'PUT', {
    namespace: getInstallSlug(root),
    name: authEnv ? `NanoClaw model (${authEnv})` : 'NanoClaw model',
    source: { source_type: 'control_plane', secret: value, config: {} },
    inject_config: {},
    replace_config: { proxy_value: 'gateway-managed', match_headers: ['Authorization', 'X-Api-Key'], require: false },
    // CONNECT establishes the tunnel before the SDK sends its auth header.
    // Require replacement only on the inner HTTP requests.
    rules: [{ host, http_methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] }],
  });
  await grantSecret('static', credential.id, root);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  const [command, kind, id] = process.argv.slice(2);
  const run = async () => {
    if (command === 'grant' && kind && id) await grantSecret(kind, id);
    else if (command === 'remove') await removeControl();
    else if (command === 'status') {
      const p = controlPaths();
      console.log(
        `Official Iron Control: http://127.0.0.1:${controlPort(process.cwd())}\nLocal login details: ${p.login}`,
      );
    } else
      throw new Error(
        'Use setup.ts --with-control to install; control.ts accepts status, grant <kind> <id>, or remove',
      );
  };
  void run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
