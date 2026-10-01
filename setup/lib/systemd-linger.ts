import { execFileSync } from 'child_process';

import { log } from '../../src/log.js';

const COMMAND_TIMEOUT_MS = 5_000;

/** Enable persistence for this user without opening an interactive polkit agent. */
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

  // Provisioned hosts can already have linger enabled. Do not ask polkit to
  // authorize an unnecessary change (minimal images may not ship pkttyagent).
  if (isEnabled()) return true;

  const enableArgs = ['--no-ask-password', 'enable-linger', user];
  const attempts: [string, string[]][] = [
    ['loginctl', enableArgs],
    // Use only existing noninteractive sudo rights; never prompt from setup.
    ['sudo', ['-n', 'loginctl', ...enableArgs]],
  ];
  for (const [command, args] of attempts) {
    try {
      execFileSync(command, args, {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: COMMAND_TIMEOUT_MS,
      });
    } catch {
      // The command's exit status is not proof of the resulting linger state.
    }
    if (isEnabled()) {
      log.info('Verified systemd linger for current user', { uid });
      return true;
    }
  }

  log.warn('Systemd linger could not be verified — service may stop on logout', {
    hint: `Run sudo loginctl enable-linger ${user}, then check loginctl show-user ${user} --property=Linger`,
  });
  return false;
}
