/**
 * Disable Node's `autoSelectFamily` (Happy Eyeballs) for built-in fetch.
 *
 * Why: hosts whose DNS resolver returns AAAA records but have no working
 * IPv6 default route (e.g. a box on an IPv4-only LAN where upstream DNS
 * still hands out v6) cause undici-backed `fetch()` to fail with an
 * aggregated `ETIMEDOUT` — the v6 attempt errors with `ENETUNREACH` and
 * the race surfaces as a generic `NetworkError` to callers like
 * `@chat-adapter/telegram`. Curl falls back gracefully; Node's fetch
 * does not.
 *
 * Disabling autoSelectFamily removes the family race. Node then connects
 * to a single address per `dns.lookup`, and getaddrinfo's `AI_ADDRCONFIG`
 * filter generally returns the family the host can actually reach — so
 * v4-broken/v6-healthy hosts use v6, v6-broken/v4-healthy hosts use v4,
 * and dual-stack hosts use whichever family the system prefers (RFC 6724
 * default; v4 on most Linux/macOS). DNS ordering is left at Node's
 * default so this doesn't force a family preference globally.
 *
 * Imported first from each Node entry point (`src/index.ts`,
 * `setup/auto.ts`, `setup/index.ts`) so the change is in effect before
 * any module opens a socket.
 */
import net from 'node:net';

net.setDefaultAutoSelectFamily(false);
