import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ZodType } from 'zod';

import { NdExpenseClient } from './client.js';
import { type ToolName, toolSchemas } from './contracts.js';
import { redactError } from './redaction.js';

interface ExpenseClient {
  call(name: ToolName, input: unknown): Promise<unknown>;
}

interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, ZodType>;
  handler(input: Record<string, unknown>): Promise<CallToolResult>;
}

const DESCRIPTIONS: Record<ToolName, string> = {
  submit_receipt_media: 'Submit receipt image or PDF attachments using their safe local paths.',
  submit_text_expense: 'Submit one explicit text expense.',
  get_pending_intakes: 'List receipt intakes waiting for one clarification.',
  clarify_intake: 'Answer one backend-requested field clarification.',
  update_receipt: 'Correct fields on one saved receipt.',
  trash_receipt: 'Move one saved receipt to Trash.',
  restore_receipt: 'Restore one receipt from Trash.',
  list_recent_receipts: 'List recent receipts for the fixed household account.',
  get_spending_summary: 'Summarize spending for a bounded date range.',
};

const TOOL_ORDER: ToolName[] = [
  'submit_receipt_media',
  'submit_text_expense',
  'get_pending_intakes',
  'clarify_intake',
  'update_receipt',
  'trash_receipt',
  'restore_receipt',
  'list_recent_receipts',
  'get_spending_summary',
];

function successResult(value: unknown): CallToolResult {
  const result: CallToolResult = { content: [{ type: 'text', text: JSON.stringify(value) }] };
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    result.structuredContent = value as Record<string, unknown>;
  }
  return result;
}

export function createToolDefinitions(client: ExpenseClient): ToolDefinition[] {
  return TOOL_ORDER.map((name) => ({
    name,
    description: DESCRIPTIONS[name],
    inputSchema: toolSchemas[name].shape,
    async handler(input) {
      try {
        return successResult(await client.call(name, input));
      } catch (error) {
        return {
          isError: true,
          content: [{ type: 'text', text: `ND Expense tool failed: ${redactError(error)}` }],
        };
      }
    },
  }));
}

export function createNdExpenseServer(client: ExpenseClient): McpServer {
  const server = new McpServer({ name: 'ndexpense', version: '1.0.0' });
  for (const tool of createToolDefinitions(client)) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, tool.handler);
  }
  return server;
}

async function main(): Promise<void> {
  const baseUrl = process.env.NDEXPENSE_API_BASE_URL;
  if (!baseUrl) throw new Error('NDEXPENSE_API_BASE_URL is required');
  const server = createNdExpenseServer(new NdExpenseClient(baseUrl));
  await server.connect(new StdioServerTransport());
}

if (import.meta.main) {
  main().catch((error) => {
    console.error(`ND Expense MCP startup failed: ${redactError(error)}`);
    process.exit(1);
  });
}
