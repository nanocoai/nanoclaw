import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** Suffix identifying persistent per-group files composed before the shared instructions. */
export const GROUP_PREPEND_SUFFIX = '.prepend.md';

/** Primary per-group prepend, always composed before sibling prepend files. */
export const PERSONA_PREPEND_FILE = `instructions${GROUP_PREPEND_SUFFIX}`;

/**
 * Create a group's standing instructions without following or replacing an
 * existing path. Returns false when the content is empty or the path exists.
 */
export function stageGroupPersona(groupDir: string, instructions: string): boolean {
  const content = instructions.trimEnd();
  if (!content.trim()) return false;

  fs.mkdirSync(groupDir, { recursive: true });
  try {
    fs.writeFileSync(path.join(groupDir, PERSONA_PREPEND_FILE), `${content}\n`, { flag: 'wx' });
    return true;
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'EEXIST') return false;
    throw err;
  }
}

/** Read a group's prepend files without following symlinks. */
export function readGroupPersona(groupDir: string): string | null {
  let prependFiles: string[];
  try {
    prependFiles = listPrependFiles(groupDir);
    // eslint-disable-next-line no-catch-all/no-catch-all -- standing instructions are best-effort; filesystem errors must not block agent spawn
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not enumerate group standing instructions; omitting prepend files', {
      groupDir,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }

  const sections: string[] = [];
  for (const file of prependFiles) {
    const content = readPrependFile(path.join(groupDir, file));
    if (content) sections.push(content);
  }
  return sections.length > 0 ? sections.join('\n\n') : null;
}

function listPrependFiles(groupDir: string): string[] {
  const files = fs.readdirSync(groupDir).filter((file) => file.endsWith(GROUP_PREPEND_SUFFIX));
  const siblings = files.filter((file) => file !== PERSONA_PREPEND_FILE).sort();
  return files.includes(PERSONA_PREPEND_FILE) ? [PERSONA_PREPEND_FILE, ...siblings] : siblings;
}

function readPrependFile(file: string): string | null {
  let fd: number | undefined;
  try {
    // Refuse symlinks, and do not wait on special files before fstat rejects them.
    const safeReadFlags = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK;
    fd = fs.openSync(file, safeReadFlags);
    if (!fs.fstatSync(fd).isFile()) return null;
    return fs.readFileSync(fd, 'utf-8').trim() || null;
    // eslint-disable-next-line no-catch-all/no-catch-all -- one unreadable prepend must not block agent spawn or the remaining prepends
  } catch (err) {
    if (typeof err === 'object' && err !== null && 'code' in err && err.code === 'ENOENT') return null;
    log.warn('Could not read group standing instructions; omitting prepend file', {
      file,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}
