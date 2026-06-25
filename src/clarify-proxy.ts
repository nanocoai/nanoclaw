/**
 * Clarify CRM Proxy — runs on the host, proxies MCP calls to
 * api.clarify.ai using the local credential tokens.
 * Containers access this via the clarify MCP stdio server.
 */
import { createServer, Server } from 'http';
import fs from 'fs';
import path from 'path';
import os from 'os';

import { logger } from './logger.js';

const MCP_URL = 'https://api.clarify.ai/mcp';
const CRED_DIR = path.join(os.homedir(), '.config', 'mcporter', 'credentials');

interface ClarifyCredential {
  accessToken: string;
  refreshToken?: string;
  clientId?: string;
  authServer?: string;
}

const WORKSPACE_FILES: Record<string, string> = {
  cleanerdns: 'clarify.json',
  appthrive: 'clarify-appthrive.json',
};

function readCred(
  workspace: string,
): { cred: ClarifyCredential; credPath: string } | null {
  const file = WORKSPACE_FILES[workspace];
  if (!file) return null;
  const credPath = path.join(CRED_DIR, file);
  try {
    const cred: ClarifyCredential = JSON.parse(
      fs.readFileSync(credPath, 'utf-8'),
    );
    return { cred, credPath };
  } catch {
    logger.warn({ workspace, credPath }, 'Cannot read Clarify credential');
    return null;
  }
}

function getToken(workspace: string): string | null {
  return readCred(workspace)?.cred.accessToken ?? null;
}

/**
 * Refresh an expired Clarify token via the OAuth refresh_token grant and
 * persist it back to the shared credential file. Mirrors the on-401 refresh
 * in bd-brain-sync's clarify_client.py so the agent path self-heals instead
 * of free-riding on the sync schedule. Returns the new access token or null.
 */
async function refreshToken(workspace: string): Promise<string | null> {
  const entry = readCred(workspace);
  if (!entry) return null;
  const { cred, credPath } = entry;
  const authServer = cred.authServer || 'https://auth1.clarify.ai';
  if (!cred.refreshToken || !cred.clientId) {
    logger.warn(
      { workspace },
      'Cannot refresh Clarify token — missing refreshToken or clientId',
    );
    return null;
  }

  try {
    const response = await fetch(`${authServer}/oauth2/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: cred.clientId,
        refresh_token: cred.refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      error?: string;
    };
    if (!data.access_token) {
      logger.warn(
        { workspace, error: data.error || 'unknown' },
        'Clarify token refresh failed — interactive re-auth may be needed',
      );
      return null;
    }
    cred.accessToken = data.access_token;
    if (data.refresh_token) cred.refreshToken = data.refresh_token;
    fs.writeFileSync(credPath, JSON.stringify(cred, null, 2));
    logger.info({ workspace }, 'Refreshed Clarify token');
    return data.access_token;
  } catch (err) {
    logger.warn(
      { workspace, err: err instanceof Error ? err.message : String(err) },
      'Clarify token refresh error',
    );
    return null;
  }
}

async function clarifyCall(
  tool: string,
  args: Record<string, unknown>,
  token: string,
): Promise<{
  status: string;
  output?: string;
  error?: string;
  httpStatus?: number;
}> {
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: tool, arguments: args },
  });

  try {
    const response = await fetch(MCP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: payload,
      signal: AbortSignal.timeout(30_000),
    });

    // Expired/invalid token — surface the status so the caller can refresh
    // and retry (mirrors clarify_client.py's on-401 refresh).
    if (response.status === 401 || response.status === 403) {
      return {
        status: 'error',
        error: `Clarify auth failed (HTTP ${response.status})`,
        httpStatus: response.status,
      };
    }

    const data = (await response.json()) as {
      result?: { content?: Array<{ text?: string }>; isError?: boolean };
      error?: { message?: string };
    };

    if (data.error) {
      return { status: 'error', error: data.error.message || 'Unknown error' };
    }

    const text = data.result?.content?.[0]?.text || '';
    if (data.result?.isError) {
      return { status: 'error', error: text };
    }
    return { status: 'ok', output: text };
  } catch (err) {
    return {
      status: 'error',
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function startClarifyProxy(
  port: number,
  host = '127.0.0.1',
): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      if (req.method !== 'POST' || req.url !== '/exec') {
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        let body: {
          tool: string;
          args: Record<string, unknown>;
          workspace?: string;
        };
        try {
          body = JSON.parse(Buffer.concat(chunks).toString());
        } catch {
          res.writeHead(400);
          res.end(JSON.stringify({ status: 'error', error: 'Invalid JSON' }));
          return;
        }

        if (!body.tool || !body.args) {
          res.writeHead(400);
          res.end(
            JSON.stringify({
              status: 'error',
              error: 'Missing tool or args',
            }),
          );
          return;
        }

        const workspace = body.workspace || 'cleanerdns';
        const token = getToken(workspace);
        if (!token) {
          res.writeHead(500);
          res.end(
            JSON.stringify({
              status: 'error',
              error: `No token for workspace '${workspace}'`,
            }),
          );
          return;
        }

        clarifyCall(body.tool, body.args, token)
          .then(async (result) => {
            // Token expired mid-flight: refresh once and retry. Unlike the
            // sync path, the proxy holds no long-lived token of its own, so
            // this is the only place the agent path can self-heal.
            if (result.httpStatus === 401 || result.httpStatus === 403) {
              const fresh = await refreshToken(workspace);
              if (fresh) {
                result = await clarifyCall(body.tool, body.args, fresh);
              }
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(result));
          })
          .catch((err) => {
            res.writeHead(500);
            res.end(
              JSON.stringify({
                status: 'error',
                error: String(err),
              }),
            );
          });
      });
    });

    server.on('error', reject);
    server.listen(port, host, () => {
      logger.info({ port, host }, 'Clarify proxy started');
      resolve(server);
    });
  });
}
