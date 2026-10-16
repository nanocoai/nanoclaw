/**
 * SocketTransport — client side. Used by the `ncl` binary when running on
 * the host (i.e. invoked from a shell or by Claude in the project).
 *
 * Wire format: line-delimited JSON. One request per connection; the server
 * writes one response and closes.
 */
import net from 'net';
import path from 'path';

import { DATA_DIR } from '../config.js';
import type { RequestFrame, ResponseFrame } from './frame.js';
import type { Transport } from './transport.js';

/**
 * `ncl` CLI socket endpoint — host-shell-only (the agent-runner inside the
 * container uses a DB transport, not this socket). On Windows Node's AF_UNIX
 * support on NTFS hits EACCES under the service account (the daemon binds but
 * cannot chmod the socket file, then the next start re-binds and fails), so
 * we use a named pipe instead — auto-cleaned by the OS when the owning
 * process exits, which also means no stale-unlink step is needed on win32.
 */
export function getNclSocketPath(): string {
  if (process.platform === 'win32') {
    return '\\\\.\\pipe\\nanoclaw-ncl';
  }
  return path.join(DATA_DIR, 'ncl.sock');
}

export const DEFAULT_SOCKET_PATH = getNclSocketPath();

export class SocketTransport implements Transport {
  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  async sendFrame(req: RequestFrame): Promise<ResponseFrame> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.socketPath);
      let buffer = '';
      let settled = false;

      const settle = (action: 'resolve' | 'reject', valueOrErr: ResponseFrame | Error): void => {
        if (settled) return;
        settled = true;
        try {
          client.end();
        } catch (_e) {
          // best-effort
        }
        if (action === 'resolve') resolve(valueOrErr as ResponseFrame);
        else reject(valueOrErr as Error);
      };

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n');
      });

      client.on('data', (chunk) => {
        buffer += chunk.toString('utf8');
        const idx = buffer.indexOf('\n');
        if (idx < 0) return;
        const line = buffer.slice(0, idx);
        try {
          const frame = JSON.parse(line) as ResponseFrame;
          settle('resolve', frame);
        } catch (e) {
          settle('reject', new Error(`malformed response from host: ${e instanceof Error ? e.message : String(e)}`));
        }
      });

      client.on('error', (err) => settle('reject', err));
      client.on('close', () => {
        if (!settled) {
          settle('reject', new Error('host closed connection before sending response'));
        }
      });
    });
  }
}
