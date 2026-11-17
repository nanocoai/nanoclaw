/**
 * Proves agy's model traffic reaches the credential gateway carrying only the
 * placeholder key. Opt-in, like the native test (needs the real binary and
 * openssl):
 *
 *   AGY_TEST_BINARY=/absolute/path/to/agy bun test src/providers/antigravity.gateway-proxy.test.ts
 *
 * The container never holds the Gemini key: the host injects the placeholder
 * GEMINI_API_KEY, agy sends it as `x-goog-api-key`, and the gateway (reached
 * through HTTPS_PROXY, trusted through SSL_CERT_FILE) swaps in the vaulted
 * key. This stands up that shape on localhost: a test CA passed via
 * SSL_CERT_FILE, a CONNECT proxy that tunnels every request to a TLS origin
 * presenting a generativelanguage.googleapis.com certificate from that CA, and
 * a decoy key in the runner's environment that must never appear on the wire.
 * No GOOGLE_GEMINI_BASE_URL: agy dials its real endpoint, which only the proxy
 * resolves. Nothing leaves the machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawn } from 'child_process';
import fs from 'fs';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';

import { ANTIGRAVITY_API_KEY_PLACEHOLDER, antigravityRuntimeOwnership } from './antigravity-config.js';
import { AntigravityProvider, defaultAntigravityRuntimeDeps } from './antigravity.js';
import type { ProviderEvent } from './types.js';

const binary = process.env.AGY_TEST_BINARY;
const DECOY_KEY = 'AIzaDECOY-real-key-must-never-leave';

function hasOpenssl(): boolean {
  try {
    execFileSync('openssl', ['version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

let root: string;
let origin: https.Server;
let proxy: net.Server;
let originPort: number;
const connectTargets: string[] = [];
const originRequests: Array<{ host: string | undefined; url: string; headers: Record<string, unknown>; body: string }> =
  [];
const savedEnv: Record<string, string | undefined> = {};

/** A throwaway CA and a leaf for the two Google hosts agy dials, valid for two days. */
function generateCertificates(dir: string): { caPath: string; key: string; cert: string } {
  const run = (args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });
  run([
    'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=nanoclaw-agy-gateway-test-ca',
    '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
  ]); // prettier-ignore
  run([
    'req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:P-256', '-nodes',
    '-keyout', 'leaf.key', '-out', 'leaf.csr', '-subj', '/CN=generativelanguage.googleapis.com',
  ]); // prettier-ignore
  fs.writeFileSync(
    path.join(dir, 'leaf.ext'),
    'subjectAltName=DNS:generativelanguage.googleapis.com,DNS:play.googleapis.com\n' +
      'basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nkeyUsage=digitalSignature\n',
  );
  run([
    'x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
    '-out', 'leaf.pem', '-days', '2', '-extfile', 'leaf.ext',
  ]); // prettier-ignore
  return {
    caPath: path.join(dir, 'ca.pem'),
    key: fs.readFileSync(path.join(dir, 'leaf.key'), 'utf-8'),
    cert: fs.readFileSync(path.join(dir, 'leaf.pem'), 'utf-8'),
  };
}

function listen(server: net.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () => resolve((server.address() as net.AddressInfo).port)),
  );
}

describe.skipIf(!binary || !hasOpenssl())('agy through a TLS-intercepting gateway proxy', () => {
  beforeAll(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'antigravity-gateway-'));
    fs.mkdirSync(path.join(root, 'home'));
    fs.mkdirSync(path.join(root, 'workspace'));
    const { caPath, key, cert } = generateCertificates(root);

    // The "upstream" the gateway forwards to: answers model calls as Gemini
    // would, anything else (telemetry) with an empty 200.
    origin = https.createServer({ key, cert }, (req, res) => {
      let body = '';
      req.on('data', (chunk) => (body += chunk));
      req.on('end', () => {
        originRequests.push({ host: req.headers.host, url: req.url ?? '', headers: { ...req.headers }, body });
        if (!/:streamGenerateContent/.test(req.url ?? '')) {
          res.writeHead(200, { 'content-type': 'application/json' }).end('{}');
          return;
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const chunk = {
          candidates: [
            { content: { role: 'model', parts: [{ text: 'PONG via gateway' }] }, finishReason: 'STOP', index: 0 },
          ],
          usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 },
        };
        res.end(`data: ${JSON.stringify(chunk)}\r\n\r\n`);
      });
    });
    originPort = await listen(origin);

    // The gateway's front door: CONNECT only, every tunnel lands on the origin.
    proxy = net.createServer((client) => {
      let head = '';
      const onData = (data: Buffer): void => {
        head += data.toString('latin1');
        const end = head.indexOf('\r\n\r\n');
        if (end === -1) return;
        client.off('data', onData);
        const match = /^CONNECT (\S+) HTTP\/1\.[01]/.exec(head);
        if (!match) {
          client.end('HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        connectTargets.push(match[1]!);
        const upstream = net.connect({ host: '127.0.0.1', port: originPort }, () => {
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
    const proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;

    for (const [name, value] of Object.entries({
      HOME: path.join(root, 'home'),
      GEMINI_API_KEY: ANTIGRAVITY_API_KEY_PLACEHOLDER,
      GOOGLE_API_KEY: DECOY_KEY,
      ANTHROPIC_API_KEY: DECOY_KEY,
      HTTPS_PROXY: proxyUrl,
      HTTP_PROXY: proxyUrl,
      SSL_CERT_FILE: caPath,
    })) {
      savedEnv[name] = process.env[name];
      process.env[name] = value;
    }
    antigravityRuntimeOwnership.contractOwnsRuntimeFiles = false;
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    origin?.close();
    proxy?.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it('sends the model request through the proxy with only the placeholder key', async () => {
    const provider = new AntigravityProvider(
      {},
      {
        ...defaultAntigravityRuntimeDeps,
        // The production env (allowlist + placeholder), unmodified; only
        // the binary path differs from the production spawn.
        spawnAgy: (args, options) =>
          spawn(binary!, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }),
      },
    );
    provider.registerMemorySessionHook({ command: 'true', legacyCommands: [], sources: ['startup'] });
    const events: ProviderEvent[] = [];
    const query = provider.query({ prompt: 'hello gateway', cwd: path.join(root, 'workspace') });
    const done = (async () => {
      for await (const event of query.events) {
        events.push(event);
        if (event.type === 'result') query.end();
      }
    })();
    await done;

    expect(events.filter((event) => event.type === 'result')).toEqual([
      { type: 'result', text: expect.stringContaining('PONG via gateway') },
    ] as never);
    expect(connectTargets).toContain('generativelanguage.googleapis.com:443');
    const modelCalls = originRequests.filter((request) => request.url.includes(':streamGenerateContent'));
    expect(modelCalls.length).toBeGreaterThan(0);
    for (const call of modelCalls) {
      expect(call.host).toBe('generativelanguage.googleapis.com');
      expect(call.headers['x-goog-api-key']).toBe(ANTIGRAVITY_API_KEY_PLACEHOLDER);
      expect(call.url).not.toContain('key=');
    }
    // The decoy never reaches the wire, in any header, URL or body.
    for (const request of originRequests) {
      expect(JSON.stringify(request)).not.toContain(DECOY_KEY);
    }
    // Every tunnel was to Google: the model endpoint and agy's telemetry.
    for (const target of connectTargets) {
      expect(['generativelanguage.googleapis.com:443', 'play.googleapis.com:443']).toContain(target);
    }
  }, 120_000);
});
