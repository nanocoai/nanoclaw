import { execFileSync } from 'child_process';

import { log } from '../../src/log.js';

const COMMAND_TIMEOUT_MS = 5_000;

/** Enables linger for this user without a polkit prompt; true only once loginctl reports it on. */
export function ensureUserLinger(uid: number): boolean {
  const user = String(uid);
  const isEnabled = (): boolean => {
    try {
      return (
        execFileSync('loginctl', ['show-user', user, '--property=Linger', '--value'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: COMMAND_TIMEOUT_MS,
        }).trim() === 'yes'
      );
    } catch {
      return false;
    }
  };

  // Already on (provisioned hosts): change nothing.
  if (isEnabled()) return true;

  // With a controlling terminal, loginctl forks pkttyagent onto it even when
  // stdin is ignored (systemd 257); without polkit that prints an exec error.
  const enableArgs = ['--no-ask-password', 'enable-linger', user];
  const attempts: [string, string[]][] = [
    ['loginctl', enableArgs],
    // Without polkit only root may set linger. Use sudo only if it needs no password.
    ['sudo', ['-n', 'loginctl', ...enableArgs]],
  ];
  const failures: string[] = [];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: COMMAND_TIMEOUT_MS,
      });
    } catch (err) {
      // The exit status doesn't decide; the state read below does.
      const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
      failures.push(`${command}: ${stderr || String(err)}`);
    }
    if (isEnabled()) {
      log.info('Verified systemd linger for current user', { uid });
      return true;
    }
  }

  log.warn('Systemd linger could not be verified — service may stop on logout', {
    failures,
    hint: `Run sudo loginctl enable-linger ${user}, then check loginctl show-user ${user} --property=Linger`,
  });
  return false;
}
