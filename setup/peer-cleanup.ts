/**
 * Detect and clean up unhealthy NanoClaw peer services.
 *
 * Runs as a setup preflight before we install our own service. A crash-looping
 * peer install (typically the legacy v1 `com.nanoclaw` plist) silently trashes
 * this install's containers on every respawn because its `cleanupOrphans()`
 * reaps anything matching `nanoclaw-`. We scope our reaper by label now, but
 * we still need to stop the peer from killing us on its way down.
 *
 * A peer is "unhealthy" when:
 *   - launchd: `state != running` AND `runs > UNHEALTHY_RUNS_THRESHOLD`
 *   - systemd: unit is in `failed` state, OR `activating` with many restarts
 *
 * Separately, a peer registration is "dead" when the program it launches no
 * longer exists on disk — almost always a deleted test checkout or worktree.
 * The service manager keeps retrying the missing binary forever, and the
 * health probes can't see it because an unloaded/inactive job doesn't report
 * via `launchctl print` / `systemctl show`. Deleting an install's folder
 * without running the uninstaller leaves these behind, so they accumulate. We
 * unload and delete the orphaned config file outright.
 *
 * Healthy peers are left alone — multiple installs can coexist fine now that
 * container-reaper is label-scoped.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel, getSystemdUnit } from '../src/install-slug.js';
import { log } from '../src/log.js';

const UNHEALTHY_RUNS_THRESHOLD = 10;

export interface PeerStatus {
  label: string;
  configPath: string;
  state: string;
  runs: number;
  unhealthy: boolean;
}

export interface PeerCleanupResult {
  checked: PeerStatus[];
  unloaded: PeerStatus[];
  removed: Array<{ label: string; configPath: string }>;
  failures: Array<{ label: string; err: string }>;
}

/**
 * Scan for peer NanoClaw services and unload any that are crash-looping.
 * Returns a summary suitable for emitStatus / setup-log reporting.
 */
export function cleanupUnhealthyPeers(projectRoot: string = process.cwd()): PeerCleanupResult {
  const platform = os.platform();
  if (platform === 'darwin') {
    return cleanupLaunchdPeers(projectRoot);
  }
  if (platform === 'linux') {
    return cleanupSystemdPeers(projectRoot);
  }
  return { checked: [], unloaded: [], removed: [], failures: [] };
}

/**
 * Unload a dead peer's job (best-effort) and delete its orphaned config file.
 * `unload` runs first and may throw harmlessly when the job isn't loaded or the
 * service-manager binary is absent (e.g. exercising launchd cleanup on Linux).
 */
function reapDeadPeer(
  result: PeerCleanupResult,
  peer: { label: string; configPath: string },
  unload: () => void,
  kind: string,
  missingTarget: string,
): void {
  try {
    unload();
  } catch {
    /* job not loaded — nothing to unload */
  }
  try {
    fs.rmSync(peer.configPath, { force: true });
    log.info(`Removed dead peer ${kind}`, {
      label: peer.label,
      configPath: peer.configPath,
      missingTarget,
    });
    result.removed.push(peer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to remove dead peer ${kind}`, { label: peer.label, err: message });
    result.failures.push({ label: peer.label, err: message });
  }
}

// ---- launchd (macOS) --------------------------------------------------------

function cleanupLaunchdPeers(projectRoot: string): PeerCleanupResult {
  const ownLabel = getLaunchdLabel(projectRoot);
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const result: PeerCleanupResult = { checked: [], unloaded: [], removed: [], failures: [] };

  let plists: string[];
  try {
    plists = fs
      .readdirSync(agentsDir)
      .filter((f) => /^com\.nanoclaw.*\.plist$/.test(f))
      .map((f) => path.join(agentsDir, f));
  } catch {
    return result;
  }

  const uid = process.getuid?.() ?? 0;

  for (const plistPath of plists) {
    const label = path.basename(plistPath, '.plist');
    if (label === ownLabel) continue;

    const missingTarget = deadLaunchdTarget(plistPath);
    if (missingTarget) {
      reapDeadPeer(
        result,
        { label, configPath: plistPath },
        // Best-effort unload in case launchd still has it registered; throwing
        // (not loaded, or launchctl absent off-macOS) is expected and ignored.
        () => execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' }),
        'launchd plist',
        missingTarget,
      );
      continue;
    }

    const status = probeLaunchdPeer(label, plistPath, uid);
    if (!status) continue;
    result.checked.push(status);

    if (!status.unhealthy) continue;

    try {
      execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' });
      log.info('Unloaded unhealthy peer launchd service', {
        label,
        state: status.state,
        runs: status.runs,
        plistPath,
      });
      result.unloaded.push(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to unload peer launchd service', { label, err: message });
      result.failures.push({ label, err: message });
    }
  }

  return result;
}

function probeLaunchdPeer(label: string, plistPath: string, uid: number): PeerStatus | null {
  let output: string;
  try {
    output = execFileSync('launchctl', ['print', `gui/${uid}/${label}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf-8',
    });
  } catch {
    // Not loaded → not currently a threat. Skip silently.
    return null;
  }

  const state = /^\s*state\s*=\s*(.+?)\s*$/m.exec(output)?.[1] ?? 'unknown';
  const runsStr = /^\s*runs\s*=\s*(\d+)/m.exec(output)?.[1];
  const runs = runsStr ? parseInt(runsStr, 10) : 0;

  const unhealthy = state !== 'running' && runs > UNHEALTHY_RUNS_THRESHOLD;
  return { label, configPath: plistPath, state, runs, unhealthy };
}

/**
 * Returns the program path a launchd plist launches when that program no longer
 * exists on disk (a dead registration), or undefined when the plist is
 * unreadable, has an unrecognized shape, or its target still exists — in which
 * case the plist must not be touched.
 */
function deadLaunchdTarget(plistPath: string): string | undefined {
  let xml: string;
  try {
    xml = fs.readFileSync(plistPath, 'utf-8');
  } catch {
    return undefined;
  }
  // ProgramArguments is [nodePath, "<projectRoot>/dist/index.js"]; the host
  // entry point is the stable marker to match on.
  const target = /<string>([^<]*\/dist\/index\.js)<\/string>/.exec(xml)?.[1];
  if (!target) return undefined;
  return fs.existsSync(target) ? undefined : target;
}

// ---- systemd (Linux) --------------------------------------------------------

function cleanupSystemdPeers(projectRoot: string): PeerCleanupResult {
  const ownUnit = getSystemdUnit(projectRoot);
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const result: PeerCleanupResult = { checked: [], unloaded: [], removed: [], failures: [] };

  let units: string[];
  try {
    units = fs
      .readdirSync(unitDir)
      .filter((f) => /^nanoclaw.*\.service$/.test(f))
      .map((f) => f.replace(/\.service$/, ''));
  } catch {
    return result;
  }

  for (const unit of units) {
    if (unit === ownUnit) continue;

    const unitPath = path.join(unitDir, `${unit}.service`);
    const missingTarget = deadSystemdTarget(unitPath);
    if (missingTarget) {
      reapDeadPeer(
        result,
        { label: unit, configPath: unitPath },
        () => {
          execFileSync('systemctl', ['--user', 'disable', '--now', `${unit}.service`], { stdio: 'pipe' });
          execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
        },
        'systemd unit',
        missingTarget,
      );
      continue;
    }

    const status = probeSystemdPeer(unit);
    if (!status) continue;
    result.checked.push(status);

    if (!status.unhealthy) continue;

    try {
      execFileSync('systemctl', ['--user', 'disable', '--now', `${unit}.service`], { stdio: 'pipe' });
      log.info('Disabled unhealthy peer systemd unit', {
        unit,
        state: status.state,
        runs: status.runs,
      });
      result.unloaded.push(status);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn('Failed to disable peer systemd unit', { unit, err: message });
      result.failures.push({ label: unit, err: message });
    }
  }

  return result;
}

function probeSystemdPeer(unit: string): PeerStatus | null {
  const unitPath = path.join(os.homedir(), '.config', 'systemd', 'user', `${unit}.service`);
  try {
    const output = execFileSync(
      'systemctl',
      ['--user', 'show', '--property=ActiveState,NRestarts', `${unit}.service`],
      { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const activeState = /^ActiveState=(.+)$/m.exec(output)?.[1]?.trim() ?? 'unknown';
    const restartsStr = /^NRestarts=(\d+)/m.exec(output)?.[1];
    const runs = restartsStr ? parseInt(restartsStr, 10) : 0;

    const unhealthy =
      activeState === 'failed' || (activeState !== 'active' && runs > UNHEALTHY_RUNS_THRESHOLD);
    return { label: unit, configPath: unitPath, state: activeState, runs, unhealthy };
  } catch {
    return null;
  }
}

/**
 * Returns the program path a systemd unit launches when that program no longer
 * exists on disk (a dead registration), or undefined when the unit is
 * unreadable, has an unrecognized shape, or its target still exists.
 */
function deadSystemdTarget(unitPath: string): string | undefined {
  let unit: string;
  try {
    unit = fs.readFileSync(unitPath, 'utf-8');
  } catch {
    return undefined;
  }
  // ExecStart=<nodePath> <projectRoot>/dist/index.js
  const target = /^ExecStart=\S+\s+(\S+\/dist\/index\.js)\s*$/m.exec(unit)?.[1];
  if (!target) return undefined;
  return fs.existsSync(target) ? undefined : target;
}
