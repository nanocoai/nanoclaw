/**
 * Attachments on inbound mail, as the coding session sees them.
 *
 * The host stages a message's files under the session dir
 * (`inbox/<message id>/<name>`, session-manager.ts) and leaves
 * `{ name, type, localPath }` in the content; the session dir is mounted at
 * /workspace, so the file is at `/workspace/<localPath>` from inside. Both
 * readers of mail — the delivery loop's prompt rendering and `ncl inbox read`
 * — describe every attachment through here, so a screenshot with a caption
 * is never delivered as the caption alone.
 */

/** Where the session dir is mounted inside the container. */
export const SESSION_MOUNT = '/workspace';

export interface MailAttachment {
  name: string;
  type: string;
  /** The staged path relative to the session dir, when the host saved the file. */
  localPath: string | null;
  /** The same file as an absolute path inside the container. */
  path: string | null;
  /** A remote location, when the platform gave one and nothing was staged. */
  url: string | null;
}

/** The structured attachments of a parsed content object; [] when there are none. */
export function parseAttachments(content: unknown): MailAttachment[] {
  if (typeof content !== 'object' || content === null) return [];
  const raw = (content as { attachments?: unknown }).attachments;
  if (!Array.isArray(raw)) return [];
  const out: MailAttachment[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const a = entry as Record<string, unknown>;
    const name = str(a.name) || str(a.filename) || 'attachment';
    const type = str(a.type) || 'file';
    const localPath = str(a.localPath) || null;
    const url = str(a.url) || null;
    out.push({ name, type, localPath, path: localPath ? `${SESSION_MOUNT}/${localPath}` : null, url });
  }
  return out;
}

/** One line per attachment: what it is, and where the file is. */
export function describeAttachments(attachments: MailAttachment[]): string[] {
  return attachments.map((a) => {
    if (a.path) return `[${a.type}: ${a.name} — saved to ${a.path}]`;
    return a.url ? `[${a.type}: ${a.name} (${a.url})]` : `[${a.type}: ${a.name}]`;
  });
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
