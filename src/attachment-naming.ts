/**
 * Derive a safe, extensioned filename for inbound attachments when the
 * channel bridge passes data without an explicit `name`.
 *
 * Two-step lookup:
 *   1. `mimeType` → extension (Discord/Slack documents, Telegram document
 *      uploads — channels that set the MIME but not a filename).
 *   2. `att.type` → extension (Telegram photos/stickers/voice/animations —
 *      coarse media-class set by the chat-sdk bridge with no MIME).
 *
 * Output is still passed through `isSafeAttachmentName` at the call site.
 * The maps emit static values, so no derivation path can construct a
 * traversal payload — only an attacker-controlled `att.name` can, and that
 * goes through the safety guard unchanged.
 */

// Map common MIME types to canonical file extensions. Without an extension,
// agents (and humans) can't tell what kind of file landed in the inbox, and
// tools keyed on extension (image viewers, exiftool, etc.) misbehave.
const MIME_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/heic': 'heic',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/wav': 'wav',
  'audio/mp4': 'm4a',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/quicktime': 'mov',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
  'application/zip': 'zip',
};

// Fallback when `mimeType` is missing — Telegram photos and stickers arrive
// without an explicit MIME on the attachment object. The channel bridge sets
// `att.type` to a coarse media-class (`photo` / `sticker` / `voice` / etc.)
// which is reliable enough to derive a canonical extension. Telegram's GIFs
// are actually MP4, hence `animation: 'mp4'`.
const TYPE_TO_EXT: Record<string, string> = {
  image: 'jpg',
  photo: 'jpg',
  sticker: 'webp',
  voice: 'ogg',
  audio: 'mp3',
  video: 'mp4',
  animation: 'mp4',
};

// The reverse direction, for files the agent sends *out*. Derived from
// MIME_TO_EXT so the two can't drift, plus the spellings that map onto a MIME
// already listed above but aren't its canonical extension.
const EXT_TO_MIME: Record<string, string> = {
  ...Object.fromEntries(Object.entries(MIME_TO_EXT).map(([mime, ext]) => [ext, mime])),
  jpeg: 'image/jpeg',
  htm: 'text/html',
  html: 'text/html',
  csv: 'text/csv',
  md: 'text/markdown',
  svg: 'image/svg+xml',
};

export function extForMime(mime: unknown): string {
  if (typeof mime !== 'string' || !mime) return '';
  const clean = mime.split(';')[0].trim().toLowerCase();
  return MIME_TO_EXT[clean] ?? '';
}

/**
 * MIME type for an outbound filename, or undefined when the extension isn't
 * one we recognize.
 *
 * Undefined rather than 'application/octet-stream': adapters already default
 * to that, and a caller that can do something smarter with "unknown" should
 * not have the guess handed to it as though it were a fact.
 */
export function mimeForFilename(filename: unknown): string | undefined {
  if (typeof filename !== 'string') return undefined;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return undefined;
  return EXT_TO_MIME[filename.slice(dot + 1).toLowerCase()];
}

export function deriveAttachmentName(att: Record<string, unknown>): string {
  const explicit = att.name;
  if (typeof explicit === 'string' && explicit) return explicit;
  let ext = extForMime(att.mimeType);
  if (!ext && typeof att.type === 'string') {
    ext = TYPE_TO_EXT[att.type.toLowerCase()] ?? '';
  }
  const ts = Date.now();
  return ext ? `attachment-${ts}.${ext}` : `attachment-${ts}`;
}
