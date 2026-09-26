/**
 * Step: service — Generate and load service manager config.
 * Replaces 08-setup-service.sh
 *
 * Fixes: Root→system systemd, WSL nohup fallback, no `|| true` swallowing errors.
 */
import { execFileSync, execSync } from 'child_process';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';

import { log } from '../src/log.js';
import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { writeUpgradeState } from '../src/upgrade-state.js';
import { cleanupUnhealthyPeers } from './peer-cleanup.js';
import { commandExists, getPlatform, getNodePath, getServiceManager, isRoot } from './platform.js';
import { emitStatus } from './status.js';

export async function run(_args: string[]): Promise<void> {
  const projectRoot = process.cwd();
  const platform = getPlatform();
  const nodePath = getNodePath();
  const homeDir = os.homedir();

  log.info('Setting up service', { platform, nodePath, projectRoot });

  // Build first
  log.info('Building TypeScript');
  try {
    execSync('pnpm run build', {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    log.info('Build succeeded');
  } catch {
    log.error('Build failed');
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'build_failed',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  fs.mkdirSync(path.join(projectRoot, 'logs'), { recursive: true });

  // Stamp the upgrade marker before the host first starts, so the startup
  // tripwire (enforceUpgradeTripwire) sees this as a sanctioned install.
  const stamped = writeUpgradeState({ via: 'setup' });
  log.info('Stamped upgrade marker', { version: stamped.version });

  // Peer preflight — a crash-looping peer install (most often the legacy v1
  // `com.nanoclaw` plist) will keep trashing this install's containers on
  // every respawn via its own cleanupOrphans. Detect and unload any peer
  // that's unhealthy before we install our service. Healthy peers are left
  // alone now that container reaping is install-label-scoped.
  const peerReport = cleanupUnhealthyPeers(projectRoot);
  if (peerReport.unloaded.length > 0) {
    log.warn('Unloaded unhealthy peer NanoClaw services', {
      count: peerReport.unloaded.length,
      labels: peerReport.unloaded.map((p) => p.label),
    });
  }
  if (peerReport.removed.length > 0) {
    log.warn('Removed dead peer NanoClaw registrations (target binary missing)', {
      count: peerReport.removed.length,
      labels: peerReport.removed.map((p) => p.label),
    });
  }

  if (platform === 'macos') {
    setupLaunchd(projectRoot, nodePath, homeDir);
  } else if (platform === 'linux') {
    await setupLinux(projectRoot, nodePath, homeDir);
  } else {
    emitStatus('SETUP_SERVICE', {
      SERVICE_TYPE: 'unknown',
      NODE_PATH: nodePath,
      PROJECT_PATH: projectRoot,
      STATUS: 'failed',
      ERROR: 'unsupported_platform',
      LOG: 'logs/setup.log',
    });
    process.exit(1);
  }

  installCliSymlink(projectRoot, homeDir);
}

/**
 * Symlink bin/ncl into ~/.local/bin so `ncl` is available from anywhere.
 * Idempotent — overwrites an existing symlink but won't clobber a real file.
 */
function installCliSymlink(projectRoot: string, homeDir: string): void {
  const source = path.join(projectRoot, 'bin', 'ncl');
  const targetDir = path.join(homeDir, '.local', 'bin');
  const target = path.join(targetDir, 'ncl');

  try {
    fs.mkdirSync(targetDir, { recursive: true });

    // Remove existing symlink (but not a real file)
    try {
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(target);
      } else {
        log.warn('~/.local/bin/ncl exists and is not a symlink — skipping', { target });
        return;
      }
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code !== 'ENOENT') throw err;
    }

    fs.symlinkSync(source, target);
    log.info('Installed ncl CLI symlink', { target, source });
  } catch (err) {
    log.warn('Could not install ncl CLI symlink (non-fatal)', { err });
  }
}

function setupLaunchd(projectRoot: string, nodePath: string, homeDir: string): void {
  // Per-checkout service label so multiple NanoClaw installs can coexist
  // without clobbering each other's plist.
  const label = getLaunchdLabel(projectRoot);
  const plistPath = path.join(homeDir, 'Library', 'LaunchAgents', `${label}.plist`);
  fs.mkdirSync(path.dirname(plistPath), { recursive: true });

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>${nodePath}</string>
        <string>${projectRoot}/dist/index.js</string>
    </array>
    <key>WorkingDirectory</key>
    <string>${projectRoot}</string>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>${path.dirname(nodePath)}:/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin</string>
        <key>HOME</key>
        <string>${homeDir}</string>
    </dict>
    <key>StandardOutPath</key>
    <string>${projectRoot}/logs/nanoclaw.log</string>
    <key>StandardErrorPath</key>
    <string>${projectRoot}/logs/nanoclaw.error.log</string>
</dict>
</plist>`;

  fs.writeFileSync(plistPath, plist);
  log.info('Wrote launchd plist', { plistPath });

  // Unload first to force launchd to drop any cached plist and re-read from
  // disk. Bare `launchctl load` on an already-loaded plist errors with
  // "already loaded" and keeps the ORIGINAL plist's ProgramArguments /
  // WorkingDirectory in memory — even if the file on disk changed. That
  // bit us when the plist target shifted between installs: kickstart kept
  // relaunching the old binary and the CLI socket landed in the wrong dir.
  // unload succeeds whether or not the service was previously loaded; the
  // failure case is "Could not find specified service" which is harmless.
  try {
    execSync(`launchctl unload ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    log.info('launchctl unload succeeded');
  } catch {
    log.info('launchctl unload noop (plist was not previously loaded)');
  }

  try {
    execSync(`launchctl load ${JSON.stringify(plistPath)}`, {
      stdio: 'ignore',
    });
    log.info('launchctl load succeeded');
  } catch (err) {
    log.error('launchctl load failed', { err });
  }

  // launchd can leave a freshly loaded RunAtLoad job queued without ever
  // spawning it (`launchctl print` shows "pended nondemand spawn =
  // speculative", runs = 0, indefinitely — seen live 2026-08-10). kickstart
  // demand-starts it, and is a no-op on a job that load already spawned.
  try {
    execSync(`launchctl kickstart gui/${process.getuid!()}/${label}`, { stdio: 'ignore' });
  } catch (err) {
    log.error('launchctl kickstart failed', { err });
  }

  // Verify
  let serviceLoaded = false;
  try {
    const output = execSync('launchctl list', { encoding: 'utf-8' });
    serviceLoaded = output.includes(label);
  } catch {
    // launchctl list failed
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'launchd',
    SERVICE_LABEL: label,
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    PLIST_PATH: plistPath,
    SERVICE_LOADED: serviceLoaded,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

async function setupLinux(projectRoot: string, nodePath: string, homeDir: string): Promise<void> {
  const serviceManager = getServiceManager();

  if (serviceManager === 'systemd') {
    await setupSystemd(projectRoot, nodePath, homeDir);
  } else {
    // WSL without systemd or other Linux without systemd
    await setupNohupFallback(projectRoot, nodePath);
  }
}

/**
 * Kill any orphaned nanoclaw node processes left from previous runs or debugging.
 * Prevents connection conflicts when two instances connect to the same channel simultaneously.
 */
function killOrphanedProcesses(projectRoot: string): void {
  try {
    execSync(`pkill -f '${projectRoot}/dist/index\\.js' || true`, {
      stdio: 'ignore',
    });
    log.info('Stopped any orphaned nanoclaw processes');
  } catch {
    // pkill not available or no orphans
  }
}

/**
 * Detect stale docker group membership in the user systemd session.
 *
 * When a user is added to the docker group mid-session, the user systemd
 * daemon (user@UID.service) keeps the old group list from login time.
 * Docker works in the terminal but not in the service context.
 *
 * Only relevant on Linux with user-level systemd (not root, not macOS, not WSL nohup).
 */
function checkDockerGroupStale(): boolean {
  try {
    execSync('systemd-run --user --pipe --wait docker info', {
      stdio: 'pipe',
      timeout: 10000,
    });
    return false; // Docker works from systemd session
  } catch {
    // Check if docker works from the current shell (to distinguish stale group vs broken docker)
    try {
      execSync('docker info', { stdio: 'pipe', timeout: 5000 });
      return true; // Works in shell but not systemd session → stale group
    } catch {
      return false; // Docker itself is not working, different issue
    }
  }
}

async function setupSystemd(projectRoot: string, nodePath: string, homeDir: string): Promise<void> {
  const runningAsRoot = isRoot();
  const unitName = getSystemdUnit(projectRoot);
  const unitFileName = `${unitName}.service`;

  // Root uses system-level service, non-root uses user-level
  let unitPath: string;
  let systemctlPrefix: string;

  if (runningAsRoot) {
    unitPath = `/etc/systemd/system/${unitFileName}`;
    systemctlPrefix = 'systemctl';
    log.info('Running as root — installing system-level systemd unit');
  } else {
    // Check if user-level systemd session is available
    try {
      execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    } catch {
      log.warn('systemd user session not available — falling back to nohup wrapper');
      await setupNohupFallback(projectRoot, nodePath);
      return;
    }
    const unitDir = path.join(homeDir, '.config', 'systemd', 'user');
    fs.mkdirSync(unitDir, { recursive: true });
    unitPath = path.join(unitDir, unitFileName);
    systemctlPrefix = 'systemctl --user';
  }

  const unit = `[Unit]
Description=NanoClaw Personal Assistant
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${projectRoot}/dist/index.js
WorkingDirectory=${projectRoot}
Restart=always
RestartSec=5
KillMode=process
Environment=HOME=${homeDir}
Environment=PATH=${path.dirname(nodePath)}:/usr/local/bin:/usr/bin:/bin:${homeDir}/.local/bin
StandardOutput=append:${projectRoot}/logs/nanoclaw.log
StandardError=append:${projectRoot}/logs/nanoclaw.error.log

[Install]
WantedBy=${runningAsRoot ? 'multi-user.target' : 'default.target'}`;

  fs.writeFileSync(unitPath, unit);
  log.info('Wrote systemd unit', { unitPath });

  // Detect stale docker group before starting (user systemd only). The user
  // systemd manager is a long-running process whose group list is frozen at
  // login, so `usermod -aG docker` mid-session doesn't reach it. Rather than
  // require the user to log out + back in, punch a POSIX ACL onto the socket
  // that grants the current user rw directly. This is temporary — the socket
  // is recreated by dockerd on restart (and by then the user has relogged, so
  // normal group perms apply again).
  let dockerGroupStale = !runningAsRoot && checkDockerGroupStale();
  if (dockerGroupStale) {
    log.warn('Docker group not active in systemd session — user was likely added to docker group mid-session');
    if (commandExists('setfacl')) {
      const user = execSync('whoami', { encoding: 'utf-8' }).trim();
      try {
        execSync(`sudo setfacl -m u:${user}:rw /var/run/docker.sock`, {
          stdio: 'inherit',
        });
        log.info('Applied temporary ACL to /var/run/docker.sock (resets on docker restart or reboot)');
        dockerGroupStale = false;
      } catch (err) {
        log.warn('Failed to apply setfacl workaround', { err });
      }
    } else {
      log.warn('setfacl not installed — cannot apply automatic workaround');
    }
  }

  // Kill orphaned nanoclaw processes to avoid channel connection conflicts
  killOrphanedProcesses(projectRoot);

  // Enable lingering so the user service survives SSH logout.
  // Without linger, systemd terminates all user processes when the last session closes.
  if (!runningAsRoot) {
    try {
      execSync('loginctl enable-linger', { stdio: 'ignore' });
      log.info('Enabled loginctl linger for current user');
    } catch (err) {
      log.warn('loginctl enable-linger failed — service may stop on SSH logout', { err });
    }
  }

  // Enable and start
  try {
    execSync(`${systemctlPrefix} daemon-reload`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl daemon-reload failed', { err });
  }

  try {
    execSync(`${systemctlPrefix} enable ${unitName}`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl enable failed', { err });
  }

  // restart (not start) so a previously-running instance picks up edits to
  // the unit file. `start` on an active unit is a no-op, which would leave
  // the old ExecStart / WorkingDirectory in effect even after daemon-reload.
  // `restart` on a stopped unit is equivalent to `start`, so this is safe
  // as a first-install path too.
  try {
    execSync(`${systemctlPrefix} restart ${unitName}`, { stdio: 'ignore' });
  } catch (err) {
    log.error('systemctl restart failed', { err });
  }

  // Verify
  let serviceLoaded = false;
  try {
    execSync(`${systemctlPrefix} is-active ${unitName}`, { stdio: 'ignore' });
    serviceLoaded = true;
  } catch {
    // Not active
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: runningAsRoot ? 'systemd-system' : 'systemd-user',
    SERVICE_UNIT: unitName,
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    UNIT_PATH: unitPath,
    SERVICE_LOADED: serviceLoaded,
    ...(dockerGroupStale ? { DOCKER_GROUP_STALE: true } : {}),
    LINGER_ENABLED: !runningAsRoot,
    STATUS: 'success',
    LOG: 'logs/setup.log',
  });
}

// Single quotes keep checkout paths literal in the generated shell script.
function shellQuote(value: string): string {
  return "'" + value.replace(/'/g, "'\\''") + "'";
}

function processRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // kill -0 also succeeds for an exited child waiting to be reaped on Linux.
    return !/\) Z /.test(fs.readFileSync(`/proc/${pid}/stat`, 'utf8'));
  } catch {
    return false;
  }
}

/** The admin socket opens at the end of host startup, after channels and polls. */
export async function waitForNohupStartup(projectRoot: string, pid: number, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!processRunning(pid)) throw new Error('NanoClaw exited during startup');
    const ready = await new Promise<boolean>((resolve) => {
      // Do not probe cli.sock: connecting there replaces the interactive chat client.
      const socket = net.createConnection(path.join(projectRoot, 'data', 'ncl.sock'));
      const done = (connected: boolean): void => {
        socket.destroy();
        resolve(connected);
      };
      socket.once('connect', () => done(true));
      socket.once('error', () => done(false));
      socket.setTimeout(Math.min(500, Math.max(1, deadline - Date.now())), () => done(false));
    });
    if (ready && processRunning(pid)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('Timed out waiting for NanoClaw admin socket');
}

async function setupNohupFallback(projectRoot: string, nodePath: string): Promise<void> {
  log.warn('No usable systemd service — starting with nohup');

  const wrapperPath = path.join(projectRoot, 'start-nanoclaw.sh');
  const pidFile = path.join(projectRoot, 'nanoclaw.pid');
  const entrypoint = path.join(projectRoot, 'dist', 'index.js');

  const lines = [
    '#!/bin/bash',
    '# start-nanoclaw.sh — Start NanoClaw without systemd',
    `# To stop: kill "$(cat ${shellQuote(pidFile)})"`,
    '',
    'set -euo pipefail',
    `cd ${shellQuote(projectRoot)}`,
    '',
    '# Only stop the recorded host from this checkout; a PID can be reused.',
    'is_previous_host() {',
    '  [[ "$OLD_PID" =~ ^[1-9][0-9]*$ ]] || return 1',
    '  [ -r "/proc/$OLD_PID/cmdline" ] || return 1',
    '  local -a args=()',
    '  mapfile -d "" -t args < "/proc/$OLD_PID/cmdline" 2>/dev/null || return 1',
    `  [ "\${args[1]:-}" = ${shellQuote(entrypoint)} ]`,
    '}',
    `OLD_PID=$(cat ${shellQuote(pidFile)} 2>/dev/null || true)`,
    'if is_previous_host; then',
    '  echo "Stopping existing NanoClaw (PID $OLD_PID)..."',
    '  kill "$OLD_PID"',
    '  for ((i=0; i<100; i++)); do',
    '    is_previous_host || break',
    '    sleep 0.1',
    '  done',
    '  if is_previous_host; then',
    '    echo "Previous NanoClaw did not stop; refusing to start another host" >&2',
    '    exit 1',
    '  fi',
    'fi',
    '',
    '# A missing/stale PID file must not let an existing listener fake readiness.',
    `${shellQuote(nodePath)} -e ${shellQuote(`
const socket = require('net').createConnection(process.argv[1]);
socket.once('connect', () => {
  console.error('NanoClaw admin socket is already in use; stop the existing host first');
  process.exit(1);
});
socket.once('error', (err) => {
  if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED') process.exit(0);
  console.error('Cannot check NanoClaw admin socket:', err.message);
  process.exit(1);
});
socket.setTimeout(1000, () => {
  console.error('Timed out checking existing NanoClaw admin socket');
  process.exit(1);
});
`)} ${shellQuote(path.join(projectRoot, 'data', 'ncl.sock'))}`,
    '',
    'echo "Starting NanoClaw..."',
    // Node resets the inherited SIGHUP ignore; detach from the wizard terminal.
    `setsid nohup ${shellQuote(nodePath)} ${shellQuote(entrypoint)} \\`,
    `  >> ${shellQuote(projectRoot + '/logs/nanoclaw.log')} \\`,
    `  2>> ${shellQuote(projectRoot + '/logs/nanoclaw.error.log')} < /dev/null &`,
    `echo $! > ${shellQuote(pidFile)}`,
    'echo "NanoClaw launched (PID $!)"',
  ];
  fs.writeFileSync(wrapperPath, lines.join('\n') + '\n', { mode: 0o755 });
  log.info('Wrote nohup wrapper script', { wrapperPath });

  let failure: unknown;
  try {
    execFileSync('/bin/bash', [wrapperPath], { cwd: projectRoot, stdio: 'pipe', timeout: 15_000 });
    const pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    if (!Number.isInteger(pid) || pid <= 0) throw new Error('Invalid NanoClaw PID file');
    await waitForNohupStartup(projectRoot, pid);
  } catch (err) {
    failure = err;
    log.error('Nohup service failed to start; see logs/nanoclaw.error.log', { err });
  }

  emitStatus('SETUP_SERVICE', {
    SERVICE_TYPE: 'nohup',
    NODE_PATH: nodePath,
    PROJECT_PATH: projectRoot,
    WRAPPER_PATH: wrapperPath,
    SERVICE_LOADED: !failure,
    FALLBACK: 'no_usable_systemd',
    STATUS: failure ? 'failed' : 'success',
    ...(failure ? { ERROR: 'service_start_failed' } : {}),
    LOG: 'logs/setup.log',
  });
  if (failure) throw new Error('NanoClaw failed to start; see logs/nanoclaw.error.log', { cause: failure });
}
