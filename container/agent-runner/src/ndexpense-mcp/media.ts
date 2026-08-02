import { lstat, realpath } from 'node:fs/promises';
import { basename, extname, relative, sep } from 'node:path';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_CALL_BYTES = 20 * 1024 * 1024;
const MAX_FILES = 10;

const MIME_BY_EXTENSION: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
};

export interface ResolvedReceiptMedia {
  path: string;
  name: string;
  type: string;
  size: number;
  file: ReturnType<typeof Bun.file>;
}

function matchesMagic(type: string, bytes: Uint8Array): boolean {
  if (type === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (type === 'image/png')
    return bytes.slice(0, 8).every((byte, index) => byte === [137, 80, 78, 71, 13, 10, 26, 10][index]);
  if (type === 'image/webp') {
    return (
      new TextDecoder().decode(bytes.slice(0, 4)) === 'RIFF' && new TextDecoder().decode(bytes.slice(8, 12)) === 'WEBP'
    );
  }
  if (type === 'application/pdf') return new TextDecoder().decode(bytes.slice(0, 5)) === '%PDF-';
  return false;
}

export async function resolveReceiptMedia(
  paths: string[],
  downloadsRoot = '/workspace/downloads',
): Promise<ResolvedReceiptMedia[]> {
  if (paths.length === 0 || paths.length > MAX_FILES) throw new Error('Receipt media requires 1 to 10 files');
  const root = await realpath(downloadsRoot);
  const resolved: ResolvedReceiptMedia[] = [];
  let total = 0;

  for (const inputPath of paths) {
    const inputStats = await lstat(inputPath);
    if (inputStats.isSymbolicLink()) throw new Error('Receipt media symlinks are not allowed');
    if (!inputStats.isFile()) throw new Error('Receipt media must be a regular file');
    const path = await realpath(inputPath);
    const fromRoot = relative(root, path);
    if (fromRoot === '..' || fromRoot.startsWith(`..${sep}`) || fromRoot.startsWith(sep)) {
      throw new Error('Receipt media must remain under the downloads directory');
    }
    const type = MIME_BY_EXTENSION[extname(path).toLowerCase()];
    if (!type) throw new Error('Unsupported receipt media type');
    if (inputStats.size > MAX_FILE_BYTES) throw new Error('Receipt media exceeds 10 MiB');
    total += inputStats.size;
    if (total > MAX_CALL_BYTES) throw new Error('Receipt media exceeds 20 MiB per call');
    const file = Bun.file(path, { type });
    const header = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    if (!matchesMagic(type, header)) throw new Error('Receipt media content does not match its file type');
    resolved.push({ path, name: basename(path), type, size: inputStats.size, file });
  }

  return resolved;
}
