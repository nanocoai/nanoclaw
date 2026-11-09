/**
 * Allocate a TCP port that is free right now by letting the kernel pick one
 * (listen on 0), then release it for the caller to bind.
 *
 * Replaces the "random port in 21000–41000" pattern in tests, which overlaps
 * the OS ephemeral range (32768–60999 on Linux) and races other vitest
 * workers — it flaked CI with EADDRINUSE on the chosen port. The
 * release-then-rebind window is microseconds; a collision there fails the
 * test loudly rather than hanging on a connection refusal.
 *
 * `host` should match what the server under test binds (webhook-server binds
 * 0.0.0.0).
 */
import net from 'net';

export async function allocateFreePort(host = '0.0.0.0'): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, host, resolve);
  });
  const address = probe.address();
  if (!address || typeof address === 'string') throw new Error('Expected an allocated TCP port');
  const { port } = address;
  await new Promise<void>((resolve, reject) => probe.close((err) => (err ? reject(err) : resolve())));
  return port;
}
