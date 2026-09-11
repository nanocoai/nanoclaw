/**
 * The door's SSH server: in-process, loopback only, host key from the door
 * directory, public keys only. The protocol is ssh2's (curve25519 key
 * exchange, chacha20 / aes-gcm ciphers, ed25519 host key by default);
 * everything a connection may do is decided per connection by the session
 * handler. Stopping the server ends every connection with it.
 */
// ssh2 is a CommonJS module: only its default export is reachable from Node ESM.
import ssh2, { type ClientInfo, type Connection, type Server as SshServer } from 'ssh2';

const { Server } = ssh2;

export type DoorLogLevel = 'debug' | 'info' | 'warn' | 'error';
export type DoorLog = (level: DoorLogLevel, message: string, data?: Record<string, unknown>) => void;

export interface DoorServerOptions {
  port: number;
  /** The private host key, as the file holds it. */
  hostKey: string;
  onConnection: (client: Connection, info: ClientInfo) => void;
  log: DoorLog;
  keepaliveInterval?: number;
  keepaliveCountMax?: number;
}

export interface DoorServerStatus {
  running: boolean;
  port: number;
  /** Connections that completed the handshake and are still open. */
  connections: number;
  startedAt?: string;
}

export const KEEPALIVE_INTERVAL_MS = 20_000;
export const KEEPALIVE_COUNT_MAX = 3;

export class DoorServer {
  private server?: SshServer;
  private startedAt?: string;
  private readonly clients = new Set<Connection>();

  constructor(private readonly options: DoorServerOptions) {}

  async start(): Promise<void> {
    if (this.server) return;
    const { port, hostKey, log } = this.options;
    const server = new Server(
      {
        hostKeys: [hostKey],
        keepaliveInterval: this.options.keepaliveInterval ?? KEEPALIVE_INTERVAL_MS,
        keepaliveCountMax: this.options.keepaliveCountMax ?? KEEPALIVE_COUNT_MAX,
      },
      (client, info) => {
        this.clients.add(client);
        client.once('close', () => this.clients.delete(client));
        client.on('error', (error) => log('debug', 'Remote terminal connection error', { from: info.ip, err: error }));
        this.options.onConnection(client, info);
      },
    );
    await new Promise<void>((resolve, reject) => {
      server.once('error', (error: NodeJS.ErrnoException) =>
        reject(
          error.code === 'EADDRINUSE'
            ? new Error(`127.0.0.1:${port} is already in use; the door cannot listen there`, { cause: error })
            : error,
        ),
      );
      server.listen(port, '127.0.0.1', () => {
        server.removeAllListeners('error');
        server.on('error', (error: Error) => log('error', 'Remote terminal server error', { err: error }));
        resolve();
      });
    });
    this.server = server;
    this.startedAt = new Date().toISOString();
    log('info', 'Remote terminal door listening', { port });
  }

  /** Close the listener and end every connection (their sessions end with them). */
  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.startedAt = undefined;
    if (!server) return;
    for (const client of this.clients) client.end();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    this.clients.clear();
  }

  status(): DoorServerStatus {
    return {
      running: this.server !== undefined,
      port: this.options.port,
      connections: this.clients.size,
      ...(this.startedAt ? { startedAt: this.startedAt } : {}),
    };
  }
}
