import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export interface McpToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>, context?: { signal: AbortSignal }) => Promise<CallToolResult>;
}
