/**
 * hindsight-mcp - HTTP transport entry-point.
 *
 * Streamable-HTTP MCP server with multi-tenant Bearer-token auth.
 * Each token maps to a bank prefix; the prefix is prepended to the tool's
 * `group` argument to form the Hindsight bank_id.
 *
 * Tool implementation lives in ./tools.ts (shared with server-stdio.ts).
 */

import express from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "crypto";

import { createMcpServer } from "./tools.js";

const HINDSIGHT_URL = (process.env.HINDSIGHT_URL ?? "http://hindsight:8888").replace(/\/$/, "");
const MCP_PORT = parseInt(process.env.MCP_PORT ?? "3852", 10);
const MCP_BIND = process.env.MCP_BIND ?? "0.0.0.0";

function parseAuthTokens(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const [token, prefix] = trimmed.split(":");
    if (!token || !prefix) {
      console.warn(`[config] Ignoring malformed auth token entry: "${trimmed}"`);
      continue;
    }
    out.set(token.trim(), prefix.trim());
  }
  return out;
}

const AUTH_TOKENS = parseAuthTokens(process.env.MCP_AUTH_TOKENS);
if (AUTH_TOKENS.size === 0) {
  console.warn(
    "[config] MCP_AUTH_TOKENS is empty -- all requests will be rejected."
  );
} else {
  console.log(`[config] Loaded ${AUTH_TOKENS.size} auth token(s)`);
  for (const [, prefix] of AUTH_TOKENS) {
    console.log(`  prefix: ${prefix}`);
  }
}

const app = express();
app.use(express.json({ limit: "20mb" }));

const transports: Record<string, StreamableHTTPServerTransport> = {};

function extractBearer(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const [kind, token] = authHeader.split(" ");
  if (kind !== "Bearer" || !token) return null;
  return token;
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", hindsight_url: HINDSIGHT_URL });
});

app.all("/mcp", async (req, res) => {
  const token = extractBearer(req.header("authorization"));
  const prefix = token ? AUTH_TOKENS.get(token) : undefined;
  if (!prefix) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "Unauthorized" },
      id: null,
    });
    return;
  }

  const sessionId = req.header("mcp-session-id") as string | undefined;
  let transport: StreamableHTTPServerTransport;

  if (sessionId && transports[sessionId]) {
    transport = transports[sessionId];
  } else if (!sessionId && isInitializeRequest(req.body)) {
    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sid) => {
        transports[sid] = transport;
      },
    });
    transport.onclose = () => {
      if (transport.sessionId) delete transports[transport.sessionId];
    };
    const server = createMcpServer({
      hindsightUrl: HINDSIGHT_URL,
      bankPrefix: prefix,
    });
    await server.connect(transport);
  } else {
    res.status(400).json({
      jsonrpc: "2.0",
      error: { code: -32000, message: "No valid session" },
      id: null,
    });
    return;
  }

  await transport.handleRequest(req, res, req.body);
});

app.listen(MCP_PORT, MCP_BIND, () => {
  console.log(
    `[hindsight-mcp/http] listening on ${MCP_BIND}:${MCP_PORT} -> ${HINDSIGHT_URL}`
  );
});
