import { execFileSync } from 'child_process';

import { log } from '../../src/log.js';

// Steps run with stdin ignored, but sudo prompts on /dev/tty, which would hang
// out of sight under the wizard spinner. -n uses a cached ticket or fails fast.
export function sudoNonInteractive(args: string[], timeout: number): boolean {
  try {
    execFileSync('sudo', ['-n', ...args], { stdio: ['ignore', 'pipe', 'pipe'], timeout });
    return true;
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    log.warn('sudo command failed', { command: args.join(' '), stderr: stderr || String(err) });
    return false;
  }
}
