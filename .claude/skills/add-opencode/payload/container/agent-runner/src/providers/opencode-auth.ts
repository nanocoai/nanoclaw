import { randomUUID } from 'crypto';
import fs from 'fs';
import path from 'path';

/** Initialize this container's private auth state before every server start.
 * These placeholders select OpenCode's OAuth transport; OneCLI owns real tokens.
 * API-key mode clears stale OAuth state when a session changes backend.
 */
export function initializeOpenCodeAuth(dataHome: string, mode: string | undefined): void {
  if (!path.isAbsolute(dataHome)) throw new Error('OpenCode requires an absolute XDG_DATA_HOME');
  const directory = path.join(dataHome, 'opencode');
  fs.mkdirSync(dataHome, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(dataHome).isDirectory()) throw new Error('OpenCode auth state must use directories, not symlinks');
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!fs.lstatSync(directory).isDirectory()) {
    throw new Error('OpenCode auth state must use directories, not symlinks');
  }
  const auth =
    mode === 'chatgpt'
      ? {
          openai: { type: 'oauth', access: 'onecli-managed', refresh: 'onecli-managed', expires: Date.UTC(2100, 0, 1) },
        }
      : {};
  const temporary = path.join(directory, `.auth-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(auth)}\n`, { mode: 0o600, flag: 'wx' });
    // Replace stale files or symlinks without following or changing their targets.
    fs.renameSync(temporary, path.join(directory, 'auth.json'));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}
