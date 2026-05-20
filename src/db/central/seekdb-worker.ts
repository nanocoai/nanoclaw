import { parentPort, type MessagePort } from 'node:worker_threads';

import { AdminClient, SeekdbClient } from 'seekdb';
import type { SeekdbClientArgs } from 'seekdb';

let port: MessagePort;
let client: SeekdbClient | null = null;

type WorkerRequest = {
  id: number;
  type: string;
  args?: SeekdbClientArgs;
  database?: string;
  sql?: string;
  values?: unknown[];
};

type WorkerResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

function reply(msg: WorkerResponse): void {
  port.postMessage(msg);
}

async function handle(msg: WorkerRequest): Promise<void> {
  try {
    switch (msg.type) {
      case 'admin-ensure-db': {
        const admin = AdminClient(msg.args!);
        try {
          const existing = await admin.listDatabases();
          if (!existing.some((d) => d.name === msg.database)) {
            await admin.createDatabase(msg.database!);
          }
        } finally {
          await admin.close();
        }
        reply({ id: msg.id, ok: true });
        return;
      }
      case 'client-open': {
        client = new SeekdbClient(msg.args!);
        await client.execute('SELECT 1');
        reply({ id: msg.id, ok: true });
        return;
      }
      case 'execute': {
        const rows = await client!.execute(msg.sql!, msg.values);
        reply({ id: msg.id, ok: true, result: rows });
        return;
      }
      case 'client-close': {
        if (client) {
          await client.close();
          client = null;
        }
        reply({ id: msg.id, ok: true });
        return;
      }
      case 'shutdown': {
        if (client) {
          await client.close();
          client = null;
        }
        reply({ id: msg.id, ok: true });
        return;
      }
      default:
        reply({ id: msg.id, ok: false, error: `unknown op: ${msg.type}` });
    }
  } catch (err) {
    reply({
      id: msg.id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

parentPort!.once('message', (msg: { type: string; port: MessagePort }) => {
  if (msg.type !== 'init-port') return;
  port = msg.port;
  port.on('message', (req: WorkerRequest & { type: string }) => {
    if (req.type === 'handshake') {
      port.postMessage({ ready: true });
      return;
    }
    void handle(req as WorkerRequest);
  });
});
