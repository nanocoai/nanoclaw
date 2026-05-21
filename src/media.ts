import fs from 'fs';
import path from 'path';

const SUPPORTED_VIDEO_MIMES: ReadonlySet<string> = new Set([
  'video/mp4',
  'video/quicktime',
]);

export function isSupportedVideoMime(mime: string | undefined | null): boolean {
  return !!mime && SUPPORTED_VIDEO_MIMES.has(mime);
}

// Image MIMEs all map to .jpg because processImageBuffer (src/image.ts)
// re-encodes everything to JPEG before we ever write to disk. Mapping the
// stored extension to the post-encode format keeps "what's on disk" honest.
const MIME_TO_EXT: ReadonlyMap<string, string> = new Map([
  ['image/jpeg', '.jpg'],
  ['image/png', '.jpg'],
  ['image/gif', '.jpg'],
  ['image/webp', '.jpg'],
  ['image/heic', '.jpg'],
  ['image/heif', '.jpg'],
  ['image/avif', '.jpg'],
  ['video/mp4', '.mp4'],
  ['video/quicktime', '.mov'],
]);

export function mediaExtForMime(mime: string): string {
  const ext = MIME_TO_EXT.get(mime);
  if (!ext) {
    throw new Error(`Unsupported media MIME for extension lookup: ${mime}`);
  }
  return ext;
}

// Slack file IDs are uppercase alphanumeric (e.g. F0XXXXXX). Reject anything
// else upstream so the synthesized filename can never carry a separator,
// dot, or traversal segment into the inbox path.
const SLACK_FILE_ID_PATTERN = /^[A-Z0-9]+$/;

export function inboxFilename(opts: {
  timestamp: Date;
  fileId: string;
  mime: string;
}): string {
  if (!SLACK_FILE_ID_PATTERN.test(opts.fileId)) {
    throw new Error(
      `Invalid file ID for inbox filename (expected uppercase alphanumeric, got ${JSON.stringify(opts.fileId)})`,
    );
  }
  // ISO compact: 2026-05-20T14:30:12.000Z -> 2026-05-20T143012Z. No colons or
  // milliseconds, so the filename is portable across filesystems.
  const iso = opts.timestamp.toISOString();
  const compactTs = iso.replace(/:/g, '').replace(/\.\d+Z$/, 'Z');
  const ext = mediaExtForMime(opts.mime);
  return `${compactTs}-${opts.fileId}${ext}`;
}

export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

// Defense-in-depth path-escape: matches the predicate established at
// src/ipc.ts:594 (image IPC) and src/ipc.ts:659 (video IPC). Permits the root
// itself, requires the separator otherwise so "/groups/main-evil" cannot pass
// a startsWith("/groups/main") check.
function isInside(absChild: string, absRoot: string): boolean {
  return absChild === absRoot || absChild.startsWith(absRoot + path.sep);
}

export async function materializeAttachment(opts: {
  bytes: Buffer;
  relName: string;
  groupFolder: string;
  groupsRoot: string;
}): Promise<string> {
  const absGroupsRoot = path.resolve(opts.groupsRoot);
  const absGroup = path.resolve(absGroupsRoot, opts.groupFolder);
  if (!isInside(absGroup, absGroupsRoot) || absGroup === absGroupsRoot) {
    throw new Error(
      `materializeAttachment: groupFolder escapes groupsRoot (${opts.groupFolder})`,
    );
  }

  const absInbox = path.resolve(absGroup, 'inbox');
  if (!isInside(absInbox, absGroup) || absInbox === absGroup) {
    throw new Error(
      `materializeAttachment: inbox dir escapes group (${absInbox})`,
    );
  }

  const absFile = path.resolve(absInbox, opts.relName);
  if (!isInside(absFile, absInbox) || absFile === absInbox) {
    throw new Error(
      `materializeAttachment: relName escapes inbox (${opts.relName})`,
    );
  }

  fs.mkdirSync(absInbox, { recursive: true });
  fs.writeFileSync(absFile, opts.bytes);
  return path.join('inbox', opts.relName);
}
