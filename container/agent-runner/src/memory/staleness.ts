/**
 * Memory staleness notices.
 *
 * `memory/` is injected into context only when a provider opens a NEW context
 * window — startup, /clear, compaction (see session-hook.ts) — never on
 * `resume`. And a session's continuation survives container kills, since it
 * lives in outbound.db, a host-mounted file no kill path touches. So a
 * conversation resumes across any number of restarts while its in-context copy
 * of memory/ silently ages: another session, the operator, or `ncl` rewrites
 * the tree and nothing in this conversation ever hears about it.
 *
 * Re-injecting the tree every turn would fix that by spending context on every
 * message to re-carry files that rarely change. Instead, fingerprint the tree
 * between turns and, when something moved, spend one short block naming it. The
 * agent re-reads on demand — memory/ is a bind mount, so the files on disk are
 * authoritative and edits from anywhere are visible immediately.
 *
 * Scope: this watches the whole tree, not just the files this session read. A
 * change to a file this conversation never loaded still produces a notice —
 * deliberate, since narrowing it means instrumenting every Read via PostToolUse
 * and persisting the set, and a spurious line costs less than a missed one.
 *
 * Nothing here throws: a notice is a nicety, and a turn must never fail because
 * memory/ was mid-write.
 */
import fs from 'fs';
import path from 'path';

/** How many paths a notice names before summarizing the remainder. */
const MAX_NAMED = 10;

/**
 * Every file under `<baseDir>/memory` as sorted `path\tmtime:size` lines.
 * mtime+size rather than a content hash: one stat per file instead of a full
 * read, and the only failure mode is a spurious notice on a byte-identical
 * rewrite. A missing or unreadable tree fingerprints as empty.
 */
export function fingerprintMemoryTree(baseDir = '/workspace/agent'): string {
  const root = path.join(baseDir, 'memory');
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { recursive: true, withFileTypes: true });
  } catch {
    return '';
  }
  return entries
    .filter((entry) => entry.isFile()) // Excludes symlinks; recursion never follows them either.
    .map((entry) => {
      const full = path.join(entry.parentPath, entry.name);
      try {
        const { mtimeMs, size } = fs.statSync(full);
        return `${path.relative(root, full)}\t${Math.trunc(mtimeMs)}:${size}`;
      } catch {
        return ''; // Vanished between readdir and stat; the next turn re-walks.
      }
    })
    .filter(Boolean)
    .sort()
    .join('\n');
}

function stamps(fingerprint: string): Map<string, string> {
  return new Map(
    fingerprint
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf('\t');
        return [line.slice(0, tab), line.slice(tab + 1)];
      }),
  );
}

/**
 * What to tell a resumed conversation about memory edits it hasn't seen.
 * Undefined when nothing moved, or when there is no baseline yet — a session's
 * first turn establishes one rather than reporting the whole tree as new.
 */
export function memoryChangeNotice(previous: string | undefined, baseDir?: string): string | undefined {
  // Strictly undefined, not falsy: '' is a real baseline — a tree that was
  // empty last turn — so the first file to appear in it still gets reported.
  if (previous === undefined) return undefined;

  const before = stamps(previous);
  const after = stamps(fingerprintMemoryTree(baseDir));

  // Both maps come from sorted fingerprints, so this order is deterministic.
  const changes: string[] = [];
  for (const [file, stamp] of after) {
    if (!before.has(file)) changes.push(`added: memory/${file}`);
    else if (before.get(file) !== stamp) changes.push(`modified: memory/${file}`);
  }
  for (const file of before.keys()) {
    if (!after.has(file)) changes.push(`removed: memory/${file}`);
  }
  if (changes.length === 0) return undefined;

  const named = changes.slice(0, MAX_NAMED).map((change) => `  ${change}`);
  if (changes.length > named.length) named.push(`  ...and ${changes.length - named.length} more`);

  return [
    '<memory_changed>',
    'These files under /workspace/agent/memory/ changed since this conversation',
    'last loaded memory, so any copy of them already in your context is stale:',
    ...named,
    'The files on disk are authoritative. Re-read the ones relevant to this turn',
    'before answering from memory.',
    '</memory_changed>',
  ].join('\n');
}
