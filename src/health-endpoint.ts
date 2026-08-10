/**
 * Liveness probe on the shared webhook server: `GET /webhook/health`.
 *
 * Exists so an external dashboard can show a real up/down state for the host
 * process. NanoClaw runs as a systemd/launchd user service, not a container,
 * so there is no Docker socket for a dashboard to read state from — without
 * this it can only ping the port, and the webhook server answers 404 to every
 * path it does not recognise, which reads as "down".
 *
 * Registering this starts the webhook server even when no channel adapter
 * needs it. That is deliberate: a liveness probe that disappears exactly when
 * you have no webhook-delivered channels wired is useless for its one job.
 *
 * The payload carries no install detail — no group, channel, user, or config
 * names. The shared server binds 0.0.0.0, so treat anything returned here as
 * readable by the whole LAN.
 *
 * This answers "the host process is alive and its event loop is turning". It
 * does NOT prove any agent can reach its model provider or that a channel is
 * connected — a container whose provider is unreachable still reports ok.
 */
import { registerWebhookHandler } from './webhook-server.js';

/** Register the liveness route. Idempotent — re-registering replaces it. */
export function registerHealthEndpoint(): void {
  registerWebhookHandler('health', (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { 'Content-Type': 'text/plain', Allow: 'GET, HEAD' });
      res.end('Method Not Allowed');
      return;
    }

    const body = JSON.stringify({
      status: 'ok',
      uptimeSeconds: Math.floor(process.uptime()),
      timestamp: new Date().toISOString(),
    });

    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    // Node suppresses the body for HEAD on its own; end() without it is explicit.
    if (req.method === 'HEAD') res.end();
    else res.end(body);
  });
}
