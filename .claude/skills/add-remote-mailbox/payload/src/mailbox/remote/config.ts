/**
 * Remote mailbox settings, read by the skill itself rather than core config.
 *
 * `process.env` wins, then `.env` (the host parses `.env` in-process; it has no
 * `EnvironmentFile=`). Read once at import, like every other host setting: an
 * edit applies on restart.
 *
 * - NANOCLAW_REMOTE_MAILBOX_GROUPS: comma-separated agent group ids whose
 *   runner reaches its mailbox over HTTP instead of a mounted session
 *   directory. Empty = feature fully off.
 * - NANOCLAW_MAILBOX_PORT: loopback port of the host service (default 18770).
 * - NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER: the registered session driver the
 *   `remote-mailbox` driver wraps (default `docker`).
 */
import { readEnvFile } from '../../env.js';

const KEYS = [
  'NANOCLAW_REMOTE_MAILBOX_GROUPS',
  'NANOCLAW_MAILBOX_PORT',
  'NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER',
] as const;

export const DEFAULT_MAILBOX_PORT = 18770;
export const DEFAULT_INNER_DRIVER = 'docker';

function read(key: (typeof KEYS)[number], env: NodeJS.ProcessEnv): string {
  return env[key] || readEnvFile([...KEYS])[key] || '';
}

export function parseRemoteMailboxGroups(raw: string): string[] {
  return raw
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
}

export function parseMailboxPort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : DEFAULT_MAILBOX_PORT;
}

export const REMOTE_MAILBOX_GROUPS: readonly string[] = parseRemoteMailboxGroups(
  read('NANOCLAW_REMOTE_MAILBOX_GROUPS', process.env),
);
export const MAILBOX_PORT: number = parseMailboxPort(read('NANOCLAW_MAILBOX_PORT', process.env));
export const REMOTE_MAILBOX_INNER_DRIVER: string =
  read('NANOCLAW_REMOTE_MAILBOX_INNER_DRIVER', process.env).trim().toLowerCase() || DEFAULT_INNER_DRIVER;
