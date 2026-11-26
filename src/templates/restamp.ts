/**
 * In-place plugin update for an already-stamped agent group.
 *
 * The plugin (including its NanoClaw extension) is the source of truth for
 * every surface it stamps: plugin files, the skills overlay, plugin-owned MCP
 * servers, persona, context extras, and tasks. Restamping resets those to the
 * new template version. Everything else — memory, workspace files the plugin
 * never shipped, plugin-data/, user-added MCP servers, wiring, sessions — is
 * never touched.
 *
 * Drift detection needs no bookkeeping: the previous plugin copy still sitting
 * at groups/<folder>/plugins/<name> is the pristine baseline (read-only in the
 * container), so "customized" = the live copy differs from what that version
 * stamped. The plan is computed first, side-effect free; `apply: false` is the
 * dry run shown to the operator (or on the approval card path, re-run by the
 * approver) before anything is replaced.
 */
import fs from 'fs';
import path from 'path';

import { AnchoredDir } from '../anchored-dir.js';
import { isSafeAttachmentName } from '../attachment-safety.js';
import { mcpServerPluginOwner, resolveGroupTimezone, type McpServerConfig } from '../container-config.js';
import { getAgentGroup, getAllAgentGroups } from '../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { findTaskSessions } from '../db/sessions.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { PERSONA_PREPEND_FILE, readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import { createScheduledTask, taskNameSlug } from '../modules/scheduling/create.js';
import { parseTaskContent } from '../modules/scheduling/task-content.js';
import { withExistingMailboxSession } from '../session-manager.js';
import type { AgentGroup } from '../types.js';
import { groupSkillsOverlayDir, markPluginServers } from './create-agent.js';
import { resolveLocalTemplate } from './local-dir.js';
import { parsePluginManifest, PLUGIN_MANIFEST_FILE } from './manifest.js';
import { pluginDataCwdSubpaths } from './mcp.js';
import { parseTemplate, type Template } from './parse.js';
import {
  copyPluginDir,
  MAX_PLUGIN_DEPTH,
  MAX_PLUGIN_FILES,
  MAX_PLUGIN_TOTAL_BYTES,
  walkPluginDir,
} from './plugin-dir.js';
import { prepareTemplateTasks } from './tasks.js';

export interface RestampChange {
  surface: 'plugin' | 'persona' | 'context' | 'skill' | 'mcp-server' | 'task';
  name: string;
  action: 'update' | 'create' | 'remove' | 'skip' | 'unchanged';
  /** The live copy differs from what the previous plugin version stamped — local edits are lost on apply. */
  customized?: boolean;
  note?: string;
}

export interface RestampResult {
  group: AgentGroup;
  plugin: string;
  applied: boolean;
  changes: RestampChange[];
  /** Named skip/ignore notices from the plugin reader. */
  report: string[];
  note: string;
}

/**
 * Agent groups that carry this template's plugin — a stamped manifest on disk
 * is the marker. `ncl groups create --template` uses this to decide between
 * stamping a fresh agent and updating the one already stamped. Reads only the
 * manifest (the full walk/caps/lint pass runs in the stamp it gates, not in
 * this probe).
 */
export async function groupsCarryingPlugin(ref: string, groups?: readonly AgentGroup[]): Promise<AgentGroup[]> {
  const dir = resolveLocalTemplate(ref);
  const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILE);
  // The fast path reads ONLY a regular manifest file. Anything else — absent
  // (pre-plugin layout), or a symlink — goes through the full parse so the
  // reader's own errors surface (the migration pointer, symlink rejection)
  // instead of a raw ENOENT or a followed link.
  if (!fs.existsSync(manifestPath) || !fs.lstatSync(manifestPath).isFile()) {
    parseTemplate(dir);
  }
  const manifest = parsePluginManifest(JSON.parse(fs.readFileSync(manifestPath, 'utf-8')));
  return (groups ?? (await getAllAgentGroups())).filter((g) =>
    fs.existsSync(path.join(resolveGroupFolderPath(g.folder), 'plugins', manifest.name, PLUGIN_MANIFEST_FILE)),
  );
}

/**
 * Plan (and with `apply: true` execute) an in-place plugin update. Throws
 * before any mutation when the group is missing, the group doesn't carry this
 * plugin, either plugin copy fails validation, or a template task is invalid.
 */
export async function restampAgentFromTemplate(
  ref: string,
  agentGroupId: string,
  opts: { apply: boolean },
): Promise<RestampResult> {
  const group = await getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);
  const configRow = await getContainerConfig(group.id);
  if (!configRow) throw new Error(`No container config for group: ${group.id}`);

  const tpl = parseTemplate(resolveLocalTemplate(ref));
  const groupDir = resolveGroupFolderPath(group.folder);
  const oldPluginDir = path.join(groupDir, 'plugins', tpl.name);
  if (!fs.existsSync(path.join(oldPluginDir, PLUGIN_MANIFEST_FILE))) {
    throw new Error(
      `Group "${group.name}" does not carry plugin "${tpl.name}" — ` +
        'check the group id, or drop --id to stamp a new agent',
    );
  }
  let old: Template;
  try {
    old = parseTemplate(oldPluginDir);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`Cannot read the previously stamped plugin at plugins/${tpl.name}: ${message}`, { cause: err });
  }

  // All template tasks are validated and prepared up front (slug uniqueness
  // included — the shared gate with createAgentFromTemplate) so nothing below
  // can half-apply over an invalid task file. NEW-side only: the old parsed
  // copy is tolerated as-is, so an already-stamped bad template stays
  // restampable to a fixed version.
  const preparedTasks = prepareTemplateTasks(tpl.tasks, await resolveGroupTimezone(group.id));
  const newTaskSlugs = new Set(tpl.tasks.map((task) => taskNameSlug(task.name)));

  const changes: RestampChange[] = [];
  const ops: Array<() => void | Promise<void>> = [];

  // --- plugin files: plugins/<name> replaced wholesale ---------------------
  if (dirsEqual(hostTree(tpl.dir), hostTree(oldPluginDir))) {
    changes.push({ surface: 'plugin', name: `plugins/${tpl.name}`, action: 'unchanged' });
  } else {
    changes.push({
      surface: 'plugin',
      name: `plugins/${tpl.name}`,
      action: 'update',
      note: 'replaced wholesale from the template',
    });
    ops.push(() => {
      copyPluginDir(tpl.dir, oldPluginDir);
      withWritableDir(groupDir, ['plugin-data', tpl.name], () => {});
    });
  }

  // cwd dirs are plugin-data scaffold, not plugin files: create them even
  // when plugins/<name> is byte-identical. An engine upgrade changes what the
  // same template ref stamps (a cwd server the old engine skipped appears on
  // restamp with no plugin-file diff), and the dir may also have been deleted
  // since the last stamp. Missing parents are created through pinned directories.
  ops.push(() => {
    for (const sub of pluginDataCwdSubpaths(tpl.mcpServers)) {
      // The cwd validator accepts a trailing root slash and current-directory segments.
      const segments = sub.split('/').filter((segment) => segment !== '' && segment !== '.');
      withWritableDir(groupDir, ['plugin-data', tpl.name, ...segments], () => {});
    }
  });

  // --- persona -------------------------------------------------------------
  const livePersona = readGroupPersona(groupDir);
  const oldPersona = old.instructions?.trim() || undefined;
  const newPersona = tpl.instructions?.trim() || undefined;
  if (newPersona !== undefined) {
    if (livePersona === newPersona) {
      changes.push({ surface: 'persona', name: PERSONA_PREPEND_FILE, action: 'unchanged' });
    } else {
      changes.push({
        surface: 'persona',
        name: PERSONA_PREPEND_FILE,
        action: livePersona === null ? 'create' : 'update',
        ...(livePersona !== null && livePersona !== oldPersona ? { customized: true } : {}),
      });
      ops.push(() => {
        withWritableDir(groupDir, [], (dir) => {
          dir.remove(PERSONA_PREPEND_FILE);
          dir.writeNewFile(PERSONA_PREPEND_FILE, Buffer.from(`${tpl.instructions!.trimEnd()}\n`));
        });
      });
    }
  } else if (oldPersona !== undefined && livePersona !== null) {
    changes.push({
      surface: 'persona',
      name: PERSONA_PREPEND_FILE,
      action: 'remove',
      ...(livePersona !== oldPersona ? { customized: true } : {}),
    });
    ops.push(() => withWritableDir(groupDir, [], (dir) => dir.remove(PERSONA_PREPEND_FILE)));
  }

  // --- context extras ------------------------------------------------------
  const oldContext = new Map(old.contextExtras.map((e) => [e.name, e.content]));
  const newContext = new Map(tpl.contextExtras.map((e) => [e.name, e.content]));
  for (const name of new Set([...oldContext.keys(), ...newContext.keys()])) {
    assertInsideGroup(groupDir, name);
    const segments = name.split('/');
    const leaf = segments.pop()!;
    const live = readTreeFile(liveTree(groupDir, []), name)?.bytes.toString('utf-8');
    // What holds the name when the host cannot load it: a link, an unreadable or oversized file.
    const unread = (): 'none' | 'file' | 'other' => liveEntry(liveTree(groupDir, name.split('/')));
    const wanted = newContext.get(name);
    if (wanted !== undefined) {
      if (live === wanted) {
        changes.push({ surface: 'context', name, action: 'unchanged' });
        continue;
      }
      changes.push({
        surface: 'context',
        name,
        action: live === undefined ? 'create' : 'update',
        ...((live === undefined ? unread() !== 'none' : live !== oldContext.get(name)) ? { customized: true } : {}),
      });
      ops.push(() => {
        withWritableDir(groupDir, segments, (dir) => {
          dir.remove(leaf);
          dir.writeNewFile(leaf, Buffer.from(wanted));
        });
      });
    } else if (live !== undefined || unread() === 'file') {
      // A regular file is still the stamped name, loadable or not: remove it. A link is left alone.
      changes.push({
        surface: 'context',
        name,
        action: 'remove',
        ...(live !== oldContext.get(name) ? { customized: true } : {}),
      });
      ops.push(() => withWritableDir(groupDir, segments, (dir) => dir.remove(leaf)));
    }
  }

  // --- skills overlay ------------------------------------------------------
  const overlayRoot = groupSkillsOverlayDir(group.id);
  // .claude-shared is host-owned; open the writable skills child through it.
  const copySkill = (srcDir: string, name: string): void => {
    const files = walkPluginDir(srcDir);
    const source = AnchoredDir.open(srcDir, []);
    if (!source) throw new Error(`Skill source disappeared: ${srcDir}`);
    try {
      withWritableDir(path.dirname(overlayRoot), ['skills'], (dir) => {
        dir.remove(name, true);
        dir.copyFiles(
          source,
          name,
          files.map((file) => file.rel),
        );
      });
    } finally {
      source.close();
    }
  };
  const oldSkills = new Map(old.skills.map((s) => [s.name, s.srcDir]));
  const newSkills = new Map(tpl.skills.map((s) => [s.name, s.srcDir]));
  // .claude-shared is host-owned; `skills` and every name below it are not.
  const overlayTree = (name: string): TreeRef => liveTree(path.dirname(overlayRoot), ['skills', name]);
  for (const [name, srcDir] of newSkills) {
    const oldSrc = oldSkills.get(name);
    if (liveEntry(overlayTree(name)) === 'none') {
      changes.push({
        surface: 'skill',
        name,
        action: 'create',
        ...(oldSrc !== undefined ? { customized: true, note: 'was removed locally; recreated' } : {}),
      });
      ops.push(() => copySkill(srcDir, name));
    } else if (dirsEqual(overlayTree(name), hostTree(srcDir))) {
      changes.push({ surface: 'skill', name, action: 'unchanged' });
    } else {
      changes.push({
        surface: 'skill',
        name,
        action: 'update',
        ...(oldSrc === undefined || !dirsEqual(overlayTree(name), hostTree(oldSrc)) ? { customized: true } : {}),
      });
      ops.push(() => copySkill(srcDir, name));
    }
  }
  for (const [name, oldSrc] of oldSkills) {
    if (newSkills.has(name)) continue;
    if (liveEntry(overlayTree(name)) === 'none') continue;
    changes.push({
      surface: 'skill',
      name,
      action: 'remove',
      ...(!dirsEqual(overlayTree(name), hostTree(oldSrc)) ? { customized: true } : {}),
    });
    ops.push(() => withWritableDir(path.dirname(overlayRoot), ['skills'], (dir) => dir.remove(name, true)));
  }

  // --- MCP servers (by ownership marker) -----------------------------------
  const servers = JSON.parse(configRow.mcp_servers) as Record<string, McpServerConfig>;
  const newOwned = markPluginServers(tpl.mcpServers, tpl.name);
  const oldOwned = markPluginServers(old.mcpServers, tpl.name);
  const next: Record<string, McpServerConfig> = { ...servers };
  let mcpDirty = false;
  for (const [name, server] of Object.entries(newOwned)) {
    const existing = servers[name];
    const owner = existing === undefined ? undefined : mcpServerPluginOwner(existing);
    if (existing !== undefined && owner !== tpl.name) {
      changes.push({
        surface: 'mcp-server',
        name,
        action: 'skip',
        note: owner
          ? `a server owned by plugin "${owner}" has this name; the "${tpl.name}" version was not installed`
          : 'a server you added has this name; the plugin version was not installed',
      });
      continue;
    }
    if (existing === undefined) {
      changes.push({ surface: 'mcp-server', name, action: 'create' });
      next[name] = server;
      mcpDirty = true;
    } else if (JSON.stringify(existing) === JSON.stringify(server)) {
      changes.push({ surface: 'mcp-server', name, action: 'unchanged' });
    } else {
      changes.push({
        surface: 'mcp-server',
        name,
        action: 'update',
        ...(JSON.stringify(existing) !== JSON.stringify(oldOwned[name]) ? { customized: true } : {}),
      });
      next[name] = server;
      mcpDirty = true;
    }
  }
  for (const [name, existing] of Object.entries(servers)) {
    if (mcpServerPluginOwner(existing) !== tpl.name || name in newOwned) continue;
    changes.push({ surface: 'mcp-server', name, action: 'remove' });
    delete next[name];
    mcpDirty = true;
  }
  if (mcpDirty) ops.push(async () => await updateContainerConfigJson(group.id, 'mcp_servers', next));

  // --- tasks (matched by name slug; pause/resume state is operator-owned) --
  // Old-side tasks are keyed by SLUG — the identity live series carry. A rename
  // that preserves the slug (case, punctuation, truncation) must read as an
  // update of the same series, never as remove + create of the live series.
  const oldTasks = new Map(old.tasks.map((t) => [taskNameSlug(t.name), t]));
  for (const task of tpl.tasks) {
    const prepared = preparedTasks.get(task.name)!;
    const match = await findTaskSeriesBySlug(group.id, taskNameSlug(task.name));
    const oldTask = oldTasks.get(taskNameSlug(task.name));
    // A dead series (no live row, nothing armed to re-arm) is history, not a
    // task — a fresh series is created alongside it.
    if (match === undefined || (!match.live && match.recurrence === null)) {
      changes.push({
        surface: 'task',
        name: task.name,
        action: 'create',
        ...(oldTask !== undefined
          ? { customized: true, note: 'was removed locally; recreated paused' }
          : { note: 'created paused' }),
      });
      ops.push(async () => {
        await createScheduledTask(group.id, prepared, { status: 'paused' });
      });
      continue;
    }
    if (!match.live) {
      // Completed row with a recurrence: the sweep re-arms it within a minute.
      // Updating history rows would falsify what actually ran, so ask for a
      // retry instead of writing through the window.
      changes.push({
        surface: 'task',
        name: task.name,
        action: 'skip',
        note: `series ${match.seriesId} is re-arming between runs; re-run restamp to update it`,
      });
      continue;
    }
    const changed =
      match.prompt !== prepared.prompt || match.script !== prepared.script || match.recurrence !== prepared.recurrence;
    if (!changed) {
      changes.push({ surface: 'task', name: task.name, action: 'unchanged', note: `series ${match.seriesId}` });
      continue;
    }
    const customized =
      oldTask === undefined ||
      match.prompt !== oldTask.prompt ||
      match.script !== (oldTask.script ?? null) ||
      match.recurrence !== oldTask.schedule;
    changes.push({
      surface: 'task',
      name: task.name,
      action: 'update',
      ...(customized ? { customized: true } : {}),
      note: `series ${match.seriesId}; status "${match.status}" kept`,
    });
    ops.push(async () => {
      await withExistingMailboxSession(group.id, match.sessionId, (mailbox) =>
        mailbox.updateTask(match.seriesId, {
          prompt: prepared.prompt,
          script: prepared.script,
          ...(match.recurrence !== prepared.recurrence
            ? { recurrence: prepared.recurrence, processAfter: prepared.processAfter }
            : {}),
        }),
      );
    });
  }
  for (const [slug, oldTask] of oldTasks) {
    if (newTaskSlugs.has(slug)) continue;
    const match = await findTaskSeriesBySlug(group.id, slug);
    // Nothing to remove when the series is already dead history.
    if (match === undefined || (!match.live && match.recurrence === null)) continue;
    changes.push({
      surface: 'task',
      name: oldTask.name,
      action: 'remove',
      note: `series ${match.seriesId} deleted (was ${match.status})`,
    });
    ops.push(async () => {
      await withExistingMailboxSession(group.id, match.sessionId, (mailbox) => mailbox.deleteTask(match.seriesId));
    });
  }

  for (const line of tpl.report) log.warn('Template reader notice', { ref, notice: line });

  // Ops are independent and idempotent; a mid-list throw names how far it
  // got so the operator knows a re-run converges the rest.
  if (opts.apply) {
    for (const [index, op] of ops.entries()) {
      try {
        await op();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new Error(
          `Restamp failed after applying ${index} of ${ops.length} changes (re-run to converge the rest): ${message}`,
          { cause: err },
        );
      }
    }
  }

  const anyChange = changes.some((c) => c.action !== 'unchanged' && c.action !== 'skip');
  const note = opts.apply
    ? anyChange
      ? `Restamp applied. Run \`ncl groups restart --id ${group.id}\` for skill and MCP changes to take effect.`
      : 'Nothing to apply — the group already matches the template.'
    : 'DRY RUN — nothing was changed. Re-run with --yes to apply.';
  return { group, plugin: tpl.name, applied: opts.apply, changes, report: tpl.report, note };
}

/** Human rendering of a restamp plan/result — one aligned line per surface. */
export function formatRestampResult(result: RestampResult): string {
  const lines = [`Restamp "${result.plugin}" → group "${result.group.name}" (${result.group.id})`, result.note, ''];
  for (const c of result.changes) {
    const flags = [c.customized ? 'CUSTOMIZED — local edits lost' : undefined, c.note]
      .filter((s): s is string => s !== undefined)
      .join('; ');
    lines.push(`  ${c.action.padEnd(9)} ${c.surface.padEnd(10)} ${c.name}${flags ? `  (${flags})` : ''}`);
  }
  if (result.report.length > 0) {
    lines.push('', 'Template reader notices:');
    for (const notice of result.report) lines.push(`  - ${notice}`);
  }
  return lines.join('\n');
}

/** Refuse a context-relative extra whose path leaves the group folder. */
function assertInsideGroup(groupDir: string, name: string): void {
  const rel = path.relative(groupDir, path.join(groupDir, ...name.split('/')));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`context file "${name}" escapes the group folder`);
  }
}

/**
 * A folder restamp reads: the host-owned `root`, then `segments` below it.
 * Every name below the root is opened one at a time, pinned, and never through
 * a symlink, because in a `live` tree the container owns those names and can
 * rename any of them at any moment.
 */
interface TreeRef {
  root: string;
  segments: readonly string[];
  live: boolean;
}

const hostTree = (root: string): TreeRef => ({ root, segments: [], live: false });
const liveTree = (root: string, segments: readonly string[]): TreeRef => ({ root, segments, live: true });

/** Thrown when a tree is past the plugin caps, so it cannot be a template copy. */
class NotATemplateCopy extends Error {}

/**
 * Run one read of `tree`. In a live tree the container can swap a folder for a
 * link, remove it or make it unreadable mid-walk; that means "not what the
 * template stamped", never a failed plan. A host-owned tree still throws.
 */
function readTree<T>(tree: TreeRef, read: () => T): T | undefined {
  try {
    return read();
  } catch (err) {
    if (tree.live && madeUnreadableByContainer(err)) return undefined;
    throw err;
  }
}

function madeUnreadableByContainer(err: unknown): boolean {
  if (err instanceof NotATemplateCopy) return true;
  // AnchoredDir wraps its refusal of a non-folder around the open error.
  const { code, cause } = err as NodeJS.ErrnoException;
  const errno = code ?? (cause as NodeJS.ErrnoException | undefined)?.code ?? '';
  // ENAMETOOLONG: a listed name that is not UTF-8 can grow when it is encoded again.
  return NOT_A_REGULAR_FILE.has(errno) || ['EACCES', 'EPERM', 'ENAMETOOLONG'].includes(errno);
}

/**
 * What holds the last name of a live tree, without looking through it: a
 * symlink there (dangling or not) is an entry apply must replace, never a
 * folder to enter. A parent that cannot be read counts as 'other', so the
 * plan says "changed" rather than "create".
 */
function liveEntry(tree: TreeRef): 'none' | 'file' | 'other' {
  const leaf = tree.segments[tree.segments.length - 1];
  const found = readTree(tree, () => {
    const dir = AnchoredDir.open(tree.root, tree.segments.slice(0, -1));
    if (!dir) return 'none';
    try {
      return dir.lstat(leaf).isFile() ? 'file' : 'other';
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return 'none';
      throw err;
    } finally {
      dir.close();
    }
  });
  return found ?? 'other';
}

/** Relative '/'-separated paths of the regular files in `tree`; empty when the folder is missing. */
function listTreeFiles(tree: TreeRef): Set<string> {
  const files = new Set<string>();
  const top = AnchoredDir.open(tree.root, tree.segments);
  if (!top) return files;
  let entries = 0;
  const visit = (dir: AnchoredDir, prefix: string, depth: number): void => {
    for (const name of dir.entries()) {
      // A tree past the plugin caps is no template copy; stop before walking it all.
      if (++entries > MAX_PLUGIN_FILES) throw new NotATemplateCopy('more entries than a plugin can hold');
      // Nor is one with a name AnchoredDir refuses, such as a backslash: plugins cannot ship those.
      if (!isSafeAttachmentName(name)) throw new NotATemplateCopy(`entry name ${JSON.stringify(name)}`);
      // Symlinks are never plugin content, so a link compares as an absent
      // file. So does an entry the container removed since the listing.
      let stat: fs.Stats;
      try {
        stat = dir.lstat(name);
      } catch (err) {
        if (NOT_A_REGULAR_FILE.has((err as NodeJS.ErrnoException).code ?? '')) continue;
        throw err;
      }
      if (stat.isFile()) files.add(prefix + name);
      if (!stat.isDirectory()) continue;
      // Each level holds a descriptor, and the container picks the depth.
      if (depth >= MAX_PLUGIN_DEPTH) throw new NotATemplateCopy('nested deeper than a plugin can be');
      const child = dir.openDir(name);
      if (!child) continue;
      try {
        visit(child, `${prefix}${name}/`, depth + 1);
      } finally {
        child.close();
      }
    }
  };
  try {
    visit(top, '', 0);
  } finally {
    top.close();
  }
  return files;
}

/** Pin writable descendants of a stable root for the entire operation. */
function withWritableDir(root: string, segments: string[], action: (dir: AnchoredDir) => void): void {
  const dir = AnchoredDir.open(root, segments, true);
  if (!dir) throw new Error(`Restamp directory disappeared: ${path.join(root, ...segments)}`);
  try {
    action(dir);
  } finally {
    dir.close();
  }
}

/**
 * Equality of two directory trees: relative layout, file contents, and the
 * executable bit (the copier preserves it, so a chmod-only template revision
 * must read as a change, not "unchanged").
 */
function dirsEqual(a: TreeRef, b: TreeRef): boolean {
  const filesA = readTree(a, () => listTreeFiles(a));
  const filesB = readTree(b, () => listTreeFiles(b));
  if (filesA === undefined || filesB === undefined || filesA.size !== filesB.size) return false;
  for (const rel of filesA) {
    if (!filesB.has(rel)) return false;
    const fileA = readTreeFile(a, rel);
    const fileB = readTreeFile(b, rel);
    if (fileA === undefined || fileB === undefined) return false;
    if ((fileA.mode & 0o111) !== (fileB.mode & 0o111) || !fileA.bytes.equals(fileB.bytes)) return false;
  }
  return true;
}

// Open errors that mean the name is not a regular file (or its folder is not a folder).
const NOT_A_REGULAR_FILE = new Set(['ENOENT', 'ENOTDIR', 'ELOOP', 'ENXIO', 'EOPNOTSUPP']);

/**
 * The bytes and mode of the file at `rel` in `tree`, or undefined unless it is
 * a regular file under real folders. A live name can change after any earlier
 * check, so each call starts again from the root: pin every folder on the way,
 * open the file without following a symlink or blocking on a FIFO, and take
 * bytes and mode from that one descriptor.
 */
function readTreeFile(tree: TreeRef, rel: string): { bytes: Buffer; mode: number } | undefined {
  const folders = rel.split('/');
  const leaf = folders.pop()!;
  return readTree(tree, () => {
    const dir = AnchoredDir.open(tree.root, [...tree.segments, ...folders]);
    if (!dir) return undefined;
    try {
      return readRegularFile(dir, leaf);
    } finally {
      dir.close();
    }
  });
}

function readRegularFile(dir: AnchoredDir, name: string): { bytes: Buffer; mode: number } | undefined {
  let fd: number;
  try {
    // O_NOFOLLOW | O_NONBLOCK, then an fstat check that the descriptor is a regular file.
    fd = dir.openReadFd(name);
  } catch (err) {
    // No code: openReadFd's own refusal of an opened non-file, such as a FIFO.
    const code = (err as NodeJS.ErrnoException).code;
    if (code === undefined || NOT_A_REGULAR_FILE.has(code)) return undefined;
    throw err;
  }
  try {
    const stat = fs.fstatSync(fd);
    // The container picks a live file's size and can grow it mid-read: load at
    // most what a whole plugin may hold, and never more than this fstat saw.
    if (stat.size > MAX_PLUGIN_TOTAL_BYTES) throw new NotATemplateCopy('file larger than a plugin can be');
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    for (let read = -1; read !== 0 && length < bytes.length; length += read) {
      read = fs.readSync(fd, bytes, length, bytes.length - length, null);
    }
    if (length > stat.size) throw new NotATemplateCopy('file grew while it was read');
    return { bytes: bytes.subarray(0, length), mode: stat.mode };
  } finally {
    fs.closeSync(fd);
  }
}

interface TaskSeriesMatch {
  sessionId: string;
  seriesId: string;
  /** A pending/paused row exists — the series can be updated in place. */
  live: boolean;
  status: string;
  recurrence: string | null;
  prompt: string;
  script: string | null;
}

/**
 * Find the task series a named task produced. Task rows don't store the name —
 * the id embeds its slug as `<slug>-<4hex>`, so match that shape across the
 * group's task sessions. Oldest session first: the stamped series predates any
 * same-named task created later, so a user's own task never shadows it. Rows
 * match in ANY state — a recurring series between a run completing and the
 * sweep re-arming it (≤60s) has only completed rows but is still alive.
 */
async function findTaskSeriesBySlug(agentGroupId: string, slug: string): Promise<TaskSeriesMatch | undefined> {
  if (!slug) return undefined;
  for (const session of [...(await findTaskSessions(agentGroupId))].reverse()) {
    const row = await withExistingMailboxSession(agentGroupId, session.id, (mailbox) =>
      mailbox.findTaskBySeriesSlug(slug),
    );
    if (!row?.seriesId) continue;
    const content = parseTaskContent(row.content);
    return {
      sessionId: session.id,
      seriesId: row.seriesId,
      live: row.status === 'pending' || row.status === 'paused',
      status: row.status,
      recurrence: row.recurrence,
      prompt: content.prompt,
      script: content.script,
    };
  }
  return undefined;
}
