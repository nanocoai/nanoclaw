/**
 * OneCLI's compose files fall back to a fixed Postgres password when none is
 * set. Setup gives each install its own; run alone, this moves an existing
 * install off the fallback: pnpm exec tsx .claude/skills/add-onecli/scripts/postgres-password.ts
 */
import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';

export const COMPOSE_DEFAULT_PASSWORD = 'onecli';
const PROJECT = 'onecli';
const VAR = 'POSTGRES_PASSWORD';
// Shell exports beat .env in compose interpolation (the upgrade guide drops these too), and COMPOSE_*
// settings such as COMPOSE_ENV_FILES make compose read files the checks below do not. A default
// platform from .env is checked below.
const SHADOWING_VARS = [VAR, 'ONECLI_VERSION', 'DOCKER_DEFAULT_PLATFORM'];

export type Exec = (cmd: string, args: string[], input?: string) => string;

const realExec: Exec = (cmd, args, input) => {
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (SHADOWING_VARS.includes(name) || name.startsWith('COMPOSE_')) delete env[name];
  }
  return execFileSync(cmd, args, {
    encoding: 'utf8',
    env,
    input,
    stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
  });
};

export interface Paths {
  envFile: string;
  composeFile: string;
}

export function defaultPaths(home = os.homedir()): Paths {
  const dir = path.join(home, '.onecli');
  return { envFile: path.join(dir, '.env'), composeFile: path.join(dir, 'docker-compose.yml') };
}

export function envValue(content: string, name: string): string | undefined {
  const raw = [...content.matchAll(new RegExp(`^${name}=(.*)$`, 'gm'))].at(-1)?.[1]?.trim();
  return raw === undefined ? undefined : raw.replace(/^(['"])(.*)\1$/, '$2');
}

export function withEnvLine(content: string, name: string, value: string): string {
  const body = content
    .split('\n')
    .filter((line) => !line.startsWith(`${name}=`))
    .join('\n')
    .trimEnd();
  return `${body}${body ? '\n' : ''}${name}=${value}\n`;
}

function readEnv(file: string): string {
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

// Rename over the old file, so a crash never leaves a half-written .env.
function writeEnv(file: string, content: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// Hex: safe inside the DATABASE_URL the compose file builds from it.
export function newPassword(): string {
  return crypto.randomBytes(32).toString('hex');
}

// A saved value is kept only if compose passes it through unchanged and it fits in a URL.
function usable(value: string | undefined): value is string {
  return !!value && value !== COMPOSE_DEFAULT_PASSWORD && /^[A-Za-z0-9._~-]+$/.test(value);
}

/** What Postgres stores for a SCRAM-SHA-256 password; sending this keeps the plain text out of its logs. */
export function scramVerifier(password: string, salt = crypto.randomBytes(16), iterations = 4096): string {
  const salted = crypto.pbkdf2Sync(password, salt, iterations, 32, 'sha256');
  const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
  const storedKey = crypto.createHash('sha256').update(clientKey).digest('base64');
  const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$${iterations}:${salt.toString('base64')}$${storedKey}:${serverKey}`;
}

export function verifierMatches(verifier: string, password: string, role: string): boolean {
  const scram = /^SCRAM-SHA-256\$(\d+):([^$]+)\$[^:]+:.+$/.exec(verifier);
  if (scram) return scramVerifier(password, Buffer.from(scram[2], 'base64'), Number(scram[1])) === verifier;
  if (/^md5[0-9a-f]{32}$/.test(verifier)) {
    return (
      verifier ===
      `md5${crypto
        .createHash('md5')
        .update(password + role)
        .digest('hex')}`
    );
  }
  return false;
}

// Pin the project directory so compose reads ~/.onecli/.env, whatever the caller's cwd.
function compose(exec: Exec, paths: Paths, args: string[]): string {
  const dir = path.dirname(paths.composeFile);
  return exec('docker', ['compose', '-p', PROJECT, '--project-directory', dir, '-f', paths.composeFile, ...args]);
}

function postgresContainer(exec: Exec, all: boolean): string | null {
  try {
    const ids = exec('docker', [
      'ps',
      all ? '-aq' : '-q',
      '--filter',
      `label=com.docker.compose.project=${PROJECT}`,
      '--filter',
      'label=com.docker.compose.service=postgres',
    ]);
    return ids.split('\n').find(Boolean) ?? null;
  } catch {
    return null; // no Docker here: nothing local to fix
  }
}

// The image trusts its local socket; SQL goes on stdin, never into a command line.
function psql(exec: Exec, container: string, sql: string): string {
  return exec(
    'docker',
    [
      'exec',
      '-i',
      '-e',
      `PGPASSWORD=${COMPOSE_DEFAULT_PASSWORD}`,
      container,
      'sh',
      '-c',
      'exec psql -X -q -At -v ON_ERROR_STOP=1 -U "${POSTGRES_USER:-postgres}" -d postgres',
    ],
    sql,
  );
}

interface ComposeService {
  image?: string;
  pull_policy?: string;
  platform?: string;
  ports?: Array<{ host_ip?: string; published?: string | number; target: number }>;
  volumes?: Array<{ type: string; source?: string; target: string }>;
  environment?: Record<string, string | null>;
}
interface Container {
  Image: string;
  Config: { Image: string; Labels: Record<string, string>; Env?: string[] };
  HostConfig: { PortBindings?: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
  Mounts?: Array<{ Type: string; Name?: string; Source: string; Destination: string }>;
}

// The only settings a recreate is meant to change.
const PASSWORD_SETTINGS = [VAR, 'DATABASE_URL'];
// OneCLI's compose file uses these only for the image tag and the published ports.
const IMAGE_AND_PORT_SETTINGS = [
  'ONECLI_VERSION',
  'ONECLI_BIND_HOST',
  'ONECLI_APP_PORT',
  'ONECLI_GATEWAY_PORT',
  'POSTGRES_PORT',
];

// Pull policies under which `up` uses an image already on this machine.
const LOCAL_IMAGE_POLICIES = [undefined, 'missing', 'if_not_present', 'never'];

// os/arch/variant, normalized as compose's platform matcher does.
const DEFAULT_VARIANT: Record<string, string> = { arm64: 'v8', arm: 'v7' };
function platformKey(system: string, arch: string, variant = ''): string {
  const v = variant || DEFAULT_VARIANT[arch] || '';
  return [system, arch, arch === 'amd64' && v === 'v1' ? '' : v].filter(Boolean).join('/');
}

// The local image a tag names and its platform; null if it is not on this machine.
function localImage(exec: Exec, image: string | undefined): { id: string; platform: string } | null {
  if (!image) return null;
  try {
    const [img] = JSON.parse(exec('docker', ['image', 'inspect', image])) as Array<{
      Id: string;
      Os: string;
      Architecture: string;
      Variant?: string;
    }>;
    return { id: img.Id, platform: platformKey(img.Os, img.Architecture, img.Variant) };
  } catch {
    return null;
  }
}

function projectContainers(exec: Exec): Container[] {
  const ids = exec('docker', ['ps', '-aq', '--filter', `label=com.docker.compose.project=${PROJECT}`])
    .split('\n')
    .filter(Boolean);
  return ids.length ? (JSON.parse(exec('docker', ['inspect', ...ids])) as Container[]) : [];
}

/** Why recreating the stack from its files would change more than the password; null if it would not. */
export function recreateDrift(exec: Exec, paths: Paths, containers: Container[]): string | null {
  if (!fs.existsSync(paths.composeFile)) return `no ${paths.composeFile}`;
  const config = JSON.parse(compose(exec, paths, ['config', '--format', 'json'])) as {
    services: Record<string, ComposeService>;
    volumes?: Record<string, { name?: string }>;
  };
  const show = (list: string[]) => list.join(' ') || 'none';
  // Compose creates a service without its own platform for this one (the shell's is dropped). Read as
  // loosely as compose does; an odd value then fails the platform check instead of slipping past it.
  const defaultPlatform = [
    ...readEnv(paths.envFile).matchAll(/^\s*(?:export\s+)?DOCKER_DEFAULT_PLATFORM\s*[=:]\s*(.*)$/gm),
  ]
    .at(-1)?.[1]
    .replace(/\s+#.*$/, '')
    .trim()
    .replace(/^(['"])(.*)\1$/, '$2');
  const seen = new Set<string>();
  const imageEnv = new Map<string, string[]>();
  for (const c of containers) {
    if (c.Config.Labels['com.docker.compose.oneoff'] === 'True') continue; // a `compose run` leftover
    const name = c.Config.Labels['com.docker.compose.service'];
    const svc = config.services[name];
    // Left running, it would keep the old password; compose would not replace it.
    if (!svc) return `${name} is not in ${paths.composeFile}`;
    seen.add(name);
    // Compose would need a missing image, or one for another platform, after the password changed.
    // Another tag of the same image is no change, e.g. `latest` from before setup pinned ONECLI_VERSION;
    // the same tag is what any `up` runs.
    if (!LOCAL_IMAGE_POLICIES.includes(svc.pull_policy)) {
      return `${name} has pull_policy ${svc.pull_policy}, so a restart could change its image`;
    }
    const image = localImage(exec, svc.image);
    const platform = svc.platform || defaultPlatform;
    // A platform not written as lowercase os/arch[/variant] never matches, so it refuses.
    const parts = platform?.split('/') ?? [];
    const wanted =
      parts.length >= 2 && parts.length <= 3 && parts.every((part) => /^[a-z0-9_.-]+$/.test(part))
        ? platformKey(parts[0], parts[1], parts[2])
        : null;
    if (!image || (platform && wanted !== image.platform)) {
      return `${name} would need ${svc.image}${platform ? ` for ${platform}` : ''}, which is not on this machine`;
    }
    if (svc.image !== c.Config.Image && image.id !== c.Image) {
      return `${name} would switch from ${c.Config.Image} to ${svc.image}`;
    }
    const want = (svc.ports ?? []).map((p) => `${p.host_ip ?? ''}:${p.published}->${p.target}`).sort();
    const have = Object.entries(c.HostConfig.PortBindings ?? {})
      .flatMap(([port, binds]) => (binds ?? []).map((b) => `${b.HostIp}:${b.HostPort}->${parseInt(port, 10)}`))
      .sort();
    if (want.join() !== have.join()) return `${name} would move from ${show(have)} to ${show(want)}`;
    // Named volumes and binds hold the data; anonymous volumes are carried over by compose.
    const wantMounts = (svc.volumes ?? [])
      .filter((v) => v.source && (v.type === 'volume' || v.type === 'bind'))
      .map((v) =>
        v.type === 'volume'
          ? `${config.volumes?.[v.source!]?.name ?? `${PROJECT}_${v.source}`}:${v.target}`
          : `${v.source}:${v.target}`,
      )
      .sort();
    const haveMounts = (c.Mounts ?? [])
      .filter((m) => m.Type === 'bind' || (m.Type === 'volume' && !/^[0-9a-f]{64}$/.test(m.Name ?? '')))
      .map((m) => `${m.Type === 'volume' ? m.Name : m.Source}:${m.Destination}`)
      .sort();
    if (wantMounts.join() !== haveMounts.join()) {
      return `${name} would mount ${show(wantMounts)} instead of ${show(haveMounts)}`;
    }
    // A changed setting such as PGDATA can point the same volume at other data, and so can a new one,
    // unless it only picks the image tag and ports checked above: setup saves ONECLI_VERSION and
    // ONECLI_BIND_HOST to .env after macOS starts OneCLI, and compose hands .env to the app too.
    const env = new Map((c.Config.Env ?? []).map((e) => [e.slice(0, e.indexOf('=')), e.slice(e.indexOf('=') + 1)]));
    const changed = Object.entries(svc.environment ?? {}).find(
      ([key, value]) =>
        value !== null &&
        !PASSWORD_SETTINGS.includes(key) &&
        (env.has(key) ? env.get(key) !== value : !IMAGE_AND_PORT_SETTINGS.includes(key)),
    );
    if (changed) return `${name} would ${env.has(changed[0]) ? 'change' : 'add'} ${changed[0]}`;
    // So can dropping one, unless the image sets the same value.
    if (!imageEnv.has(c.Image)) {
      const [image] = JSON.parse(exec('docker', ['image', 'inspect', c.Image])) as Array<{
        Config: { Env?: string[] };
      }>;
      imageEnv.set(c.Image, image.Config.Env ?? []);
    }
    const dropped = (c.Config.Env ?? []).find(
      (e) => !imageEnv.get(c.Image)!.includes(e) && !(e.slice(0, e.indexOf('=')) in (svc.environment ?? {})),
    );
    if (dropped) return `${name} would drop ${dropped.slice(0, dropped.indexOf('='))}`;
  }
  const added = Object.keys(config.services).find((name) => !seen.has(name));
  return added ? `${added} would be created` : null;
}

/** Why compose would not hand `password` to every database setting; null if it would. */
function passwordGap(exec: Exec, paths: Paths, password: string): string | null {
  const { services } = JSON.parse(compose(exec, paths, ['config', '--format', 'json'])) as {
    services: Record<string, ComposeService>;
  };
  for (const [name, svc] of Object.entries(services)) {
    const env = svc.environment ?? {};
    if (VAR in env && env[VAR] !== password) return `${name} sets ${VAR} itself`;
    const url = env.DATABASE_URL;
    if (url != null && !url.includes(`:${password}@`)) return `${name} sets its DATABASE_URL password itself`;
  }
  return null;
}

// A container created before the role's password changed still connects with the default.
function carriesDefault(containers: Container[]): boolean {
  const old = new RegExp(
    `^(${VAR}=${COMPOSE_DEFAULT_PASSWORD}|DATABASE_URL=postgres(ql)?://[^:/@]*:${COMPOSE_DEFAULT_PASSWORD}@.*)$`,
  );
  return containers.some((c) => (c.Config.Env ?? []).some((e) => old.test(e)));
}

/**
 * Before OneCLI's first start. The installer keeps an existing .env line, so a
 * new database starts with this password. An existing database volume already
 * has its password, so it is left to rotateDefaultPassword.
 */
export function seedPassword(paths = defaultPaths(), exec: Exec = realExec): boolean {
  const content = readEnv(paths.envFile);
  const current = envValue(content, VAR);
  if (current && current !== COMPOSE_DEFAULT_PASSWORD) return false;
  let volumes = '';
  try {
    volumes = exec('docker', ['volume', 'ls', '-q', '--filter', `label=com.docker.compose.project=${PROJECT}`]);
  } catch {
    // no Docker yet: the installer stops on that itself
  }
  if (volumes.split('\n').some((name) => name.endsWith('pgdata'))) return false;
  writeEnv(paths.envFile, withEnvLine(content, VAR, newPassword()));
  return true;
}

export type RotateResult =
  { status: 'rotated' | 'own-password' | 'no-database' | 'stopped' } | { status: 'refused'; detail: string };

function readRole(exec: Exec, container: string): { role: string; verifier: string } {
  const sql = "SELECT rolname, coalesce(rolpassword, '') FROM pg_authid WHERE rolname = current_user;\n";
  const [role = '', verifier = ''] = psql(exec, container, sql).trim().split('|');
  return { role, verifier };
}

// Runs after .env holds the password, so it is never only in the database.
function setRolePassword(exec: Exec, container: string, role: string, password: string, paths: Paths, before: string) {
  try {
    psql(exec, container, `ALTER ROLE CURRENT_USER PASSWORD '${scramVerifier(password)}';\n`);
    return;
  } catch (err) {
    // The ALTER may have committed before the error came back: undo .env only if the role still has the default.
    let now = '';
    try {
      now = readRole(exec, container).verifier;
    } catch {
      // unknown: keep .env, the next run finishes either way
    }
    if (verifierMatches(now, password, role)) return;
    if (verifierMatches(now, COMPOSE_DEFAULT_PASSWORD, role)) {
      writeEnv(paths.envFile, before);
      throw new Error('Could not set the OneCLI database password; nothing changed', { cause: err });
    }
    throw new Error(
      'Could not confirm the OneCLI database password change. The new password is saved in ~/.onecli/.env; run this again to finish.',
      { cause: err },
    );
  }
}

/**
 * Moves a running local database off the compose default: the new password
 * goes into .env, then onto the role, then the stack is recreated so every
 * DATABASE_URL carries it. Data stays in the volume. A run cut off before the
 * recreate is finished by the next one.
 */
export function rotateDefaultPassword(paths = defaultPaths(), exec: Exec = realExec): RotateResult {
  const container = postgresContainer(exec, false);
  if (!container) return { status: postgresContainer(exec, true) ? 'stopped' : 'no-database' };
  const before = readEnv(paths.envFile);
  const saved = envValue(before, VAR);
  let role: string;
  let onDefault: boolean;
  let drift: string | null;
  try {
    let verifier: string;
    ({ role, verifier } = readRole(exec, container));
    onDefault = verifierMatches(verifier, COMPOSE_DEFAULT_PASSWORD, role);
    const unfinished = !onDefault && usable(saved) && verifierMatches(verifier, saved, role);
    if (!onDefault && !unfinished) return { status: 'own-password' };
    const containers = projectContainers(exec);
    if (unfinished && !carriesDefault(containers)) return { status: 'own-password' };
    drift = recreateDrift(exec, paths, containers);
  } catch (err) {
    return { status: 'refused', detail: `could not inspect OneCLI: ${(err as Error).message.split('\n')[0]}` };
  }
  if (drift) return { status: 'refused', detail: drift };

  const password = usable(saved) ? saved : newPassword();
  writeEnv(paths.envFile, withEnvLine(before, VAR, password));
  let gap: string | null;
  try {
    gap = passwordGap(exec, paths, password);
  } catch (err) {
    gap = `could not inspect OneCLI: ${(err as Error).message.split('\n')[0]}`;
  }
  if (gap) {
    writeEnv(paths.envFile, before);
    return { status: 'refused', detail: gap };
  }
  if (onDefault) setRolePassword(exec, container, role, password, paths, before);
  try {
    compose(exec, paths, ['up', '-d', '--wait']);
  } catch (err) {
    throw new Error(
      'The OneCLI database password changed and is saved in ~/.onecli/.env, but OneCLI did not restart cleanly. ' +
        'Run `cd ~/.onecli && docker compose up -d`.',
      { cause: err },
    );
  }
  return { status: 'rotated' };
}

export const REFUSED_HINT =
  'Save the settings OneCLI runs with in ~/.onecli/.env (for example ONECLI_VERSION; see docs/onecli-upgrades.md), ' +
  'then run: pnpm exec tsx .claude/skills/add-onecli/scripts/postgres-password.ts';

export const DEFAULT_PASSWORD_HINT =
  "OneCLI's database still accepts the default password, so any agent container can log in to it. " + REFUSED_HINT;

/**
 * Reads, and changes nothing: does a running local database still accept the
 * compose default? Setup's own rotation can refuse and still succeed, so the
 * skill asks this afterwards and tells the operator. Never throws.
 */
export function passwordCheck(exec: Exec = realExec): { warn: 'yes' | 'no'; hint: string } {
  const container = postgresContainer(exec, false);
  if (!container) return { warn: 'no', hint: 'none' };
  try {
    const { role, verifier } = readRole(exec, container);
    return verifierMatches(verifier, COMPOSE_DEFAULT_PASSWORD, role)
      ? { warn: 'yes', hint: DEFAULT_PASSWORD_HINT }
      : { warn: 'no', hint: 'none' };
  } catch {
    return {
      warn: 'yes',
      hint:
        "Could not check whether OneCLI's database still accepts the default password. " +
        'Run: pnpm exec tsx .claude/skills/add-onecli/scripts/postgres-password.ts',
    };
  }
}

// Compare real file URLs, so a checkout path with a space or a symlink still runs.
function runDirectly(): boolean {
  try {
    return !!process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
  } catch {
    return false; // argv[1] is not a file, as under `node -e`
  }
}

if (runDirectly()) {
  const result = rotateDefaultPassword();
  if (result.status === 'refused') {
    console.error(`Not changed: ${result.detail}. ${REFUSED_HINT}`);
    process.exit(1);
  }
  console.log(
    {
      rotated: "OneCLI's database now has its own password, saved in ~/.onecli/.env. OneCLI restarted.",
      'own-password': "OneCLI's database already has its own password. Nothing changed.",
      'no-database': 'No OneCLI database on this machine. Nothing changed.',
      stopped:
        "OneCLI's database is stopped. Start OneCLI (`cd ~/.onecli && docker compose up -d`), then run this again.",
    }[result.status],
  );
}
