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
  /**
   * Volumes and networks of the Compose projects this copy's labeled
   * containers belong to; removed with the data group.
   */
  projects?: ProjectInventory;
  notes: string[];
}

export interface ProjectInventory {
  /** Compose project names, from the containers carrying this copy's install label. */
  names: string[];
  volumes: string[];
  networks: string[];
}

/** The label Compose stamps on every container, volume and network of a project. */
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project';

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
  const projects = scanProjects(runCommand, slug, containerRuntime, notes);

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
    ...(projects ? { projects } : {}),
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

/** Non-empty trimmed stdout lines, or null when the runtime did not answer. */
function listLines(runCommand: RunCommand, runtime: string, args: string[]): string[] | null {
  let res: { status: number | null; stdout: string };
  try {
    res = runCommand(runtime, args);
  } catch {
    return null;
  }
  if (res.status !== 0) return null;
  return res.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * A project's containers with their install label, from one listing so the
 * ownership verdict and the ids it covers cannot drift apart. An unlabeled
 * container shows as an empty slug, never as a missing line.
 */
function projectMembers(
  runCommand: RunCommand,
  runtime: string,
  project: string,
): { id: string; slug: string }[] | null {
  const lines = listLines(runCommand, runtime, [
    'ps',
    '-a',
    '--filter',
    `label=${COMPOSE_PROJECT_LABEL}=${project}`,
    '--format',
    '{{.ID}}|{{.Label "nanoclaw-install"}}',
  ]);
  if (!lines) return null;
  return lines.map((line) => {
    const [id, slug = ''] = line.split('|');
    return { id, slug };
  });
}

/**
 * Compose projects owned outright by this copy: every container of the
 * project carries its install label. A project with a container labeled for
 * another copy, or for none, is shared and never selected. Null when the
 * runtime did not answer, so a failed lookup is never read as "nothing there".
 */
export function listOwnedProjects(runCommand: RunCommand, runtime: string, slug: string): string[] | null {
  const labels = listLines(runCommand, runtime, [
    'ps',
    '-a',
    '--filter',
    `label=nanoclaw-install=${slug}`,
    '--format',
    `{{.Label "${COMPOSE_PROJECT_LABEL}"}}`,
  ]);
  if (!labels) return null;
  const owned: string[] = [];
  for (const project of [...new Set(labels)].sort()) {
    const members = projectMembers(runCommand, runtime, project);
    if (!members) return null;
    if (members.every((m) => m.slug === slug)) owned.push(project);
  }
  return owned;
}

export interface ProjectResidue {
  /** False once any container of the project carries another copy's label, or none. */
  owned: boolean;
  containerIds: string[];
  volumes: string[];
  networks: string[];
}

/** A project's containers, volumes and networks by its Compose label; null when a listing failed. */
export function listProjectResidue(
  runCommand: RunCommand,
  runtime: string,
  slug: string,
  project: string,
): ProjectResidue | null {
  const filter = `label=${COMPOSE_PROJECT_LABEL}=${project}`;
  const members = projectMembers(runCommand, runtime, project);
  const volumes = listLines(runCommand, runtime, ['volume', 'ls', '-q', '--filter', filter]);
  const networks = listLines(runCommand, runtime, ['network', 'ls', '--filter', filter, '--format', '{{.Name}}']);
  if (!members || !volumes || !networks) return null;
  return {
    owned: members.every((m) => m.slug === slug),
    containerIds: members.map((m) => m.id),
    volumes,
    networks,
  };
}

/** One pasteable line per project; `;` so an empty listing doesn't skip the rest. */
export function projectCleanup(runtime: string, project: string): string {
  const filter = `--filter label=${COMPOSE_PROJECT_LABEL}=${project}`;
  return (
    `${runtime} ps -aq ${filter} | xargs -r ${runtime} rm -f; ` +
    `${runtime} volume ls -q ${filter} | xargs -r ${runtime} volume rm; ` +
    `${runtime} network ls -q ${filter} | xargs -r ${runtime} network rm`
  );
}

function scanProjects(
  runCommand: RunCommand,
  slug: string,
  runtime: string,
  notes: string[],
): ProjectInventory | undefined {
  const names = listOwnedProjects(runCommand, runtime, slug);
  if (!names) {
    notes.push(
      `Service volumes/networks: '${runtime}' unavailable; for each project of this copy's containers ` +
        `(${runtime} ps -a --filter label=nanoclaw-install=${slug} --format '{{.Label "${COMPOSE_PROJECT_LABEL}"}}') ` +
        `remove later with: ${projectCleanup(runtime, '<project>')}`,
    );
    return undefined;
  }
  const found: ProjectInventory = { names: [], volumes: [], networks: [] };
  for (const project of names) {
    const residue = listProjectResidue(runCommand, runtime, slug, project);
    if (!residue) {
      notes.push(
        `Project ${project}: '${runtime}' listing failed; remove later with: ${projectCleanup(runtime, project)}`,
      );
      continue;
    }
    if (residue.volumes.length === 0 && residue.networks.length === 0) continue;
    found.names.push(project);
    found.volumes.push(...residue.volumes);
    found.networks.push(...residue.networks);
  }
  return found.names.length > 0 ? found : undefined;
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
