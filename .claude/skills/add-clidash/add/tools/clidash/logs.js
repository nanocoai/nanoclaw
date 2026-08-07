// Log tailing for clidash — reads the last N lines of an allowlisted log file
// and strips ANSI color codes (the host logger writes colored output).

import { readFile } from 'node:fs/promises';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Last `maxLines` lines of a log file, ANSI-stripped.
 * @returns {{ lines: string[], text: string }}
 */
export async function tailFile(path, maxLines) {
  const raw = (await readFile(path, 'utf8')).replace(ANSI_RE, '');
  const all = raw.split('\n');
  if (all.length && all.at(-1) === '') all.pop(); // drop trailing newline's empty field
  const lines = all.slice(-maxLines);
  return { lines, text: lines.join('\n') };
}
