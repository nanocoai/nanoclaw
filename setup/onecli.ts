/**
 * Step: onecli — Install + configure the OneCLI gateway and CLI.
 *
 * Two modes:
 *   (default) run the OneCLI installer, configure api-host, write .env.
 *   --reuse   skip the installer; reuse the onecli instance already running
 *             on the host. Required for users who have other apps bound to
 *             an existing gateway, since re-running the installer rebinds
 *             the listener and breaks those consumers.
 *
 * Emits ONECLI_URL and polls /health so downstream steps (auth, service)
 * get a ready gateway.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

// The OneCLI installer writes everything under ~/.onecli/. We touch three
// files: the compose file (rewrite ports), config.json (admin URL the CLI
// uses), and optionally .env (admin URL the runtime SDK reads — may not
// exist on every install shape, so all writes to it are best-effort).
const ONECLI_DIR = path.join(os.homedir(), '.onecli');
const ONECLI_COMPOSE_PATH = path.join(ONECLI_DIR, 'docker-compose.yml');
const ONECLI_ENV_PATH = path.join(ONECLI_DIR, '.env');
const ONECLI_CONFIG_PATH = path.join(ONECLI_DIR, 'config.json');

// The compose file sets `container_name: onecli` on the gateway service,
// so this name is stable across compose recreations and version bumps.
const ONECLI_CONTAINER = 'onecli';

// Marker comment we write into the compose file so re-running setup detects
// our prior rewrite and no-ops instead of re-patching (or worse, double-patching).
// References the upstream issue so anyone reading the file can find context.
const NANOCLAW_HARDEN_MARKER = '# nanoclaw: admin+postgres pinned to loopback (onecli/onecli#268)';

function childEnv(): NodeJS.ProcessEnv {
  const parts = [LOCAL_BIN];
  if (process.env.PATH) parts.push(process.env.PATH);
  return { ...process.env, PATH: parts.join(path.delimiter) };
}

function onecliVersion(): string | null {
  try {
    return execFileSync('onecli', ['version'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Ask the installed onecli CLI for its configured api-host. Returns null if
 * onecli isn't on PATH, errors, or has no api-host configured.
 *
 * Tolerates both JSON output (onecli 1.3+) and older raw-text output.
 */
export function getOnecliApiHost(): string | null {
  try {
    const out = execFileSync('onecli', ['config', 'get', 'api-host'], {
      encoding: 'utf-8',
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    try {
      const parsed = JSON.parse(out) as { data?: unknown; value?: unknown };
      const val = parsed.data ?? parsed.value;
      if (typeof val === 'string' && val.trim()) return val.trim();
    } catch {
      // not JSON — fall through to URL extraction
    }
    return extractUrlFromOutput(out);
  } catch {
    return null;
  }
}

function extractUrlFromOutput(output: string): string | null {
  const match = output.match(/https?:\/\/[\w.\-]+(?::\d+)?/);
  return match ? match[0] : null;
}

function ensureShellProfilePath(): void {
  const home = os.homedir();
  const line = 'export PATH="$HOME/.local/bin:$PATH"';
  for (const profile of [path.join(home, '.bashrc'), path.join(home, '.zshrc')]) {
    try {
      const content = fs.existsSync(profile) ? fs.readFileSync(profile, 'utf-8') : '';
      if (!content.includes('.local/bin')) {
        fs.appendFileSync(profile, `\n${line}\n`);
        log.info('Added ~/.local/bin to PATH in shell profile', { profile });
      }
    } catch (err) {
      log.warn('Could not update shell profile', { profile, err });
    }
  }
}

function writeEnvVar(name: string, value: string): void {
  const envFile = path.join(process.cwd(), '.env');
  let content = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf-8') : '';
  const re = new RegExp(`^${name}=.*$`, 'm');
  if (re.test(content)) {
    content = content.replace(re, `${name}=${value}`);
  } else {
    content = content.trimEnd() + (content ? '\n' : '') + `${name}=${value}\n`;
  }
  fs.writeFileSync(envFile, content);
}

function writeEnvOnecliUrl(url: string): void {
  writeEnvVar('ONECLI_URL', url);
}

// Last-known-good CLI release. Used only if BOTH the upstream installer
// and the redirect-based version probe fail. Bump deliberately when a
// new CLI release ships.
const ONECLI_GATEWAY_VERSION = '1.23.0';
const ONECLI_CLI_FALLBACK_VERSION = '1.3.0';
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

function installOnecliCliOnly(): { stdout: string; ok: boolean } {
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  if (upstream.ok) return { stdout: upstream.stdout, ok: true };
  const fallback = installOnecliCliDirect();
  return { stdout: upstream.stdout + (upstream.stderr ?? '') + '\n' + fallback.stdout, ok: fallback.ok };
}

// Remove containers in the "onecli" compose project whose service name isn't
// in the v2 set. Pre-v2 OneCLI used service "app" (container onecli-app-1);
// v2 uses "onecli". Compose flags the old container as an orphan but won't
// stop it without --remove-orphans, leaving port 10254 bound and crashing
// the new bring-up. Filed upstream; this is the downstream workaround.
function removeLegacyOnecliContainers(): string {
  const out: string[] = [];
  let list = '';
  try {
    list = execSync(
      `docker ps -a --filter "label=com.docker.compose.project=onecli" --format '{{.Names}}|{{.Label "com.docker.compose.service"}}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
  } catch {
    return '';
  }
  if (!list) return '';
  const v2Services = new Set(['onecli', 'postgres']);
  for (const line of list.split('\n')) {
    const [name, service] = line.split('|');
    if (!name || !service || v2Services.has(service)) continue;
    out.push(`Removing legacy OneCLI container: ${name} (service=${service})`);
    try {
      execSync(`docker rm -f ${JSON.stringify(name)}`, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      out.push(`  rm failed (continuing): ${(err as Error).message}`);
    }
  }
  return out.join('\n');
}

type HardenPaths = {
  composePath?: string;
  envPath?: string;
  configPath?: string;
};

type HardenResult = {
  changed: boolean;
  reason?: string;
  // When hardening succeeds we may have rewritten the admin URL in the
  // installer's config.json. Callers use this to keep NanoClaw's own ONECLI_URL
  // in sync (the URL extracted from install stdout still has the old bind).
  adminUrlRewritten?: boolean;
};

/**
 * Rewrite the OneCLI-generated docker-compose so the admin API (:10254) and
 * Postgres (:5432) bind to 127.0.0.1, while the proxy gateway (:10255) keeps
 * whatever the installer chose. On bare-metal Linux the installer auto-picks
 * the docker0 bridge IP, which makes the admin API and Postgres reachable
 * from every container on the host's default bridge — see onecli/onecli#268.
 *
 * After the compose rewrite, also fix up:
 *   - ~/.onecli/config.json:  api-host (the CLI's pointer to the admin API)
 *   - ~/.onecli/.env:         ONECLI_URL (read by the runtime SDK)
 * so the host can still reach the admin API at its new loopback bind. Both
 * are best-effort — the security fix is the compose rewrite. `.env` may not
 * exist depending on installer version, and that's fine.
 *
 * The rewrite is a targeted regex on lines we recognize, with a marker comment
 * for idempotency. If the upstream compose shape changes in a way we don't
 * recognize, we warn and no-op rather than corrupt the file.
 *
 * `paths` is an optional override for tests; production code uses the
 * module-level constants.
 */
export function hardenOneCliBinds(paths: HardenPaths = {}): HardenResult {
  const composePath = paths.composePath ?? ONECLI_COMPOSE_PATH;
  const envPath = paths.envPath ?? ONECLI_ENV_PATH;
  const configPath = paths.configPath ?? ONECLI_CONFIG_PATH;

  if (!fs.existsSync(composePath)) {
    log.warn('OneCLI compose file not found — skipping bind hardening', { composePath });
    return { changed: false, reason: 'compose_missing' };
  }

  const original = fs.readFileSync(composePath, 'utf-8');
  if (original.includes(NANOCLAW_HARDEN_MARKER)) {
    return { changed: false, reason: 'already_patched' };
  }

  // Match the three port lines we expect from upstream's compose. The bind
  // host is captured in group 1 so we can decide what to swap. We only rewrite
  // admin (:10254) and postgres (:5432); the gateway (:10255) is left alone
  // because the bridge IP is the *correct* bind there.
  const adminRe = /^(\s*-\s*)"\$\{ONECLI_BIND_HOST:-127\.0\.0\.1\}:\$\{ONECLI_APP_PORT:-10254\}:10254"\s*$/m;
  const pgRe = /^(\s*-\s*)"\$\{ONECLI_BIND_HOST:-127\.0\.0\.1\}:\$\{POSTGRES_PORT:-5432\}:5432"\s*$/m;

  if (!adminRe.test(original) || !pgRe.test(original)) {
    log.warn('OneCLI compose layout not recognized — leaving file untouched', { composePath });
    return { changed: false, reason: 'layout_unrecognized' };
  }

  let patched = original.replace(
    adminRe,
    `$1"127.0.0.1:\${ONECLI_APP_PORT:-10254}:10254"`,
  );
  patched = patched.replace(
    pgRe,
    `$1"127.0.0.1:\${POSTGRES_PORT:-5432}:5432"`,
  );

  // Prepend the marker so a re-run is a no-op. Keep it as the very first line
  // so `head -1` / quick visual inspection finds it.
  patched = `${NANOCLAW_HARDEN_MARKER}\n${patched}`;
  fs.writeFileSync(composePath, patched);
  log.info('Pinned OneCLI admin API and Postgres to 127.0.0.1', { composePath });

  const configChanged = patchOnecliConfigJson(configPath);
  const envChanged = patchOnecliEnvAdminUrl(envPath);

  return { changed: true, adminUrlRewritten: configChanged || envChanged };
}

/**
 * Swap the host portion of a URL with `127.0.0.1` *only* when the URL is the
 * admin port (:10254) and the host isn't already loopback. Returns the URL
 * unchanged otherwise — gateway URLs (:10255) must stay on the bridge IP so
 * agent containers can keep reaching the proxy.
 */
export function swapHostInAdminUrl(url: string): string {
  const m = url.match(/^(https?:\/\/)([^:/]+)(:10254\b.*)$/);
  if (!m) return url;
  if (m[2] === '127.0.0.1' || m[2] === 'localhost') return url;
  return `${m[1]}127.0.0.1${m[3]}`;
}

function patchOnecliConfigJson(configPath: string): boolean {
  if (!fs.existsSync(configPath)) return false;
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const obj = JSON.parse(raw) as Record<string, unknown>;
    const apiHost = obj['api-host'];
    if (typeof apiHost !== 'string') return false;
    const swapped = swapHostInAdminUrl(apiHost);
    if (swapped === apiHost) return false;
    obj['api-host'] = swapped;
    fs.writeFileSync(configPath, JSON.stringify(obj, null, 2) + '\n');
    log.info('Updated OneCLI config.json api-host to 127.0.0.1', { configPath });
    return true;
  } catch (err) {
    log.warn('Could not update OneCLI config.json — leave it for manual fix', { configPath, err });
    return false;
  }
}

function patchOnecliEnvAdminUrl(envPath: string): boolean {
  if (!fs.existsSync(envPath)) return false;
  try {
    const original = fs.readFileSync(envPath, 'utf-8');
    // Only rewrite admin URL lines (port 10254). Leave gateway URLs (10255) alone.
    const re = /^(\s*ONECLI_URL\s*=\s*)("?)(https?:\/\/)([^:/"]+)(:10254\b[^"\n]*)("?)\s*$/m;
    const m = original.match(re);
    if (!m) return false;
    const host = m[4];
    if (host === '127.0.0.1' || host === 'localhost') return false;
    const patched = original.replace(re, '$1$2$3127.0.0.1$5$6');
    if (patched === original) return false;
    fs.writeFileSync(envPath, patched);
    log.info('Updated ~/.onecli/.env ONECLI_URL to 127.0.0.1', { envPath });
    return true;
  } catch (err) {
    log.warn('Could not update ~/.onecli/.env', { envPath, err });
    return false;
  }
}

type PortInspector = (container: string, port: string) => string | null;

/**
 * Read the actual host-side bind for a given container:port from
 * `docker inspect`. Returns null if docker isn't reachable, the container
 * isn't running, or that port isn't bound. This is the source of truth —
 * .env and compose `${...}` defaults can disagree with reality.
 */
function inspectPortBind(container: string, port: string): string | null {
  try {
    const out = execSync(
      `docker inspect ${JSON.stringify(container)} --format '{{json .NetworkSettings.Ports}}'`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const ports = JSON.parse(out) as Record<string, Array<{ HostIp?: string }> | null>;
    const binding = ports[port]?.[0];
    if (binding?.HostIp) return binding.HostIp;
    return null;
  } catch {
    return null;
  }
}

function readEnvBindHost(envPath: string): string | null {
  if (!fs.existsSync(envPath)) return null;
  try {
    const content = fs.readFileSync(envPath, 'utf-8');
    const m = content.match(/^\s*ONECLI_BIND_HOST\s*=\s*(.+?)\s*$/m);
    if (!m) return null;
    const bind = m[1].replace(/^["']|["']$/g, '');
    return bind || null;
  } catch {
    return null;
  }
}

/**
 * Where should the gateway (:10255) bind to after we recreate the containers?
 * Whatever the currently-running gateway is bound to. Fall back to the
 * installer's .env, then to loopback. We need this because the compose file's
 * `:10255` line is `${ONECLI_BIND_HOST:-127.0.0.1}` — if our subprocess env
 * doesn't have ONECLI_BIND_HOST set, the default loopback wins and every
 * agent container loses the proxy on next reconcile.
 */
function detectGatewayBindHost(opts: { envPath?: string; inspectFn?: PortInspector } = {}): string {
  const inspect = opts.inspectFn ?? inspectPortBind;
  const envPath = opts.envPath ?? ONECLI_ENV_PATH;
  const fromInspect = inspect(ONECLI_CONTAINER, '10255/tcp');
  if (fromInspect) return fromInspect;
  const fromEnv = readEnvBindHost(envPath);
  if (fromEnv) return fromEnv;
  return '127.0.0.1';
}

/**
 * After rewriting the compose file, ask docker to reconcile the running
 * containers with the new port mappings. `up -d` is the right verb here:
 * it stops and recreates only the services whose effective config changed,
 * and leaves the rest alone. We don't fail the install if this errors —
 * the rewrite already landed and a `docker compose up -d` on next boot will
 * pick it up.
 *
 * We must pass `ONECLI_BIND_HOST` explicitly because the installer set it
 * only in its own shell, and the compose file's `:10255` line falls back to
 * `127.0.0.1` if it's not in the environment.
 */
function applyHardenedCompose(composePath: string = ONECLI_COMPOSE_PATH): void {
  const bindHost = detectGatewayBindHost();
  try {
    execSync(`docker compose -f ${JSON.stringify(composePath)} up -d`, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ONECLI_BIND_HOST: bindHost },
    });
  } catch (err) {
    log.warn('docker compose up -d after bind hardening failed (will apply on next boot)', { err });
  }
}

type DetectOptions = {
  envPath?: string;
  inspectFn?: PortInspector;
};

/**
 * --reuse mode helper: detect whether an existing OneCLI install has the
 * admin port bound to anything other than loopback, so we can warn without
 * rewriting someone else's file. `docker inspect` is the source of truth;
 * fall back to the installer's .env only if inspect fails (container not
 * running, docker not on PATH, etc.). Returns the unsafe bind value if
 * detected, otherwise null.
 */
export function detectUnsafeOneCliBinds(opts: DetectOptions = {}): string | null {
  const inspect = opts.inspectFn ?? inspectPortBind;
  const envPath = opts.envPath ?? ONECLI_ENV_PATH;
  const adminBind = inspect(ONECLI_CONTAINER, '10254/tcp');
  if (adminBind) {
    if (adminBind === '127.0.0.1' || adminBind === 'localhost') return null;
    return adminBind;
  }
  const envBind = readEnvBindHost(envPath);
  if (envBind && envBind !== '127.0.0.1' && envBind !== 'localhost') return envBind;
  return null;
}

function installOnecli(): { stdout: string; ok: boolean } {
  let stdout = '';

  const cleanup = removeLegacyOnecliContainers();
  if (cleanup) stdout += cleanup + '\n';

  // Gateway install (docker-compose based, no rate-limit concerns).
  const gw = runInstall(`export ONECLI_VERSION=${ONECLI_GATEWAY_VERSION} && curl -fsSL onecli.sh/install | sh`);
  stdout += gw.stdout;
  if (!gw.ok) {
    log.error('OneCLI gateway install failed', { stderr: gw.stderr });
    return { stdout: stdout + (gw.stderr ?? ''), ok: false };
  }

  // CLI install. The upstream script calls the GitHub releases API
  // (api.github.com) to resolve the latest tag — which 403s anonymous
  // callers after 60 requests/hour per IP. Try upstream first; on failure
  // resolve the version ourselves (via HTTP redirect, which isn't
  // API-throttled) and download the release archive directly.
  const upstream = runInstall('curl -fsSL onecli.sh/cli/install | sh');
  stdout += upstream.stdout;
  if (upstream.ok) return { stdout, ok: true };

  log.warn('Upstream CLI installer failed — falling back to direct download', {
    stderr: upstream.stderr,
  });
  stdout += (upstream.stderr ?? '') + '\n';

  const fallback = installOnecliCliDirect();
  stdout += fallback.stdout;
  if (!fallback.ok) {
    log.error('OneCLI CLI install failed (both upstream and direct fallback)');
    return { stdout, ok: false };
  }
  return { stdout, ok: true };
}

function runInstall(cmd: string): { stdout: string; stderr?: string; ok: boolean } {
  try {
    const stdout = execSync(cmd, {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { stdout, ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { stdout: e.stdout ?? '', stderr: e.stderr, ok: false };
  }
}

/**
 * Reinstate the OneCLI CLI install without hitting GitHub's rate-limited
 * releases API. Resolves the version via the HTTP redirect from
 * /releases/latest → /releases/tag/vX.Y.Z, then downloads the archive
 * directly. Falls back to ONECLI_CLI_FALLBACK_VERSION if the redirect
 * probe also fails.
 */
function installOnecliCliDirect(): { stdout: string; ok: boolean } {
  const lines: string[] = [];
  const append = (s: string): void => {
    lines.push(s);
  };

  const osName = process.platform === 'darwin' ? 'darwin' : process.platform === 'linux' ? 'linux' : null;
  if (!osName) {
    append(`Unsupported platform: ${process.platform}`);
    return { stdout: lines.join('\n'), ok: false };
  }
  const arch = process.arch === 'x64' ? 'amd64' : process.arch === 'arm64' ? 'arm64' : null;
  if (!arch) {
    append(`Unsupported arch: ${process.arch}`);
    return { stdout: lines.join('\n'), ok: false };
  }

  let version: string | null = null;
  try {
    const redirect = execSync(
      `curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/${ONECLI_CLI_REPO}/releases/latest`,
      { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim();
    const m = redirect.match(/\/tag\/v?([^/]+)$/);
    if (m) version = m[1];
  } catch {
    // redirect probe failed — we'll pin the fallback
  }
  if (!version) {
    version = ONECLI_CLI_FALLBACK_VERSION;
    append(`Version probe failed; installing pinned fallback ${version}.`);
  } else {
    append(`Resolved onecli CLI ${version} via release redirect.`);
  }

  const archive = `onecli_${version}_${osName}_${arch}.tar.gz`;
  const url = `https://github.com/${ONECLI_CLI_REPO}/releases/download/v${version}/${archive}`;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'onecli-'));
  const archivePath = path.join(tmpDir, archive);

  try {
    append(`Downloading ${url}`);
    execSync(`curl -fsSL -o ${JSON.stringify(archivePath)} ${JSON.stringify(url)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    execSync(`tar -xzf ${JSON.stringify(archivePath)} -C ${JSON.stringify(tmpDir)}`, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let installDir = '/usr/local/bin';
    try {
      fs.accessSync(installDir, fs.constants.W_OK);
    } catch {
      installDir = LOCAL_BIN;
      fs.mkdirSync(installDir, { recursive: true });
    }
    const binSrc = path.join(tmpDir, 'onecli');
    const binDest = path.join(installDir, 'onecli');
    fs.copyFileSync(binSrc, binDest);
    fs.chmodSync(binDest, 0o755);
    append(`onecli ${version} installed to ${binDest}.`);
    return { stdout: lines.join('\n'), ok: true };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    append(`Direct install failed: ${e.stderr ?? e.message ?? String(err)}`);
    return { stdout: lines.join('\n'), ok: false };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

export async function pollHealth(url: string, timeoutMs: number): Promise<boolean> {
  // `/api/health` matches the path probe.sh uses — keep them aligned.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/api/health`);
      if (res.ok) return true;
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

export async function run(args: string[]): Promise<void> {
  const reuse = args.includes('--reuse');
  const remoteUrlIdx = args.indexOf('--remote-url');
  const remoteUrl = remoteUrlIdx !== -1 ? args[remoteUrlIdx + 1] : null;
  ensureShellProfilePath();

  if (remoteUrl) {
    // Remote-mode: install only the CLI, point it at the remote gateway, and
    // record the URL in .env. No local gateway is started.
    log.info('Installing OneCLI CLI for remote gateway', { remoteUrl });
    const res = installOnecliCliOnly();
    if (!res.ok || !onecliVersion()) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'cli_install_failed',
        HINT: 'CLI binary install failed. Make sure curl is installed and ~/.local/bin is writable.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    try {
      execFileSync('onecli', ['config', 'set', 'api-host', remoteUrl], {
        stdio: 'ignore',
        env: childEnv(),
      });
    } catch (err) {
      log.warn('onecli config set api-host failed', { err });
    }
    writeEnvOnecliUrl(remoteUrl);
    log.info('Wrote ONECLI_URL to .env', { url: remoteUrl });
    const remoteToken = process.env.NANOCLAW_ONECLI_API_TOKEN?.trim();
    if (remoteToken) {
      // Two auth surfaces: `onecli auth login` persists the key for CLI
      // calls during setup itself (e.g. detecting an existing Anthropic
      // secret via `onecli secrets list`), and ONECLI_API_KEY in .env is
      // read by the runtime SDK at request time. Both are needed.
      try {
        execFileSync('onecli', ['auth', 'login', '--api-key', remoteToken], {
          stdio: 'ignore',
          env: childEnv(),
        });
      } catch (err) {
        log.warn('onecli auth login failed', { err });
      }
      writeEnvVar('ONECLI_API_KEY', remoteToken);
      log.info('Wrote ONECLI_API_KEY to .env');
    }
    const healthy = await pollHealth(remoteUrl, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REMOTE: true,
      ONECLI_URL: remoteUrl,
      HEALTHY: healthy,
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  if (reuse) {
    // Reuse-mode: don't touch the running gateway at all. Just verify it
    // exists, read its api-host, write ONECLI_URL to .env, and move on.
    const version = onecliVersion();
    if (!version) {
      emitStatus('ONECLI', {
        INSTALLED: false,
        STATUS: 'failed',
        ERROR: 'onecli_not_found_for_reuse',
        HINT: 'onecli not on PATH. Re-run setup and choose "install fresh".',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    const url = getOnecliApiHost();
    if (!url) {
      emitStatus('ONECLI', {
        INSTALLED: true,
        STATUS: 'failed',
        ERROR: 'onecli_api_host_not_configured',
        HINT: 'Existing onecli has no api-host set. Run `onecli config set api-host <url>` or re-run setup with install-fresh.',
        LOG: 'logs/setup.log',
      });
      process.exit(1);
    }
    writeEnvOnecliUrl(url);
    log.info('Reusing existing OneCLI', { url });
    const unsafeBind = detectUnsafeOneCliBinds();
    if (unsafeBind) {
      log.warn(
        'Existing OneCLI binds admin API and Postgres on a non-loopback address. ' +
          'Containers on that network can reach the admin API and Postgres directly. ' +
          'See onecli/onecli#268. To remediate: stop the gateway, re-run setup without --reuse, ' +
          'or manually pin :10254 and :5432 to 127.0.0.1 in ~/.onecli/docker-compose.yml, ' +
          'and update the admin URL in ~/.onecli/config.json (and ~/.onecli/.env if present).',
        { bind: unsafeBind },
      );
    }
    const healthy = await pollHealth(url, 5000);
    emitStatus('ONECLI', {
      INSTALLED: true,
      REUSED: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      ...(unsafeBind ? { UNSAFE_BIND: unsafeBind, HARDEN_NOTE: 'admin_api_and_postgres_exposed_on_bridge' } : {}),
      STATUS: 'success',
      LOG: 'logs/setup.log',
    });
    return;
  }

  log.info('Installing OneCLI gateway and CLI');
  const res = installOnecli();
  if (!res.ok) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'install_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }
  if (!onecliVersion()) {
    emitStatus('ONECLI', {
      INSTALLED: false,
      STATUS: 'failed',
      ERROR: 'onecli_not_on_path_after_install',
      HINT: 'Open a new shell or run `export PATH="$HOME/.local/bin:$PATH"` and retry.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  // Pin admin API (:10254) and Postgres (:5432) to 127.0.0.1 before we hand
  // back to the rest of setup. The upstream installer picks the docker0
  // bridge IP as ONECLI_BIND_HOST on bare-metal Linux, which makes both
  // services reachable from any container on the host's default bridge.
  // See onecli/onecli#268.
  const harden = hardenOneCliBinds();
  if (harden.changed) applyHardenedCompose();

  // The URL the installer printed still has the bridge IP. If we just hardened
  // the admin port to loopback, that URL is now dead from the host's POV —
  // swap the host portion to 127.0.0.1 so `api-host` and NanoClaw's own
  // ONECLI_URL match the new bind. Gateway URLs (:10255) are left alone.
  const extracted = extractUrlFromOutput(res.stdout);
  const url = harden.changed && extracted ? swapHostInAdminUrl(extracted) : extracted;
  if (!url) {
    emitStatus('ONECLI', {
      INSTALLED: true,
      STATUS: 'failed',
      ERROR: 'could_not_resolve_api_host',
      HINT: 'Inspect logs/setup.log for the install output.',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  try {
    execFileSync('onecli', ['config', 'set', 'api-host', url], {
      stdio: 'ignore',
      env: childEnv(),
    });
  } catch (err) {
    log.warn('onecli config set api-host failed', { err });
  }

  writeEnvOnecliUrl(url);
  log.info('Wrote ONECLI_URL to .env', { url });

  const healthy = await pollHealth(url, 15000);

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    HARDENED: harden.changed,
    HARDEN_NOTE: harden.changed
      ? harden.adminUrlRewritten
        ? 'admin_api_and_postgres_pinned_to_loopback_and_admin_url_rewritten'
        : 'admin_api_and_postgres_pinned_to_loopback'
      : harden.reason ?? 'no_change',
    // Install succeeded regardless — a failed health poll often just means
    // the endpoint is auth-gated or the gateway hasn't finished warming up.
    // The next step (auth) will surface a genuinely broken gateway via
    // `onecli secrets list`, so don't trigger rescue attempts from here.
    STATUS: 'success',
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll returned non-ok within 15s — likely auth-gated. Proceed to the auth step; it will surface a real outage.',
        }),
    LOG: 'logs/setup.log',
  });
}
