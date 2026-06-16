/**
 * File delivery via the outbox.
 *
 * A file is delivered in two parts that must stay in lockstep: the bytes are
 * staged under `/workspace/outbox/<id>/<filename>` (the host reads them from
 * there after polling), and a `messages_out` row carries `{ files: [name] }`
 * so the host knows to attach them. This helper owns that contract so the two
 * callers — the `send_file` MCP tool (model-driven) and the poll-loop's `file`
 * event consumer (harness-generated images) — can't drift apart.
 */
import fs from 'fs';
import path from 'path';

import { writeMessageOut } from './db/messages-out.js';

/** Where staged files live. Overridable for tests; production is always the mount. */
function outboxBase(): string {
  return process.env.NANOCLAW_OUTBOX_DIR ?? '/workspace/outbox';
}

function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export interface FileOutRouting {
  platform_id: string;
  channel_type: string;
  thread_id: string | null;
  in_reply_to?: string | null;
}

export interface EnqueueFileOut {
  /** Absolute or already-resolved path to the file to deliver. Must exist. */
  srcPath: string;
  routing: FileOutRouting;
  /** Optional accompanying message text. */
  text?: string;
  /** Display name; defaults to the basename of `srcPath`. */
  filename?: string;
}

/**
 * Stage a file into the outbox and enqueue its `messages_out` row.
 *
 * Throws if `srcPath` cannot be read/copied — callers decide whether that
 * should surface to the user (the MCP tool validates existence first; the
 * poll-loop consumer logs and moves on so one bad image can't fail the turn).
 */
export function enqueueFileOut(opts: EnqueueFileOut): { id: string; filename: string; seq: number } {
  const id = generateId();
  const filename = opts.filename ?? path.basename(opts.srcPath);

  const outboxDir = path.join(outboxBase(), id);
  fs.mkdirSync(outboxDir, { recursive: true });
  fs.copyFileSync(opts.srcPath, path.join(outboxDir, filename));

  const seq = writeMessageOut({
    id,
    in_reply_to: opts.routing.in_reply_to ?? null,
    kind: 'chat',
    platform_id: opts.routing.platform_id,
    channel_type: opts.routing.channel_type,
    thread_id: opts.routing.thread_id,
    content: JSON.stringify({ text: opts.text ?? '', files: [filename] }),
  });

  return { id, filename, seq };
}
