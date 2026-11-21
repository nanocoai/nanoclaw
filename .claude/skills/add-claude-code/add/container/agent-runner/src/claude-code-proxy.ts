/**
 * Claude Code MCP Proxy — stdio-to-HTTP bridge
 *
 * Runs inside the container as an MCP server (stdio transport).
 * Exposes a single "code" tool that forwards requests to the
 * Claude Code HTTP daemon on the host.
 *
 * Unlike qmd-proxy (which transparently forwards MCP protocol),
 * this implements the MCP server protocol directly with one tool.
 *
 * Host address: host.docker.internal:8282 (Docker's host gateway)
 */
import { createInterface } from 'readline';

const CLAUDE_CODE_URL = `http://host.docker.internal:${process.env.CLAUDE_CODE_PORT || '8282'}`;

function log(msg: string): void {
  process.stderr.write(`[claude-code-proxy] ${msg}\n`);
}

// MCP JSON-RPC helpers
function jsonRpcResponse(id: unknown, result: unknown): string {
  return JSON.stringify({ jsonrpc: '2.0', id, result });
}

function jsonRpcError(id: unknown, code: number, message: string): string {
  return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
}

// Tool definition for the MCP tools/list response
const CODE_TOOL = {
  name: 'code',
  description: 'Delegate a coding task to Claude Code running on the host machine. Use this for tasks that require reading, writing, or modifying code in the NanoClaw repository or other allowed directories. Claude Code has full access to the filesystem, git, npm, and other dev tools.',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The coding task to perform. Be specific about what files to change, what behavior to add/fix, and any constraints.',
      },
      cwd: {
        type: 'string',
        description: 'Working directory for the task. Must be in the allowlist (e.g., /Users/nanoclaw/nanoclaw).',
      },
      model: {
        type: 'string',
        description: 'Optional model override (e.g., "claude-sonnet-4-6"). Defaults to the host\'s configured model.',
      },
      session_id: {
        type: 'string',
        description: 'Resume a previous Claude Code session by ID. Useful for multi-step tasks.',
      },
    },
    required: ['prompt', 'cwd'],
  },
};

/**
 * Call the Claude Code HTTP daemon on the host.
 */
async function invokeClaudeCode(args: {
  prompt: string;
  cwd: string;
  model?: string;
  session_id?: string;
}): Promise<string> {
  const body = JSON.stringify({
    prompt: args.prompt,
    cwd: args.cwd,
    model: args.model,
    sessionId: args.session_id,
  });

  log(`Invoking Claude Code: cwd=${args.cwd}, prompt=${args.prompt.slice(0, 100)}...`);

  const response = await fetch(`${CLAUDE_CODE_URL}/invoke`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(300_000), // 5 minute timeout (matches host)
  });

  const result = await response.json();

  if (result.status === 'error') {
    throw new Error(result.error || 'Claude Code invocation failed');
  }

  const parts: string[] = [];
  if (result.result) parts.push(result.result);
  if (result.sessionId) parts.push(`\n[Session ID: ${result.sessionId}]`);
  if (result.durationMs) parts.push(`[Duration: ${(result.durationMs / 1000).toFixed(1)}s]`);
  if (result.costUsd) parts.push(`[Cost: $${result.costUsd.toFixed(4)}]`);

  return parts.join('\n');
}

/**
 * Handle a single JSON-RPC request from the MCP client (Claude SDK).
 */
async function handleRequest(parsed: { id?: unknown; method?: string; params?: unknown }): Promise<string | null> {
  const { id, method, params } = parsed;

  switch (method) {
    case 'initialize':
      return jsonRpcResponse(id, {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'claude-code', version: '1.0.0' },
      });

    case 'notifications/initialized':
      // No response needed for notifications
      return null;

    case 'tools/list':
      return jsonRpcResponse(id, { tools: [CODE_TOOL] });

    case 'tools/call': {
      const callParams = params as { name: string; arguments: Record<string, unknown> };
      if (callParams?.name !== 'code') {
        return jsonRpcError(id, -32602, `Unknown tool: ${callParams?.name}`);
      }

      const args = callParams.arguments as {
        prompt: string;
        cwd: string;
        model?: string;
        session_id?: string;
      };

      try {
        const result = await invokeClaudeCode(args);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: result }],
        });
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        log(`Invocation error: ${errorMsg}`);
        return jsonRpcResponse(id, {
          content: [{ type: 'text', text: `Error: ${errorMsg}` }],
          isError: true,
        });
      }
    }

    default:
      log(`Unknown method: ${method}`);
      return jsonRpcError(id, -32601, `Method not found: ${method}`);
  }
}

async function main(): Promise<void> {
  log('Starting Claude Code MCP proxy');

  const rl = createInterface({ input: process.stdin });

  rl.on('line', async (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: { id?: unknown; method?: string; params?: unknown };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      log(`Invalid JSON: ${trimmed.slice(0, 100)}`);
      return;
    }

    try {
      const response = await handleRequest(parsed);
      if (response !== null) {
        process.stdout.write(response + '\n');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      log(`Handler error: ${errorMsg}`);
      const errorResponse = jsonRpcError(parsed.id, -32000, `Proxy error: ${errorMsg}`);
      process.stdout.write(errorResponse + '\n');
    }
  });

  rl.on('close', () => {
    log('Stdin closed, exiting');
    process.exit(0);
  });

  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
