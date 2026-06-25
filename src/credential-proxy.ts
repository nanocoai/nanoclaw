/**
 * Credential proxy for container isolation.
 * Containers connect here instead of directly to the Anthropic API.
 * The proxy injects real credentials so containers never see them.
 *
 * Two auth modes:
 *   API key:  Proxy injects x-api-key on every request.
 *   OAuth:    Container CLI exchanges its placeholder token for a temp
 *             API key via /api/oauth/claude_cli/create_api_key.
 *             Proxy injects real OAuth token on that exchange request;
 *             subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server } from 'http';
import { request as httpsRequest } from 'https';
import { request as httpRequest, RequestOptions } from 'http';

import {
  getEffectiveMode,
  noteEviction,
  noteHealthy,
  noteUsageGate,
} from './auth-state.js';
import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export type AuthMode = 'api-key' | 'oauth';

export interface ProxyConfig {
  authMode: AuthMode;
}

export function startCredentialProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  // Both creds are loaded up front; the effective mode is decided per-request
  // by the shared auth posture (subscription-primary, API-key failover).
  const apiKey = secrets.ANTHROPIC_API_KEY;
  const oauthToken =
    secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  const upstreamUrl = new URL(
    secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com',
  );
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> =
          {
            ...(req.headers as Record<string, string>),
            host: upstreamUrl.host,
            'content-length': body.length,
          };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        // Effective mode is captured once per request (so a retry reuses it,
        // and the response handler reports health against the same mode).
        const reqMode = getEffectiveMode();
        const isOAuthExchange = (req.url || '').includes('oauth');
        if (reqMode === 'api-key') {
          // API-key mode: inject x-api-key on every request. Also clear any
          // Authorization the container sent (it may be OAuth-configured if we
          // just failed over) so the real key is what reaches the API.
          delete headers['x-api-key'];
          delete headers['authorization'];
          headers['x-api-key'] = apiKey;
        } else {
          // OAuth/subscription mode: replace the placeholder Bearer token with
          // the real one only on the exchange/auth requests that carry an
          // Authorization header. Post-exchange requests use x-api-key (a temp
          // key) and pass through without token injection.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) {
              headers['authorization'] = `Bearer ${oauthToken}`;
            }
          }
        }

        // Retry transient network failures (flaky DNS / dropped connections
        // to the upstream API) so a single blip doesn't kill the agent's
        // request and hang its container. Safe to replay because the body is
        // fully buffered above and we only retry before any response bytes
        // have been written downstream (res.headersSent === false).
        const TRANSIENT_CODES = new Set([
          'ECONNRESET',
          'ETIMEDOUT',
          'ENOTFOUND',
          'EAI_AGAIN',
          'EPIPE',
          'ECONNREFUSED',
        ]);
        const MAX_RETRIES = 3;

        const sendUpstream = (attempt: number) => {
          const upstream = makeRequest(
            {
              hostname: upstreamUrl.hostname,
              port: upstreamUrl.port || (isHttps ? 443 : 80),
              path: req.url,
              method: req.method,
              headers,
            } as RequestOptions,
            (upRes) => {
              // Report subscription-path health to the shared auth posture so
              // it can fail over (and recover). Only meaningful in OAuth mode.
              if (reqMode === 'oauth') {
                const sc = upRes.statusCode || 0;
                if (sc === 401 && isOAuthExchange) {
                  noteEviction(`exchange ${req.url}`);
                } else if (sc === 429) {
                  noteUsageGate();
                } else if (sc >= 200 && sc < 300) {
                  noteHealthy();
                }
              }
              res.writeHead(upRes.statusCode!, upRes.headers);
              upRes.pipe(res);
            },
          );

          upstream.on('error', (err: NodeJS.ErrnoException) => {
            if (
              err.code &&
              TRANSIENT_CODES.has(err.code) &&
              attempt < MAX_RETRIES &&
              !res.headersSent
            ) {
              const delay = 250 * 2 ** attempt; // 250ms, 500ms, 1000ms
              logger.warn(
                { code: err.code, url: req.url, attempt: attempt + 1, delay },
                'Credential proxy upstream transient error, retrying',
              );
              setTimeout(() => sendUpstream(attempt + 1), delay);
              return;
            }
            logger.error(
              { err, url: req.url, attempt },
              'Credential proxy upstream error',
            );
            if (!res.headersSent) {
              res.writeHead(502);
              res.end('Bad Gateway');
            }
          });

          upstream.write(body);
          upstream.end();
        };

        sendUpstream(0);
      });
    });

    server.listen(port, host, () => {
      logger.info(
        { port, host, mode: getEffectiveMode() },
        'Credential proxy started',
      );
      resolve(server);
    });

    server.on('error', reject);
  });
}

/** Detect which auth mode the host is configured for. */
export function detectAuthMode(): AuthMode {
  const secrets = readEnvFile(['ANTHROPIC_API_KEY']);
  return secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
}
