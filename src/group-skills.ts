/**
 * Provider-agnostic template-skill materialization.
 *
 * A template stamps its skills as REAL directories into the group-private store
 * `data/v2-sessions/<group-id>/.claude-shared/skills/<name>` (src/templates/create-agent.ts).
 * Claude reads that store directly — it is mounted at `~/.claude/skills`, and
 * real dirs survive the symlink-only skill-link prune. Every OTHER surfaces-owning
 * provider (codex, opencode, pi, …) reads a DIFFERENT per-group skills directory,
 * often READ-ONLY-mounted, so the skills must be copied there host-side, before
 * the container starts.
 *
 * This is the single shared spot that does that copy. Each provider's host-side
 * container contribution calls it once with its own skills dir (codex →
 * `.agents/skills`; a future provider → whatever it reads), either as an
 * anchor root plus path segments, or as one full path inside the group folder.
 * Adding a provider therefore adds one call, not a new mirror implementation.
 * The copied dirs are real (not symlinks), so they survive providers'
 * symlink-only prunes and persist across respawns.
 *
 * This module is a main-owned seam that provider payloads (on the `providers`
 * donor branch) import — mirrors src/group-persona.ts.
 */
import fs from 'fs';
import path from 'path';

import { AnchoredDir, copyRegularFile } from './anchored-dir.js';
import { DATA_DIR, GROUPS_DIR } from './config.js';
import { log } from './log.js';

/** Bounds the recursion so a concurrent rename cannot spin it (and leak fds) forever. */
const MAX_SKILL_TREE_DEPTH = 64;

/** The group-private store templates stamp skills into (Claude's read plane). */
function templateSkillsSourceRoot(agentGroupId: string): { root: string; segments: readonly string[] } {
  return { root: path.join(DATA_DIR, 'v2-sessions', agentGroupId), segments: ['.claude-shared', 'skills'] };
}

/**
 * Copy a group's template skills into a provider's per-group skills directory.
 * No-op if the group has no template skills, or if the destination IS the
 * source (Claude, which reads the source directly — copying onto itself would
 * delete it). Idempotent: overwrites each template skill so edits propagate on
 * respawn. It manages only its own skill dirs — other entries in the
 * destination (e.g. a provider's shared-skill symlinks) are left untouched.
 *
 * Both sides live under agent-writable mounts (`.claude-shared` and the
 * destination both sit inside a container bind), so each is reached through an
 * {@link AnchoredDir} and walked by descriptor: a symlink swapped in for a
 * skills dir, a skill, or any entry below is refused, never followed into a
 * recursive delete, read, or copy outside the mount.
 *
 * The destination is `destRoot/destSegments...`, with `destRoot` a host-owned
 * anchor (the group folder or a state-volume root). Without `destSegments`,
 * `destRoot` is the full skills path and must lie inside a group folder under
 * `GROUPS_DIR`; it is then anchored at that group folder and every component
 * below it is a segment, so both call shapes guard the same way. A full path
 * outside every group folder is refused.
 */
export function materializeTemplateSkills(
  agentGroupId: string,
  destRoot: string,
  destSegments?: readonly string[],
): void {
  const source = templateSkillsSourceRoot(agentGroupId);
  const destPath = destSegments ? path.resolve(destRoot, ...destSegments) : path.resolve(destRoot);
  if (path.resolve(source.root, ...source.segments) === destPath) return;

  let srcDir: AnchoredDir | null = null;
  let destDir: AnchoredDir | null = null;
  try {
    const dest = destSegments ? { root: destRoot, segments: destSegments } : anchorWithinGroupFolder(destRoot);
    srcDir = AnchoredDir.open(source.root, source.segments);
    if (!srcDir) return; // no template store
    destDir = AnchoredDir.open(dest.root, dest.segments, true);
    if (!destDir) return;

    for (const name of srcDir.entries()) {
      // The Claude plane plants shared-skill symlinks here whose targets only
      // resolve inside the container; template skills are always real dirs, so
      // anything else (a link, a file) is not ours to copy.
      let stat: fs.Stats;
      try {
        stat = srcDir.lstat(name);
      } catch {
        continue;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) continue;

      const srcSkill = srcDir.openDir(name);
      if (!srcSkill) continue;
      try {
        removeEntry(destDir, name, 0);
        const destSkill = destDir.openDir(name, true);
        if (!destSkill) continue;
        try {
          copyTree(srcSkill, destSkill, 0);
        } finally {
          destSkill.close();
        }
      } finally {
        srcSkill.close();
      }
    }
  } catch (err) {
    log.warn('Template skills not materialized: unsafe skills directory', { agentGroupId, path: destPath, err });
  } finally {
    srcDir?.close();
    destDir?.close();
  }
}

/**
 * Split a full skills path into the group folder that anchors it and the
 * segments below. `GROUPS_DIR` is not mounted anywhere, so its direct children
 * are host-owned and safe to open as an anchor root; everything deeper is
 * container-writable and is opened by descriptor, symlinks refused. A path at
 * or above a group folder, or outside `GROUPS_DIR`, has no safe anchor and is
 * refused, as is a relative path or one with `.` or `..` components: those are
 * never what a caller means, so they are not normalized into a group.
 */
function anchorWithinGroupFolder(skillsPath: string): { root: string; segments: readonly string[] } {
  const base = path.resolve(GROUPS_DIR);
  const relative = path.relative(base, path.resolve(skillsPath));
  const [folder, ...segments] = relative.split(path.sep);
  if (
    !path.isAbsolute(skillsPath) ||
    skillsPath.split(/[\\/]/).some((component) => component === '.' || component === '..') ||
    !folder ||
    folder === '..' ||
    path.isAbsolute(relative) ||
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === '.' || segment === '..')
  ) {
    throw new Error(`refusing skills directory outside a group folder: '${skillsPath}'`);
  }
  return { root: path.join(base, folder), segments };
}

/** Delete `name` within `dir` — a symlink by unlink, a tree by anchored recursion. */
function removeEntry(dir: AnchoredDir, name: string, depth: number): void {
  if (depth > MAX_SKILL_TREE_DEPTH) throw new Error('skill tree too deep to remove safely');
  let stat: fs.Stats;
  try {
    stat = dir.lstat(name);
  } catch {
    return; // absent
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    dir.unlink(name);
    return;
  }
  const child = dir.openDir(name);
  if (child) {
    try {
      for (const entry of child.entries()) removeEntry(child, entry, depth + 1);
    } finally {
      child.close();
    }
  }
  dir.rmdir(name);
}

/** Copy the anchored tree `srcDir` into the anchored `destDir`, both by descriptor. */
function copyTree(srcDir: AnchoredDir, destDir: AnchoredDir, depth: number): void {
  if (depth > MAX_SKILL_TREE_DEPTH) throw new Error('skill tree too deep to copy safely');
  for (const entry of srcDir.entries()) {
    let stat: fs.Stats;
    try {
      stat = srcDir.lstat(entry);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      destDir.symlink(srcDir.readlink(entry), entry);
    } else if (stat.isDirectory()) {
      const srcChild = srcDir.openDir(entry);
      if (!srcChild) continue;
      try {
        const destChild = destDir.openDir(entry, true);
        if (!destChild) continue;
        try {
          copyTree(srcChild, destChild, depth + 1);
        } finally {
          destChild.close();
        }
      } finally {
        srcChild.close();
      }
    } else if (stat.isFile()) {
      copyRegularFile(srcDir, entry, destDir, entry);
    }
  }
}
