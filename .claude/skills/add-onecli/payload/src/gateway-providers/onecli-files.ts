import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Keep the SDK's system trust order and its proxy-only fallback.
const SYSTEM_CA_PATHS = ['/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'];

export function combinedCaBundle(certificate: string): string | undefined {
  for (const file of SYSTEM_CA_PATHS) {
    let system: string;
    try {
      system = fs.readFileSync(file, 'utf8');
    } catch (error) {
      // Unavailable host trust stores are optional, as in the SDK. Do not
      // include staging here: a failed write must abort the contribution.
      if (!(error instanceof Error && 'code' in error)) throw error;
      continue;
    }
    return `${system.trimEnd()}\n${certificate.trimEnd()}\n`;
  }
}

/**
 * Content-addressed files remain stable for existing read-only bind mounts.
 * A new CA/stub publishes a new path; retries reuse it. Never remove old
 * versions here: another session may still have one mounted.
 */
export function stageOnecliFile(dataDir: string, kind: 'ca' | 'combined' | 'stub', content: string): string {
  const directory = path.join(dataDir, 'onecli');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryStat = fs.lstatSync(directory);
  if (
    !directoryStat.isDirectory() ||
    directoryStat.uid !== process.getuid?.() ||
    (directoryStat.mode & 0o777) !== 0o700
  ) {
    throw new Error('OneCLI file directory must be owned by the current user with mode 0700');
  }
  const digest = createHash('sha256').update(content).digest('hex');
  const destination = path.join(directory, `${kind}-${digest}${kind === 'stub' ? '' : '.pem'}`);
  const mode = kind === 'stub' ? 0o600 : 0o644;
  const validate = (): boolean => {
    const stat = fs.lstatSync(destination);
    if (!stat.isFile() || stat.uid !== directoryStat.uid) {
      throw new Error(`OneCLI staged file has an unexpected type or owner: ${destination}`);
    }
    const fd = fs.openSync(destination, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return (stat.mode & 0o777) === mode && fs.readFileSync(fd, 'utf8') === content;
    } finally {
      fs.closeSync(fd);
    }
  };
  try {
    if (validate()) return destination;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  // Publish a complete, flushed file with an atomic rename. The temporary and
  // destination paths share a directory, so rename works on filesystems that
  // do not support hard links (exFAT, SMB and DrvFs included). Concurrent
  // writers publish the same content-addressed bytes. A regular file owned by
  // this user but left incomplete or with the wrong mode is repaired for
  // future mounts; existing bind mounts keep their old inode.
  const temporary = path.join(directory, `.pending-${randomUUID()}`);
  const fd = fs.openSync(temporary, 'wx', mode);
  try {
    try {
      fs.writeFileSync(fd, content);
      fs.fchmodSync(fd, mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.renameSync(temporary, destination);
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (!['EEXIST', 'EPERM', 'ENOTEMPTY'].includes(code ?? '')) throw error;

        // Windows does not replace an existing destination with rename. A
        // concurrent valid publisher wins; an owned regular mismatch is
        // removed and retried. validate() still refuses symlinks/directories
        // and files owned by another user.
        try {
          if (validate()) return destination;
          fs.unlinkSync(destination);
        } catch (validationError) {
          if ((validationError as NodeJS.ErrnoException).code !== 'ENOENT') throw validationError;
        }
        if (attempt === 2) throw new Error(`Could not publish OneCLI staged file: ${destination}`, { cause: error });
      }
    }
    if (!validate()) throw new Error(`OneCLI staged file validation failed after publish: ${destination}`);
    return destination;
  } finally {
    try {
      fs.unlinkSync(temporary);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}
