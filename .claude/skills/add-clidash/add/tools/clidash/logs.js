// Log tailing for clidash — reads the last N lines of an allowlisted log file
// and strips ANSI color codes (the host logger writes colored output).

import { readFile } from 'node:fs/promises';

const ANSI_RE = /\x1b\[[0-9;]*m/g;

/**
 * Last `maxLines` lines of a log file, ANSI-stripped.
 *
 * A configured file that does not exist yet is an empty tail, not an error:
 * NanoClaw's `logs/nanoclaw.log` and `logs/nanoclaw.error.log` exist only
 * because the launchd plist / systemd unit redirects the host's stdout and
 * stderr into them, so a `pnpm run dev` install has neither, and a healthy
 * service install has no error log until something errors. Any other failure
 * (EACCES, EISDIR, …) still throws — those are real misconfiguration.
 *
 * @returns {{ lines: string[], text: string, missing: boolean }}
 */
export async function tailFile(path, maxLines) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { lines: [], text: '', missing: true };
    throw err;
  }
  const raw = contents.replace(ANSI_RE, '');
  const all = raw.split('\n');
  if (all.length && all.at(-1) === '') all.pop(); // drop trailing newline's empty field
  const lines = all.slice(-maxLines);
  return { lines, text: lines.join('\n'), missing: false };
}
