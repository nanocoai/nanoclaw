/**
 * Image attachment → content block extraction.
 *
 * The host's chat-sdk-bridge writes attachment metadata into messages_in
 * rows with a `localPath` field (relative to `/workspace/`) and strips the
 * base64 `data` field — the actual bytes are spilled to
 * `<sessionDir>/inbox/<messageId>/<filename>` to keep the DB small. Inside
 * the container that file is mounted at `/workspace/<localPath>`.
 *
 * For multimodal-capable providers (Claude), we load each image attachment's
 * bytes back into a base64 content block here. The block is delivered as a
 * separate user-turn message after the text prompt — mirrors v1's
 * `pushMultimodal` pattern.
 *
 * Non-image attachments (audio, pdf) are NOT handled here — those are
 * host-side preprocessed into inline text (`transcription` for voice,
 * extracted `text` for PDFs) by the chat-sdk-bridge, and rendered by the
 * formatter alongside the message body.
 */

import fs from 'fs';
import path from 'path';

import type { MessageInRow } from './db/messages-in.js';
import type { ContentBlock, ImageContentBlock, ImageMediaType } from './providers/types.js';

const DEFAULT_WORKSPACE_ROOT = '/workspace';

/**
 * Test-only override of the workspace root. Production uses the constant
 * `/workspace`; tests inject a tempdir via `setWorkspaceRootForTests`.
 */
let WORKSPACE_ROOT = DEFAULT_WORKSPACE_ROOT;

export function setWorkspaceRootForTests(root: string | null): void {
  WORKSPACE_ROOT = root ?? DEFAULT_WORKSPACE_ROOT;
}

/**
 * Max image bytes to forward as a content block. Anthropic's Messages API
 * tops out at 5MB per image; we leave a small buffer for base64 expansion
 * and aggregate guard the call site. If an attachment is over the cap, the
 * formatter's text rendering still references it via `localPath` so the
 * agent can `Read` it as a fallback.
 */
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** Mime types the Messages API accepts for `type: 'image'`. */
const SUPPORTED_IMAGE_MIME = new Set<ImageMediaType>([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
]);

function isSupportedImageMime(mime: string): mime is ImageMediaType {
  return (SUPPORTED_IMAGE_MIME as Set<string>).has(mime);
}

function log(msg: string): void {
  console.error(`[multimodal] ${msg}`);
}

interface AttachmentLike {
  type?: string;
  mimeType?: string;
  localPath?: string;
  skipMultimodal?: boolean;
  name?: string;
}

interface ParsedContent {
  attachments?: AttachmentLike[];
}

function safeParse(json: string): ParsedContent {
  try {
    return JSON.parse(json) as ParsedContent;
  } catch {
    return {};
  }
}

/**
 * Resolve a host-relative attachment localPath into an in-container absolute
 * path under `/workspace/` and confirm it stays inside the workspace root.
 * Returns null if the path tries to escape (e.g. via `..`).
 */
function resolveContainerPath(localPath: string): string | null {
  if (!localPath) return null;
  if (path.isAbsolute(localPath)) return null;
  const abs = path.resolve(WORKSPACE_ROOT, localPath);
  const rel = path.relative(WORKSPACE_ROOT, abs);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  return abs;
}

/**
 * Read every image attachment out of `messages` and return a content-block
 * array suitable for `AgentQuery.pushBlocks`. Skips: non-image types,
 * unsupported mime types, files that don't exist on disk, files that exceed
 * `MAX_IMAGE_BYTES`, and any attachment whose `skipMultimodal` flag is set
 * (host-side opt-out for groups configured with `skipImageMultimodal`).
 */
export function extractImageBlocks(messages: MessageInRow[]): ContentBlock[] {
  const blocks: ContentBlock[] = [];

  for (const msg of messages) {
    if (msg.kind !== 'chat' && msg.kind !== 'chat-sdk') continue;
    const content = safeParse(msg.content);
    const atts = content.attachments;
    if (!Array.isArray(atts) || atts.length === 0) continue;

    for (const att of atts) {
      const mime = (att.mimeType || '').toLowerCase();
      if (!mime.startsWith('image/')) continue;
      if (att.skipMultimodal === true) continue;
      if (!isSupportedImageMime(mime)) {
        log(`Skip unsupported image mime: ${mime} (${att.name || '?'})`);
        continue;
      }
      if (!att.localPath) {
        log(`Skip image without localPath: ${att.name || '?'}`);
        continue;
      }

      const abs = resolveContainerPath(att.localPath);
      if (!abs) {
        log(`Refused unsafe localPath: ${att.localPath}`);
        continue;
      }

      let bytes: Buffer;
      try {
        const stat = fs.statSync(abs);
        if (stat.size > MAX_IMAGE_BYTES) {
          log(`Skip oversize image (${stat.size}B > ${MAX_IMAGE_BYTES}B): ${att.localPath}`);
          continue;
        }
        bytes = fs.readFileSync(abs);
      } catch (err) {
        log(`Failed to read image at ${abs}: ${err instanceof Error ? err.message : String(err)}`);
        continue;
      }

      const block: ImageContentBlock = {
        type: 'image',
        source: {
          type: 'base64',
          media_type: mime,
          data: bytes.toString('base64'),
        },
      };
      blocks.push(block);
    }
  }

  return blocks;
}
