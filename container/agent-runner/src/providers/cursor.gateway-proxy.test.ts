/**
 * Proves the Cursor provider's network paths reach the credential gateway.
 *
 * The container never holds the Cursor key: the host injects the placeholder
 * `CURSOR_API_KEY`, the SDK sends it as a bearer header, and the gateway proxy
 * (HTTPS_PROXY) swaps in the vaulted key on its routes. That only holds if
 * every request actually transits the proxy carrying the placeholder. This
 * test stands up a fake CONNECT proxy and a fake TLS origin on localhost,
 * spawns the real provider + real `@cursor/sdk` in a child whose env mirrors
 * the container (HTTPS_PROXY, the gateway CA via SSL_CERT_FILE, and a decoy
 * CURSOR_API_KEY that must never appear on the wire), and asserts:
 *
 *   - the user-key exchange (global fetch) arrives through the proxy with the
 *     placeholder bearer;
 *   - the agent runtime's Connect RPCs (connect-node over HTTP/1.1, i.e.
 *     node:https) arrive through the same proxy carrying the exchanged token;
 *   - nothing carries the decoy key, and no CONNECT targets anything but
 *     Cursor's two API hosts;
 *   - every TCP connection the origin accepted came out of a proxy tunnel,
 *     and the child opened no TLS session of its own.
 *
 * The second case has the fake origin answer `GetServerConfig` with
 * `http2Config: FORCE_ALL_ENABLED`, which is how Cursor's server overrides the
 * client's HTTP/1.1 pin. Under Bun `node:http2` ignores HTTPS_PROXY, so the
 * provider's guard (`installHttp2ProxyGuard` in providers/cursor.ts) must
 * refuse the session before it dials. The child loads the provider barrel
 * first, exactly as the agent-runner does, so the http2 ESM namespace already
 * exists when the guard installs — the case where only its TLS-level hook can
 * hold — and reports that condition back for the assertion. No network is used
 * here — the CONNECT tunnel terminates at the local fake origin, so DNS for
 * Cursor's hosts is never consulted; if the guard ever failed, the refusal
 * assertion fails first.
 *
 * The last block exercises the guard on its own, in-process: no-op without a
 * proxy, refusal of `http2.connect` and of any ALPN-h2 TLS dial to a non-proxy
 * origin, NO_PROXY, idempotence, restore.
 */
import fs from 'fs';
import http2 from 'http2';
import net from 'net';
import os from 'os';
import path from 'path';
import tls from 'tls';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';

import { CURSOR_API_KEY_PLACEHOLDER, http2ProxyBypassError, installHttp2ProxyGuard } from './cursor.js';

// Throwaway self-signed certificate for the fake origin, valid for
// api2.cursor.sh / api.cursor.com / localhost until 2126. Test fixture only —
// it is also the "gateway CA" the child trusts via SSL_CERT_FILE, the same
// variable the gateway sets for its own bundle.
const FIXTURE_CERT = `-----BEGIN CERTIFICATE-----
MIIB4jCCAYegAwIBAgIUdQfCJX6l6nTbL+9ujNqBbDQswdEwCgYIKoZIzj0EAwIw
JzElMCMGA1UEAwwcbmFub2NsYXctY3Vyc29yLWdhdGV3YXktdGVzdDAgFw0yNjA5
MDMxMzI1NDhaGA8yMTI2MDgxMDEzMjU0OFowJzElMCMGA1UEAwwcbmFub2NsYXct
Y3Vyc29yLWdhdGV3YXktdGVzdDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABNIm
FcIH4v+fbiAWNoooI3v3TJrPnsf61V39UYZLi5GRkpreP7r6pfhD5Wf2G49R/U8r
ZWpbkO6T0bg2tc6qcdijgY4wgYswOgYDVR0RBDMwMYIOYXBpMi5jdXJzb3Iuc2iC
DmFwaS5jdXJzb3IuY29tgglsb2NhbGhvc3SHBH8AAAEwDAYDVR0TBAUwAwEB/zAL
BgNVHQ8EBAMCAqQwEwYDVR0lBAwwCgYIKwYBBQUHAwEwHQYDVR0OBBYEFAdUNoI+
19cTO4TLXVIkzpZENEXlMAoGCCqGSM49BAMCA0kAMEYCIQD2xdyTKJQYyHWQk18/
OdWutH9D/rNOHSEbDLcvtkVdzwIhAPCSq17lUJHPxVL6hlvZTnL7uEFIQiSwE9wV
Ysok+36W
-----END CERTIFICATE-----
`;
const FIXTURE_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgrDGZowwCSq/kUaF7
cx5EYmlJx7J/DwVs5lm2zDTD0L6hRANCAATSJhXCB+L/n24gFjaKKCN790yaz57H
+tVd/VGGS4uRkZKa3j+6+qX4Q+Vn9huPUf1PK2VqW5Duk9G4NrXOqnHY
-----END PRIVATE KEY-----
`;

const EXCHANGED_TOKEN = 'nanoclaw-test-exchanged-access-token';
const DECOY_KEY = 'cursor_decoy_real_key_that_must_never_reach_the_wire';
const PROBE_MODEL = 'nanoclaw-gateway-probe-model';
const CURSOR_HOSTS = new Set(['api2.cursor.sh:443', 'api.cursor.com:443']);
const SERVER_CONFIG_PATH = '/aiserver.v1.ServerConfigService/GetServerConfig';
const PRIVACY_MODE_PATH = '/aiserver.v1.DashboardService/GetUserPrivacyMode';
// aiserver.v1.GetServerConfigResponse field 7 `http2_config` (enum, varint):
// tag 0x38, value 2 = HTTP2_CONFIG_FORCE_ALL_ENABLED.
const FORCE_HTTP2_PROTO = new Uint8Array([0x38, 0x02]);
const FORCE_HTTP2_JSON = { http2Config: 'HTTP2_CONFIG_FORCE_ALL_ENABLED' };
const REFUSAL =
  /Cursor SDK attempted an HTTP\/2 connection to https:\/\/api2\.cursor\.sh(?::443)? that would bypass the configured proxy; refusing \(see \/add-cursor troubleshooting\)/;

interface SeenRequest {
  method: string;
  host: string;
  path: string;
  authorization: string | null;
  contentLength: string | null;
  transferEncoding: string | null;
}

interface ProbeSummary {
  events: Array<Record<string, unknown>>;
  tlsDials: Array<{ host: string; port: string; alpn: unknown }>;
  http2EsmSnapshotStale: boolean;
  argv: string[];
  env: Record<string, string>;
}

/**
 * `refuse-rpcs`: every Connect RPC is 401 — the SDK re-exchanges once and then
 * fails closed, which ends the child quickly and shows the placeholder on a
 * second exchange. `force-http2`: the two RPCs the SDK makes before building
 * its agent transport succeed, and the server config forces HTTP/2.
 */
let originMode: 'refuse-rpcs' | 'force-http2' = 'refuse-rpcs';

const seenRequests: SeenRequest[] = [];
const connectTargets: string[] = [];
const nonConnectLines: string[] = [];
// Remote port of every TCP connection the origin accepted, and the local port
// of every upstream socket the proxy opened: a connection whose remote port
// the proxy never used came from somewhere else.
const originConnections: number[] = [];
const proxyUpstreamPorts = new Set<number>();

let origin: ReturnType<typeof Bun.serve>;
let originFront: net.Server;
let originFrontPort: number;
let proxy: net.Server;
let proxyPort: number;
let tempRoot: string;
let certPath: string;

function directOriginConnections(): number[] {
  return originConnections.filter((port) => !proxyUpstreamPorts.has(port));
}

function connectResponse(request: Request, proto: Uint8Array, json: unknown): Response {
  const contentType = request.headers.get('content-type') ?? 'application/proto';
  if (contentType.includes('json')) return Response.json(json);
  return new Response(proto, { headers: { 'content-type': contentType } });
}

function startOriginFront(): Promise<number> {
  originFront = net.createServer((socket) => {
    originConnections.push(socket.remotePort ?? -1);
    const upstream = net.connect({ host: '127.0.0.1', port: origin.port! });
    socket.pipe(upstream);
    upstream.pipe(socket);
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });
  return new Promise((resolve) => {
    originFront.listen(0, '127.0.0.1', () => resolve((originFront.address() as net.AddressInfo).port));
  });
}

function startProxy(): Promise<number> {
  proxy = net.createServer((client) => {
    let head = '';
    const onData = (chunk: Buffer): void => {
      head += chunk.toString('latin1');
      const end = head.indexOf('\r\n\r\n');
      if (end === -1) return;
      client.off('data', onData);
      const requestLine = head.slice(0, head.indexOf('\r\n'));
      const match = /^CONNECT (\S+) HTTP\/1\.[01]$/.exec(requestLine);
      if (!match) {
        nonConnectLines.push(requestLine);
        client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n');
        return;
      }
      connectTargets.push(match[1]!);
      // Every tunnel lands on the fake origin, whatever host was asked for:
      // the proxy is the only thing that ever resolves Cursor's names here.
      const upstream = net.connect({ host: '127.0.0.1', port: originFrontPort }, () => {
        proxyUpstreamPorts.add(upstream.localPort!);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        const rest = head.slice(end + 4);
        if (rest) upstream.write(Buffer.from(rest, 'latin1'));
        client.pipe(upstream);
        upstream.pipe(client);
      });
      upstream.on('error', () => client.destroy());
      client.on('error', () => upstream.destroy());
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  return new Promise((resolve) => {
    proxy.listen(0, '127.0.0.1', () => resolve((proxy.address() as net.AddressInfo).port));
  });
}

beforeAll(async () => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-gateway-proxy-'));
  certPath = path.join(tempRoot, 'gateway-ca.pem');
  fs.writeFileSync(certPath, FIXTURE_CERT);

  origin = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    tls: { cert: FIXTURE_CERT, key: FIXTURE_KEY },
    fetch(request) {
      const url = new URL(request.url);
      seenRequests.push({
        method: request.method,
        host: request.headers.get('host') ?? url.host,
        path: url.pathname,
        authorization: request.headers.get('authorization'),
        contentLength: request.headers.get('content-length'),
        transferEncoding: request.headers.get('transfer-encoding'),
      });
      if (url.pathname === '/auth/exchange_user_api_key') {
        return Response.json({ accessToken: EXCHANGED_TOKEN });
      }
      if (url.pathname === '/v1/models') {
        // The SDK validates the requested model against this list before it
        // builds the agent transport; the probe's model must be on it.
        return Response.json({ items: [{ id: PROBE_MODEL }] });
      }
      if (originMode === 'force-http2') {
        if (url.pathname === PRIVACY_MODE_PATH) return connectResponse(request, new Uint8Array(), {});
        if (url.pathname === SERVER_CONFIG_PATH) return connectResponse(request, FORCE_HTTP2_PROTO, FORCE_HTTP2_JSON);
      }
      return Response.json({ code: 'unauthenticated', message: 'nanoclaw gateway probe' }, { status: 401 });
    },
  });
  originFrontPort = await startOriginFront();
  proxyPort = await startProxy();
});

beforeEach(() => {
  seenRequests.length = 0;
  connectTargets.length = 0;
  nonConnectLines.length = 0;
  originConnections.length = 0;
  proxyUpstreamPorts.clear();
});

afterAll(() => {
  proxy?.close();
  originFront?.close();
  origin?.stop(true);
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

async function runProbe(): Promise<ProbeSummary> {
  const home = path.join(tempRoot, 'home');
  const agentDir = path.join(tempRoot, 'agent');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(agentDir, 'memory', 'system'), { recursive: true });
  fs.writeFileSync(path.join(agentDir, 'memory', 'index.md'), '# probe\n');
  fs.writeFileSync(path.join(agentDir, 'memory', 'system', 'definition.md'), '# probe\n');

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (/^(https?_proxy|no_proxy|all_proxy|ssl_cert_file|node_extra_ca_certs|cursor_)/i.test(key)) continue;
    env[key] = value;
  }
  Object.assign(env, {
    HOME: home,
    NANOCLAW_AGENT_DIR: agentDir,
    NANOCLAW_CONVERSATIONS_DIR: path.join(agentDir, 'conversations'),
    // What the gateway contributes at spawn: proxy + CA bundle pointer.
    HTTPS_PROXY: `http://127.0.0.1:${proxyPort}`,
    SSL_CERT_FILE: certPath,
    // What the host adapter contributes is the placeholder; a decoy stands in
    // its place here so any code path that read the env instead of passing
    // the placeholder would show up on the wire.
    CURSOR_API_KEY: DECOY_KEY,
  });

  const runnerRoot = path.resolve(import.meta.dir, '..', '..');
  const child = Bun.spawn(['bun', path.join(import.meta.dir, 'cursor-gateway-probe.ts')], {
    cwd: runnerRoot,
    env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const killer = setTimeout(() => child.kill(), 45_000);
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  await child.exited;
  clearTimeout(killer);
  const line = stdout.trim().split('\n').at(-1) ?? '';
  try {
    return JSON.parse(line);
  } catch {
    throw new Error(`probe produced no summary\nstdout: ${stdout}\nstderr: ${stderr}`);
  }
}

function logWire(label: string, summary: ProbeSummary): void {
  // What crossed the wire, for the log: every tunnel target and every
  // request the fake origin saw (method, path, bearer, body framing).
  console.error(
    `[cursor-gateway-proxy:${label}] tunnels=${JSON.stringify(connectTargets)} requests=${JSON.stringify(
      seenRequests.map((request) => ({
        ...request,
        authorization: request.authorization?.replace(/Bearer (\S{6})\S*/, 'Bearer $1…') ?? null,
      })),
    )} events=${JSON.stringify(summary.events)} tlsDials=${JSON.stringify(summary.tlsDials)}`,
  );
}

/** The invariants that must hold on every run, whatever the origin answers. */
function expectGatewayInvariants(summary: ProbeSummary): void {
  // The child ran with the decoy in its env and finished on its own.
  expect(summary.env.CURSOR_API_KEY).toBe(DECOY_KEY);
  expect(summary.events.some((event) => event.type === 'result' || event.type === 'thrown')).toBe(true);
  expect(summary.argv.some((arg) => arg.includes(DECOY_KEY) || arg.includes(CURSOR_API_KEY_PLACEHOLDER))).toBe(false);

  // Everything left the container through CONNECT tunnels to Cursor's hosts.
  expect(connectTargets.length).toBeGreaterThan(0);
  expect(connectTargets.filter((target) => !CURSOR_HOSTS.has(target))).toEqual([]);
  expect(nonConnectLines).toEqual([]);

  // The user-key exchange (global fetch) carried the placeholder, never the decoy.
  const exchanges = seenRequests.filter((request) => request.path === '/auth/exchange_user_api_key');
  expect(exchanges.length).toBeGreaterThan(0);
  for (const exchange of exchanges) {
    expect(exchange.method).toBe('POST');
    expect(exchange.host).toBe('api2.cursor.sh');
    expect(exchange.authorization).toBe(`Bearer ${CURSOR_API_KEY_PLACEHOLDER}`);
  }

  // The agent runtime's Connect RPCs (connect-node → node:https) rode the
  // same tunnel with the token the exchange returned.
  const rpcs = seenRequests.filter((request) => request.path.startsWith('/aiserver.v1.'));
  expect(rpcs.length).toBeGreaterThan(0);
  for (const rpc of rpcs) {
    expect(rpc.host).toBe('api2.cursor.sh');
    expect(rpc.authorization).toBe(`Bearer ${EXCHANGED_TOKEN}`);
  }

  // No request of any kind carried the decoy.
  for (const request of seenRequests) {
    expect(request.authorization ?? '').not.toContain(DECOY_KEY);
  }

  // Every connection the origin accepted came out of a proxy tunnel, and the
  // child never opened a TLS session of its own (an HTTP/2 dial would be one).
  expect(originConnections.length).toBeGreaterThan(0);
  expect(directOriginConnections()).toEqual([]);
  expect(summary.tlsDials).toEqual([]);
}

describe('Cursor traffic through the credential gateway proxy', () => {
  it('sends the key exchange and the agent RPCs through HTTPS_PROXY with only the placeholder', async () => {
    originMode = 'refuse-rpcs';
    const summary = await runProbe();
    logWire('http1', summary);
    expectGatewayInvariants(summary);
  }, 60_000);

  it('refuses the HTTP/2 transport when the server forces it, without a direct connection', async () => {
    originMode = 'force-http2';
    const summary = await runProbe();
    logWire('force-http2', summary);
    expectGatewayInvariants(summary);

    // The SDK asked for the server config through the tunnel and was told to
    // use HTTP/2 — the input that overrides the client's HTTP/1.1 pin.
    expect(seenRequests.some((request) => request.path === SERVER_CONFIG_PATH)).toBe(true);

    // The production condition held: the http2 ESM namespace predates the
    // guard, so the refusal below came from the TLS-level hook.
    expect(summary.http2EsmSnapshotStale).toBe(true);

    // The guard refused the HTTP/2 session with the documented error, and the
    // run failed closed on it rather than reaching Cursor directly.
    const texts = summary.events.flatMap((event) =>
      [event.message, event.text].filter((value): value is string => typeof value === 'string'),
    );
    expect(texts.some((text) => REFUSAL.test(text))).toBe(true);
    expect(summary.events.some((event) => event.type === 'result' && event.isError === true)).toBe(true);
  }, 60_000);
});

// ─── the guard on its own ───────────────────────────────────────────────
// Port 1 on 127.0.0.1 has no listener, so a dial the guard permits fails
// asynchronously with ECONNREFUSED — distinguishable from the guard's
// synchronous refusal — and every permitted dial here stays on localhost.

const PROXY_ENV = { HTTPS_PROXY: 'http://127.0.0.1:1' };
const REFUSED = 'that would bypass the configured proxy; refusing (see /add-cursor troubleshooting)';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

/** Swallow the asynchronous ECONNREFUSED of a permitted dial and close it. */
function settle(dial: { on(event: 'error', handler: (err: Error) => void): unknown; destroy(): unknown }): void {
  dial.on('error', () => {});
  dial.destroy();
}

describe('installHttp2ProxyGuard (client-side refusal, in-process)', () => {
  it('installs nothing when no proxy is configured', () => {
    const before = { http2: http2.connect, tls: tls.connect };
    expect(installHttp2ProxyGuard({})).toBeNull();
    expect(installHttp2ProxyGuard({ NO_PROXY: '*', HTTP_PROXY: 'http://127.0.0.1:1' })).toBeNull();
    expect(http2.connect).toBe(before.http2);
    expect(tls.connect).toBe(before.tls);
  });

  it('refuses http2.connect to any origin but the proxy', () => {
    restore = installHttp2ProxyGuard(PROXY_ENV);
    expect(() => http2.connect('https://api2.cursor.sh')).toThrow(
      http2ProxyBypassError('https://api2.cursor.sh').message,
    );
    expect(() => http2.connect(new URL('https://api.cursor.com:8443/x'))).toThrow(
      `Cursor SDK attempted an HTTP/2 connection to https://api.cursor.com:8443/x ${REFUSED}`,
    );
    // The proxy itself is the one permitted destination.
    settle(http2.connect('http://127.0.0.1:1'));
  });

  it('refuses a TLS dial with ALPN h2 to any origin but the proxy and passes every other dial through', () => {
    restore = installHttp2ProxyGuard(PROXY_ENV);
    expect(() => tls.connect({ host: 'api2.cursor.sh', port: 443, ALPNProtocols: ['h2'] })).toThrow(
      `Cursor SDK attempted an HTTP/2 connection to https://api2.cursor.sh:443 ${REFUSED}`,
    );
    expect(() => tls.connect(443, 'api2.cursor.sh', { ALPNProtocols: ['h2'] })).toThrow(REFUSED);
    expect(() => tls.connect({ host: 'api2.cursor.sh', port: 443, ALPNProtocols: ['http/1.1', 'h2'] })).toThrow(
      REFUSED,
    );
    // HTTP/1.1 and plain TLS to a non-proxy host are not the guard's business.
    settle(tls.connect({ host: '127.0.0.1', port: 1, ALPNProtocols: ['http/1.1'] }));
    settle(tls.connect({ host: '127.0.0.1', port: 1 }));
    // An h2 dial to the proxy itself is permitted.
    settle(tls.connect({ host: '127.0.0.1', port: 1, ALPNProtocols: ['h2'] }));
  });

  it('honors NO_PROXY for hosts the operator excluded from the proxy', () => {
    restore = installHttp2ProxyGuard({ HTTPS_PROXY: 'http://10.0.0.1:3128', NO_PROXY: '127.0.0.1,.example' });
    settle(http2.connect('https://127.0.0.1:1'));
    settle(tls.connect({ host: '127.0.0.1', port: 1, ALPNProtocols: ['h2'] }));
    expect(() => http2.connect('https://api2.cursor.sh')).toThrow(REFUSED);
  });

  it('refuses every HTTP/2 dial when the proxy setting cannot be parsed', () => {
    restore = installHttp2ProxyGuard({ HTTPS_PROXY: 'not a url' });
    expect(() => http2.connect('https://127.0.0.1:1')).toThrow(REFUSED);
    expect(() => tls.connect({ host: '127.0.0.1', port: 1, ALPNProtocols: ['h2'] })).toThrow(REFUSED);
  });

  it('is idempotent and restores the originals', () => {
    const originals = { http2: http2.connect, tls: tls.connect };
    restore = installHttp2ProxyGuard(PROXY_ENV);
    const guarded = { http2: http2.connect, tls: tls.connect };
    expect(guarded.http2).not.toBe(originals.http2);
    expect(guarded.tls).not.toBe(originals.tls);

    const again = installHttp2ProxyGuard(PROXY_ENV);
    expect(http2.connect).toBe(guarded.http2);
    expect(tls.connect).toBe(guarded.tls);
    again?.();
    expect(http2.connect).toBe(guarded.http2);
    expect(tls.connect).toBe(guarded.tls);

    restore();
    restore = null;
    expect(http2.connect).toBe(originals.http2);
    expect(tls.connect).toBe(originals.tls);
  });
});
