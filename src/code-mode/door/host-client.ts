/**
 * One request frame to the host's ncl socket, for the landing program. The
 * regular client transport is not imported here because its module evaluates
 * the host's cwd-relative configuration; the forced commands run with the
 * user's home as cwd and are told the socket path by the door state instead.
 * Same wire format: one line-delimited JSON frame per connection.
 */
import net from 'node:net';
import { randomUUID } from 'node:crypto';

import type { RequestFrame, ResponseFrame } from '../../cli/frame.js';

/** Attach waits up to 90 s for a cold sandbox; creation up to 30 s. */
const DEFAULT_TIMEOUT_MS = 180_000;

export function sendHostFrame(
  socketPath: string,
  command: string,
  args: Record<string, unknown>,
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ResponseFrame> {
  const req: RequestFrame = { id: randomUUID(), command, args };
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let buffer = '';
    let settled = false;
    const settle = (outcome: () => void): void => {
      if (settled) return;
      settled = true;
      client.destroy();
      outcome();
    };
    client.setTimeout(timeoutMs, () => settle(() => reject(new Error('the host did not answer in time'))));
    client.on('connect', () => client.write(JSON.stringify(req) + '\n'));
    client.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      const idx = buffer.indexOf('\n');
      if (idx < 0) return;
      const line = buffer.slice(0, idx);
      try {
        const frame = JSON.parse(line) as ResponseFrame;
        settle(() => resolve(frame));
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
        settle(() =>
          reject(
            new Error(`malformed response from host: ${error instanceof Error ? error.message : String(error)}`, {
              cause: error,
            }),
          ),
        );
      }
    });
    client.on('error', (error) => settle(() => reject(error)));
    client.on('close', () => settle(() => reject(new Error('host closed connection before sending response'))));
  });
}
