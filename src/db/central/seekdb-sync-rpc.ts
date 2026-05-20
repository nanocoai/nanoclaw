import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MessageChannel, Worker, receiveMessageOnPort, type MessagePort } from 'node:worker_threads';

function resolveWorkerScript(): string {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const adjacent = path.join(dir, 'seekdb-worker.js');
  if (fs.existsSync(adjacent)) return adjacent;
  const root = path.resolve(dir, '../../..');
  const built = path.join(root, 'dist/db/central/seekdb-worker.js');
  if (fs.existsSync(built)) return built;
  throw new Error('SeekDB worker script missing; run pnpm run build');
}

type RpcResponse = {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
};

/** Sync RPC to a worker thread — SeekdbClient async I/O runs off the main event loop. */
export class SeekDbWorkerBridge {
  private readonly worker: Worker;
  private readonly port: MessagePort;
  private seq = 0;

  private constructor(worker: Worker, port: MessagePort) {
    this.worker = worker;
    this.port = port;
  }

  static openSync(): SeekDbWorkerBridge {
    const worker = new Worker(resolveWorkerScript());
    const channel = new MessageChannel();
    worker.postMessage({ type: 'init-port', port: channel.port1 }, [channel.port1]);
    channel.port2.postMessage({ type: 'handshake' });

    const deadline = Date.now() + 30_000;
    let ready = false;
    while (!ready && Date.now() < deadline) {
      const received = receiveMessageOnPort(channel.port2);
      if (received?.message?.ready) {
        ready = true;
        break;
      }
    }
    if (!ready) {
      void worker.terminate();
      throw new Error('SeekDB worker failed to start');
    }

    return new SeekDbWorkerBridge(worker, channel.port2);
  }

  call<T>(type: string, payload: Record<string, unknown> = {}): T {
    const id = ++this.seq;
    this.port.postMessage({ id, type, ...payload });
    while (true) {
      const received = receiveMessageOnPort(this.port);
      if (!received) continue;
      const msg = received.message as RpcResponse;
      if (msg.id !== id) continue;
      if (!msg.ok) throw new Error(msg.error ?? 'SeekDB worker error');
      return msg.result as T;
    }
  }

  terminate(): void {
    try {
      this.call('shutdown');
    } catch {
      // ignore
    }
    void this.worker.terminate();
  }
}
