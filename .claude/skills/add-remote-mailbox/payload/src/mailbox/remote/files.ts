/**
 * File operations of the remote mailbox: inbox listing/reading and chunked
 * outbox writes.
 *
 * The session directory is agent-writable in the local deployment, so every
 * access goes through AnchoredDir: each component is opened by descriptor with
 * O_NOFOLLOW, symlinks are refused, only regular files are opened, and a FIFO
 * can never block the host (O_NONBLOCK + fstat).
 */
import crypto from 'crypto';
import fs from 'fs';

import { AnchoredDir, copyRegularFile } from '../../anchored-dir.js';
import { isSafeAttachmentName } from '../../attachment-safety.js';
import { sessionMailboxDir } from '../sqlite/paths.js';
import { isSafeMailboxId, isSafeOutboxFilename } from './ids.js';
import type { RemoteSessionKey } from './ids.js';

export const MAX_INBOX_READ_BYTES = 4 * 1024 * 1024;
const MAX_INBOX_DEPTH = 8;
const MAX_INBOX_ENTRIES = 10_000;

/** A request the client got wrong, or one that tried to leave its sandbox. */
export class PathRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PathRejectedError';
  }
}

function sessionRoot(key: RemoteSessionKey): string {
  return sessionMailboxDir(key);
}

/** Split a client-supplied relative path into safe segments or throw. */
function safeSegments(rel: unknown): string[] {
  if (typeof rel !== 'string' || rel.length === 0 || rel.length > 4096) throw new PathRejectedError('invalid path');
  if (rel.includes('\0') || rel.includes('\\') || rel.startsWith('/')) throw new PathRejectedError('invalid path');
  const segments = rel.split('/');
  if (segments.length > MAX_INBOX_DEPTH + 1 || segments.some((s) => !isSafeAttachmentName(s))) {
    throw new PathRejectedError('invalid path');
  }
  return segments;
}

function errnoOf(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

/** Move regular file `from` to `to` inside `dir`. Whatever held `to` (a planted symlink too) is removed, never followed. */
function moveEntry(dir: AnchoredDir, from: string, to: string): void {
  try {
    dir.unlink(to);
  } catch (err) {
    if (errnoOf(err) !== 'ENOENT') throw err;
  }
  copyRegularFile(dir, from, dir, to);
  dir.unlink(from);
}

function openRejecting(root: string, segments: string[], create: boolean): AnchoredDir | null {
  try {
    return AnchoredDir.open(root, segments, create);
  } catch (err) {
    throw new PathRejectedError(`refused: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface InboxEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

export function inboxList(key: RemoteSessionKey): InboxEntry[] {
  const root = openRejecting(sessionRoot(key), ['inbox'], false);
  if (!root) return [];
  const out: InboxEntry[] = [];
  const walk = (dir: AnchoredDir, prefix: string, depth: number): void => {
    for (const name of dir.entries().sort()) {
      if (out.length >= MAX_INBOX_ENTRIES) return;
      if (!isSafeAttachmentName(name)) continue;
      let st: fs.Stats;
      try {
        st = dir.lstat(name);
      } catch {
        continue;
      }
      // Symlinks, FIFOs, sockets and devices are never listed.
      if (st.isFile()) {
        out.push({ path: `${prefix}${name}`, size: st.size, mtimeMs: st.mtimeMs });
      } else if (st.isDirectory() && depth < MAX_INBOX_DEPTH) {
        let child: AnchoredDir | null = null;
        try {
          child = dir.openDir(name);
        } catch {
          continue;
        }
        if (!child) continue;
        try {
          walk(child, `${prefix}${name}/`, depth + 1);
        } finally {
          child.close();
        }
      }
    }
  };
  try {
    walk(root, '', 0);
  } finally {
    root.close();
  }
  return out;
}

export function inboxRead(
  key: RemoteSessionKey,
  rel: unknown,
  offset: unknown,
  length: unknown,
): { data: string; eof: boolean } {
  const segments = safeSegments(rel);
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new PathRejectedError('invalid offset');
  if (!Number.isSafeInteger(length) || (length as number) < 0 || (length as number) > MAX_INBOX_READ_BYTES) {
    throw new PathRejectedError('invalid length');
  }
  const leaf = segments[segments.length - 1];
  const dir = openRejecting(sessionRoot(key), ['inbox', ...segments.slice(0, -1)], false);
  if (!dir) throw new PathRejectedError('not found');
  try {
    let fd: number;
    try {
      fd = dir.openReadFd(leaf);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') throw new PathRejectedError('not found');
      throw new PathRejectedError('refused: not a regular file');
    }
    try {
      const size = fs.fstatSync(fd).size;
      const buffer = Buffer.alloc(Math.min(length as number, Math.max(0, size - (offset as number))));
      const read = buffer.length === 0 ? 0 : fs.readSync(fd, buffer, 0, buffer.length, offset as number);
      return { data: buffer.subarray(0, read).toString('base64'), eof: (offset as number) + read >= size };
    } finally {
      fs.closeSync(fd);
    }
  } finally {
    dir.close();
  }
}

function partName(filename: string): string {
  // Leading dot: can never collide with a client filename (those may not start with one).
  return `.part-${crypto.createHash('sha256').update(filename).digest('hex').slice(0, 24)}`;
}

function sameBytes(dir: AnchoredDir, name: string, offset: number, data: Buffer): boolean {
  let fd: number;
  try {
    fd = dir.openReadFd(name);
  } catch {
    return false;
  }
  try {
    if (fs.fstatSync(fd).size !== offset + data.length) return false;
    const buffer = Buffer.alloc(data.length);
    const read = data.length === 0 ? 0 : fs.readSync(fd, buffer, 0, data.length, offset);
    return read === data.length && buffer.equals(data);
  } finally {
    fs.closeSync(fd);
  }
}

/** True when this exact chunk was already applied; completes a pending rename for a final replay. */
function isReplay(
  dir: AnchoredDir,
  tmp: string,
  filename: string,
  offset: number,
  data: Buffer,
  final: boolean,
): boolean {
  if (sameBytes(dir, tmp, offset, data)) {
    if (final) moveEntry(dir, tmp, filename);
    return true;
  }
  // The final chunk was applied and renamed before the reply was lost.
  return final && sameBytes(dir, filename, offset, data);
}

/**
 * Append one chunk of `outbox/<messageId>/<filename>`. Chunks accumulate in a
 * temp name inside the same directory; the final chunk renames it into place.
 * `offset` 0 starts the file over; any other offset must equal the bytes
 * already staged.
 */
export function outboxWrite(
  key: RemoteSessionKey,
  messageId: unknown,
  filename: unknown,
  offset: unknown,
  dataBase64: unknown,
  final: unknown,
): null {
  if (!isSafeMailboxId(messageId)) throw new PathRejectedError('invalid message id');
  if (!isSafeOutboxFilename(filename)) throw new PathRejectedError('invalid filename');
  if (!Number.isSafeInteger(offset) || (offset as number) < 0) throw new PathRejectedError('invalid offset');
  if (typeof dataBase64 !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(dataBase64)) {
    throw new PathRejectedError('invalid data');
  }
  if (typeof final !== 'boolean') throw new PathRejectedError('invalid final flag');
  const data = Buffer.from(dataBase64, 'base64');

  const dir = openRejecting(sessionRoot(key), ['outbox', messageId], true);
  if (!dir) throw new PathRejectedError('session directory missing');
  try {
    const tmp = partName(filename);
    if (offset === 0) {
      try {
        dir.unlink(tmp);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    } else {
      let staged = -1;
      try {
        staged = dir.lstat(tmp).size;
      } catch {
        /* nothing staged */
      }
      if (staged !== offset) {
        // Replay of a chunk already applied (the client lost our reply): same bytes at the same place.
        if (isReplay(dir, tmp, filename, offset as number, data, final)) return null;
        throw new PathRejectedError(`offset ${String(offset)} does not match staged size`);
      }
    }
    try {
      dir.appendFile(tmp, data);
    } catch (err) {
      throw new PathRejectedError(`refused: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (final) moveEntry(dir, tmp, filename);
    return null;
  } finally {
    dir.close();
  }
}
