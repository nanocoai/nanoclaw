/**
 * Hand the terminal to a child program and follow it to the end. The forced
 * commands run this for the attach client (and the waiting room for the
 * landing): a hang-up or termination sent to the forced command — by the
 * server when the connection drops, by the host when a key is revoked — is
 * forwarded to the child, and the exit code is the child's.
 */
import { spawn } from 'node:child_process';

const FORWARDED: NodeJS.Signals[] = ['SIGHUP', 'SIGTERM'];

export function runForeground(bin: string, args: string[], env?: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, { stdio: 'inherit', ...(env ? { env } : {}) });
    const handlers = new Map(FORWARDED.map((signal) => [signal, (): void => void child.kill(signal)] as const));
    for (const [signal, handler] of handlers) process.on(signal, handler);
    const done = (code: number): void => {
      for (const [signal, handler] of handlers) process.off(signal, handler);
      resolve(code);
    };
    child.on('error', () => done(1));
    child.on('exit', (code, signal) => done(code ?? (signal ? 128 : 1)));
  });
}
