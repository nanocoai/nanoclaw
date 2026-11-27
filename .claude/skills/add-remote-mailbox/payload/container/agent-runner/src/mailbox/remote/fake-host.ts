/** Test helper: launches fake-host.server.ts as a subprocess and drives its control plane. */
import net from 'node:net';

export interface FakeHost {
  url: string;
  port: number;
  token: string;
  session: string;
  ctl<T = any>(body: Record<string, unknown>): Promise<T>;
  dump(): Promise<{
    log: Array<{ op: string; args: unknown[]; session: string | null; id: number }>;
    inboxReads: number;
    outbound: Array<Record<string, any>>;
    outbox: Record<string, { data: string; complete: boolean; chunks: number }>;
  }>;
  stop(): void;
}

export async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

export async function startFakeHost(
  options: { token?: string; session?: string; startDelayMs?: number; waitReady?: boolean } = {},
): Promise<FakeHost> {
  const port = await freePort();
  const token = options.token ?? 'tok-' + Math.random().toString(36).slice(2);
  const session = options.session ?? 'ag-1/sess-1';
  const proc = Bun.spawn([process.execPath, new URL('./fake-host.server.ts', import.meta.url).pathname], {
    env: {
      ...process.env,
      PORT: String(port),
      TOKEN: token,
      SESSION: session,
      START_DELAY_MS: String(options.startDelayMs ?? 0),
    },
    stdout: 'pipe',
    stderr: 'inherit',
  });
  const host: FakeHost = {
    url: `http://127.0.0.1:${port}/v1/mailbox`,
    port,
    token,
    session,
    async ctl(body) {
      const response = await fetch(`http://127.0.0.1:${port}/_ctl`, { method: 'POST', body: JSON.stringify(body) });
      return (await response.json()) as any;
    },
    dump: () => host.ctl({ cmd: 'dump' }),
    stop: () => proc.kill(),
  };
  if (options.waitReady !== false) {
    const reader = proc.stdout.getReader();
    const { value } = await reader.read();
    if (!new TextDecoder().decode(value).includes('ready')) throw new Error('fake host failed to start');
    reader.releaseLock();
  }
  return host;
}
