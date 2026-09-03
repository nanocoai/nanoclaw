/**
 * Installs `docker-credential-nanoclaw` and points docker at it for exactly one
 * registry.
 *
 * The helper is a standalone script, not a repo module: docker execs it from an
 * arbitrary cwd, and uninstalling NanoClaw deletes this checkout while the
 * helper stays on PATH. So installing means copying the source out of the tree
 * and stamping an absolute shebang onto the copy — `#!/usr/bin/env node` would
 * resolve through whatever nvm/asdf shim happens to be in the spawning
 * process's PATH, which is not reliably anything when the spawner is docker.
 *
 * Wiring is one `credHelpers` key in `~/.docker/config.json`, read-modify-write
 * around every other key. That key is a pointer — no secret is written there,
 * which is also why uninstall must never run `docker logout`: logout would
 * revoke the credential of any other install sharing this machine.
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { log } from '../src/log.js';
import { readAgentImagePin, registryAuthPath } from './lib/registry-state.js';
import { emitStatus } from './status.js';

/** Docker resolves `credHelpers[host] = "<name>"` to `docker-credential-<name>` on PATH. */
export const CRED_HELPER_NAME = 'nanoclaw';
export const HELPER_BINARY_NAME = `docker-credential-${CRED_HELPER_NAME}`;

/**
 * Must match `HELPER_ID` in `setup/registry/credential-helper.mjs`. Install
 * verifies the installed binary prints it, so drift fails at install time
 * rather than silently making uninstall refuse to clean up.
 */
const HELPER_MARKER = 'nanoclaw-docker-credential-helper';

/** Preferred first; `~/.local/bin` is the unprivileged fallback, as in setup/onecli.ts. */
const BIN_DIRS = ['/usr/local/bin', path.join(os.homedir(), '.local', 'bin')];

/**
 * A registry hostname, optionally with a port — never a URL. Docker Hub is
 * keyed as `https://index.docker.io/v1/`, so a scheme here is a sign someone
 * generalized from the wrong example; ECR wants the plain host.
 */
const HOSTNAME_RE = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*(:\d{1,5})?$/;

export interface CredHelperOptions {
  /** The registry to wire. Defaults to the one recorded by login. */
  registryHost?: string;
  /** Override the install directory. Defaults to the first writable of BIN_DIRS. */
  binDir?: string;
  /** Override `~/.docker/config.json`. Honors `DOCKER_CONFIG` by default. */
  dockerConfigPath?: string;
}

export interface CredHelperInstallResult {
  helperPath: string;
  registryHost: string;
  dockerConfigPath: string;
  dockerConfigChanged: boolean;
  /** False means docker will not find the helper — the caller should say so. */
  onPath: boolean;
}

export interface CredHelperRemovalResult {
  removedBinaries: string[];
  /** Binaries left alone because they are not ours. */
  keptBinaries: string[];
  removedHosts: string[];
  dockerConfigPath: string;
  dockerConfigChanged: boolean;
}

export interface CredHelperStatus {
  installed: boolean;
  helperPath?: string;
  wiredHosts: string[];
  dockerConfigPath: string;
}

function helperSourcePath(): string {
  return fileURLToPath(new URL('registry/credential-helper.mjs', import.meta.url));
}

export function dockerConfigPath(override?: string): string {
  if (override) return override;
  const base = process.env.DOCKER_CONFIG?.trim() || path.join(os.homedir(), '.docker');
  return path.join(base, 'config.json');
}

/**
 * Which registry to wire. The image pin is the authoritative answer — it is the
 * reference `container/pull.sh` will hand docker, and wiring any other host
 * would route the pull past this helper. Sign-in may also record a `registry`,
 * which wins because it reflects the entitlement the token was issued against.
 */
export function resolveRegistryHost(explicit?: string): string {
  const candidates = [
    explicit,
    readRecordedRegistry(),
    registryFromRef(readAgentImagePin()),
    process.env.NANOCLAW_REGISTRY_HOST,
  ];
  const host = candidates.find((c) => c && c.trim())?.trim();
  if (!host) {
    throw new Error(
      'No registry host to wire. Pass one, pin the agent image in versions.json, or sign in first so ' +
        `${registryAuthPath()} records which registry this install pulls from.`,
    );
  }
  if (!HOSTNAME_RE.test(host)) {
    throw new Error(`Not a registry hostname: ${host} (expected e.g. 1234.dkr.ecr.us-east-1.amazonaws.com, no scheme)`);
  }
  return host.toLowerCase();
}

function readRecordedRegistry(): string | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(registryAuthPath(), 'utf-8'));
    const registry = (parsed as { registry?: unknown } | null)?.registry;
    return typeof registry === 'string' ? registry : undefined;
  } catch (_err) {
    // Absent before sign-in, and unreadable is the same answer: we don't know.
    return undefined;
  }
}

/**
 * The registry a pullable reference names, by docker's own rule: the first path
 * component is a hostname only when it carries a dot or a port, or is
 * `localhost`. Anything else is a Docker Hub short name with no registry in it.
 */
function registryFromRef(ref: string | undefined): string | undefined {
  const slash = ref?.indexOf('/') ?? -1;
  if (!ref || slash === -1) return undefined;
  const first = ref.slice(0, slash);
  return first === 'localhost' || first.includes('.') || first.includes(':') ? first : undefined;
}

function chooseBinDir(override?: string): string {
  const dirs = override ? [override] : BIN_DIRS;
  for (const dir of dirs) {
    try {
      fs.accessSync(dir, fs.constants.W_OK);
      return dir;
    } catch (_err) {
      // Not writable, or absent — /usr/local/bin does not exist on a fresh
      // Apple Silicon machine. Fall through to the next candidate.
    }
  }
  const fallback = dirs[dirs.length - 1];
  fs.mkdirSync(fallback, { recursive: true });
  return fallback;
}

/** Swap the source's shebang for one naming this exact node binary. */
export function renderHelper(source: string, nodePath: string): string {
  const body = source.startsWith('#!') ? source.slice(source.indexOf('\n') + 1) : source;
  return `#!${nodePath}\n${body}`;
}

/**
 * Write through a temp file in the same directory. Replacing a running
 * executable in place is `ETXTBSY` on Linux and a torn read for a pull already
 * in flight; a rename is atomic and gives the old inode to whoever holds it.
 */
function writeExecutable(dest: string, contents: string): void {
  const tmp = `${dest}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmp, contents, { mode: 0o755 });
    fs.chmodSync(tmp, 0o755);
    fs.renameSync(tmp, dest);
  } catch (err) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch (_cleanupErr) {
      // Nothing more to do; the original error is the one that matters.
    }
    throw err;
  }
}

function isOurBinary(file: string): boolean {
  try {
    return fs.readFileSync(file, 'utf-8').includes(HELPER_MARKER);
  } catch (_err) {
    return false;
  }
}

function onPath(dir: string): boolean {
  const entries = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  return entries.some((entry) => path.resolve(entry) === path.resolve(dir));
}

interface DockerConfig {
  credHelpers?: Record<string, string>;
  [key: string]: unknown;
}

/**
 * Refuses to guess at a config it cannot parse. This file can hold every
 * registry credential on the machine, so "rewrite it from scratch" is not an
 * acceptable recovery.
 */
function readDockerConfig(file: string): DockerConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
    throw err;
  }
  if (!raw.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${file} is not valid JSON, so it cannot be edited safely: ${(err as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${file} is not a JSON object, so it cannot be edited safely`);
  }
  const config = parsed as DockerConfig;
  const helpers = config.credHelpers;
  if (helpers !== undefined && (typeof helpers !== 'object' || Array.isArray(helpers))) {
    throw new Error(`${file} has a credHelpers value that is not an object — fix it by hand`);
  }
  return config;
}

/** Tab-indented to match what the docker CLI itself writes, keeping diffs quiet. */
function writeDockerConfig(file: string, config: DockerConfig): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch (_err) {
    // New file: 0600, matching what docker creates.
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, `${JSON.stringify(config, null, '\t')}\n`, { mode });
  fs.renameSync(tmp, file);
}

export function installCredentialHelper(options: CredHelperOptions = {}): CredHelperInstallResult {
  const registryHost = resolveRegistryHost(options.registryHost);

  // Read the docker config before writing anything: an unparsable one aborts
  // the install, and it should abort it before a binary lands on PATH.
  const configFile = dockerConfigPath(options.dockerConfigPath);
  const config = readDockerConfig(configFile);

  const binDir = chooseBinDir(options.binDir);
  const helperPath = path.join(binDir, HELPER_BINARY_NAME);
  writeExecutable(helperPath, renderHelper(fs.readFileSync(helperSourcePath(), 'utf-8'), process.execPath));

  // Proves the shebang resolves and that this binary is the one uninstall will
  // recognize — both silent failures otherwise, discovered mid-pull.
  const check = spawnSync(helperPath, ['version'], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (check.status !== 0 || !(check.stdout ?? '').includes(HELPER_MARKER)) {
    throw new Error(
      `${helperPath} did not run after install (exit ${check.status}): ${(check.stderr ?? check.error?.message ?? '').trim()}`,
    );
  }

  const credHelpers = config.credHelpers ?? {};
  const dockerConfigChanged = credHelpers[registryHost] !== CRED_HELPER_NAME;
  if (dockerConfigChanged) {
    credHelpers[registryHost] = CRED_HELPER_NAME;
    config.credHelpers = credHelpers;
    writeDockerConfig(configFile, config);
  }

  const reachable = onPath(binDir);
  // Debug, not info: `log.info` writes to stdout, and the only success-path
  // caller is the interactive sign-in, where this lands as a timestamped
  // diagnostic mid-conversation. The cases needing attention are `log.warn`
  // below, which goes to stderr.
  log.debug('Installed the docker credential helper', {
    helperPath,
    registryHost,
    dockerConfigChanged,
    onPath: reachable,
  });
  if (!reachable) {
    log.warn('Helper directory is not on PATH — docker will not find it', { binDir });
  }

  return { helperPath, registryHost, dockerConfigPath: configFile, dockerConfigChanged, onPath: reachable };
}

/**
 * Removes our key and our binary, nothing else.
 *
 * Every `credHelpers` entry pointing at us goes, not just the currently
 * configured host, so a registry change earlier in this install's life cannot
 * strand a key that routes pulls to a helper that no longer exists.
 */
export function uninstallCredentialHelper(options: CredHelperOptions = {}): CredHelperRemovalResult {
  const removedBinaries: string[] = [];
  const keptBinaries: string[] = [];
  const dirs = options.binDir ? [options.binDir] : BIN_DIRS;
  for (const dir of dirs) {
    const file = path.join(dir, HELPER_BINARY_NAME);
    if (!fs.existsSync(file)) continue;
    if (!isOurBinary(file)) {
      keptBinaries.push(file);
      continue;
    }
    try {
      fs.rmSync(file);
      removedBinaries.push(file);
    } catch (err) {
      log.warn('Could not remove the credential helper', { file, err });
      keptBinaries.push(file);
    }
  }

  const configFile = dockerConfigPath(options.dockerConfigPath);
  const removedHosts: string[] = [];
  let dockerConfigChanged = false;
  try {
    const config = readDockerConfig(configFile);
    const credHelpers = config.credHelpers ?? {};
    for (const [host, helper] of Object.entries(credHelpers)) {
      if (helper === CRED_HELPER_NAME) {
        delete credHelpers[host];
        removedHosts.push(host);
      }
    }
    if (removedHosts.length > 0) {
      if (Object.keys(credHelpers).length === 0) delete config.credHelpers;
      else config.credHelpers = credHelpers;
      writeDockerConfig(configFile, config);
      dockerConfigChanged = true;
    }
  } catch (err) {
    // An unparsable docker config is the user's to fix; the binary is already
    // gone, so a stale pointer fails loudly rather than silently minting.
    log.warn('Left the docker config alone', { configFile, err });
  }

  log.info('Removed the docker credential helper', { removedBinaries, removedHosts });
  return { removedBinaries, keptBinaries, removedHosts, dockerConfigPath: configFile, dockerConfigChanged };
}

export function credentialHelperStatus(options: CredHelperOptions = {}): CredHelperStatus {
  const dirs = options.binDir ? [options.binDir] : BIN_DIRS;
  const helperPath = dirs.map((dir) => path.join(dir, HELPER_BINARY_NAME)).find((file) => isOurBinary(file));

  const configFile = dockerConfigPath(options.dockerConfigPath);
  let wiredHosts: string[] = [];
  try {
    const config = readDockerConfig(configFile);
    wiredHosts = Object.entries(config.credHelpers ?? {})
      .filter(([, helper]) => helper === CRED_HELPER_NAME)
      .map(([host]) => host);
  } catch (err) {
    log.warn('Could not read the docker config', { configFile, err });
  }

  return { installed: helperPath !== undefined, helperPath, wiredHosts, dockerConfigPath: configFile };
}

function parseArgs(args: string[]): { mode: 'install' | 'uninstall' | 'status'; options: CredHelperOptions } {
  const options: CredHelperOptions = {};
  let mode: 'install' | 'uninstall' | 'status' = 'install';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--uninstall') mode = 'uninstall';
    else if (args[i] === '--status') mode = 'status';
    else if (args[i] === '--registry-host' && args[i + 1]) options.registryHost = args[++i];
    else if (args[i] === '--bin-dir' && args[i + 1]) options.binDir = args[++i];
    else if (args[i] === '--docker-config' && args[i + 1]) options.dockerConfigPath = args[++i];
  }
  return { mode, options };
}

/** Never prompts — reachable from setup's step runner, which discards stdin. */
export async function run(args: string[]): Promise<void> {
  const { mode, options } = parseArgs(args);

  if (mode === 'status') {
    const status = credentialHelperStatus(options);
    emitStatus('CRED_HELPER', {
      INSTALLED: status.installed,
      ...(status.helperPath ? { HELPER: status.helperPath } : {}),
      HOSTS: status.wiredHosts.join(',') || '(none)',
      DOCKER_CONFIG: status.dockerConfigPath,
      STATUS: 'success',
    });
    return;
  }

  if (mode === 'uninstall') {
    const removal = uninstallCredentialHelper(options);
    emitStatus('CRED_HELPER', {
      REMOVED: removal.removedBinaries.join(',') || '(none)',
      ...(removal.keptBinaries.length ? { KEPT: removal.keptBinaries.join(',') } : {}),
      HOSTS: removal.removedHosts.join(',') || '(none)',
      DOCKER_CONFIG: removal.dockerConfigPath,
      CONFIG_EDITED: removal.dockerConfigChanged,
      STATUS: 'success',
    });
    return;
  }

  const result = installCredentialHelper(options);
  const pathHint = `Add ${path.dirname(result.helperPath)} to PATH or docker cannot find the helper`;
  emitStatus('CRED_HELPER', {
    HELPER: result.helperPath,
    HOST: result.registryHost,
    DOCKER_CONFIG: result.dockerConfigPath,
    ON_PATH: result.onPath,
    STATUS: 'success',
    ...(result.onPath ? {} : { HINT: pathHint }),
  });
}

/** True when this file is the entry point rather than an import. */
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  // realpath because node resolves a module's own URL through symlinks while
  // argv[1] keeps whatever the caller typed — on macOS /tmp and /var alone are
  // enough to make the naive comparison fail.
  const resolved = fs.existsSync(entry) ? fs.realpathSync(entry) : entry;
  return import.meta.url === pathToFileURL(resolved).href;
}

if (invokedDirectly()) {
  run(process.argv.slice(2)).catch((err: unknown) => {
    log.error('Credential helper install failed', { err });
    process.exit(1);
  });
}
