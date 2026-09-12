/** The filesystem heartbeat used by the OSS Docker Host's idle lease.
 * Match the chat runner's configurable path. A missing or unwritable mount
 * must be reported without crashing the coding session. */
import fs from 'fs';

const DEFAULT_HEARTBEAT_PATH = '/workspace/.heartbeat';

export function heartbeatPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.NANOCLAW_HEARTBEAT_PATH?.trim() || DEFAULT_HEARTBEAT_PATH;
}

export function touchHeartbeat(target: string = heartbeatPath(), now: Date = new Date()): boolean {
  try {
    if (!fs.statSync(target).isFile()) return false;
    fs.utimesSync(target, now, now);
    return true;
  } catch {
    // A missing file can be created; an invalid mount still fails below.
  }
  try {
    fs.writeFileSync(target, '');
    fs.utimesSync(target, now, now);
    return true;
  } catch {
    return false;
  }
}
