/**
 * What a repo self-edit may touch, decided from the patch text alone.
 *
 * A proposal is a `git diff`-format patch. Every file it names must be a
 * plain relative path under an editable prefix and outside the protected
 * set. Renames, copies, symlinks, mode changes and binary hunks are refused
 * outright: each one can change what a path means without the change being
 * readable on the approval card.
 *
 * The protected set is the machinery that makes the edit safe to approve —
 * the guard, the approval chain, this module, the credential gateway, the
 * env reader. An approved edit that loosened any of those would let the
 * next edit skip the human.
 */
export const EDITABLE_PREFIXES = ['src/', 'container/agent-runner/src/', 'container/skills/', 'docs/'];

export const PROTECTED_PREFIXES = [
  'src/modules/repo-self-edit/',
  'container/agent-runner/src/mcp-tools/repo-self-edit.',
  'src/guard/',
  'src/modules/approvals/',
  'src/modules/permissions/',
  'src/modules/mount-security/',
  'src/gateway-providers/',
  'src/gateway-approval-coordinator.ts',
  'src/delivery.ts',
  'src/delivery-guard.ts',
  'src/env.ts',
  'src/upgrade-state.ts',
];

export const MAX_FILES = 20;

/** Lines that change a path's type, mode or identity rather than its text. */
const REFUSED_HEADER_RE =
  /^(rename from |rename to |copy from |copy to |old mode |new mode |similarity index |dissimilarity index |GIT binary patch|Binary files )/;
const FILE_MODE_RE = /^(new|deleted) file mode (\d+)$/;
const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)$/;
const HUNK_PATH_RE = /^(---|\+\+\+) (?:[ab]\/(\S+)|\/dev\/null)$/;

export type PatchFiles = { ok: true; files: string[] } | { ok: false; error: string };

/** Parse the file list out of a git-format patch, refusing anything but text edits. */
export function parsePatchFiles(diff: string): PatchFiles {
  const files: string[] = [];
  for (const line of diff.split('\n')) {
    if (REFUSED_HEADER_RE.test(line)) {
      return { ok: false, error: `patch changes more than file text ("${line.slice(0, 60)}")` };
    }
    const mode = line.match(FILE_MODE_RE);
    if (mode && mode[2] !== '100644' && mode[2] !== '100755') {
      return { ok: false, error: `patch creates or deletes a non-regular file (mode ${mode[2]})` };
    }
    const header = line.match(DIFF_GIT_RE);
    if (header) {
      if (header[1] !== header[2]) return { ok: false, error: `patch renames ${header[1]} to ${header[2]}` };
      files.push(header[1]);
      continue;
    }
    const hunk = line.match(HUNK_PATH_RE);
    if (hunk && hunk[2] !== undefined && !files.includes(hunk[2])) {
      return { ok: false, error: `hunk header names ${hunk[2]}, which has no "diff --git" header` };
    }
  }
  if (files.length === 0)
    return { ok: false, error: 'patch must be in "git diff" format (no "diff --git" header found)' };
  if (new Set(files).size !== files.length) return { ok: false, error: 'patch names the same file twice' };
  if (files.length > MAX_FILES) return { ok: false, error: `patch touches more than ${MAX_FILES} files` };
  return { ok: true, files };
}

/** Why `file` may not be edited, or null when it may. */
export function pathRefusal(file: string): string | null {
  if (file.includes('\0') || file.includes('\\')) return `${JSON.stringify(file)} is not a plain relative path`;
  const segments = file.split('/');
  if (file.startsWith('/') || segments.some((s) => s === '' || s === '.' || s === '..')) {
    return `${JSON.stringify(file)} is not a plain relative path`;
  }
  if (segments.some((s) => s.startsWith('.env'))) return `${file} is an env file`;
  if (!EDITABLE_PREFIXES.some((p) => file.startsWith(p))) {
    return `${file} is outside the editable paths (${EDITABLE_PREFIXES.join(', ')})`;
  }
  const guarded = PROTECTED_PREFIXES.find((p) => file.startsWith(p));
  if (guarded) return `${file} is protected (${guarded}) — it is part of what makes self-edits safe to approve`;
  return null;
}

export interface EditScope {
  host: boolean;
  container: boolean;
}

/** Which runtime has to restart to pick the edit up. Docs-only edits need neither. */
export function editScope(files: string[]): EditScope {
  return {
    host: files.some((f) => f.startsWith('src/')),
    container: files.some((f) => f.startsWith('container/')),
  };
}
