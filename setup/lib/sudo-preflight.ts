import { spawnSync } from 'child_process';

import { commandExists, getPlatform, isRoot } from '../platform.js';
import { runInheritScript } from './inherit-script.js';

/** sudo's prompt, indented to line up with the wizard's log lines. */
export const SUDO_PROMPT = '   [sudo] password for %p: ';

export type SudoUpFront = 'not-needed' | 'granted' | 'refused';

export type DockerSudoReason = 'install' | 'start' | 'group';

/**
 * Why the container step will call sudo here, if it will. Besides installing
 * a missing Docker, on Linux it runs `sudo systemctl start docker` whenever
 * `docker info` fails, and `sudo usermod` when the socket refuses the user.
 */
export function dockerSudoReason(): DockerSudoReason | undefined {
  if (getPlatform() !== 'linux' || isRoot()) return undefined;
  if (!commandExists('docker')) return 'install';
  // A hung daemon holds this for the full 15 s. It runs once, and the step's
  // own `docker info` (no timeout) would hang on the same daemon anyway.
  const info = spawnSync('docker', ['info'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    timeout: 15_000,
  });
  // A probe that timed out proves nothing; leave it to the step, as before.
  if (info.status === 0 || info.status === null) return undefined;
  // Same check as the step's (setup/container.ts): the socket refuses us.
  return /permission denied/i.test(`${info.stderr ?? ''}\n${info.stdout ?? ''}`) ? 'group' : 'start';
}

/**
 * Put sudo's password prompt in front of the user before a step that needs
 * it. Steps run with stdin ignored and their output in a window, so a prompt
 * from inside one is hidden and times out. A `sudo -v` here refreshes the
 * timestamp that the step's own sudo calls then reuse.
 */
export async function sudoUpFront(explain: () => void): Promise<SudoUpFront> {
  if (getPlatform() !== 'linux' || isRoot()) return 'not-needed';
  // Without a terminal nobody can answer, so keep the old behaviour.
  if (!process.stdin.isTTY || !commandExists('sudo')) return 'not-needed';
  if (spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0) return 'not-needed';
  explain();
  return (await runInheritScript('sudo', ['-v', '-p', SUDO_PROMPT])) === 0 ? 'granted' : 'refused';
}
