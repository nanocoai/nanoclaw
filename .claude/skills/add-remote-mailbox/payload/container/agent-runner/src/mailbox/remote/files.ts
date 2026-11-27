/**
 * Inbox download / outbox upload over the mailbox channel.
 *
 * The host is a separate trust domain from the files it names: every path it
 * sends is validated and confined to the local inbox root before anything is
 * written, and symlinks are never followed.
 */
import fs from 'node:fs';
import path from 'node:path';

export type RpcCall = <T = unknown>(op: string, args?: unknown[]) => T;

export const INBOX_CHUNK_BYTES = 3 * 1024 * 1024;
export const OUTBOX_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_INBOX_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface InboxEntry {
  path: string;
  size: number;
  mtimeMs: number;
}

/** Returns the absolute destination for a host-supplied relative path, or null if it is unsafe. */
export function resolveInboxPath(root: string, relative: unknown): string | null {
  if (typeof relative !== 'string' || relative === '' || relative.length > 1024) return null;
  if (relative.includes('\0') || relative.includes('\\') || relative.startsWith('/')) return null;
  const segments = relative.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return null;
  const resolved = path.resolve(root, ...segments);
  return resolved.startsWith(path.resolve(root) + path.sep) ? resolved : null;
}

function mkdirNoSymlinks(root: string, target: string): boolean {
  fs.mkdirSync(root, { recursive: true });
  const rel = path.relative(root, target);
  let current = root;
  for (const segment of rel.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats | undefined;
    try {
      stat = fs.lstatSync(current);
    } catch {
      stat = undefined;
    }
    if (!stat) {
      if (current === target) return true; // leaf is the file itself; caller writes it
      fs.mkdirSync(current);
    } else if (stat.isSymbolicLink()) {
      return false;
    } else if (current !== target && !stat.isDirectory()) {
      return false;
    }
  }
  return true;
}

function upToDate(dest: string, entry: InboxEntry): boolean {
  try {
    const stat = fs.lstatSync(dest);
    return stat.isFile() && stat.size === entry.size && Math.abs(stat.mtimeMs - entry.mtimeMs) < 2;
  } catch {
    return false;
  }
}

/** Downloads new or changed inbox files into `root`. Returns the paths written. */
export function syncInbox(call: RpcCall, root: string): string[] {
  const listing = call<InboxEntry[]>('inboxList');
  const written: string[] = [];
  if (!Array.isArray(listing)) return written;

  for (const entry of listing) {
    const dest = resolveInboxPath(root, entry?.path);
    if (!dest || !Number.isFinite(entry.size) || !Number.isFinite(entry.mtimeMs)) {
      console.error(`[mailbox] Ignoring unsafe inbox entry from host: ${JSON.stringify(entry?.path)}`);
      continue;
    }
    if (upToDate(dest, entry)) continue;
    if (!mkdirNoSymlinks(path.resolve(root), dest)) {
      console.error(`[mailbox] Refusing to write through a symlink: ${entry.path}`);
      continue;
    }
    const tmp = `${dest}.part-${process.pid}`;
    const fd = fs.openSync(tmp, 'w', 0o644);
    try {
      let offset = 0;
      for (;;) {
        const chunk = call<{ data: string; eof: boolean }>('inboxRead', [entry.path, offset, INBOX_CHUNK_BYTES]);
        const data = Buffer.from(chunk.data, 'base64');
        fs.writeSync(fd, data);
        offset += data.length;
        if (offset > MAX_INBOX_FILE_BYTES) throw new Error(`inbox file ${entry.path} exceeds size limit`);
        if (chunk.eof || data.length === 0) break;
      }
      fs.closeSync(fd);
      fs.renameSync(tmp, dest);
      const seconds = entry.mtimeMs / 1000;
      fs.utimesSync(dest, seconds, seconds);
      written.push(entry.path);
    } catch (error) {
      try {
        fs.closeSync(fd);
      } catch {
        // already closed
      }
      fs.rmSync(tmp, { force: true });
      throw error;
    }
  }
  return written;
}

/** Uploads /workspace/outbox/<messageId>/* before the message that references it is sent. */
export function uploadOutbox(call: RpcCall, root: string, messageId: string): string[] {
  if (!SAFE_ID.test(messageId)) return [];
  const dir = path.join(root, messageId);
  let names: string[];
  try {
    const stat = fs.lstatSync(dir);
    if (!stat.isDirectory()) return [];
    names = fs.readdirSync(dir).sort();
  } catch {
    return [];
  }
  const uploaded: string[] = [];
  for (const name of names) {
    const file = path.join(dir, name);
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) continue; // never follow symlinks or send directories
    const fd = fs.openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(OUTBOX_CHUNK_BYTES);
      let offset = 0;
      for (;;) {
        const read = fs.readSync(fd, buffer, 0, buffer.length, offset);
        const final = read < buffer.length || offset + read >= stat.size;
        call('outboxWrite', [messageId, name, offset, buffer.subarray(0, read).toString('base64'), final]);
        offset += read;
        if (final) break;
      }
    } finally {
      fs.closeSync(fd);
    }
    uploaded.push(name);
  }
  return uploaded;
}
