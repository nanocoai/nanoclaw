/**
 * Host-side TCP relay so an Apple Container agent on the 192.168.64.0/24 bridge
 * can reach the OneCLI gateway, which runs INSIDE Docker Desktop and publishes
 * 10255 only on 127.0.0.1. Binds the bridge gateway IP:10255 and pipes each
 * connection to 127.0.0.1:10255. No-op under Docker.
 *
 * Security invariants (do NOT relax):
 *  - Binds ONLY the host-only RFC1918 bridge gateway IP — NEVER 0.0.0.0. The
 *    relayed port injects vault credentials; exposing it on a routable LAN NIC
 *    is unacceptable. If the bridge IP isn't bindable yet, retry — never widen.
 *  - Rejects any connection whose remote address is not in 192.168.64.0/24
 *    (defense-in-depth even if the OS ever routes one in).
 *  - Refuses to start unless 127.0.0.1:10255 is reachable (Docker Desktop hosts
 *    the OneCLI gateway) AND the unauthenticated control API on 10254 is NOT
 *    reachable off-loopback (10254 freely serves the proxy credential, so
 *    "10254 loopback-only" — not the proxy's basic-auth — is the real boundary).
 */
import net from 'net';

import { IS_APPLE_CONTAINER, detectHostGateway } from './container-runtime.js';
import { ONECLI_FORWARD_BIND, ONECLI_REMOTE_HOST } from './config.js';
import { log } from './log.js';

const PROXY_PORT = 10255;
const CONTROL_PORT = 10254;
const TARGET = '127.0.0.1';

let server: net.Server | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let stopped = false;

export function inBridgeSubnet(ip?: string): boolean {
  if (!ip) return false;
  return ip.replace(/^::ffff:/, '').startsWith('192.168.64.');
}

function probe(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      s.destroy();
      resolve(ok);
    };
    s.once('connect', () => finish(true));
    s.once('error', () => finish(false));
    setTimeout(() => finish(false), timeoutMs);
  });
}

/**
 * Start the OneCLI forwarder. No-op under Docker. Throws (aborting host startup)
 * if the OneCLI gateway is unreachable or the control API is exposed off-loopback.
 */
export async function startOneCliForwarder(): Promise<void> {
  if (!IS_APPLE_CONTAINER) return;

  // The forwarder bridges a LOCAL OneCLI (gateway on 127.0.0.1) to the Apple
  // Container bridge. A REMOTE OneCLI (ONECLI_URL points off-host) is reached
  // directly over the LAN — no forwarder; the injected gateway host is retargeted
  // to ONECLI_REMOTE_HOST in container-runner instead.
  if (ONECLI_REMOTE_HOST) {
    log.info('OneCLI is remote — skipping local forwarder', { onecliHost: ONECLI_REMOTE_HOST });
    return;
  }
  stopped = false;

  const bind = ONECLI_FORWARD_BIND || detectHostGateway();
  if (!bind.startsWith('192.168.64.')) {
    throw new Error(`OneCLI forwarder refuses to bind non-bridge address ${bind}`);
  }

  // Precondition 1: OneCLI gateway must be reachable on loopback (Docker Desktop running).
  if (!(await probe(TARGET, PROXY_PORT, 3000))) {
    throw new Error(
      `OneCLI gateway not reachable on ${TARGET}:${PROXY_PORT} — Docker Desktop must be running to host the OneCLI gateway, even under Apple Container`,
    );
  }
  // Precondition 2: the unauthenticated control API must NOT be reachable off-loopback.
  if (await probe(bind, CONTROL_PORT, 2000)) {
    throw new Error(
      `OneCLI control API ${CONTROL_PORT} is reachable on ${bind} — refusing to start. The unauthenticated control API must stay loopback-only (it serves the proxy credential).`,
    );
  }

  server = net.createServer((c) => {
    if (!inBridgeSubnet(c.remoteAddress)) {
      log.warn('OneCLI forwarder rejected off-bridge client', { remote: c.remoteAddress });
      c.destroy();
      return;
    }
    const up = net.connect(PROXY_PORT, TARGET);
    c.pipe(up);
    up.pipe(c);
    const swallow = (e: NodeJS.ErrnoException) => {
      if (e && e.code !== 'ECONNRESET') log.debug('OneCLI forwarder conn error', { err: e });
      c.destroy();
      up.destroy();
    };
    c.on('error', swallow);
    up.on('error', swallow);
  });

  server.on('error', (e: NodeJS.ErrnoException) => {
    if (stopped) return;
    if (e.code === 'EADDRNOTAVAIL') {
      // bridge100 IP not up yet — retry the SAME server on the bridge IP. Never
      // widen to 0.0.0.0 (that would publish vault credentials on the LAN).
      log.warn('OneCLI forwarder: bridge IP not up yet, retrying in 3s', { bind });
      retryTimer = setTimeout(() => {
        if (!stopped && server) server.listen(PROXY_PORT, bind);
      }, 3000);
    } else {
      log.error('OneCLI forwarder listen error (refusing 0.0.0.0 fallback)', { err: e, bind });
    }
  });

  server.listen(PROXY_PORT, bind, () =>
    log.info('OneCLI forwarder listening', { bind, port: PROXY_PORT, target: `${TARGET}:${PROXY_PORT}` }),
  );
}

export function stopOneCliForwarder(): void {
  stopped = true;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  server?.close();
  server = null;
}
