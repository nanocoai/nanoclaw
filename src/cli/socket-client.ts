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

export type SocketRequestOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  maxResponseBytes?: number;
};

export class SocketTransport implements Transport {
  constructor(private readonly socketPath: string = DEFAULT_SOCKET_PATH) {}

  async sendFrame(req: RequestFrame, options: SocketRequestOptions = {}): Promise<ResponseFrame> {
    return new Promise((resolve, reject) => {
      const client = net.createConnection(this.socketPath);
      const timeoutMs = options.timeoutMs ?? 30_000;
      const maxResponseBytes = options.maxResponseBytes ?? 1024 * 1024;
      let buffer = Buffer.alloc(0);
      let settled = false;

      const abort = (): void => settle('reject', new Error('host request aborted'));
      const timer = setTimeout(
        () => settle('reject', new Error(`host request timed out after ${timeoutMs} ms`)),
        timeoutMs,
      );

      const settle = (action: 'resolve' | 'reject', valueOrErr: ResponseFrame | Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        client.destroy();
        if (action === 'resolve') resolve(valueOrErr as ResponseFrame);
        else reject(valueOrErr as Error);
      };

      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) {
        abort();
        return;
      }

      client.on('connect', () => {
        client.write(JSON.stringify(req) + '\n');
      });

      client.on('data', (chunk) => {
        if (buffer.byteLength + chunk.byteLength > maxResponseBytes) {
          settle('reject', new Error(`host response exceeded ${maxResponseBytes} bytes`));
          return;
        }
        buffer = Buffer.concat([buffer, chunk]);
        const idx = buffer.indexOf(0x0a);
        if (idx < 0) return;
        const line = buffer.subarray(0, idx).toString('utf8');
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
