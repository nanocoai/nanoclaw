/**
 * Minimal local HTTP CONNECT proxy with DNS-over-HTTPS resolution.
 *
 * Why: on the capture machine the macOS system resolver (configd) is broken
 * ("No DNS configuration available" from `scutil --dns`), so getaddrinfo —
 * and with it curl, git, Node/Bun fetch — cannot resolve ANY hostname, while
 * raw DNS servers answer fine and TCP to resolved IPs works. The Claude Code
 * CLI honors HTTPS_PROXY, and a CONNECT proxy receives the target as a
 * hostname it can resolve itself — here via DoH to 1.1.1.1 BY IP LITERAL, so
 * no local resolution is ever needed.
 *
 * Capture-harness support only. Never used by the agent-runner at runtime.
 */
import net from 'node:net';

const cache = new Map<string, string>();

async function resolveHost(host: string): Promise<string> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return host;
  const hit = cache.get(host);
  if (hit) return hit;
  const res = await fetch(`https://1.1.1.1/dns-query?name=${encodeURIComponent(host)}&type=A`, {
    headers: { accept: 'application/dns-json' },
  });
  if (!res.ok) throw new Error(`DoH HTTP ${res.status} for ${host}`);
  const body = (await res.json()) as { Answer?: Array<{ type: number; data: string }> };
  const a = (body.Answer ?? []).find((x) => x.type === 1)?.data;
  if (!a) throw new Error(`DoH: no A record for ${host}`);
  cache.set(host, a);
  return a;
}

/** Start the proxy on 127.0.0.1:<random>. Returns the port and a closer. */
export function startDohProxy(): Promise<{ port: number; close: () => void }> {
  const server = net.createServer((sock) => {
    sock.once('data', (buf) => {
      void (async () => {
        const head = buf.toString('utf8');
        const m = head.match(/^CONNECT ([^ :]+):(\d+) /);
        if (!m) {
          sock.end('HTTP/1.1 400 Bad Request\r\n\r\n');
          return;
        }
        try {
          const ip = await resolveHost(m[1]);
          const up = net.connect(Number(m[2]), ip, () => {
            sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
            sock.pipe(up);
            up.pipe(sock);
          });
          up.on('error', () => sock.destroy());
          sock.on('error', () => up.destroy());
        } catch {
          sock.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
        }
      })();
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as net.AddressInfo;
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}
