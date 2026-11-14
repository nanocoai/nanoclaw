import crypto from 'crypto';
import path from 'path';

/** First character of every encoded inbox folder name; see `inboxFolderName`. */
const ENCODED_FOLDER_MARK = '~';
/** Longest single path component (in bytes) common filesystems accept. */
const MAX_FOLDER_NAME_BYTES = 255;

/**
 * Is `name` safe to use as the last segment of a path inside an
 * attachment-staging directory? Filenames originate from untrusted sources —
 * channel messages from any chat participant, agent-to-agent forwards from
 * a possibly-compromised peer agent — and land in `path.join(dir, name)`
 * sinks on the host. Without this guard, a `..`-laden name escapes the
 * inbox and writes anywhere the host process has filesystem permission.
 *
 * Rejects:
 *   - non-string / empty
 *   - `.` / `..` (traversal sentinels that path.basename returns as-is)
 *   - anything containing a path separator (`/` or `\`) or NUL
 *   - any value where `path.basename(name) !== name`, catching OS-specific
 *     separators and covering drives/prefixes on Windows runtimes
 */
export function isSafeAttachmentName(name: string): boolean {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name === '.' || name === '..') return false;
  if (/[\\/\0]/.test(name)) return false;
  return path.basename(name) === name;
}

/**
 * Folder under `inbox/` for a message's attachments, or null to refuse the id.
 * Ids can contain `/`, so an id that is already a safe name keeps it (existing
 * folders never move) and any other becomes `~<slug>-<hash>`; safe ids starting
 * with `~` are encoded too, so no id can name another message's folder.
 */
export function inboxFolderName(messageId: string): string | null {
  if (typeof messageId !== 'string' || messageId.length === 0 || messageId.includes('\0')) return null;
  if (
    isSafeAttachmentName(messageId) &&
    !messageId.startsWith(ENCODED_FOLDER_MARK) &&
    Buffer.byteLength(messageId, 'utf8') <= MAX_FOLDER_NAME_BYTES
  ) {
    return messageId;
  }
  if (path.posix.isAbsolute(messageId) || path.win32.isAbsolute(messageId)) return null;
  if (messageId.split(/[\\/]/).some((segment) => segment === '.' || segment === '..')) return null;

  const hash = crypto.createHash('sha256').update(messageId, 'utf8').digest('hex').slice(0, 16);
  const slug = messageId
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .slice(0, 64)
    .replace(/^-+|-+$/g, '');
  return `${ENCODED_FOLDER_MARK}${slug ? `${slug}-` : ''}${hash}`;
}
