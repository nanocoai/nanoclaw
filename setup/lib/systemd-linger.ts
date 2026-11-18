import { execFileSync } from 'child_process';

import { log } from '../../src/log.js';
import { sudoNonInteractive } from './sudo-noninteractive.js';

const COMMAND_TIMEOUT_MS = 5_000;

const reason = (err: unknown): string => (err as { stderr?: Buffer | string }).stderr?.toString().trim() || String(err);

/** Enables linger for this user without a polkit prompt; true only once loginctl reports it on. */
export function ensureUserLinger(uid: number): boolean {
  const user = String(uid);
  let readError = '';
  const isEnabled = (): boolean => {
    readError = '';
    try {
      return (
        execFileSync('loginctl', ['show-user', user, '--property=Linger', '--value'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'pipe'],
          timeout: COMMAND_TIMEOUT_MS,
        }).trim() === 'yes'
      );
    } catch (err) {
      readError = reason(err);
      return false;
    }
  };

  // Already on (provisioned hosts): change nothing.
  if (isEnabled()) return true;

  // With a controlling terminal, loginctl forks pkttyagent onto it even when
  // stdin is ignored (systemd 257.x stable, e.g. Debian 13's 257.13); without
  // polkit that prints an exec error.
  let loginctlError = '';
  try {
    execFileSync('loginctl', ['--no-ask-password', 'enable-linger', user], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: COMMAND_TIMEOUT_MS,
    });
  } catch (err) {
    loginctlError = reason(err);
  }
  // Exit statuses don't decide; the state reads do. Without polkit only root may
  // set linger. Root's loginctl starts no agent, so sudo runs the hint's exact
  // command, which a narrow sudoers rule can allow.
  let enabled = isEnabled();
  if (!enabled) {
    sudoNonInteractive(['loginctl', 'enable-linger', user], COMMAND_TIMEOUT_MS);
    enabled = isEnabled();
  }
  if (enabled) {
    log.info('Verified systemd linger for current user', { uid });
    return true;
  }

  log.warn('Systemd linger could not be verified — service may stop on logout', {
    loginctl: loginctlError || 'exited 0',
    linger: readError || 'off',
    hint: `Run sudo loginctl enable-linger ${user}, then check loginctl show-user ${user} --property=Linger`,
  });
  return false;
}
