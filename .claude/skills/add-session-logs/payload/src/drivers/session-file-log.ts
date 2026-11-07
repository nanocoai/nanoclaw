/**
 * Persistent per-session container logs.
 *
 * Registers a session log sink (see `session-log-sink.ts`) that appends every
 * stderr line of a session's container to `logs/sessions/<session-id>.log`.
 * Containers run with `--rm`, so this file is what remains after one exits.
 *
 * Each file is size-bounded: once it reaches the cap, one marker line is
 * written and further lines are dropped. Nothing is ever deleted or rotated.
 *
 * Environment (both optional):
 *   NANOCLAW_SESSION_LOG_DIR        directory for the log files
 *   NANOCLAW_SESSION_LOG_MAX_BYTES  per-file cap in bytes (default 5 MiB)
 */
import fs from 'fs';
import path from 'path';

import { registerSessionLogSink, type SessionLogSink } from './session-log-sink.js';

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

export interface SessionFileSinkOptions {
  dir: string;
  maxBytes: number;
}

/** Session ids become file names; keep them to one path segment. */
function fileNameFor(sessionId: string): string {
  return `${sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.log`;
}

export function createSessionFileSink(opts: () => SessionFileSinkOptions | null): SessionLogSink {
  return (key, runtimeName) => {
    const resolved = opts();
    if (!resolved) return undefined;
    const { dir, maxBytes } = resolved;
    fs.mkdirSync(dir, { recursive: true });
    const fd = fs.openSync(path.join(dir, fileNameFor(key.sessionId)), 'a');
    let size = fs.fstatSync(fd).size;
    let capped = false;

    const append = (text: string): void => {
      const buf = Buffer.from(`${new Date().toISOString()} ${text}\n`);
      fs.writeSync(fd, buf);
      size += buf.length;
    };

    // A restarted container appends to the same file; the header marks the seam.
    if (size < maxBytes) append(`--- container ${runtimeName} started ---`);

    return {
      write(line) {
        if (capped) return;
        if (size >= maxBytes) {
          capped = true;
          append(`--- log capped at ${maxBytes} bytes; further output dropped ---`);
          return;
        }
        append(line);
      },
      close() {
        fs.closeSync(fd);
      },
    };
  };
}

function resolveOptions(): SessionFileSinkOptions | null {
  const override = process.env.NANOCLAW_SESSION_LOG_DIR;
  // Unit tests must not write into the checkout's logs/ directory.
  if (!override && process.env.VITEST) return null;
  const parsed = Number.parseInt(process.env.NANOCLAW_SESSION_LOG_MAX_BYTES ?? '', 10);
  return {
    dir: override || path.join(process.cwd(), 'logs', 'sessions'),
    maxBytes: parsed > 0 ? parsed : DEFAULT_MAX_BYTES,
  };
}

registerSessionLogSink(createSessionFileSink(resolveOptions));
