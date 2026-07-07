// Read-only file viewer for clidash.
//
// Surfaces on-disk documents (skills, CLAUDE.md, profile.json, conversations)
// that are NOT ncl resources. Same security posture as the rest of clidash:
// only files matching a configured collection's glob patterns are listable or
// readable; a deny-list blocks secrets; path traversal is impossible because a
// requested path must be a member of the freshly-globbed allow-set.

import { readdirSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';

// Convert one glob segment to an anchored regex. `*` matches any run of
// non-slash chars (so it works both as a whole segment and inside a filename,
// e.g. `CLAUDE*.md`). All other regex metacharacters are escaped.
function segToRegExp(seg) {
  const esc = seg.replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '[^/]*');
  return new RegExp('^' + esc + '$');
}

// A path is denied if any of its segments matches any deny glob.
function isDenied(relPath, deny) {
  const segs = relPath.split('/');
  return deny.some((d) => {
    const re = segToRegExp(d);
    return segs.some((s) => re.test(s));
  });
}

// Directed walk: descend only entries matching each successive pattern segment.
function walk(root, rel, segs, depth, out, deny) {
  if (depth >= segs.length) return;
  let entries;
  try {
    entries = readdirSync(join(root, rel), { withFileTypes: true });
  } catch {
    return;
  }
  const re = segToRegExp(segs[depth]);
  const last = depth === segs.length - 1;
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    if (!re.test(e.name)) continue;
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    if (isDenied(childRel, deny)) continue;
    if (last) {
      if (e.isFile()) out.add(childRel);
    } else if (e.isDirectory()) {
      walk(root, childRel, segs, depth + 1, out, deny);
    }
  }
}

/**
 * Relative paths under `root` matching any of `patterns`, minus `deny` matches.
 * Sorted, de-duplicated. Patterns use `*` per the segment rules above; no `**`.
 */
export function globFiles(root, patterns, deny = []) {
  const out = new Set();
  for (const pattern of patterns) {
    walk(root, '', pattern.split('/'), 0, out, deny);
  }
  return [...out].sort();
}

/**
 * Human-friendly grouping/label for a relative path.
 * `groups/<g>/...` → group `<g>`; `container/...` → group `shared`.
 */
const CONTAINER_SEGS = new Set(['skills', 'conversations']); // redundant grouping dirs
export function describeFile(relPath) {
  const parts = relPath.split('/');
  if (parts[0] === 'groups' && parts.length > 2) {
    const rest = parts.slice(2).filter((s) => !CONTAINER_SEGS.has(s)).join('/');
    return { group: parts[1], label: `${parts[1]} / ${rest}` };
  }
  if (parts[0] === 'container') {
    const rest = parts.slice(2).filter((s) => !CONTAINER_SEGS.has(s)).join('/');
    return { group: 'shared', label: `shared / ${rest}` };
  }
  return { group: '', label: relPath };
}

/**
 * Validate a requested doc path against a collection and return its absolute
 * path, or throw. A path is allowed only if it is a member of the collection's
 * freshly-globbed allow-set — this single check enforces the patterns, the
 * deny-list, and traversal safety at once.
 */
export function resolveDoc(root, collection, relPath, deny = []) {
  const allowed = new Set(globFiles(root, collection.patterns, deny));
  if (!allowed.has(relPath)) {
    throw new Error(`Path not allowed: ${relPath}`);
  }
  // Defence in depth: the resolved real path must still live under root.
  const abs = resolve(root, relPath);
  const rootReal = realpathSync(root);
  const absReal = realpathSync(abs);
  if (absReal !== rootReal && !absReal.startsWith(rootReal + sep)) {
    throw new Error(`Path not allowed: ${relPath}`);
  }
  return abs;
}
