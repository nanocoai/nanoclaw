/**
 * Owns the door's OpenSSH server process on the host's behalf. The host holds
 * the write end of this program's stdin; when that pipe closes — a clean
 * stop, a crash, or SIGKILL of the host — the server is terminated, so the
 * dedicated listener can never outlive the host that configured it.
 */
import { spawn } from 'node:child_process';

import { isMainModule } from './paths.js';

export function runSshdWrapper(argv: string[]): void {
  const [sshd, config] = argv;
  if (!sshd || !config) {
    process.stderr.write('usage: sshd-wrapper <sshd> <sshd_config>\n');
    process.exit(2);
  }
  const child = spawn(sshd, ['-D', '-e', '-f', config], { stdio: ['ignore', 'ignore', 'inherit'] });
  let stopping = false;
  let deadline: NodeJS.Timeout | undefined;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    child.kill('SIGTERM');
    deadline = setTimeout(() => child.kill('SIGKILL'), 5000);
  };
  process.stdin.resume();
  process.stdin.once('end', stop);
  process.stdin.once('close', stop);
  process.stdin.once('error', stop);
  for (const signal of ['SIGTERM', 'SIGINT', 'SIGHUP'] as const) process.once(signal, stop);
  child.once('error', (error) => {
    clearTimeout(deadline);
    process.stderr.write(`sshd-wrapper: ${error.message}\n`);
    process.exit(1);
  });
  child.once('exit', (code) => {
    clearTimeout(deadline);
    process.exit(stopping ? 0 : (code ?? 1));
  });
}

if (isMainModule(import.meta.url)) runSshdWrapper(process.argv.slice(2));
