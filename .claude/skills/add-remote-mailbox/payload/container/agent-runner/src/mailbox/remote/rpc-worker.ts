/**
 * Worker half of the synchronous RPC channel (see sync-rpc.ts).
 *
 * Loop: wait for state=1 (request) → perform the HTTP exchange (with
 * connection-level retry) → write the raw response → state=2 and notify.
 * All policy about ids/JSON lives on the main thread; this thread only moves
 * bytes and decides whether a failed attempt is worth repeating.
 */
import { workerData } from 'node:worker_threads';

const STATE_IDLE = 0;
const STATE_REQUEST = 1;
const STATE_RESPONSE = 2;

/** ctl[2] values below zero are transport outcomes; otherwise it is the HTTP status. */
const STATUS_NETWORK = -1;
const STATUS_TIMEOUT = -2;
const STATUS_TOO_LARGE = -3;

const { sab, url, token } = workerData as { sab: SharedArrayBuffer; url: string; token: string };
const ctl = new Int32Array(sab, 0, 4); // [state, length, status, _]
const bytes = new Uint8Array(sab, 16);
const dec = new TextDecoder();
const enc = new TextEncoder();

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface Envelope {
  body: string;
  session: string;
  timeoutMs: number;
  retryBudgetMs: number;
}

async function exchange(env: Envelope): Promise<{ status: number; text: string }> {
  const started = Date.now();
  let delay = 50;
  for (;;) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        body: env.body,
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
          // No pooled connections: after a host restart a kept-alive socket
          // (notably through OpenShell's network proxy) can go dead without
          // the guest seeing it, and the next call hangs until it times out.
          connection: 'close',
          'x-nanoclaw-session': env.session,
        },
        signal: AbortSignal.timeout(env.timeoutMs),
        keepalive: false,
      });
      return { status: response.status, text: await response.text() };
    } catch (error) {
      const name = (error as { name?: string })?.name;
      if (name === 'TimeoutError' || name === 'AbortError') {
        return { status: STATUS_TIMEOUT, text: `no response within ${env.timeoutMs}ms` };
      }
      const message = error instanceof Error ? error.message : String(error);
      // Connection refused / reset: the host may be restarting. Retry with backoff.
      if (Date.now() - started + delay >= env.retryBudgetMs) {
        return { status: STATUS_NETWORK, text: message };
      }
      await sleep(delay);
      delay = Math.min(delay * 2, 2000);
    }
  }
}

for (;;) {
  Atomics.wait(ctl, 0, STATE_IDLE);
  if (Atomics.load(ctl, 0) !== STATE_REQUEST) continue;
  const env = JSON.parse(dec.decode(bytes.slice(0, ctl[1]))) as Envelope;
  let { status, text } = await exchange(env);
  let payload = enc.encode(text);
  if (payload.length > bytes.length) {
    status = STATUS_TOO_LARGE;
    payload = enc.encode(`response of ${payload.length} bytes exceeds the ${bytes.length}-byte channel`);
  }
  bytes.set(payload);
  ctl[1] = payload.length;
  ctl[2] = status;
  Atomics.store(ctl, 0, STATE_RESPONSE);
  Atomics.notify(ctl, 0);
}
