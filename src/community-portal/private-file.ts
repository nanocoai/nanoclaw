import { randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { isErrno } from './errors.js';

/** Parse a JSON file, returning `fallback` when it does not exist. */
export async function readJson<T = unknown>(file: string, fallback: T | null = null): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return fallback;
    throw error;
  }
}

/**
 * Write JSON with owner-only permissions and no torn reads: a fresh 0600 temp
 * file, fsync, atomic rename, then fsync of the directory entry.
 */
export async function writePrivate(file: string, value: unknown): Promise<void> {
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomBytes(8).toString('base64url')}.tmp`;
  const output = await open(temp, 'wx', 0o600);
  try {
    await output.writeFile(JSON.stringify(value, null, 2));
    await output.sync();
  } finally {
    await output.close();
  }
  await rename(temp, file);
  const entry = await open(directory, 'r');
  try {
    await entry.sync();
  } finally {
    await entry.close();
  }
}
