/**
 * Uninstall inventory scan — find every artifact this checkout created.
 *
 * Everything NanoClaw creates is tagged with the per-checkout install slug
 * (sha1(projectRoot)[:8]), so several copies can coexist on one machine.
 * The scan reports ONLY things belonging to the given project root; shared
 * tools (gateway applications, shell PATH lines, host-wide config) are never inventoried.
 *
 * External commands go through the injected `runCommand`
 * so tests can fake them; filesystem checks are real — tests use temp dirs.
 * A missing/down docker daemon degrades to an empty result plus a note with
 * manual cleanup commands; it never throws.
 *
 * Deliberately does NOT import src/config.ts (import-time side effects).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { getContainerImageBase, getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
export type RunCommand = (command: string, args: string[]) => { status: number | null; stdout: string };

export interface PathItem {
  /** Human label, e.g. "Database & conversations". */
  what: string;
  /** Display location (tilde-abbreviated). */
  where: string;
  /** Absolute path to remove. */
  path: string;
}

export interface ServiceInventory {
  launchdPlist?: string;
  systemdUserUnit?: string;
  systemdSystemUnit?: string;
  pidFile?: string;
  containerIds: string[];
  image?: string;
  nclSymlink?: string;
}

export interface Inventory {
  slug: string;
  projectRoot: string;
  containerRuntime: string;
  service: ServiceInventory;
  /** Group 2: app data, logs & secrets. */
  data: PathItem[];
  /**
   * dist/ + node_modules/ — displayed with the data group but removed dead
   * last: the uninstaller itself runs on tsx out of node_modules.
   */
  runtime: PathItem[];
  /** Group 3: groups/ and store/ — user content, unrecoverable. */
  user: PathItem[];
  /** add-iron-proxy's Iron Control database; removed with the data group. */
  ironControl?: IronControlInventory;
  notes: string[];
}

export interface IronControlInventory {
  project: string;
  containerIds: string[];
  /** Present only when the volume exists. */
  volume?: string;
  /** Present only when the network exists. */
  network?: string;
}

/**
 * The Compose project add-iron-proxy names after this install's slug (its
 * controlPaths(); a skill test pins the two together). Its database volume
 * is encrypted with keys kept in data/, so it cannot outlive that folder.
 */
export function ironControlProject(slug: string): string {
  return `nanoclaw-iron-control-${slug}`;
}

export interface ScanDeps {
  projectRoot: string;
  home: string;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}

export function tilde(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function scanInstall(deps: ScanDeps): Inventory {
  const { projectRoot, home, runCommand } = deps;
  const slug = getInstallSlug(projectRoot);
  const containerRuntime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const notes: string[] = [];

  const service = scanService(deps, slug, containerRuntime, notes);
  const ironControl = scanIronControl(runCommand, slug, containerRuntime, notes);

  const data = existingItems(projectRoot, home, [
    { rel: 'data', what: 'Database & conversations' },
    { rel: 'logs', what: 'Logs' },
    { rel: '.env', what: 'Secrets / API keys (.env)', where: 'backed up before removal' },
    { rel: 'start-nanoclaw.sh', what: 'Start script', where: 'start-nanoclaw.sh' },
    { rel: 'nanoclaw.pid', what: 'PID file', where: 'nanoclaw.pid' },
  ]);
  const updates = path.join(path.dirname(projectRoot), '.nanoclaw-updates', slug);
  if (fs.existsSync(updates)) {
    data.push({
      what: 'Update rollback snapshots',
      where: `${tilde(updates, home)}/`,
      path: updates,
    });
  }

  const runtime = existingItems(projectRoot, home, [
    { rel: 'dist', what: 'Build output' },
    { rel: 'node_modules', what: 'Installed dependencies' },
  ]);

  const user = existingItems(projectRoot, home, [
    { rel: 'groups', what: 'Agent memory & files' },
    { rel: 'store', what: 'Migrated data store' },
  ]);

  return {
    slug,
    projectRoot,
    containerRuntime,
    service,
    data,
    runtime,
    user,
    ...(ironControl ? { ironControl } : {}),
    notes,
  };
}

/**
 * Cheap existing-install probe for mid-setup detection: service registration
 * (per-platform) or a central DB. No external commands.
 */
export function detectExistingInstall(projectRoot: string): boolean {
  if (fs.existsSync(path.join(projectRoot, 'data', 'v2.db'))) return true;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return fs.existsSync(path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(projectRoot)}.plist`));
  }
  if (process.platform === 'linux') {
    const unit = getSystemdUnit(projectRoot);
    return (
      fs.existsSync(path.join(home, '.config', 'systemd', 'user', `${unit}.service`)) ||
      fs.existsSync(`/etc/systemd/system/${unit}.service`)
    );
  }
  return false;
}

function scanService(deps: ScanDeps, slug: string, containerRuntime: string, notes: string[]): ServiceInventory {
  const { projectRoot, home, platform, runCommand } = deps;
  const service: ServiceInventory = { containerIds: [] };

  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(projectRoot)}.plist`);
    if (fs.existsSync(plist)) service.launchdPlist = plist;
  } else if (platform === 'linux') {
    const unit = getSystemdUnit(projectRoot);
    const userUnit = path.join(home, '.config', 'systemd', 'user', `${unit}.service`);
    const systemUnit = `/etc/systemd/system/${unit}.service`;
    if (fs.existsSync(userUnit)) service.systemdUserUnit = userUnit;
    if (fs.existsSync(systemUnit)) service.systemdSystemUnit = systemUnit;
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (fs.existsSync(pidFile)) service.pidFile = pidFile;
  }

  // Container label matches what container-runner.ts stamps at spawn time.
  const installLabel = `nanoclaw-install=${slug}`;
  const image = `${getContainerImageBase(projectRoot)}:latest`;
  let runtimeOk = true;
  try {
    const ps = runCommand(containerRuntime, ['ps', '-aq', '--filter', `label=${installLabel}`]);
    if (ps.status === 0) {
      service.containerIds = ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean);
    } else {
      runtimeOk = false;
    }
  } catch {
    runtimeOk = false;
  }
  if (runtimeOk) {
    try {
      const inspect = runCommand(containerRuntime, ['image', 'inspect', image]);
      if (inspect.status === 0) service.image = image;
    } catch {
      runtimeOk = false;
    }
  }
  if (!runtimeOk) {
    notes.push(
      `Containers/image: '${containerRuntime}' unavailable; remove later with: ` +
        `${containerRuntime} ps -aq --filter label=${installLabel} | xargs -r ${containerRuntime} rm -f; ` +
        `${containerRuntime} rmi ${image}`,
    );
  }

  const link = path.join(home, '.local', 'bin', 'ncl');
  let linkStat: fs.Stats | null = null;
  try {
    linkStat = fs.lstatSync(link);
  } catch {
    linkStat = null;
  }
  if (linkStat?.isSymbolicLink()) {
    let target = fs.readlinkSync(link);
    if (!path.isAbsolute(target)) {
      target = path.resolve(path.dirname(link), target);
    }
    if (path.resolve(target) === path.join(projectRoot, 'bin', 'ncl')) {
      service.nclSymlink = link;
    } else {
      notes.push(`ncl command ${tilde(link, home)} points to another NanoClaw copy; left untouched.`);
    }
  }

  return service;
}

/** Only this install's project label and names; another copy's slug never matches. */
function scanIronControl(
  runCommand: RunCommand,
  slug: string,
  runtime: string,
  notes: string[],
): IronControlInventory | undefined {
  const project = ironControlProject(slug);
  const volume = `${project}_database`;
  try {
    const ps = runCommand(runtime, ['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]);
    if (ps.status !== 0) throw new Error('unavailable');
    const inventory: IronControlInventory = {
      project,
      containerIds: ps.stdout
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean),
    };
    if (runCommand(runtime, ['volume', 'inspect', volume]).status === 0) inventory.volume = volume;
    if (runCommand(runtime, ['network', 'inspect', project]).status === 0) inventory.network = project;
    return inventory.containerIds.length || inventory.volume || inventory.network ? inventory : undefined;
  } catch {
    notes.push(
      `Iron Control (if installed): '${runtime}' unavailable; remove later with: ` +
        `${runtime} ps -aq --filter label=com.docker.compose.project=${project} | xargs -r ${runtime} rm -f; ` +
        `${runtime} volume rm ${volume}; ${runtime} network rm ${project}`,
    );
    return undefined;
  }
}

function existingItems(
  projectRoot: string,
  home: string,
  specs: { rel: string; what: string; where?: string }[],
): PathItem[] {
  const items: PathItem[] = [];
  for (const spec of specs) {
    const p = path.join(projectRoot, spec.rel);
    if (!fs.existsSync(p)) continue;
    items.push({
      what: spec.what,
      where: spec.where ?? `${tilde(p, home)}/`,
      path: p,
    });
  }
  return items;
}
