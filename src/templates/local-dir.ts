import fs from 'fs';
import path from 'path';

import { TEMPLATES_DIR } from '../config.js';

/**
 * Resolve a LOCAL template ref to an absolute directory under `base`
 * (TEMPLATES_DIR by default). Lexical containment only — no realpathSync, no
 * symlink resolution (out of threat model). Mirrors ensureWithinBase() in
 * group-folder.ts. Refs are legitimately multi-segment (e.g. "sales/sdr"), so
 * this does NOT reuse isValidGroupFolder (which rejects "/").
 *
 * Rejects: empty / untrimmed refs, absolute paths, a leading "~", and any ref
 * that escapes `base` after resolution. Throws if the resolved path is missing
 * or not a directory.
 */
export function resolveLocalTemplate(ref: string, base: string = TEMPLATES_DIR): string {
  if (!ref || ref !== ref.trim()) {
    throw new Error(`Invalid template ref: "${ref}"`);
  }
  if (path.isAbsolute(ref) || ref.startsWith('~')) {
    throw new Error(`Template ref must be relative to the templates directory: "${ref}"`);
  }
  const candidate = path.resolve(base, ref);
  const rel = path.relative(base, candidate);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error(`Template ref escapes the templates directory: "${ref}"`);
  }
  if (!fs.existsSync(candidate) || !fs.statSync(candidate).isDirectory()) {
    throw new Error(`Template not found: "${ref}" (looked in ${base})`);
  }
  return candidate;
}
