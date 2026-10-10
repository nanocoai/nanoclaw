/**
 * Host file I/O inside directories an agent container can write.
 *
 * The session folder, the group folder and provider state volumes are mounted
 * read-write, so the container owns every name below each mount point and can
 * turn any of them into a symlink at any moment, including between a host
 * check and the host's next syscall. A path string is resolved again by every
 * syscall, so no lstat or realpath check on it holds: the host must not
 * address these trees by path.
 *
 * An AnchoredDir pins one directory by descriptor. Each operation resolves a
 * single name inside it and never follows a symlink there, so the host only
 * touches entries of the directories it opened, whatever the container renames.
 *
 * Node has no openat(2), so the descriptor is reached through a kernel alias:
 *   - Linux: /proc/self/fd/<fd>
 *   - macOS: /.vol/<dev>/<ino>, which only APFS and HFS+ volumes serve; on any
 *     other volume opening throws and the caller skips the operation.
 * Other platforms throw.
 */
import fs from 'fs';

import { isSafeAttachmentName } from './attachment-safety.js';

const { O_APPEND, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_NONBLOCK, O_RDONLY, O_WRONLY } = fs.constants;

function errno(err: unknown): string | undefined {
  return (err as NodeJS.ErrnoException | null)?.code;
}

export class AnchoredDir {
  private constructor(
    private readonly fd: number,
    private readonly alias: string,
  ) {}

  /**
   * Open `root/segments...`. The root is host-owned, so an operator's symlink
   * there is followed; each segment below it is opened through its parent and
   * must be a real directory. With `create`, missing segments (and the root)
   * are created. Returns null when something is missing; throws when a
   * segment is a symlink or not a directory.
   */
  static open(root: string, segments: readonly string[], create = false): AnchoredDir | null {
    if (create) fs.mkdirSync(root, { recursive: true });
    let fd: number;
    try {
      fd = fs.openSync(root, O_RDONLY | O_DIRECTORY);
    } catch (err) {
      if (errno(err) === 'ENOENT') return null;
      throw err;
    }
    let dir: AnchoredDir | null = AnchoredDir.fromFd(fd);
    for (const segment of segments) {
      const parent: AnchoredDir = dir;
      try {
        dir = parent.openDir(segment, create);
      } finally {
        parent.close();
      }
      if (!dir) return null;
    }
    return dir;
  }

  private static fromFd(fd: number): AnchoredDir {
    try {
      return new AnchoredDir(fd, descriptorAlias(fd));
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
  }

  /** Open the subdirectory `name`, creating it first when asked. Null if missing. */
  openDir(name: string, create = false): AnchoredDir | null {
    const entry = this.entryPath(name);
    if (create) {
      try {
        fs.mkdirSync(entry);
      } catch (err) {
        if (errno(err) !== 'EEXIST') throw err;
      }
    }
    let fd: number;
    try {
      fd = fs.openSync(entry, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    } catch (err) {
      const code = errno(err);
      if (code === 'ENOENT') return null;
      if (code === 'ELOOP' || code === 'ENOTDIR') {
        throw new Error(`refusing '${name}': not a real directory`, { cause: err });
      }
      throw err;
    }
    return AnchoredDir.fromFd(fd);
  }

  /** Open the regular file `name` for reading. Throws if missing, a symlink, or not a file. */
  openReadFd(name: string): number {
    // O_NONBLOCK: opening a FIFO planted under this name must not stall the host.
    const fd = fs.openSync(this.entryPath(name), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error(`refusing '${name}': not a regular file`);
    } catch (err) {
      fs.closeSync(fd);
      throw err;
    }
    return fd;
  }

  /** Create `name` for writing. EEXIST if anything, a symlink included, holds the name. */
  openNewFd(name: string): number {
    return fs.openSync(this.entryPath(name), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o666);
  }

  /** Read the regular file `name`. Throws if it is missing, a symlink, or anything else. */
  readFile(name: string): Buffer {
    const fd = this.openReadFd(name);
    try {
      return fs.readFileSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Create `name` and write `data`. EEXIST if anything, a symlink included, holds the name. */
  writeNewFile(name: string, data: Uint8Array): void {
    const fd = this.openNewFd(name);
    try {
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  }

  /** Append `data` to `name`, creating it if absent. Refuses a symlink or non-regular leaf. */
  appendFile(name: string, data: string | Uint8Array): void {
    // O_NONBLOCK + the isFile check: O_NOFOLLOW rejects a symlink but not a FIFO,
    // and a blocking open of a reader-less FIFO would stall the host. Unlike the
    // create helpers, append has no O_EXCL, so it can open an existing leaf.
    const fd = fs.openSync(this.entryPath(name), O_WRONLY | O_APPEND | O_CREAT | O_NOFOLLOW | O_NONBLOCK, 0o666);
    try {
      if (!fs.fstatSync(fd).isFile()) throw new Error(`refusing '${name}': not a regular file`);
      fs.writeFileSync(fd, data);
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Replace `name` with `data` through a temporary file and a rename inside
   * this directory, so readers never see a partial file and a symlink planted
   * under `name` is replaced, never followed.
   */
  replaceFile(name: string, data: string | Uint8Array): void {
    const tmp = `${name}.tmp-${process.pid}-${Date.now()}`;
    let fd: number | undefined = this.openNewFd(tmp);
    let renamed = false;
    try {
      fs.writeFileSync(fd, data);
      // close(2) releases the descriptor even when it reports an error, so it is
      // forgotten before the call: a second close could hit a reused number.
      const written = fd;
      fd = undefined;
      fs.closeSync(written);
      fs.renameSync(this.entryPath(tmp), this.entryPath(name));
      renamed = true;
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      // Only our own temp entry is removed: a name we failed to create is not ours.
      if (!renamed) {
        try {
          fs.unlinkSync(this.entryPath(tmp));
        } catch {
          /* nothing to remove */
        }
      }
    }
  }

  entries(): string[] {
    return fs.readdirSync(this.alias);
  }

  lstat(name: string): fs.Stats {
    return fs.lstatSync(this.entryPath(name));
  }

  /** The target of the symlink `name`, without following it. */
  readlink(name: string): string {
    return fs.readlinkSync(this.entryPath(name));
  }

  /** Removes a symlink itself, never its target. */
  unlink(name: string): void {
    fs.unlinkSync(this.entryPath(name));
  }

  rmdir(name: string): void {
    fs.rmdirSync(this.entryPath(name));
  }

  symlink(target: string, name: string): void {
    fs.symlinkSync(target, this.entryPath(name));
  }

  close(): void {
    fs.closeSync(this.fd);
  }

  // The kernel resolves only `name` by lookup; every caller above either
  // passes O_NOFOLLOW or uses a call that never follows the final component.
  private entryPath(name: string): string {
    if (!isSafeAttachmentName(name)) throw new Error(`refusing unsafe entry name ${JSON.stringify(name)}`);
    return `${this.alias}/${name}`;
  }
}

/**
 * Stream-copy the regular file `srcName` in `src` to a freshly created
 * `dstName` in `dst`, both pinned by descriptor. Streams in chunks, so it
 * neither buffers the whole file in host memory nor hits the ~2 GiB
 * read-into-Buffer ceiling. Throws EEXIST if `dstName` is already taken.
 */
export function copyRegularFile(src: AnchoredDir, srcName: string, dst: AnchoredDir, dstName: string): void {
  const srcFd = src.openReadFd(srcName);
  try {
    const mode = fs.fstatSync(srcFd).mode & 0o777;
    // Partial output on a mid-copy failure matches the old copyFileSync; the
    // caller only surfaces an attachment it wrote in full.
    const dstFd = dst.openNewFd(dstName);
    try {
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let read: number;
      while ((read = fs.readSync(srcFd, buffer, 0, buffer.length, null)) > 0) {
        // writeSync may return a short count; drain the chunk before the next read.
        for (let written = 0; written < read; ) {
          written += fs.writeSync(dstFd, buffer, written, read - written);
        }
      }
      // Preserve the source mode (e.g. an executable script) as copyFileSync did.
      fs.fchmodSync(dstFd, mode);
    } finally {
      fs.closeSync(dstFd);
    }
  } finally {
    fs.closeSync(srcFd);
  }
}

function descriptorAlias(fd: number): string {
  if (process.platform === 'linux') return `/proc/self/fd/${fd}`;
  if (process.platform === 'darwin') {
    const st = fs.fstatSync(fd, { bigint: true });
    const alias = `/.vol/${st.dev}/${st.ino}`;
    const seen = fs.statSync(alias, { bigint: true, throwIfNoEntry: false });
    if (!seen || seen.dev !== st.dev || seen.ino !== st.ino) {
      throw new Error('this volume has no /.vol inode paths; refusing to fall back to a path');
    }
    return alias;
  }
  throw new Error(`anchored directory I/O is not supported on ${process.platform}`);
}
