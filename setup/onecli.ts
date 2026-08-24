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
import { readVersionPin } from './lib/version-pins.js';
import { emitStatus } from './status.js';

const LOCAL_BIN = path.join(os.homedir(), '.local', 'bin');

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

// The SANCTIONED gateway version: fresh installs pin to it. Upgrading an
// existing gateway is NOT done here — the gateway is a separate out-of-band
// component, and the migrator is the user's coding agent following
// docs/onecli-upgrades.md during /update-nanoclaw. The pin lives in
// versions.json ("onecli-gateway") so that flow can diff it across updates and
// route the agent to the doc; bump it there deliberately on a new release.
const ONECLI_GATEWAY_VERSION = readVersionPin('onecli-gateway');
// The CLI binary follows the same convention: installed at its pin
// ("onecli-cli" in versions.json), never at whatever "latest" means today.
const ONECLI_CLI_VERSION = readVersionPin('onecli-cli');
const ONECLI_CLI_REPO = 'onecli/onecli-cli';

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

  const cli = installOnecliCliDirect();
  stdout += cli.stdout;
  if (!cli.ok) {
    log.error('OneCLI CLI install failed');
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
 * Install the OneCLI CLI at the sanctioned pin by downloading the release
 * archive straight from GitHub. Deliberately no "latest" resolution — the
 * upstream installer script always chases the newest release, which would
 * drift from the pin. PATH setup is not lost by skipping it:
 * ensureShellProfilePath() in run() covers it.
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

  const version = ONECLI_CLI_VERSION;
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

/**
 * /v1 API compatibility check. @onecli-sh/sdk 2.x requires the server's /v1
 * API; servers older than the cutover answer 404 on every SDK call (permanent,
 * but presents as transient per-spawn failures). This is detect-only — setup
 * does not migrate the gateway. The upgrade is an out-of-band action on a
 * separate component that the agent runs via docs/onecli-upgrades.md during
 * /update-nanoclaw, so this step only surfaces the condition and points there.
 */
export async function verifyGatewayV1(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<'ok' | 'incompatible' | 'unreachable'> {
  try {
    const res = await fetchImpl(`${url}/v1/health`, { signal: AbortSignal.timeout(5000) });
    return res.ok ? 'ok' : 'incompatible';
  } catch {
    return 'unreachable';
  }
}

/**
 * Detect-and-warn helper: returns a status HINT (and logs) when the gateway is
 * pre-/v1, else null. Never fails the step or auto-upgrades — the agent owns
 * the upgrade via docs/onecli-upgrades.md.
 */
function gatewayV1Hint(result: 'ok' | 'incompatible' | 'unreachable'): string | null {
  if (result !== 'incompatible') return null;
  log.warn('OneCLI gateway lacks the /v1 API @onecli-sh/sdk 2.x requires', {
    pin: ONECLI_GATEWAY_VERSION,
  });
  return 'OneCLI gateway lacks the /v1 API @onecli-sh/sdk 2.x requires — upgrade it: docs/onecli-upgrades.md';
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
    const res = installOnecliCliDirect();
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
    const v1Hint = healthy ? gatewayV1Hint(await verifyGatewayV1(remoteUrl)) : null;
    emitStatus('ONECLI', {
      INSTALLED: true,
      REMOTE: true,
      ONECLI_URL: remoteUrl,
      HEALTHY: healthy,
      STATUS: 'success',
      ...(v1Hint ? { GATEWAY_HINT: v1Hint } : {}),
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
    const healthy = await pollHealth(url, 5000);
    const v1Hint = healthy ? gatewayV1Hint(await verifyGatewayV1(url)) : null;
    emitStatus('ONECLI', {
      INSTALLED: true,
      REUSED: true,
      ONECLI_URL: url,
      HEALTHY: healthy,
      STATUS: 'success',
      ...(v1Hint ? { GATEWAY_HINT: v1Hint } : {}),
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

  const url = extractUrlFromOutput(res.stdout);
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
  const v1Hint = healthy ? gatewayV1Hint(await verifyGatewayV1(url)) : null;

  emitStatus('ONECLI', {
    INSTALLED: true,
    ONECLI_URL: url,
    HEALTHY: healthy,
    // Install succeeded regardless — a failed health poll often just means
    // the endpoint is auth-gated or the gateway hasn't finished warming up.
    // The next step (auth) will surface a genuinely broken gateway via
    // `onecli secrets list`, so don't trigger rescue attempts from here.
    STATUS: 'success',
    ...(v1Hint ? { GATEWAY_HINT: v1Hint } : {}),
    ...(healthy
      ? {}
      : {
          HEALTH_HINT:
            'Health poll returned non-ok within 15s — likely auth-gated. Proceed to the auth step; it will surface a real outage.',
        }),
    LOG: 'logs/setup.log',
  });
}
