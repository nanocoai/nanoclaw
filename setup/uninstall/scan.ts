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
import { createHash } from 'node:crypto';
import os from 'os';
import path from 'path';

import { getContainerImageBase, getInstallSlug, getLaunchdLabel, getSystemdUnit } from '../../src/install-slug.js';
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
  /** Exact checkout-owned host processes, or undefined when `ps` was unavailable. */
  hostProcessIds?: number[];
  containerRuntimeAvailable?: boolean;
  containerIds: string[];
  image?: string;
  nclSymlink?: string;
  imageIdentity?: string;
}

export interface InventoryIdentity {
  root: string;
  exactPaths: Record<string, string>;
  scopedRoots: Record<string, string>;
  containerSelector: string;
}

export interface OnecliInventory {
  mine: VaultAgent[];
  orphans: VaultAgent[];
  /** False when the OneCLI inventory could not be inspected at all. */
  available: boolean;
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
  /** Credential backups created by earlier/current uninstalls; never removed here. */
  envBackups: PathItem[];
  /** Legacy backups left inside the checkout; these block safe checkout removal. */
  legacyEnvBackups?: PathItem[];
  /** Secure external backup directory used by the removal plan. */
  credentialBackupRoot?: string;
  onecli: OnecliInventory;
  notes: string[];
  identity?: InventoryIdentity;
}

export interface ScanDeps {
  projectRoot: string;
  home: string;
  platform: NodeJS.Platform;
  runCommand: RunCommand;
}

/**
 * Credential backups live outside the checkout so deleting the checkout cannot
 * delete the only copy of the user's credentials.
 */
export function credentialBackupRoot(home: string, platform: NodeJS.Platform, slug: string): string {
  const root =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support', 'NanoClaw', 'uninstall-backups')
      : path.join(process.env.XDG_STATE_HOME || path.join(home, '.local', 'state'), 'nanoclaw', 'uninstall-backups');
  return path.join(root, slug);
}

export function tilde(p: string, home: string): string {
  return p.startsWith(home) ? `~${p.slice(home.length)}` : p;
}

export function scanInstall(deps: ScanDeps): Inventory {
  const { projectRoot, home, platform, runCommand } = deps;
  const slug = getInstallSlug(projectRoot);
  const containerRuntime = process.env.CONTAINER_RUNTIME ?? 'docker';
  const notes: string[] = [];

  const service = scanService(deps, slug, containerRuntime, notes);
  const backupRoot = credentialBackupRoot(home, platform, slug);

  const data = existingItems(projectRoot, home, [
    { rel: 'data', what: 'Database & conversations' },
    { rel: 'logs', what: 'Logs' },
    { rel: '.env', what: 'Secrets / API keys (.env)', where: 'backed up before removal' },
    { rel: 'start-nanoclaw.sh', what: 'Start script', where: 'start-nanoclaw.sh' },
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
  const envBackups = existingEnvBackups(backupRoot, home);
  const legacyEnvBackups = existingEnvBackups(projectRoot, home).filter(
    (item) => path.dirname(item.path) === projectRoot,
  );
  if (legacyEnvBackups.length > 0) {
    notes.push(
      `Legacy credential backup(s) remain inside the checkout: ${legacyEnvBackups.map((item) => item.path).join(', ')}.`,
    );
  }

  const onecli = scanOnecli(projectRoot, runCommand, notes);

  return {
    slug,
    projectRoot,
    containerRuntime,
    service,
    data,
    runtime,
    user,
    envBackups,
    legacyEnvBackups,
    credentialBackupRoot: backupRoot,
    onecli,
    notes,
    identity: {
      root: pathIdentity(projectRoot) ?? '',
      exactPaths: Object.fromEntries(
        [
          service.launchdPlist,
          service.systemdUserUnit,
          service.systemdSystemUnit,
          service.pidFile,
          service.nclSymlink,
          ...[...data, ...runtime, ...user].map((item) => item.path),
        ]
          .filter((value): value is string => Boolean(value))
          .map((value) => [value, pathIdentity(value) ?? '']),
      ),
      scopedRoots: Object.fromEntries(
        [...data, ...runtime, ...user]
          .filter((item) => {
            try {
              return fs.lstatSync(item.path).isDirectory();
            } catch {
              return false;
            }
          })
          .map((item) => [item.path, pathIdentity(item.path) ?? '']),
      ),
      containerSelector: `nanoclaw-install=${slug}`,
    },
  };
}

function existingEnvBackups(projectRoot: string, home: string): PathItem[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(projectRoot).filter((name) => /^\.env\.bak(?:\.|$)/.test(name));
  } catch {
    return [];
  }
  return names.sort().map((name) => {
    const backupPath = path.join(projectRoot, name);
    return {
      what: 'Credential backup',
      where: tilde(backupPath, home),
      path: backupPath,
    };
  });
}

/** Identity for exact filesystem artifacts; directories are ownership roots. */
export function pathIdentity(target: string): string | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return undefined;
  }

  if (stat.isSymbolicLink()) {
    try {
      return `symlink:${fs.readlinkSync(target)}`;
    } catch {
      return undefined;
    }
  }
  if (!stat.isFile()) return `node:${stat.dev}:${stat.ino}:${stat.mode}`;

  const noFollow = (fs.constants as typeof fs.constants & { O_NOFOLLOW?: number }).O_NOFOLLOW;
  if (noFollow === undefined) return undefined;
  let fd: number | undefined;
  try {
    fd = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) return undefined;
    const digest = createHash('sha256').update(fs.readFileSync(fd)).digest('hex');
    return `file:${opened.dev}:${opened.ino}:${digest}`;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/**
 * Cheap existing-install probe for mid-setup detection: service registration
 * (per-platform) or a central DB. No docker or onecli calls.
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

  service.hostProcessIds = checkoutHostProcesses(runCommand, path.join(projectRoot, 'dist', 'index.js'));
  if (!service.hostProcessIds) {
    notes.push(
      'Host processes: could not inspect the process list; no process will be signalled without a fresh exact match.',
    );
  }

  if (platform === 'darwin') {
    const plist = path.join(home, 'Library', 'LaunchAgents', `${getLaunchdLabel(projectRoot)}.plist`);
    if (knownPath(plist)) service.launchdPlist = plist;
  } else if (platform === 'linux') {
    const unit = getSystemdUnit(projectRoot);
    const userUnit = path.join(home, '.config', 'systemd', 'user', `${unit}.service`);
    const systemUnit = `/etc/systemd/system/${unit}.service`;
    if (knownPath(userUnit)) service.systemdUserUnit = userUnit;
    if (knownPath(systemUnit)) service.systemdSystemUnit = systemUnit;
    const pidFile = path.join(projectRoot, 'nanoclaw.pid');
    if (knownPath(pidFile)) service.pidFile = pidFile;
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
      if (inspect.status === 0) {
        service.image = image;
        service.imageIdentity = inspect.stdout.trim() || undefined;
      }
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
  service.containerRuntimeAvailable = runtimeOk;

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

/** Exact host argv shape used both by inventory and immediately before signalling. */
export function isNanoclawHostCommand(command: string, scriptPath: string): boolean {
  const suffix = ` ${scriptPath}`;
  if (!command.endsWith(suffix)) return false;
  const executable = command.slice(0, -suffix.length);
  return !/\s/.test(executable) && ['node', 'nodejs'].includes(path.basename(executable));
}

export function checkoutHostProcesses(runCommand: RunCommand, scriptPath: string): number[] | undefined {
  const result = runCommand('ps', ['-axo', 'pid=,command=']);
  if (result.status !== 0) return undefined;
  const pids: number[] = [];
  for (const line of result.stdout.split('\n')) {
    const match = line.match(/^\s*(\d+)\s+(.+)$/);
    if (!match || !isNanoclawHostCommand(match[2], scriptPath)) continue;
    const pid = Number(match[1]);
    if (Number.isInteger(pid) && pid > 0) pids.push(pid);
  }
  return pids;
}

function scanOnecli(projectRoot: string, runCommand: RunCommand, notes: string[]): OnecliInventory {
  const vault = listVaultAgents(runCommand);
  if (!vault.available) {
    notes.push(
      "Couldn't inspect OneCLI agents; agents registered by this copy may remain. Restore OneCLI and rerun uninstall before deleting the checkout.",
    );
    return { mine: [], orphans: [], available: false, idsKnown: false };
  }
  if (vault.agents.length === 0) {
    return { mine: [], orphans: [], available: true, idsKnown: false };
  }

  const { ids, known } = readAgentGroupIds(path.join(projectRoot, 'data', 'v2.db'));
  const { mine, orphans } = splitVaultAgents(vault.agents, ids, known);
  if (!known && orphans.length > 0) {
    notes.push(
      "Couldn't read agent_groups from data/v2.db; OneCLI agents shown as 'orphan' may actually belong to this copy.",
    );
  }
  return { mine, orphans, available: true, idsKnown: known };
}

function existingItems(
  projectRoot: string,
  home: string,
  specs: { rel: string; what: string; where?: string }[],
): PathItem[] {
  const items: PathItem[] = [];
  for (const spec of specs) {
    const p = path.join(projectRoot, spec.rel);
    if (!knownPath(p)) continue;
    items.push({
      what: spec.what,
      where: spec.where ?? `${tilde(p, home)}/`,
      path: p,
    });
  }
  return items;
}

/** Treat only a confirmed ENOENT as absence; permission and type errors are known residue. */
function knownPath(target: string): boolean {
  try {
    fs.lstatSync(target);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}
