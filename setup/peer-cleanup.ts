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
 * container-reaper is label-scoped. The exception is a service setup wrote for
 * this same checkout under another name, left behind when NANOCLAW_INSTALL_ID
 * changes: one checkout runs one host, so it is retired like a dead one. That
 * includes setup's system unit when we run as root; a normal user gets the sudo
 * command. Hand-written services are left alone.
 */
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getLaunchdLabel, getSystemdUnit, INSTALL_ID_PATTERN } from '../src/install-slug.js';
import { log } from '../src/log.js';
import { isRoot } from './platform.js';

const UNHEALTHY_RUNS_THRESHOLD = 10;
const SYSTEM_UNIT_DIR = '/etc/systemd/system';

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
  retired: Array<{ label: string; configPath: string }>;
  failures: Array<{ label: string; err: string }>;
}

/**
 * Scan for peer NanoClaw services and unload any that are crash-looping.
 * Returns a summary suitable for emitStatus / setup-log reporting.
 */
export function cleanupUnhealthyPeers(
  projectRoot: string = process.cwd(),
  systemUnitDir: string = SYSTEM_UNIT_DIR,
): PeerCleanupResult {
  const platform = os.platform();
  if (platform === 'darwin') {
    return cleanupLaunchdPeers(projectRoot);
  }
  if (platform === 'linux') {
    const result = cleanupSystemdPeers(projectRoot);
    retireSystemUnits(projectRoot, systemUnitDir, result);
    return result;
  }
  return { checked: [], unloaded: [], removed: [], retired: [], failures: [] };
}

/**
 * Unload a peer's job (best-effort) and delete its config file: a dead one
 * (`missingTarget` set) or another name for this checkout. `unload` runs first
 * and may throw harmlessly when the job isn't loaded or the service-manager
 * binary is absent (e.g. exercising launchd cleanup on Linux).
 */
function reapPeer(
  result: PeerCleanupResult,
  peer: { label: string; configPath: string },
  unload: () => void,
  kind: string,
  missingTarget?: string,
  mayStillRun?: (unloadError: unknown) => boolean,
): void {
  const what = missingTarget ? `dead peer ${kind}` : `${kind} that also starts this checkout`;
  let unloadError: unknown;
  try {
    unload();
  } catch (err) {
    unloadError = err; // usually: job not loaded — nothing to unload
  }
  // A live peer not confirmed stopped keeps its file, so it can still be stopped.
  // A dead one has no program to run, so its file goes either way.
  if (!missingTarget && mayStillRun?.(unloadError)) {
    log.warn(`Could not stop ${what}; kept its file`, { label: peer.label, configPath: peer.configPath });
    result.failures.push({ label: peer.label, err: 'not confirmed stopped' });
    return;
  }
  try {
    fs.rmSync(peer.configPath, { force: true });
    log.info(`Removed ${what}`, {
      label: peer.label,
      configPath: peer.configPath,
      ...(missingTarget ? { missingTarget } : {}),
    });
    (missingTarget ? result.removed : result.retired).push(peer);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`Failed to remove ${what}`, { label: peer.label, err: message });
    result.failures.push({ label: peer.label, err: message });
  }
}

// ---- launchd (macOS) --------------------------------------------------------

function cleanupLaunchdPeers(projectRoot: string): PeerCleanupResult {
  const ownLabel = getLaunchdLabel(projectRoot);
  const entry = path.join(projectRoot, 'dist', 'index.js');
  const agentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const result: PeerCleanupResult = { checked: [], unloaded: [], removed: [], retired: [], failures: [] };

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
    if (missingTarget || (isSetupName(label, 'com.nanoclaw-v2-') && launchdStartsEntry(plistPath, entry))) {
      reapPeer(
        result,
        { label, configPath: plistPath },
        // Best-effort unload in case launchd still has it registered; throwing
        // (not loaded, or launchctl absent off-macOS) is expected and ignored.
        () => execFileSync('launchctl', ['unload', plistPath], { stdio: 'pipe' }),
        'launchd plist',
        missingTarget,
        () => launchdLoaded(label, uid),
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
  const entry = path.join(projectRoot, 'dist', 'index.js');
  const unitDir = path.join(os.homedir(), '.config', 'systemd', 'user');
  const result: PeerCleanupResult = { checked: [], unloaded: [], removed: [], retired: [], failures: [] };

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
    if (missingTarget || (isSetupName(unit, 'nanoclaw-v2-') && systemdStartsEntry(unitPath, entry))) {
      reapPeer(
        result,
        { label: unit, configPath: unitPath },
        () => {
          execFileSync('systemctl', ['--user', 'disable', '--now', `${unit}.service`], { stdio: 'pipe' });
          execFileSync('systemctl', ['--user', 'daemon-reload'], { stdio: 'pipe' });
        },
        'systemd unit',
        missingTarget,
        systemdMayStillRun,
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

    const unhealthy = activeState === 'failed' || (activeState !== 'active' && runs > UNHEALTHY_RUNS_THRESHOLD);
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

/**
 * Setup run as root writes its unit here. An old one for this checkout is
 * retired like a user unit; a normal user cannot stop it, so it gets the sudo
 * command. Dead and unhealthy system units may belong to other installs, so
 * they are left alone.
 */
function retireSystemUnits(projectRoot: string, unitDir: string, result: PeerCleanupResult): void {
  const ownUnit = getSystemdUnit(projectRoot);
  const entry = path.join(projectRoot, 'dist', 'index.js');
  let files: string[];
  try {
    files = fs.readdirSync(unitDir).filter((f) => f.endsWith('.service'));
  } catch {
    return;
  }

  for (const file of files) {
    const unit = file.slice(0, -'.service'.length);
    const unitPath = path.join(unitDir, file);
    if (unit === ownUnit || !isSetupName(unit, 'nanoclaw-v2-') || !systemdStartsEntry(unitPath, entry)) continue;

    if (!isRoot()) {
      const fix = `sudo systemctl disable --now ${file} && sudo rm ${unitPath} && sudo systemctl daemon-reload`;
      log.warn(`An old system unit also starts this checkout. To stop it, run: ${fix}`, {
        label: unit,
        configPath: unitPath,
        fix,
      });
      continue;
    }
    reapPeer(
      result,
      { label: unit, configPath: unitPath },
      () => {
        execFileSync('systemctl', ['disable', '--now', file], { stdio: 'pipe' });
        execFileSync('systemctl', ['daemon-reload'], { stdio: 'pipe' });
      },
      'system unit',
      undefined,
      // Only a successful disable counts: systemctl missing from root's PATH is not proof.
      (disableError) => disableError !== undefined,
    );
  }
}

// ---- same checkout under another name ----------------------------------------

/** Setup writes `<prefix><slug>` only; other names were written by hand. */
function isSetupName(name: string, prefix: string): boolean {
  return name.startsWith(prefix) && INSTALL_ID_PATTERN.test(name.slice(prefix.length));
}

/** ProgramArguments holds the entry point as its own <string>. */
function launchdStartsEntry(plistPath: string, entry: string): boolean {
  return readConfig(plistPath)?.includes(`<string>${entry}</string>`) ?? false;
}

/** ExecStart=<nodePath> <entry>; the leading space keeps the match exact. */
function systemdStartsEntry(unitPath: string, entry: string): boolean {
  return (readConfig(unitPath) ?? '')
    .split('\n')
    .some((line) => line.startsWith('ExecStart=') && line.trimEnd().endsWith(` ${entry}`));
}

function launchdLoaded(label: string, uid: number): boolean {
  try {
    execFileSync('launchctl', ['print', `gui/${uid}/${label}`], { stdio: 'pipe' });
    return true;
  } catch (err) {
    return !confirmsStopped(err, [113]); // 113: no such service
  }
}

/** `disable --now` waits for the stop, so only its success (or no systemd at all) proves it. */
function systemdMayStillRun(disableError: unknown): boolean {
  return disableError !== undefined && !confirmsStopped(disableError, []);
}

/** Only these exit codes, or no service manager at all, prove it stopped; no bus or no permission does not. */
function confirmsStopped(err: unknown, stoppedStatus: number[]): boolean {
  const { code, status } = err as { code?: string; status?: number | null };
  return code === 'ENOENT' || (typeof status === 'number' && stoppedStatus.includes(status));
}

function readConfig(configPath: string): string | undefined {
  try {
    return fs.readFileSync(configPath, 'utf-8');
  } catch {
    return undefined;
  }
}
