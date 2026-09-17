#!/usr/bin/env node
/**
 * hindsight-mcp - stdio transport entry-point.
 *
 * One process per client. Bank prefix comes from env (no auth tokens, no
 * multi-tenant -- the local environment is the trust boundary).
 *
 * Required env:
 *   HINDSIGHT_URL          (e.g. http://localhost:3850)
 *   HINDSIGHT_BANK_PREFIX  (e.g. "nanoclaw")
 *
 * Tool implementation lives in ./tools.ts (shared with server.ts).
 */

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createMcpServer } from "./tools.js";

const HINDSIGHT_URL = (process.env.HINDSIGHT_URL ?? "").replace(/\/$/, "");
const BANK_PREFIX = process.env.HINDSIGHT_BANK_PREFIX ?? "";

function fail(msg: string): never {
  // stdio MCP requires *only* JSON-RPC on stdout -- write diagnostics to stderr
  process.stderr.write(`[hindsight-mcp/stdio] FATAL: ${msg}\n`);
  process.exit(1);
}

if (!HINDSIGHT_URL) fail("HINDSIGHT_URL is not set");
if (!BANK_PREFIX) fail("HINDSIGHT_BANK_PREFIX is not set");

async function main() {
  const server = createMcpServer({
    hindsightUrl: HINDSIGHT_URL,
    bankPrefix: BANK_PREFIX,
  });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  process.stderr.write(
    `[hindsight-mcp/stdio] connected: prefix=${BANK_PREFIX} hindsight=${HINDSIGHT_URL}\n`
  );
}

main().catch((err) => fail(`startup failed: ${err?.stack ?? err}`));
