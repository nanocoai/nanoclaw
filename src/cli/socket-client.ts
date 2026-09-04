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

export const DEFAULT_SOCKET_PATH = path.join(DATA_DIR, 'ncl.sock');

// A deadlocked host could accept the connection but never reply, leaving the
// promise unsettled forever; and a host streaming without a newline could grow
// the buffer without bound. Cap both — callers are interactive `ncl` invocations.
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

export class SocketTransport implements Transport {
  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  async sendFrame(req: RequestFrame): Promise<ResponseFrame> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.socketPath);
      let buffer = '';
      // Cap by raw bytes received, not decoded string length: a multibyte UTF-8
      // response could exceed the byte limit while its char-length stays under it.
      let responseBytes = 0;
      let settled = false;

      const timer = setTimeout(() => {
        settle('reject', new Error(`host did not respond within ${REQUEST_TIMEOUT_MS}ms`));
      }, REQUEST_TIMEOUT_MS);

      const settle = (action: 'resolve' | 'reject', valueOrErr: ResponseFrame | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
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
        responseBytes += chunk.byteLength;
        if (responseBytes > MAX_RESPONSE_BYTES) {
          settle('reject', new Error('host response exceeded maximum size'));
          return;
        }
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
