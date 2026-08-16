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

import { mcpServerPluginOwner, resolveGroupTimezone, type McpServerConfig } from '../container-config.js';
import { getAgentGroup, getAllAgentGroups } from '../db/agent-groups.js';
import { getContainerConfig, updateContainerConfigJson } from '../db/container-configs.js';
import { findTaskSessions } from '../db/sessions.js';
import { resolveGroupFolderPath } from '../group-folder.js';
import { PERSONA_PREPEND_FILE, readGroupPersona } from '../group-persona.js';
import { log } from '../log.js';
import { createScheduledTask, taskNameSlug } from '../modules/scheduling/create.js';
import { deleteTask, parseTaskContent, updateTask } from '../modules/scheduling/db.js';
import { inboundDbPath, withInboundDb } from '../session-manager.js';
import type { AgentGroup } from '../types.js';
import { groupSkillsOverlayDir, markPluginServers } from './create-agent.js';
import { resolveLocalTemplate } from './local-dir.js';
import { parsePluginManifest, PLUGIN_MANIFEST_FILE } from './manifest.js';
import { pluginDataCwdSubpaths } from './mcp.js';
import { parseTemplate, type Template } from './parse.js';
import { copyPluginDir } from './plugin-dir.js';
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
export function groupsCarryingPlugin(ref: string): AgentGroup[] {
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
  return getAllAgentGroups().filter((g) =>
    fs.existsSync(path.join(resolveGroupFolderPath(g.folder), 'plugins', manifest.name, PLUGIN_MANIFEST_FILE)),
  );
}

/**
 * Plan (and with `apply: true` execute) an in-place plugin update. Throws
 * before any mutation when the group is missing, the group doesn't carry this
 * plugin, either plugin copy fails validation, or a template task is invalid.
 */
export function restampAgentFromTemplate(ref: string, agentGroupId: string, opts: { apply: boolean }): RestampResult {
  const group = getAgentGroup(agentGroupId);
  if (!group) throw new Error(`Agent group not found: ${agentGroupId}`);
  const configRow = getContainerConfig(group.id);
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
  const preparedTasks = prepareTemplateTasks(tpl.tasks, resolveGroupTimezone(group.id));
  const newTaskSlugs = new Set(tpl.tasks.map((task) => taskNameSlug(task.name)));

  const changes: RestampChange[] = [];
  const ops: Array<() => void> = [];

  // --- plugin files: plugins/<name> replaced wholesale ---------------------
  if (dirsEqual(tpl.dir, oldPluginDir)) {
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
      // plugin-data sits in the container-RW group mount (unlike plugins/,
      // which is its own RO mountpoint) — same symlink rules as every write.
      mkdirRealWithin(groupDir, path.join(groupDir, 'plugin-data', tpl.name));
    });
  }

  // cwd dirs are plugin-data scaffold, not plugin files: create them even
  // when plugins/<name> is byte-identical. An engine upgrade changes what the
  // same template ref stamps (a cwd server the old engine skipped appears on
  // restamp with no plugin-file diff), and the dir may also have been deleted
  // since the last stamp. Idempotent; mkdirRealWithin creates parents.
  ops.push(() => {
    for (const sub of pluginDataCwdSubpaths(tpl.mcpServers)) {
      mkdirRealWithin(groupDir, path.join(groupDir, 'plugin-data', tpl.name, sub));
    }
  });

  // --- persona -------------------------------------------------------------
  const livePersona = readGroupPersona(groupDir);
  const oldPersona = old.instructions?.trim() || undefined;
  const newPersona = tpl.instructions?.trim() || undefined;
  const personaFile = path.join(groupDir, PERSONA_PREPEND_FILE);
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
        // rm-then-exclusive-write: the rm removes a planted symlink itself
        // (never its target), and `wx` makes a link re-planted in the race
        // window a loud failure instead of a write-through.
        fs.rmSync(personaFile, { force: true });
        fs.writeFileSync(personaFile, `${tpl.instructions!.trimEnd()}\n`, { flag: 'wx' });
      });
    }
  } else if (oldPersona !== undefined && livePersona !== null) {
    changes.push({
      surface: 'persona',
      name: PERSONA_PREPEND_FILE,
      action: 'remove',
      ...(livePersona !== oldPersona ? { customized: true } : {}),
    });
    ops.push(() => fs.rmSync(personaFile, { force: true }));
  }

  // --- context extras ------------------------------------------------------
  const oldContext = new Map(old.contextExtras.map((e) => [e.name, e.content]));
  const newContext = new Map(tpl.contextExtras.map((e) => [e.name, e.content]));
  for (const name of new Set([...oldContext.keys(), ...newContext.keys()])) {
    const target = contextTarget(groupDir, name);
    const live = fs.existsSync(target) && fs.statSync(target).isFile() ? fs.readFileSync(target, 'utf-8') : undefined;
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
        ...(live !== undefined && live !== oldContext.get(name) ? { customized: true } : {}),
      });
      ops.push(() => {
        mkdirRealWithin(groupDir, path.dirname(target));
        fs.rmSync(target, { force: true });
        fs.writeFileSync(target, wanted, { flag: 'wx' });
      });
    } else if (live !== undefined) {
      changes.push({
        surface: 'context',
        name,
        action: 'remove',
        ...(live !== oldContext.get(name) ? { customized: true } : {}),
      });
      ops.push(() => {
        mkdirRealWithin(groupDir, path.dirname(target));
        fs.rmSync(target, { force: true });
      });
    }
  }

  // --- skills overlay ------------------------------------------------------
  const overlayRoot = groupSkillsOverlayDir(group.id);
  // The overlay's parent (.claude-shared) is host-provisioned, but the
  // container can replace `skills` itself with a symlink — verify before
  // every apply-phase write under it.
  const ensureOverlayRoot = (): void => {
    fs.mkdirSync(path.dirname(overlayRoot), { recursive: true });
    mkdirRealWithin(path.dirname(overlayRoot), overlayRoot);
  };
  const oldSkills = new Map(old.skills.map((s) => [s.name, s.srcDir]));
  const newSkills = new Map(tpl.skills.map((s) => [s.name, s.srcDir]));
  for (const [name, srcDir] of newSkills) {
    const overlay = path.join(overlayRoot, name);
    const oldSrc = oldSkills.get(name);
    if (!fs.existsSync(overlay)) {
      changes.push({
        surface: 'skill',
        name,
        action: 'create',
        ...(oldSrc !== undefined ? { customized: true, note: 'was removed locally; recreated' } : {}),
      });
      ops.push(() => {
        ensureOverlayRoot();
        copyPluginDir(srcDir, overlay);
      });
    } else if (dirsEqual(overlay, srcDir)) {
      changes.push({ surface: 'skill', name, action: 'unchanged' });
    } else {
      changes.push({
        surface: 'skill',
        name,
        action: 'update',
        ...(oldSrc === undefined || !dirsEqual(overlay, oldSrc) ? { customized: true } : {}),
      });
      ops.push(() => {
        ensureOverlayRoot();
        copyPluginDir(srcDir, overlay);
      });
    }
  }
  for (const [name, oldSrc] of oldSkills) {
    if (newSkills.has(name)) continue;
    const overlay = path.join(overlayRoot, name);
    if (!fs.existsSync(overlay)) continue;
    changes.push({
      surface: 'skill',
      name,
      action: 'remove',
      ...(!dirsEqual(overlay, oldSrc) ? { customized: true } : {}),
    });
    ops.push(() => {
      ensureOverlayRoot();
      fs.rmSync(overlay, { recursive: true, force: true });
    });
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
  if (mcpDirty) ops.push(() => updateContainerConfigJson(group.id, 'mcp_servers', next));

  // --- tasks (matched by name slug; pause/resume state is operator-owned) --
  // Old-side tasks are keyed by SLUG — the identity live series carry. A rename
  // that preserves the slug (case, punctuation, truncation) must read as an
  // update of the same series, never as remove + create of the live series.
  const oldTasks = new Map(old.tasks.map((t) => [taskNameSlug(t.name), t]));
  for (const task of tpl.tasks) {
    const prepared = preparedTasks.get(task.name)!;
    const match = findTaskSeriesBySlug(group.id, taskNameSlug(task.name));
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
      ops.push(() => void createScheduledTask(group.id, prepared, { status: 'paused' }));
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
    ops.push(() => {
      withInboundDb(group.id, match.sessionId, (db) =>
        updateTask(db, match.seriesId, {
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
    const match = findTaskSeriesBySlug(group.id, slug);
    // Nothing to remove when the series is already dead history.
    if (match === undefined || (!match.live && match.recurrence === null)) continue;
    changes.push({
      surface: 'task',
      name: oldTask.name,
      action: 'remove',
      note: `series ${match.seriesId} deleted (was ${match.status})`,
    });
    ops.push(() => {
      withInboundDb(group.id, match.sessionId, (db) => deleteTask(db, match.seriesId));
    });
  }

  for (const line of tpl.report) log.warn('Template reader notice', { ref, notice: line });

  // Ops are independent and idempotent; a mid-list throw names how far it
  // got so the operator knows a re-run converges the rest.
  if (opts.apply) {
    for (const [index, op] of ops.entries()) {
      try {
        op();
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

/** Resolve a context-relative extra to its workspace path, contained in groupDir. */
function contextTarget(groupDir: string, name: string): string {
  const target = path.join(groupDir, ...name.split('/'));
  const rel = path.relative(groupDir, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`context file "${name}" escapes the group folder`);
  }
  return target;
}

function listFilesRecursive(root: string): Map<string, string> {
  const out = new Map<string, string>();
  if (!fs.existsSync(root)) return out;
  for (const entry of fs.readdirSync(root, { recursive: true }) as string[]) {
    const abs = path.join(root, entry);
    // lstat: symlinks are never plugin content, so a (possibly dangling) link
    // compares as an absent file instead of crashing the plan.
    if (fs.lstatSync(abs).isFile()) out.set(entry.split(path.sep).join('/'), abs);
  }
  return out;
}

/**
 * Create `dir` (under trusted, existing `base`) for an apply-phase write. The
 * group dir and skills overlay are container-writable, so an agent-planted
 * symlink could redirect a host-side write anywhere: the deepest EXISTING
 * ancestor must resolve inside `base` before the rest is created (freshly
 * created components cannot be symlinks).
 */
function mkdirRealWithin(base: string, dir: string): void {
  let existing = dir;
  while (!fs.existsSync(existing)) existing = path.dirname(existing);
  const rel = path.relative(fs.realpathSync(base), fs.realpathSync(existing));
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`refusing to write through "${dir}": it resolves outside the agent's own directories`);
  }
  fs.mkdirSync(dir, { recursive: true });
}

/**
 * Equality of two directory trees: relative layout, file contents, and the
 * executable bit (the copier preserves it, so a chmod-only template revision
 * must read as a change, not "unchanged").
 */
function dirsEqual(a: string, b: string): boolean {
  const filesA = listFilesRecursive(a);
  const filesB = listFilesRecursive(b);
  if (filesA.size !== filesB.size) return false;
  for (const [rel, absA] of filesA) {
    const absB = filesB.get(rel);
    if (absB === undefined) return false;
    if ((fs.lstatSync(absA).mode & 0o111) !== (fs.lstatSync(absB).mode & 0o111)) return false;
    if (!fs.readFileSync(absA).equals(fs.readFileSync(absB))) return false;
  }
  return true;
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
function findTaskSeriesBySlug(agentGroupId: string, slug: string): TaskSeriesMatch | undefined {
  if (!slug) return undefined;
  const pattern = `${slug}-[0-9a-f][0-9a-f][0-9a-f][0-9a-f]`;
  for (const session of [...findTaskSessions(agentGroupId)].reverse()) {
    if (!fs.existsSync(inboundDbPath(agentGroupId, session.id))) continue;
    const row = withInboundDb(agentGroupId, session.id, (db) =>
      db
        .prepare(
          `SELECT series_id, status, recurrence, content FROM messages_in
            WHERE kind = 'task' AND series_id GLOB ?
            ORDER BY CASE WHEN status IN ('pending', 'paused') THEN 0 ELSE 1 END, seq DESC
            LIMIT 1`,
        )
        .get(pattern),
    ) as { series_id: string; status: string; recurrence: string | null; content: string } | undefined;
    if (!row) continue;
    const content = parseTaskContent(row.content);
    return {
      sessionId: session.id,
      seriesId: row.series_id,
      live: row.status === 'pending' || row.status === 'paused',
      status: row.status,
      recurrence: row.recurrence,
      prompt: content.prompt,
      script: content.script,
    };
  }
  return undefined;
}
