/**
 * The door's sshd_config: a loopback-only listener with its own host key,
 * public keys only, a PTY and nothing else, every key routed through the
 * host's AuthorizedKeysCommand. No system sshd configuration, login key or
 * shell is touched — the server runs as the host user from this file alone.
 */
import { sshdConfigArg } from './paths.js';

export interface SshdConfigOptions {
  port: number;
  hostKeyFile: string;
  /** Absolute program + arguments; the server appends `%f %t %k`. */
  authorizedKeysCommand: string[];
  /** The host user — the only account the server may authenticate. */
  user: string;
}

const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

export function renderSshdConfig(options: SshdConfigOptions): string {
  const { port, user } = options;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error(`invalid door port ${port}`);
  if (!USER_NAME.test(user)) throw new Error(`unsupported local account name "${user}"`);
  // The server checks the raw line's first character is `/` before it splits
  // arguments, so the program itself goes unquoted; its arguments are quoted.
  const [program, ...programArgs] = options.authorizedKeysCommand;
  if (!program || !program.startsWith('/') || /\s/.test(program)) {
    throw new Error(`AuthorizedKeysCommand program must be an absolute path without spaces: ${program}`);
  }
  const command = [program, ...programArgs.map(sshdConfigArg)].join(' ');
  return [
    `Port ${port}`,
    'ListenAddress 127.0.0.1',
    `HostKey ${sshdConfigArg(options.hostKeyFile)}`,
    'PidFile none',
    `AllowUsers ${user}`,
    'AuthorizedKeysFile none',
    `AuthorizedKeysCommand ${command} %f %t %k`,
    `AuthorizedKeysCommandUser ${user}`,
    'AuthenticationMethods publickey',
    'PubkeyAuthentication yes',
    'PasswordAuthentication no',
    'KbdInteractiveAuthentication no',
    'HostbasedAuthentication no',
    'PermitRootLogin no',
    'PermitEmptyPasswords no',
    'UsePAM no',
    'PermitUserEnvironment no',
    'PermitUserRC no',
    'PermitTTY yes',
    'DisableForwarding yes',
    'AllowTcpForwarding no',
    'AllowStreamLocalForwarding no',
    'AllowAgentForwarding no',
    'X11Forwarding no',
    'PermitTunnel no',
    'GatewayPorts no',
    'ClientAliveInterval 20',
    'ClientAliveCountMax 3',
    'TCPKeepAlive yes',
    'LoginGraceTime 20',
    'MaxAuthTries 3',
    'MaxSessions 1',
    'MaxStartups 10:30:60',
    'UseDNS no',
    'PrintMotd no',
    'PrintLastLog no',
    'LogLevel VERBOSE',
    '',
  ].join('\n');
}
