/**
 * Shared containment guards for per-message inbox directories.
 *
 * Session dirs are mounted writable into agent containers, so a compromised
 * agent can pre-place a symlink inside its own session dir and wait for the
 * host to write through it — landing attacker-influenced bytes outside the
 * sandbox (CWE-59). Both inbound paths that materialise files into a session's
 * `inbox/<messageId>/` directory route through `ensureContainedInboxDir`:
 *   - channel-inbound attachments (`extractAttachmentFiles` in session-manager)
 *   - agent-to-agent forwarded files (`forwardAttachedFiles` in agent-route)
 *
 * Keeping the guard in one place means both paths defend identically; the fix
 * for GHSA #2828 originally lived only in the A2A path and the channel path had
 * the same gap (a symlinked `inbox` root was followed silently).
 */
import fs from 'fs';
import path from 'path';

import { log } from './log.js';

/** True if `child` is `parent` itself or nested within it (no traversal/escape). */
export function isPathInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Resolve and create `<inboxRoot>/<messageId>`, refusing pre-placed symlinks a
 * compromised container could use to redirect host writes outside the session.
 *
 * Guards, in order:
 *   1. lstat the inbox ROOT — reject if it is a symlink or a non-directory.
 *      Without this, a symlinked `inbox` is silently followed by mkdir AND the
 *      containment check in step 4 passes, because it compares against the
 *      already-followed (escaped) root. This is the gap that affected the
 *      channel-inbound path.
 *   2. lstat the per-message subdir — reject a pre-placed symlink/non-dir.
 *      lstat does not follow the final path component, so it sees the link
 *      itself even when the link target does not exist.
 *   3. mkdir the subdir (recursive).
 *   4. realpath containment — the resolved subdir must stay within the resolved
 *      inbox root (defence in depth; symlinks are already ruled out above).
 *
 * Returns the resolved, contained subdir path (write into it with an exclusive
 * flag — `COPYFILE_EXCL` / `wx` — so a pre-existing symlinked *file* can't be
 * followed either), or `null` if any guard tripped. On `null` the caller logs
 * its own context and skips; `context` is merged into the warn logs here so
 * each call site stays diagnosable.
 */
export function ensureContainedInboxDir(
  inboxRoot: string,
  messageId: string,
  context: Record<string, unknown>,
): string | null {
  const inboxDir = path.join(inboxRoot, messageId);

  for (const dir of [inboxRoot, inboxDir]) {
    try {
      const st = fs.lstatSync(dir);
      if (st.isSymbolicLink() || !st.isDirectory()) {
        log.warn('inbox-safety: rejecting unsafe inbox path', { ...context, dir });
        return null;
      }
    } catch {
      // Does not exist yet — fine, mkdir below creates it.
    }
  }

  fs.mkdirSync(inboxDir, { recursive: true });

  try {
    const realInboxDir = fs.realpathSync(inboxDir);
    const realInboxRoot = fs.realpathSync(inboxRoot);
    if (!isPathInside(realInboxRoot, realInboxDir)) {
      log.warn('inbox-safety: inbox dir escaped inbox root', { ...context, inboxDir });
      return null;
    }
    return realInboxDir;
  } catch (err) {
    log.warn('inbox-safety: failed to resolve inbox dir', { ...context, inboxDir, err });
    return null;
  }
}
