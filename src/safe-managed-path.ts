import fs from 'fs';
import path from 'path';

/**
 * Ensure a host-managed directory that lives under a container-writable parent
 * is a real directory and does not escape that parent through a symlink.
 *
 * Host maintenance code must not follow paths that the container can replace
 * with symlinks. Otherwise a prompt-injected or compromised agent can make the
 * host delete or write files outside the intended group/session directory on
 * the next spawn.
 */
export function ensureManagedDirectory(parentDir: string, childDir: string, label: string): void {
  const resolvedParent = path.resolve(parentDir);
  const resolvedChild = path.resolve(childDir);

  if (!isPathInside(resolvedParent, resolvedChild)) {
    throw new Error(`${label} must be inside ${resolvedParent}: ${resolvedChild}`);
  }

  const parentReal = fs.realpathSync(resolvedParent);

  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(resolvedChild);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') throw err;
    fs.mkdirSync(resolvedChild, { recursive: true });
    stat = fs.lstatSync(resolvedChild);
  }

  if (stat.isSymbolicLink()) {
    throw new Error(`${label} must be a real directory, not a symlink: ${resolvedChild}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`${label} must be a directory: ${resolvedChild}`);
  }

  const childReal = fs.realpathSync(resolvedChild);
  if (!isPathInside(parentReal, childReal)) {
    throw new Error(`${label} escapes ${parentReal}: ${childReal}`);
  }
}

function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!!relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}
