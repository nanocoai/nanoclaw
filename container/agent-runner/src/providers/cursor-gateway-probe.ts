/**
 * Test-only child process for cursor.gateway-proxy.test.ts.
 *
 * Runs one real Cursor query — the unmocked provider, the real `@cursor/sdk`,
 * real sockets — inside an environment shaped like the agent container: the
 * credential gateway's HTTPS_PROXY and SSL_CERT_FILE, and a CURSOR_API_KEY
 * that is deliberately NOT the placeholder, so the parent can prove nothing
 * but the placeholder ever reaches the wire. Prints one JSON summary line and
 * exits; the parent owns the fake proxy and origin and does the asserting.
 *
 * Load order mirrors the agent-runner: the provider barrel is imported first,
 * so the Claude SDK has already created the `http2` ESM namespace by the time
 * the Cursor module runs — the condition under which only the TLS-level hook
 * of the HTTP/2 guard can hold. `http2EsmSnapshotStale` reports that the
 * condition was actually met.
 *
 * Every import below is dynamic so the dial recorder sits underneath the
 * guard: it wraps `tls.connect` before the provider does, so it records only
 * the TLS dials that got past the guard. Bun's fetch and node:https clients
 * dial natively and never appear here; an HTTP/2 session does.
 */
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const tls = require('tls') as typeof import('tls');
const http2 = require('http2') as typeof import('http2');

const tlsDials: Array<{ host: string; port: string; alpn: unknown }> = [];
const originalTlsConnect = tls.connect;
(tls as { connect: typeof tls.connect }).connect = function (this: unknown, ...args: unknown[]) {
  const options = args.find((arg) => arg !== null && typeof arg === 'object') as
    | { host?: string; port?: string | number; ALPNProtocols?: unknown }
    | undefined;
  tlsDials.push({ host: String(options?.host), port: String(options?.port), alpn: options?.ALPNProtocols ?? null });
  return (originalTlsConnect as unknown as (...a: unknown[]) => unknown).apply(this, args);
} as typeof tls.connect;

await import('./index.js');

// Does a fresh ESM import of http2 still see a patch to the module object?
// If not, a namespace snapshot already exists (the production condition).
const pristineConnect = http2.connect;
(http2 as { connect: typeof http2.connect }).connect = (() => {
  throw new Error('probe');
}) as unknown as typeof http2.connect;
const http2EsmSnapshotStale = (await import('http2')).connect === pristineConnect;
(http2 as { connect: typeof http2.connect }).connect = pristineConnect;

const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { CursorProvider } = await import('./cursor.js');

const provider = new CursorProvider({ assistantName: 'Gateway probe', model: 'nanoclaw-gateway-probe-model' });
provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);

const query = provider.query({ prompt: 'gateway probe', cwd: process.env.NANOCLAW_AGENT_DIR ?? process.cwd() });
query.end();
const deadline = setTimeout(() => query.abort(), 20_000);

const events: Array<Record<string, unknown>> = [];
try {
  for await (const event of query.events) {
    if (event.type === 'error')
      events.push({ type: 'error', message: event.message, classification: event.classification });
    else if (event.type === 'result') events.push({ type: 'result', text: event.text, isError: event.isError });
    else events.push({ type: event.type });
  }
} catch (err) {
  events.push({ type: 'thrown', message: err instanceof Error ? err.message : String(err) });
} finally {
  clearTimeout(deadline);
}

console.log(
  JSON.stringify({
    events,
    tlsDials,
    http2EsmSnapshotStale,
    argv: process.argv,
    env: { CURSOR_API_KEY: process.env.CURSOR_API_KEY, HTTPS_PROXY: process.env.HTTPS_PROXY },
  }),
);
process.exit(0);
