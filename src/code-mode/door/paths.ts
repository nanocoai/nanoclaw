/**
 * Door file layout and program resolution — no host config imports, because
 * the forced commands (landing, waiting room, authorized-keys) run as children
 * of the OpenSSH server with the user's home directory as cwd and must not
 * evaluate the host's cwd-relative configuration.
 *
 * Everything the door owns lives in one directory (`data/door` on the host):
 * the host key pair, the rendered sshd_config, the approved-keys store, the
 * state journal, and the unix socket the forced commands ask the host through.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export interface DoorFiles {
  dir: string;
  hostKey: string;
  hostKeyPublic: string;
  sshdConfig: string;
  keyStore: string;
  state: string;
  hostSocket: string;
}

export function doorFiles(dir: string): DoorFiles {
  return {
    dir,
    hostKey: path.join(dir, 'host_ed25519'),
    hostKeyPublic: path.join(dir, 'host_ed25519.pub'),
    sshdConfig: path.join(dir, 'sshd_config'),
    keyStore: path.join(dir, 'keys.json'),
    state: path.join(dir, 'state.json'),
    hostSocket: path.join(dir, 'host.sock'),
  };
}

export type DoorEntry = 'authorized-keys' | 'landing' | 'waiting-room' | 'sshd-wrapper';

const here = fileURLToPath(import.meta.url);
const moduleDir = path.dirname(here);
const compiled = here.endsWith('.js');

/**
 * The argv that runs one of the door's programs with the same Node binary and
 * source tree as the running host. A built checkout runs `dist/…/<entry>.js`;
 * a source checkout (tsx) runs `src/…/<entry>.ts` through the local tsx CLI,
 * so `pnpm dev` hosts get a working door too. Absolute paths throughout: the
 * OpenSSH server hands its children a minimal PATH.
 */
export function resolveEntry(entry: DoorEntry, execPath: string = process.execPath): string[] {
  if (compiled) return [execPath, path.join(moduleDir, `${entry}.js`)];
  const root = path.resolve(moduleDir, '..', '..', '..');
  return [execPath, path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'), path.join(moduleDir, `${entry}.ts`)];
}

/** True when `moduleUrl` is the script Node was started with (an entry's `main` guard). */
export function isMainModule(moduleUrl: string): boolean {
  const script = process.argv[1];
  if (!script) return false;
  try {
    return path.resolve(script) === fileURLToPath(moduleUrl);
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

/** POSIX single-quote for the user's login shell, which runs forced commands as `shell -c`. */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

/**
 * The `command="…"` option for an authorized_keys line: shell-quoted argv,
 * then the option layer's own escapes (`\"` and `\\`). Refuses line breaks
 * and NULs — an authorized_keys record is one line.
 */
export function forcedCommandOption(argv: string[]): string {
  const command = argv.map(shellQuote).join(' ');
  if (/[\r\n\0]/.test(command)) throw new Error('forced command must not contain line breaks');
  return `command="${command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * One sshd_config argument. The server splits on whitespace with double-quote
 * grouping and expands `%` tokens in AuthorizedKeysCommand, so quotes,
 * backslashes and control characters in a path are refused and `%` doubled.
 */
export function sshdConfigArg(value: string): string {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (ch === '"' || ch === '\\' || code < 0x20 || code === 0x7f) {
      throw new Error(`path cannot be used in sshd_config (quotes, backslashes or control characters): ${value}`);
    }
  }
  return `"${value.replace(/%/g, '%%')}"`;
}
