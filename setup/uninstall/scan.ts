/**
 * Uninstall inventory scan — find every artifact this checkout created.
 *
 * Everything NanoClaw creates is tagged with the per-checkout install slug
 * (sha1(projectRoot)[:8]), so several copies can coexist on one machine.
 * The scan reports ONLY things belonging to the given project root; shared
 * tools (the OneCLI app/vault, shell PATH lines, host-wide config) are
 * never inventoried.
 *
 * External commands (docker, onecli) go through the injected `runCommand`
 * so tests can fake them; filesystem checks are real — tests use temp dirs.
 * A missing/down docker daemon degrades to an empty result plus a note with
 * manual cleanup commands; it never throws.
 *
 * Deliberately does NOT import src/config.ts (import-time side effects).
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import {
  getContainerImageBase,
  getInstallSlug,
  getLaunchdLabel,
  getSystemdUnit,
} from '../../src/install-slug.js';
import {
  listVaultAgents,
  readAgentGroupIds,
  splitVaultAgents,
  type RunCommand,
  type VaultAgent,
} from './onecli-agents.js';

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

export interface OnecliInventory {
  mine: VaultAgent[];
  orphans: VaultAgent[];
  /** False when agent_groups couldn't be read — orphan labels are then unreliable. */
  idsKnown: boolean;
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
  onecli: OnecliInventory;
  notes: string[];
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

  const data = existingItems(projectRoot, home, [
    { rel: 'data', what: 'Database & conversations' },
    { rel: 'logs', what: 'Logs' },
    { rel: '.env', what: 'Secrets / API keys (.env)', where: 'backed up before removal' },
    { rel: 'start-nanoclaw.sh', what: 'Start script', where: 'start-nanoclaw.sh' },
    { rel: 'nanoclaw.pid', what: 'PID file', where: 'nanoclaw.pid' },
  ]);

  const runtime = existingItems(projectRoot, home, [
    { rel: 'dist', what: 'Build output' },
    { rel: 'node_modules', what: 'Installed dependencies' },
  ]);

  const user = existingItems(projectRoot, home, [
    { rel: 'groups', what: 'Agent memory & files' },
    { rel: 'store', what: 'Migrated data store' },
  ]);

  const onecli = scanOnecli(projectRoot, runCommand, notes);

  return {
    slug,
    projectRoot,
    containerRuntime,
    service,
    data,
    runtime,
    user,
    onecli,
    notes,
  };
}

/**
 * Cheap existing-install probe for mid-setup detection: service registration
 * (per-platform) or a central DB. No docker or onecli calls.
 */
export function detectExistingInstall(projectRoot: string): boolean {
  if (fs.existsSync(path.join(projectRoot, 'data', 'v2.db'))) return true;
  const home = os.homedir();
  if (process.platform === 'darwin') {
    return fs.existsSync(
      path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(projectRoot)}.plist`),
    );
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

function scanService(
  deps: ScanDeps,
  slug: string,
  containerRuntime: string,
  notes: string[],
): ServiceInventory {
  const { projectRoot, home, platform, runCommand } = deps;
  const service: ServiceInventory = { containerIds: [] };

  if (platform === 'darwin') {
    const plist = path.join(
      home,
      'Library',
      'LaunchAgents',
      `${getLaunchdLabel(projectRoot)}.plist`,
    );
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
    const ps = runCommand(containerRuntime, [
      'ps',
      '-aq',
      '--filter',
      `label=${installLabel}`,
    ]);
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
      notes.push(
        `ncl command ${tilde(link, home)} points to another NanoClaw copy; left untouched.`,
      );
    }
  }

  return service;
}

function scanOnecli(
  projectRoot: string,
  runCommand: RunCommand,
  notes: string[],
): OnecliInventory {
  const vault = listVaultAgents(runCommand);
  if (!vault.available || vault.agents.length === 0) {
    return { mine: [], orphans: [], idsKnown: false };
  }

  const { ids, known } = readAgentGroupIds(path.join(projectRoot, 'data', 'v2.db'));
  const { mine, orphans } = splitVaultAgents(vault.agents, ids, known);
  if (!known && orphans.length > 0) {
    notes.push(
      "Couldn't read agent_groups from data/v2.db; OneCLI agents shown as 'orphan' may actually belong to this copy.",
    );
  }
  return { mine, orphans, idsKnown: known };
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
