import { execFileSync } from 'child_process';

import { log } from '../../src/log.js';
import { sudoNonInteractive } from './sudo-noninteractive.js';

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
  let loginctlError = '';
  try {
    execFileSync('loginctl', enableArgs, { stdio: ['ignore', 'pipe', 'pipe'], timeout: COMMAND_TIMEOUT_MS });
  } catch (err) {
    const stderr = (err as { stderr?: Buffer }).stderr?.toString().trim();
    loginctlError = stderr || String(err);
  }
  // Exit statuses don't decide; the state reads do. Without polkit only root
  // may set linger, so try sudo next, which fails rather than prompts.
  let enabled = isEnabled();
  if (!enabled) {
    sudoNonInteractive(['loginctl', ...enableArgs], COMMAND_TIMEOUT_MS);
    enabled = isEnabled();
  }
  if (enabled) {
    log.info('Verified systemd linger for current user', { uid });
    return true;
  }

  log.warn('Systemd linger could not be verified — service may stop on logout', {
    loginctl: loginctlError || 'exited 0, Linger still off',
    hint: `Run sudo loginctl enable-linger ${user}, then check loginctl show-user ${user} --property=Linger`,
  });
  return false;
}
