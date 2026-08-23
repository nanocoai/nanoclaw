import fs from 'node:fs';
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

export interface ResolvedInboxAttachment {
  ok: true;
  messageId: string;
  filename: string;
  absolutePath: string;
}
export interface UnresolvedInboxAttachment {
  ok: false;
  reason: string;
}

/**
 * Turns the exact string an agent copies out of its own conversation (e.g.
 * "/workspace/inbox/msg-abc123/photo.jpg" or the bare
 * "inbox/msg-abc123/photo.jpg") into a verified, on-disk path inside
 * `inboxRoot`. Fails closed with a specific, diagnostic reason on anything
 * that doesn't match -- never guesses, never falls back to scanning the
 * inbox for "the" attachment.
 *
 * The general form of the same fix applied locally in
 * lease-manager-filesystem/stage.ts's own resolveAttachmentPath: an agent
 * is never shown the internal NanoClaw message id as a standalone value
 * anywhere in its own conversation -- the `<message id="...">` XML
 * attribute the formatter renders is `msg.seq` (an unrelated sequence
 * number), and Telegram's own platform message id is a third, still
 * different value. The only thing actually and reliably visible to the
 * agent is the composed attachment line itself -- formatter.ts's
 * formatAttachments() renders `[<type>: <name> — saved to
 * /workspace/<localPath>]`, where localPath IS exactly
 * `inbox/<messageId>/<filename>`. So callers take that whole path as one
 * opaque string instead of asking the agent to decompose or infer any ID.
 *
 * Ported from old commit 824318ff, unchanged (pure filesystem logic, no DB
 * access -- not affected by the async DB migration).
 */
export function resolveInboxAttachmentPath(
  inboxRoot: string,
  attachmentPath: string,
): ResolvedInboxAttachment | UnresolvedInboxAttachment {
  let rel = attachmentPath.trim();
  if (rel.startsWith('/workspace/')) rel = rel.slice('/workspace/'.length);
  else if (rel.startsWith('workspace/')) rel = rel.slice('workspace/'.length);

  const segments = rel.split('/').filter((s) => s.length > 0);
  if (segments.length !== 3 || segments[0] !== 'inbox') {
    return {
      ok: false,
      reason:
        `attachment_path must be the exact path shown next to the attachment in this conversation, of the form ` +
        `"inbox/<id>/<filename>" (optionally prefixed "/workspace/") -- received ${JSON.stringify(attachmentPath)}.`,
    };
  }
  const [, messageId, filename] = segments;
  if (!isSafeAttachmentName(messageId) || !isSafeAttachmentName(filename)) {
    return {
      ok: false,
      reason: `attachment_path contains an invalid path segment -- received ${JSON.stringify(attachmentPath)}.`,
    };
  }

  const candidate = path.join(inboxRoot, messageId, filename);

  let realInboxRoot: string;
  try {
    realInboxRoot = fs.realpathSync(inboxRoot);
  } catch {
    return {
      ok: false,
      reason: `this conversation has no inbox yet -- no attachment could have landed. Received ${JSON.stringify(attachmentPath)}.`,
    };
  }

  if (!fs.existsSync(candidate)) {
    return {
      ok: false,
      reason: `no file exists at the resolved path -- the attachment may already have been staged, or the path was mistyped. Received ${JSON.stringify(attachmentPath)}.`,
    };
  }

  let real: string;
  try {
    real = fs.realpathSync(candidate);
  } catch (e) {
    return { ok: false, reason: `could not resolve attachment path: ${e instanceof Error ? e.message : String(e)}` };
  }
  if (real !== realInboxRoot && !real.startsWith(realInboxRoot + path.sep)) {
    return { ok: false, reason: "resolved path escapes this session's own inbox -- refusing." };
  }
  const stat = fs.statSync(real);
  if (!stat.isFile()) {
    return { ok: false, reason: 'resolved path is not a regular file.' };
  }

  return { ok: true, messageId, filename, absolutePath: real };
}
