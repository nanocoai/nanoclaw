/**
 * The forced commands' side of the target map: one `GET /target?port=N`
 * over the door's unix socket. `undefined` means the host knows no target
 * for that source port; connection failures throw.
 */
import http from 'node:http';

import type { DoorStream } from './target-map.js';

export function fetchTarget(socketPath: string, port: number, timeoutMs = 3000): Promise<DoorStream | undefined> {
  return new Promise((resolve, reject) => {
    const req = http.request({ socketPath, path: `/target?port=${port}`, method: 'GET', timeout: timeoutMs }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 404) return resolve(undefined);
        if (res.statusCode !== 200) return reject(new Error(`target lookup failed (${res.statusCode}): ${body}`));
        try {
          const stream = JSON.parse(body) as DoorStream;
          if (typeof stream?.target?.account !== 'string') throw new Error('target has no account');
          resolve(stream);
        } catch (error) {
          if (!(error instanceof Error)) throw error;
          reject(
            new Error(`malformed target: ${error instanceof Error ? error.message : String(error)}`, { cause: error }),
          );
        }
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('target lookup timed out')));
    req.on('error', reject);
    req.end();
  });
}
