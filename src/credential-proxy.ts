/**
 * Credential proxy for container isolation.
 *
 * Containers connect here as their ANTHROPIC_BASE_URL instead of directly to
 * the Anthropic API. The proxy reads real credentials from .env and injects
 * them on every forwarded request so containers never see them.
 *
 * Used when OneCLI is not configured (no ONECLI_URL in .env). Provides a
 * lighter-weight alternative without the docker-compose dependency.
 *
 * Two auth modes:
 *   api-key  — Proxy injects `x-api-key` on every request.
 *   oauth    — Container Claude CLI exchanges a placeholder token for a temp
 *              API key via /api/oauth/claude_cli/create_api_key. Proxy
 *              injects the real OAuth bearer token on that exchange request;
 *              subsequent requests carry the temp key which is valid as-is.
 */
import { createServer, Server, request as httpRequest } from 'http';
import { request as httpsRequest } from 'https';
import type { RequestOptions } from 'http';

import { readEnvFile } from './env.js';
import { log } from './log.js';

export type AuthMode = 'api-key' | 'oauth';

export function startCredentialProxy(port: number, host = '127.0.0.1'): Promise<Server> {
  const secrets = readEnvFile([
    'ANTHROPIC_API_KEY',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
  ]);

  const authMode: AuthMode = secrets.ANTHROPIC_API_KEY ? 'api-key' : 'oauth';
  const oauthToken = secrets.CLAUDE_CODE_OAUTH_TOKEN || secrets.ANTHROPIC_AUTH_TOKEN;

  if (authMode === 'api-key' && !secrets.ANTHROPIC_API_KEY) {
    throw new Error('Credential proxy: no ANTHROPIC_API_KEY found in .env');
  }
  if (authMode === 'oauth' && !oauthToken) {
    throw new Error('Credential proxy: neither ANTHROPIC_API_KEY nor CLAUDE_CODE_OAUTH_TOKEN found in .env');
  }

  const upstreamUrl = new URL(secrets.ANTHROPIC_BASE_URL || 'https://api.anthropic.com');
  const isHttps = upstreamUrl.protocol === 'https:';
  const makeRequest = isHttps ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        const headers: Record<string, string | number | string[] | undefined> = {
          ...(req.headers as Record<string, string>),
          host: upstreamUrl.host,
          'content-length': body.length,
        };

        // Strip hop-by-hop headers that must not be forwarded by proxies
        delete headers['connection'];
        delete headers['keep-alive'];
        delete headers['transfer-encoding'];

        if (authMode === 'api-key') {
          delete headers['x-api-key'];
          headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
        } else {
          // OAuth: only replace the bearer on requests that actually carry one
          // (typically the temp-key exchange + auth probes). Post-exchange
          // requests use x-api-key only and pass through untouched.
          if (headers['authorization']) {
            delete headers['authorization'];
            if (oauthToken) headers['authorization'] = `Bearer ${oauthToken}`;
          }
        }

        const upstream = makeRequest(
          {
            hostname: upstreamUrl.hostname,
            port: upstreamUrl.port || (isHttps ? 443 : 80),
            path: req.url,
            method: req.method,
            headers,
          } as RequestOptions,
          (upRes) => {
            res.writeHead(upRes.statusCode!, upRes.headers);
            upRes.pipe(res);
          },
        );

        upstream.on('error', (err) => {
          log.error('Credential proxy upstream error', { url: req.url, err });
          if (!res.headersSent) {
            res.writeHead(502);
            res.end('Bad Gateway');
          }
        });

        upstream.write(body);
        upstream.end();
      });
    });

    server.listen(port, host, () => {
      log.info('Credential proxy started', { port, host, authMode });
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
