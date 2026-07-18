/**
 * yt-dlp MCP server — wraps the yt-dlp CLI as a stdio MCP server.
 *
 * Curated tool surface (search, metadata, video download, audio download).
 * The yt-dlp binary is installed by the /add-ytdlp skill (Dockerfile patch).
 *
 * Per-group opt-in: a group enables this server by adding an
 * `mcpServers["yt-dlp"]` entry to its container.json with
 *   command: "bun", args: ["run", "/app/src/yt-dlp-mcp/server.ts"].
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import { fail } from './spawn.js';
import { downloadAudioHandler, downloadAudioTool } from './tools/download-audio.js';
import { downloadVideoHandler, downloadVideoTool } from './tools/download-video.js';
import { metadataHandler, metadataTool } from './tools/metadata.js';
import { searchHandler, searchTool } from './tools/search.js';

const TOOLS: Array<{ tool: Tool; handler: (a: Record<string, unknown>) => Promise<CallToolResult> }> = [
  { tool: searchTool, handler: searchHandler },
  { tool: metadataTool, handler: metadataHandler },
  { tool: downloadVideoTool, handler: downloadVideoHandler },
  { tool: downloadAudioTool, handler: downloadAudioHandler },
];

export async function startYtDlpMcpServer(): Promise<void> {
  const server = new Server(
    { name: 'yt-dlp', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS.map((t) => t.tool),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const found = TOOLS.find((t) => t.tool.name === name);
    if (!found) return fail(`Unknown tool: ${name}`);
    try {
      return await found.handler(args ?? {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return fail(`${name}: unhandled exception: ${msg}`);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(
    `[yt-dlp-mcp] started with ${TOOLS.length} tools: ${TOOLS.map((t) => t.tool.name).join(', ')}`,
  );
}

if (import.meta.main) {
  startYtDlpMcpServer().catch((e) => {
    console.error(`[yt-dlp-mcp] fatal: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
}
