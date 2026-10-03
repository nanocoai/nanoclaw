import crypto from 'crypto';
import path from 'path';

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
 * Turn an arbitrary message id into a value safe to use as the sole
 * `inbox/<dir>/` (or `outbox/<dir>/`) path component.
 *
 * Some channels hand us opaque tokens (Slack/Discord/WhatsApp) that already
 * pass `isSafeAttachmentName` unchanged — those are returned as-is, so
 * existing staging paths for those channels are untouched.
 *
 * Others (Google Chat's `spaces/<space>/messages/<id>`) are resource paths,
 * not filenames — `isSafeAttachmentName` correctly rejects the path
 * separators they contain, but rejecting them entirely means those channels'
 * attachments are silently dropped (#3206). Instead, derive a single-component
 * slug: unsafe characters (including `/`, `\`, `..`) are collapsed to `-`, and
 * a short SHA-256 suffix of the original id is appended so two ids that only
 * differ in stripped characters can't collide onto the same directory — with
 * the write side's exclusive-create (`wx`) flag, a collision would otherwise
 * surface as a second message's attachments being silently refused.
 *
 * The result always satisfies `isSafeAttachmentName`. Containment against
 * traversal/symlink escape is NOT this function's job — that still comes from
 * `ensureContainedInboxDir` and the `wx`/`COPYFILE_EXCL` flags at the actual
 * writes, unchanged.
 */
export function safeAttachmentDirName(id: string): string {
  if (isSafeAttachmentName(id)) return id;

  const hash = crypto
    .createHash('sha256')
    .update(typeof id === 'string' ? id : String(id), 'utf8')
    .digest('hex')
    .slice(0, 16);

  const raw = typeof id === 'string' ? id : '';
  const slug = raw
    .replace(/[\\/\0]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^\.+/, '')
    .slice(0, 80);

  const candidate = `${slug || 'msg'}-${hash}`;
  // Defensive fallback: should always hold given the construction above, but
  // never hand back a value that fails the very check this function exists
  // to satisfy.
  return isSafeAttachmentName(candidate) ? candidate : hash;
}
